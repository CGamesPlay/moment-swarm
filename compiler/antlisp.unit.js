#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// AntLisp Unit Test Harness
// ═══════════════════════════════════════════════════════════════
//
// Runs .unit.alisp test files.  Each file is a sequence of
// (test ...) blocks, each of which compiles independently, runs
// in an isolated world (single ant, tiny open map), and checks
// a set of assertion forms.
//
// Syntax:
//   (test "name" [:opt val | :flag]* (begin ...) ...)
//
// The (begin ...) is the program body.  Inline (abort! code) forms
// compile to ABORT opcodes — if triggered, the test fails.  Use the
// (assert! cond code) macro defined in the test preamble for
// structured assertions.
// :run-once implies :ticks 1 when :ticks is not also given.
//
// Options:
//   :ticks n          number of world ticks to run (default 10)
//   :run-once         run program exactly once (stop at PC wrap);
//                       implies :ticks 1
//   :max-ops n        explicit maxOpsPerTick budget
//   :ants n           number of ants (default 1)
//   :seed n           world RNG seed (default 1)
//   :map-size n       map width=height (default 32)
//   :place-food x y   place food at (x,y) before running (repeatable)
//   :ant-x x          start ant at x (default: map center)
//   :ant-y y          start ant at y (default: map center)
//
// Usage:
//   node antlisp.unit.js tests.unit.alisp
//   node antlisp.unit.js tests.unit.alisp --verbose
//   node antlisp.unit.js tests.unit.alisp -D DEBUG=1
//
// ═══════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const path = require("path");
const { compileAntLispDebug } = require("./antlisp");
const { tokenize, parse } = require("./parse");
const {
  parseAssembly,
  CellType, DEFAULT_CONFIG, RNG,
  createEmptyMap, setCell, placeFood, addBorderWalls, placeNest,
  createWorld, runTick, cloneMap,
  stepAnt,
  REG_FD, REG_CL, REG_PX, REG_PY, REG_PC,
} = require("./node-engine");

// ─── Assertion evaluators ─────────────────────────────────────

function evalOp(lhs, op, rhs) {
  switch (op) {
    case "=":  case "==": return lhs === rhs;
    case "!=":            return lhs !== rhs;
    case ">":             return lhs > rhs;
    case "<":             return lhs < rhs;
    case ">=":            return lhs >= rhs;
    case "<=":            return lhs <= rhs;
    default: throw new Error(`Unknown comparison operator: ${op}`);
  }
}

// ─── Parse test blocks from the unit file ────────────────────
//
// The unit file is parsed with the antlisp tokenizer/parser, then
// the top-level forms are scanned for (test ...) blocks.  All
// other top-level forms (define, defmacro, const, alias, etc.)
// are treated as shared preamble prepended to every test body.
//
// Syntax:
//   (test "name" [:opt val | :flag]* (begin ...) (assert-*) ...)
//
// After options, the first form is the program body — typically a
// (begin ...) wrapping all the code.  Every form after that must
// be an (assert-*) call.  This makes the boundary between program
// and assertions unambiguous.
//
// :run-once implies :ticks 1 when :ticks is not also specified.

function parseUnitFile(source) {
  const tokens = tokenize(source);
  const ast = parse(tokens);

  const preamble = [];   // shared top-level forms (outside any test)
  const tests = [];      // { name, opts, body, line }

  for (const node of ast.body) {
    if (node.type !== "list" || node.value.length === 0) continue;
    const head = node.value[0];
    if (head.type === "symbol" && head.value === "test") {
      // (test "name" [:opt val | :flag]* <body-form> <assert-form>*)
      const list = node.value.slice(1);
      if (list.length === 0 || list[0].type !== "string") {
        throw new Error(`test block at line ${node.line} must have a string name`);
      }
      const name = list[0].value;
      let i = 1;
      const opts = {};

      // Options with no following value (boolean flags)
      const BOOLEAN_FLAGS = new Set(["run-once"]);

      // Parse keyword options  :key val  or  :flag
      while (i < list.length && list[i].type === "symbol" && list[i].value.startsWith(":")) {
        const key = list[i].value.slice(1); // strip leading ":"
        i++;

        if (BOOLEAN_FLAGS.has(key)) {
          opts[key] = true;
          continue;
        }

        if (i >= list.length) throw new Error(`Missing value for option :${key} in test "${name}"`);
        const valNode = list[i];
        i++;

        if (key === "place-food") {
          // :place-food x y  — consume two coordinate values
          if (i >= list.length) throw new Error(`Missing y for :place-food in test "${name}"`);
          const x = Number(valNode.value);
          const y = Number(list[i].value);
          i++;
          opts["place-food"] = opts["place-food"] || [];
          opts["place-food"].push([x, y]);
        } else {
          opts[key] = valNode.value;
        }
      }

      // Next form is the program body (the only form after options)
      if (i >= list.length) throw new Error(`test "${name}" has no body form`);
      const bodyForm = list[i++];
      if (i < list.length)
        throw new Error(`test "${name}": unexpected form after body: (${list[i].value?.[0]?.value ?? "?"})`);

      // :run-once implies :ticks 1 unless explicitly overridden
      if (opts["run-once"] && opts["ticks"] === undefined) opts["ticks"] = 1;

      // body is the list of forms inside (begin ...), or the single form itself
      const body = unwrapBegin(bodyForm);

      tests.push({ name, opts, body, line: node.line });
    } else {
      preamble.push(node);
    }
  }

  return { preamble, tests };
}

// If node is (begin form...) return the inner forms; otherwise wrap in array.
function unwrapBegin(node) {
  if (node.type === "list" && node.value.length > 0 &&
      node.value[0].type === "symbol" && node.value[0].value === "begin") {
    return node.value.slice(1);
  }
  return [node];
}

// ─── AST → source text ───────────────────────────────────────
// Reconstructs source from a parsed AST node for re-compilation.

function astToSource(node) {
  if (node.type === "number") return String(node.value);
  if (node.type === "string") return `"${node.value}"`;
  if (node.type === "symbol") return node.value;
  if (node.type === "list")   return "(" + node.value.map(astToSource).join(" ") + ")";
  return "";
}

// ─── :run-once executor ──────────────────────────────────────
//
// Runs the program for ant 0 exactly once — stopping the moment
// the PC would wrap back to 0 (or an action opcode ends the tick).
//
// Uses stepAnt's stopAtPc=0 feature: stepAnt will execute as many
// instructions as it likes up to the ops budget, but halts before
// executing instruction 0 a second time.  We give it a large enough
// budget to handle any loop, then repeat if an action ended the
// call early.

function runProgramOnce(world) {
  const ant        = world.ants[0];
  const instrCount = world.program.instructions.length;
  const map        = world.map;
  const rng        = new RNG(world.rngState);
  const BIG        = instrCount * 100000;  // large enough for any loop

  ant.pc = 0;

  // Populate magic registers (runProgramOnce bypasses runTick, so we set them here)
  ant.regs[REG_FD] = world.foodCollected;
  ant.regs[REG_CL] = world.tick;
  ant.regs[REG_PX] = ant.x;
  ant.regs[REG_PY] = ant.y;
  ant.regs[REG_PC] = ant.pc;

  stepAnt(
    ant, 0,
    world.bytecode, instrCount,
    map, /*unused*/ 0,
    rng, BIG,
    world.antGrid,
    /*senseRange*/ 1,
    /*stopAtPc*/   0,
  );

  world.rngState = rng.state;
}

// ─── Built-in preamble ───────────────────────────────────────

function loadBuiltinPreamble() {
  const preamblePath = path.join(__dirname, "unit-preamble.alisp");
  const source = fs.readFileSync(preamblePath, "utf8");
  const tokens = tokenize(source);
  const ast = parse(tokens);
  return ast.body;
}

// ─── Build and run a single test ─────────────────────────────

function runTestBlock(testDef, preamble, verbose, sourceFile, constOverrides = {}) {
  const { name, opts, body } = testDef;

  const ticks    = Number(opts["ticks"]    ?? 10);
  const antCount = Number(opts["ants"]     ?? 1);
  const seed     = Number(opts["seed"]     ?? 1);
  const mapSize  = Number(opts["map-size"] ?? 32);
  const runOnce  = Boolean(opts["run-once"]);
  const maxOps   = opts["max-ops"] !== undefined
                   ? Number(opts["max-ops"])
                   : DEFAULT_CONFIG.maxOpsPerTick;

  // ── Compile ──────────────────────────────────────────────
  const builtinPreamble = loadBuiltinPreamble();
  const source = [...builtinPreamble, ...preamble, ...body].map(astToSource).join("\n");

  let asm;
  try {
    ({ asm } = compileAntLispDebug(source, { constOverrides, sourceFile }));
  } catch (e) {
    return { name, passed: false, error: `Compile error: ${e.message}`,
             asmSource: null, failedAssertions: [], regState: '', worldTick: 0, foodCollected: 0,
             ant: { x: 0, y: 0, carrying: false, pc: 0 } };
  }

  if (verbose) {
    console.log(`\n  --- compiled assembly for "${name}" ---`);
    asm.split("\n").forEach(l => console.log("    " + l));
    console.log("  --- end assembly ---\n");
  }

  // ── Assemble ─────────────────────────────────────────────
  // An empty program (all checks constant-folded away) means all assertions trivially passed.
  if (!asm.trim()) {
    return { name, passed: true, error: null, asmSource: asm, failedAssertions: [],
             regState: '', worldTick: 0, foodCollected: 0,
             ant: { x: 0, y: 0, carrying: false, pc: 0 } };
  }

  let program;
  try {
    program = parseAssembly(asm, { isa: 'debug' });
  } catch (e) {
    return { name, passed: false, error: `Assembly error: ${e.message}`,
             asmSource: asm, failedAssertions: [], regState: '', worldTick: 0, foodCollected: 0,
             ant: { x: 0, y: 0, carrying: false, pc: 0 } };
  }

  // ── Build world ──────────────────────────────────────────
  const map = createEmptyMap(mapSize, mapSize, seed, "unit-test");
  addBorderWalls(map);

  // Nest at map centre
  const cx = Math.floor(mapSize / 2);
  const cy = Math.floor(mapSize / 2);
  map.nestX = cx;
  map.nestY = cy;
  placeNest(map);

  // Optional food placements
  for (const [fx, fy] of (opts["place-food"] ?? [])) {
    setCell(map, fx, fy, CellType.EMPTY);   // clear any nest/wall first
    placeFood(map, fx, fy, 1);
  }

  const config = { ...DEFAULT_CONFIG, antCount, maxTicks: ticks, maxOpsPerTick: maxOps };
  const world  = createWorld(cloneMap(map), program, config);

  // Optional ant start position override
  if (opts["ant-x"] !== undefined || opts["ant-y"] !== undefined) {
    const ax = Number(opts["ant-x"] ?? cx);
    const ay = Number(opts["ant-y"] ?? cy);
    for (const ant of world.ants) { ant.x = ax; ant.y = ay; }
  }

  // ── Run ──────────────────────────────────────────────────
  if (runOnce) {
    runProgramOnce(world);
  } else {
    for (let t = 0; t < ticks; t++) runTick(world, config);
  }

  // ── Check results ───────────────────────────────────────────
  const ant0 = world.ants[0];
  const failedAssertions = [];

  // VM-level ABORT indicates test failure
  if (ant0._aborted !== undefined) {
    failedAssertions.push(`aborted with code ${ant0._aborted}`);
  }

  const passed   = failedAssertions.length === 0;
  const regState = ant0.regs.map((v, i) => `r${i}=${v}`).join("  ");

  return {
    name, passed, error: null, asmSource: asm, failedAssertions,
    regState, worldTick: world.tick, foodCollected: world.foodCollected,
    ant: { x: ant0.x, y: ant0.y, carrying: ant0.carrying, pc: ant0.pc },
  };
}

// ─── Main runner ─────────────────────────────────────────────

function runUnitFile(filePath, verbose = false, constOverrides = {}) {
  const resolvedPath = path.resolve(filePath);
  let source;
  try {
    source = fs.readFileSync(resolvedPath, "utf8");
  } catch (e) {
    console.error(`Cannot read file: ${filePath}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = parseUnitFile(source);
  } catch (e) {
    console.error(`Parse error: ${e.message}`);
    process.exit(1);
  }

  const { preamble, tests } = parsed;

  if (tests.length === 0) {
    console.log("No (test ...) blocks found.");
    process.exit(0);
  }

  console.log(`\n═══ AntLisp Unit Tests: ${filePath} ═══\n`);

  let passed = 0, failed = 0;

  for (const testDef of tests) {
    const result = runTestBlock(testDef, preamble, verbose, resolvedPath, constOverrides);

    if (result.passed) {
      console.log(`  ✓  ${result.name}`);
      if (verbose && result.regState) {
        console.log(`       regs: ${result.regState}`);
        console.log(`       ant: x=${result.ant.x} y=${result.ant.y} carrying=${result.ant.carrying} pc=${result.ant.pc}  food=${result.foodCollected}  tick=${result.worldTick}`);
      }
      passed++;
    } else {
      console.log(`  ✗  ${result.name}`);
      if (result.error) console.log(`       ERROR: ${result.error}`);
      const maxShown = 5;
      for (let i = 0; i < result.failedAssertions.length && i < maxShown; i++)
        console.log(`       FAIL: ${result.failedAssertions[i]}`);
      if (result.failedAssertions.length > maxShown)
        console.log(`       ... and ${result.failedAssertions.length - maxShown} more`);
      if (result.regState) {
        console.log(`       regs: ${result.regState}`);
        console.log(`       ant: x=${result.ant?.x} y=${result.ant?.y} carrying=${result.ant?.carrying} pc=${result.ant?.pc}  food=${result.foodCollected}  tick=${result.worldTick}`);
      }
      if (verbose && result.asmSource) {
        console.log(`       compiled assembly:`);
        result.asmSource.split("\n").forEach(l => console.log("         " + l));
      }
      failed++;
      if (failed >= 5) {
        console.log(`\n  ✗ Aborting after ${failed} failures`);
        break;
      }
    }
  }

  const skipped = tests.length - passed - failed;
  const skippedMsg = skipped > 0 ? `, ${skipped} skipped` : '';
  console.log(`\n═══ ${passed} passed, ${failed} failed${skippedMsg} ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let file = null, verbose = false;
  const constOverrides = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verbose' || arg === '-v') verbose = true;
    else if (arg === '-D' && i + 1 < args.length) {
      const pair = args[++i];
      const eq = pair.indexOf('=');
      if (eq !== -1) constOverrides[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (!arg.startsWith('-')) file = arg;
  }
  if (!file) {
    console.error("Usage: node antlisp.unit.js <tests.unit.alisp> [--verbose] [-D KEY=VAL]");
    process.exit(1);
  }
  runUnitFile(file, verbose, constOverrides);
}

module.exports = { runUnitFile, parseUnitFile, runTestBlock };
