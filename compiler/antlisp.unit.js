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
//   (test "name" [:opt val | :flag]* (begin ...) (assert-*) ...)
//
// The (begin ...) is the program body.  All (assert-*) forms come
// after it, making the boundary between code and checks explicit.
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
// Assertion forms:
//   (assert-reg rN value)           ; register rN == value
//   (assert-reg rN op value)        ; register rN <op> value  (=,!=,<,>,<=,>=)
//   (assert-reg-name varname value) ; named variable == value
//   (assert-reg-name varname op v)  ; named variable <op> value
//   (assert-carrying)               ; ant is carrying food
//   (assert-not-carrying)           ; ant is not carrying food
//   (assert-food-collected n)       ; world.foodCollected == n
//   (assert-food-collected op n)    ; world.foodCollected <op> n
//   (assert-tick n)                 ; ran for exactly n ticks
//   (assert-pc n)                   ; ant program counter == n
//   (assert-at x y)                 ; ant is at position x, y
//
// Usage:
//   node antlisp.unit.js tests.unit.alisp
//   node antlisp.unit.js tests.unit.alisp --verbose
//
// ═══════════════════════════════════════════════════════════════

"use strict";

const fs = require("fs");
const { compileAntLispDebug } = require("./antlisp2");
const { tokenize, parse } = require("./parse");
const {
  parseAssembly,
  CellType, DEFAULT_CONFIG, RNG,
  createEmptyMap, setCell, placeFood, addBorderWalls, placeNest,
  createWorld, runTick, cloneMap,
  stepAnt,
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
  const tests = [];      // { name, opts, body, assertions, line }

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

      // Next form is the program body (must not be an assertion)
      if (i >= list.length) throw new Error(`test "${name}" has no body form`);
      const bodyForm = list[i++];
      if (isAssertionForm(bodyForm))
        throw new Error(`test "${name}": expected program body before assertions, got ${bodyForm.value[0].value}`);

      // All remaining forms must be assertions
      const assertions = [];
      while (i < list.length) {
        const form = list[i++];
        if (!isAssertionForm(form))
          throw new Error(`test "${name}": expected (assert-*) after body, got (${form.value?.[0]?.value ?? "?"})`);
        assertions.push(form);
      }

      // :run-once implies :ticks 1 unless explicitly overridden
      if (opts["run-once"] && opts["ticks"] === undefined) opts["ticks"] = 1;

      // body is the list of forms inside (begin ...), or the single form itself
      const body = unwrapBegin(bodyForm);

      tests.push({ name, opts, body, assertions, line: node.line });
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

function isAssertionForm(node) {
  if (node.type !== "list" || node.value.length === 0) return false;
  const head = node.value[0];
  return head.type === "symbol" && head.value.startsWith("assert-");
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

// ─── Build and run a single test ─────────────────────────────

function runTestBlock(testDef, preamble, verbose) {
  const { name, opts, body, assertions } = testDef;

  const ticks    = Number(opts["ticks"]    ?? 10);
  const antCount = Number(opts["ants"]     ?? 1);
  const seed     = Number(opts["seed"]     ?? 1);
  const mapSize  = Number(opts["map-size"] ?? 32);
  const runOnce  = Boolean(opts["run-once"]);
  const maxOps   = opts["max-ops"] !== undefined
                   ? Number(opts["max-ops"])
                   : DEFAULT_CONFIG.maxOpsPerTick;

  // ── Compile ──────────────────────────────────────────────
  // Combine preamble + body (assertions are stripped — they run
  // against the VM state, not as part of the program).
  const source = [...preamble, ...body].map(astToSource).join("\n");

  let asm, varMap;
  try {
    ({ asm, varMap } = compileAntLispDebug(source, { testing: true }));
  } catch (e) {
    return { name, passed: false, error: `Compile error: ${e.message}`,
             asmSource: null, failedAssertions: [] };
  }

  if (verbose) {
    console.log(`\n  --- compiled assembly for "${name}" ---`);
    asm.split("\n").forEach(l => console.log("    " + l));
    console.log("  --- end assembly ---\n");
  }

  // ── Assemble ─────────────────────────────────────────────
  let program;
  try {
    program = parseAssembly(asm);
  } catch (e) {
    return { name, passed: false, error: `Assembly error: ${e.message}`,
             asmSource: asm, failedAssertions: [] };
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

  // ── Evaluate assertions ───────────────────────────────────
  const failedAssertions = [];
  const ant0 = world.ants[0];

  for (const assertNode of assertions) {
    const list = assertNode.value;
    const kind = list[0].value;

    try {
      switch (kind) {

        case "assert-reg": {
          // (assert-reg rN value)  or  (assert-reg rN op value)
          const regStr = list[1].value;
          const regIdx = parseInt(regStr.slice(1), 10);
          if (isNaN(regIdx) || regIdx < 0 || regIdx > 7)
            throw new Error(`Invalid register: ${regStr}`);
          const actual = ant0.regs[regIdx];
          if (list.length === 3) {
            const expected = Number(list[2].value);
            if (actual !== expected)
              failedAssertions.push(`assert-reg ${regStr} = ${expected}: got ${actual}`);
          } else if (list.length === 4) {
            const op = list[2].value, expected = Number(list[3].value);
            if (!evalOp(actual, op, expected))
              failedAssertions.push(`assert-reg ${regStr} ${op} ${expected}: got ${actual}`);
          } else {
            throw new Error("assert-reg: expected 2 or 3 args");
          }
          break;
        }

        case "assert-reg-name": {
          // (assert-reg-name varname value)  or  (assert-reg-name varname op value)
          const varName = list[1].value;
          const regStr  = varMap.get(varName);
          if (regStr === undefined)
            throw new Error(`assert-reg-name: unknown variable "${varName}"`);
          const regIdx = parseInt(regStr.slice(1), 10);
          const actual = ant0.regs[regIdx];
          if (list.length === 3) {
            const expected = Number(list[2].value);
            if (actual !== expected)
              failedAssertions.push(`assert-reg-name ${varName} (${regStr}) = ${expected}: got ${actual}`);
          } else if (list.length === 4) {
            const op = list[2].value, expected = Number(list[3].value);
            if (!evalOp(actual, op, expected))
              failedAssertions.push(`assert-reg-name ${varName} (${regStr}) ${op} ${expected}: got ${actual}`);
          } else {
            throw new Error("assert-reg-name: expected 2 or 3 args");
          }
          break;
        }

        case "assert-carrying":
          if (!ant0.carrying)
            failedAssertions.push("assert-carrying: ant is not carrying food");
          break;

        case "assert-not-carrying":
          if (ant0.carrying)
            failedAssertions.push("assert-not-carrying: ant is carrying food");
          break;

        case "assert-food-collected": {
          const actual = world.foodCollected;
          if (list.length === 2) {
            const expected = Number(list[1].value);
            if (actual !== expected)
              failedAssertions.push(`assert-food-collected = ${expected}: got ${actual}`);
          } else if (list.length === 3) {
            const op = list[1].value, expected = Number(list[2].value);
            if (!evalOp(actual, op, expected))
              failedAssertions.push(`assert-food-collected ${op} ${expected}: got ${actual}`);
          }
          break;
        }

        case "assert-tick": {
          const expected = Number(list[1].value);
          if (world.tick !== expected)
            failedAssertions.push(`assert-tick ${expected}: world is at tick ${world.tick}`);
          break;
        }

        case "assert-pc": {
          const expected = Number(list[1].value);
          if (ant0.pc !== expected)
            failedAssertions.push(`assert-pc ${expected}: ant pc is ${ant0.pc}`);
          break;
        }

        case "assert-at": {
          const ex = Number(list[1].value), ey = Number(list[2].value);
          if (ant0.x !== ex || ant0.y !== ey)
            failedAssertions.push(`assert-at ${ex} ${ey}: ant is at ${ant0.x} ${ant0.y}`);
          break;
        }

        default:
          throw new Error(`Unknown assertion: ${kind}`);
      }
    } catch (e) {
      failedAssertions.push(`${kind}: ERROR — ${e.message}`);
    }
  }

  // Check VM-level ASSERTEQ results
  if (ant0._assertions) {
    for (const a of ant0._assertions) {
      if (!a.passed) {
        failedAssertions.push(`assert (pc=${a.pc}): expected ${a.expected}, got ${a.actual}`);
      }
    }
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

function runUnitFile(filePath, verbose = false) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
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
    const result = runTestBlock(testDef, preamble, verbose);

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
      for (const msg of result.failedAssertions) console.log(`       FAIL: ${msg}`);
      if (result.regState) {
        console.log(`       regs: ${result.regState}`);
        console.log(`       ant: x=${result.ant?.x} y=${result.ant?.y} carrying=${result.ant?.carrying} pc=${result.ant?.pc}  food=${result.foodCollected}  tick=${result.worldTick}`);
      }
      if (verbose && result.asmSource) {
        console.log(`       compiled assembly:`);
        result.asmSource.split("\n").forEach(l => console.log("         " + l));
      }
      failed++;
    }
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// ─── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  let file = null, verbose = false;
  for (const arg of args) {
    if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (!arg.startsWith("-")) file = arg;
  }
  if (!file) {
    console.error("Usage: node antlisp.unit.js <tests.unit.alisp> [--verbose]");
    process.exit(1);
  }
  runUnitFile(file, verbose);
}

module.exports = { runUnitFile, parseUnitFile, runTestBlock };
