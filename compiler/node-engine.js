/**
 * node-engine.js — Standalone SWARM VM extracted from bundled Turbopack source.
 *
 * Pure Node.js, zero DOM dependencies.
 * Contains: constants, RNG, assembler, VM tick engine, map generators, and
 * a convenience `runSimulation()` harness.
 *
 * Usage:
 *   const { parseAssembly, compileBytecode, createWorld, runTick,
 *           generateEvalMaps, cloneMap, DEFAULT_CONFIG } = require('./node-engine');
 *
 *   const program  = parseAssembly(sourceCode);
 *   const bytecode = compileBytecode(program);
 *   const maps     = generateEvalMaps(128, 128, 42, 12);
 *   const world    = createWorld(cloneMap(maps[0]), program);
 *   for (let t = 0; t < 2000; t++) runTick(world);
 *   console.log(world.foodCollected, '/', maps[0].totalFood);
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const CellType = Object.freeze({ EMPTY: 0, WALL: 1, FOOD: 2, NEST: 3 });

const SenseTarget = Object.freeze({ FOOD: 0, WALL: 1, NEST: 2, ANT: 3, EMPTY: 4 });

const Opcode = Object.freeze({
  SENSE: 0, SMELL: 1, SNIFF: 2, PROBE: 3, CARRYING: 4,
  SET: 5, ADD: 6, SUB: 7, MOD: 8, MUL: 9, DIV: 10,
  AND: 11, OR: 12, XOR: 13, LSHIFT: 14, RSHIFT: 15,
  RANDOM: 16, MARK: 17,
  JMP: 18, CALL: 19, JEQ: 20, JNE: 21, JGT: 22, JLT: 23,
  MOVE: 24, PICKUP: 25, DROP: 26, ID: 27, NOP: 28, TAG: 29,
});

const BC_STRIDE = 5;
const DIR_DX = [0, 0, 1, 0, -1, 0];   // index: 0=unused, 1=N, 2=E, 3=S, 4=W, 5=HERE
const DIR_DY = [0, -1, 0, 1, 0, 0];
const DIR_HERE = 5;
const DIR_RANDOM = 6;
const NUM_PHEROMONE_CHANNELS = 4;
const NUM_REGISTERS = 8;
const EVAL_MAP_COUNT = 120;

const DEFAULT_CONFIG = Object.freeze({
  mapWidth: 128,
  mapHeight: 128,
  antCount: 200,
  maxTicks: 2000,
  pheromoneDecay: 0.97,
  maxOpsPerTick: 64,
  senseRange: 1,
});

// ═══════════════════════════════════════════════════════════════════════════════
// RNG  (SplitMix32 / Weyl-sequence hash)
// ═══════════════════════════════════════════════════════════════════════════════

class RNG {
  constructor(seed) {
    this.state = (seed | 0);
    if (this.state === 0) this.state = 1;
  }

  next() {
    let s = (this.state += 0x9E3779B9) | 0;
    s = Math.imul(s ^ (s >>> 16), 0x85EBCA6B);
    s = Math.imul(s ^ (s >>> 13), 0xC2B2AE35);
    return ((s ^ (s >>> 16)) >>> 0) / 0x100000000;
  }

  nextInt(max) {
    return (this.next() * max) | 0;
  }

  nextIntRange(lo, hi) {
    return lo + this.nextInt(hi - lo);
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSEMBLER  —  source text → program IR → Int32Array bytecode
// ═══════════════════════════════════════════════════════════════════════════════

class AssemblyError extends Error {
  constructor(line, msg) {
    super(`Line ${line}: ${msg}`);
    this.line = line;
  }
}

const DIRECTION_NAMES = {
  HERE: DIR_HERE,
  N: 1, E: 2, S: 3, W: 4,
  NORTH: 1, EAST: 2, SOUTH: 3, WEST: 4,
};

const SENSE_TARGET_NAMES = {
  FOOD: SenseTarget.FOOD,
  WALL: SenseTarget.WALL,
  NEST: SenseTarget.NEST,
  ANT:  SenseTarget.ANT,
  EMPTY: SenseTarget.EMPTY,
};

const CHANNEL_NAMES = { CH_RED: 0, CH_BLUE: 1, CH_GREEN: 2, CH_YELLOW: 3 };

const OPCODE_NAMES = {};
for (const [name, val] of Object.entries(Opcode)) {
  OPCODE_NAMES[name] = val;
}

/** Try to parse a token as a register reference (r0–r7). Returns index or null. */
function parseRegister(tok) {
  const m = /^[rR]([0-7])$/.exec(tok);
  return m ? parseInt(m[1]) : null;
}

/** Parse a generic operand — register, channel, direction, sense target, or integer literal. */
function parseOperand(tok) {
  const reg = parseRegister(tok);
  if (reg !== null) return { type: "reg", val: reg };

  const upper = tok.toUpperCase();

  const ch = CHANNEL_NAMES[upper];
  if (ch !== undefined) return { type: "lit", val: ch };

  const dir = DIRECTION_NAMES[upper];
  if (dir !== undefined) return { type: "lit", val: dir };

  if (upper === "RANDOM") return { type: "lit", val: DIR_RANDOM };

  const st = SENSE_TARGET_NAMES[upper];
  if (st !== undefined) return { type: "lit", val: st };

  const num = parseInt(tok, 10);
  if (!isNaN(num)) return { type: "lit", val: num };

  return null;
}

/** Parse a direction operand (stricter). */
function parseDirection(tok, lineNum) {
  const upper = tok.toUpperCase();
  if (upper === "RANDOM") return { type: "lit", val: DIR_RANDOM };
  const dir = DIRECTION_NAMES[upper];
  if (dir !== undefined) return { type: "lit", val: dir };
  const op = parseOperand(tok);
  if (op) return op;
  throw new AssemblyError(lineNum, `Invalid direction: "${tok}" (use N, E, S, W, RANDOM, or register)`);
}

/**
 * Parse assembly source into a program IR.
 * Returns { instructions, sourceLines, tagNames?, registerAliases? }
 */
function parseAssembly(source) {
  const lines = source.split("\n");
  const labels = new Map();
  const aliases = new Map();
  const consts = new Map();
  const tagNames = new Map();
  const rawInstructions = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const semi = line.indexOf(";");
    if (semi >= 0) line = line.substring(0, semi);
    line = line.trim();
    if (!line) continue;

    const firstTok = line.split(/\s+/)[0];

    // Directives
    if (firstTok.startsWith(".") && firstTok !== ".alias" && firstTok !== ".const" && firstTok !== ".tag") {
      throw new AssemblyError(i + 1, `Unknown directive: "${firstTok}"`);
    }

    if (firstTok === ".alias") {
      const parts = line.split(/\s+/);
      if (parts.length !== 3) throw new AssemblyError(i + 1, ".alias requires: .alias <name> <register>");
      const name = parts[1];
      if (parseRegister(parts[2]) === null) throw new AssemblyError(i + 1, `Expected register (r0-r7), got: "${parts[2]}"`);
      if (aliases.has(name) || consts.has(name)) throw new AssemblyError(i + 1, `"${name}" already defined`);
      aliases.set(name, parts[2]);
      continue;
    }

    if (firstTok === ".const") {
      const parts = line.split(/\s+/);
      if (parts.length !== 3) throw new AssemblyError(i + 1, ".const requires: .const <NAME> <value>");
      const name = parts[1];
      if (aliases.has(name) || consts.has(name)) throw new AssemblyError(i + 1, `"${name}" already defined`);
      consts.set(name, parts[2]);
      continue;
    }

    if (firstTok === ".tag") {
      const parts = line.split(/\s+/);
      if (parts.length < 3) throw new AssemblyError(i + 1, ".tag requires: .tag <number> <name>");
      const num = parseInt(parts[1], 10);
      if (isNaN(num) || num < 0 || num > 7) throw new AssemblyError(i + 1, `.tag number must be 0-7, got: "${parts[1]}"`);
      const name = parts[2];
      tagNames.set(num, parts.slice(2).join(" "));
      if (!aliases.has(name) && !consts.has(name)) consts.set(name, String(num));
      continue;
    }

    // Labels
    if (line.endsWith(":")) {
      const label = line.slice(0, -1).trim();
      if (!label || /\s/.test(label)) throw new AssemblyError(i + 1, `Invalid label: "${label}"`);
      if (labels.has(label)) throw new AssemblyError(i + 1, `Duplicate label: "${label}"`);
      labels.set(label, rawInstructions.length);
      continue;
    }

    // Instruction
    const tokens = line.split(/\s+/);
    for (let t = 1; t < tokens.length; t++) {
      tokens[t] = aliases.get(tokens[t]) ?? consts.get(tokens[t]) ?? tokens[t];
    }
    rawInstructions.push({ lineNum: i + 1, tokens });
  }

  // Parse each instruction into IR
  const instructions = rawInstructions.map(({ lineNum, tokens }) => {
    const mnemonic = tokens[0].toUpperCase();
    const op = OPCODE_NAMES[mnemonic];
    if (op === undefined) throw new AssemblyError(lineNum, `Unknown instruction: "${tokens[0]}"`);
    const args = tokens.slice(1);

    switch (op) {
      case Opcode.SENSE: {
        if (args.length < 1 || args.length > 2)
          throw new AssemblyError(lineNum, "SENSE requires 1-2 args: <target> [dest_reg]");
        const target = SENSE_TARGET_NAMES[args[0].toUpperCase()];
        if (target === undefined) throw new AssemblyError(lineNum, `Invalid sense target: "${args[0]}"`);
        let destReg = 0;
        if (args.length === 2) {
          destReg = parseRegister(args[1]);
          if (destReg === null) throw new AssemblyError(lineNum, `Expected register for destination, got: "${args[1]}"`);
        }
        return { op, operands: [{ type: "lit", val: target }, { type: "lit", val: destReg }] };
      }

      case Opcode.SMELL: {
        if (args.length < 1 || args.length > 2)
          throw new AssemblyError(lineNum, "SMELL requires 1-2 args: <channel> [dest_reg]");
        const ch = parseOperand(args[0]);
        if (!ch) throw new AssemblyError(lineNum, `Invalid channel: "${args[0]}"`);
        let destReg = 0;
        if (args.length === 2) {
          destReg = parseRegister(args[1]);
          if (destReg === null) throw new AssemblyError(lineNum, `Expected register for destination, got: "${args[1]}"`);
        }
        return { op, operands: [ch, { type: "lit", val: destReg }] };
      }

      case Opcode.SNIFF: {
        if (args.length < 2 || args.length > 3)
          throw new AssemblyError(lineNum, "SNIFF requires 2-3 args: <channel> <dir> [dest_reg]");
        const ch = parseOperand(args[0]);
        if (!ch) throw new AssemblyError(lineNum, `Invalid channel: "${args[0]}"`);
        const dir = parseDirection(args[1], lineNum);
        let destReg = 0;
        if (args.length === 3) {
          destReg = parseRegister(args[2]);
          if (destReg === null) throw new AssemblyError(lineNum, `Expected register for destination, got: "${args[2]}"`);
        }
        return { op, operands: [ch, dir, { type: "lit", val: destReg }] };
      }

      case Opcode.PROBE: {
        if (args.length < 1 || args.length > 2)
          throw new AssemblyError(lineNum, "PROBE requires 1-2 args: <dir> [dest_reg]");
        const dir = parseDirection(args[0], lineNum);
        let destReg = 0;
        if (args.length === 2) {
          destReg = parseRegister(args[1]);
          if (destReg === null) throw new AssemblyError(lineNum, `Expected register for destination, got: "${args[1]}"`);
        }
        return { op, operands: [dir, { type: "lit", val: destReg }] };
      }

      case Opcode.CARRYING: {
        if (args.length > 1) throw new AssemblyError(lineNum, "CARRYING takes 0-1 args: [dest_reg]");
        let destReg = 0;
        if (args.length === 1) {
          destReg = parseRegister(args[0]);
          if (destReg === null) throw new AssemblyError(lineNum, `Expected register for destination, got: "${args[0]}"`);
        }
        return { op, operands: [{ type: "lit", val: destReg }] };
      }

      case Opcode.ID: {
        if (args.length > 1) throw new AssemblyError(lineNum, "ID takes 0-1 args: [dest_reg]");
        let destReg = 0;
        if (args.length === 1) {
          destReg = parseRegister(args[0]);
          if (destReg === null) throw new AssemblyError(lineNum, `Expected register for destination, got: "${args[0]}"`);
        }
        return { op, operands: [{ type: "lit", val: destReg }] };
      }

      case Opcode.PICKUP:
      case Opcode.DROP:
      case Opcode.NOP:
        if (args.length !== 0) throw new AssemblyError(lineNum, `${mnemonic} takes no arguments`);
        return { op, operands: [] };

      case Opcode.MOVE:
        if (args.length !== 1) throw new AssemblyError(lineNum, "MOVE requires 1 arg: N, E, S, W, or register");
        return { op, operands: [parseDirection(args[0], lineNum)] };

      case Opcode.SET:
      case Opcode.ADD:
      case Opcode.SUB:
      case Opcode.MOD:
      case Opcode.MUL:
      case Opcode.DIV:
      case Opcode.AND:
      case Opcode.OR:
      case Opcode.XOR:
      case Opcode.LSHIFT:
      case Opcode.RSHIFT: {
        if (args.length !== 2) throw new AssemblyError(lineNum, `${mnemonic} requires 2 args: <reg> <val>`);
        const reg = parseRegister(args[0]);
        if (reg === null) throw new AssemblyError(lineNum, `Expected register, got: "${args[0]}"`);
        const val = parseOperand(args[1]);
        if (!val) throw new AssemblyError(lineNum, `Invalid value: "${args[1]}"`);
        return { op, operands: [{ type: "lit", val: reg }, val] };
      }

      case Opcode.RANDOM: {
        if (args.length !== 2) throw new AssemblyError(lineNum, "RANDOM requires 2 args: <reg> <max>");
        const reg = parseRegister(args[0]);
        if (reg === null) throw new AssemblyError(lineNum, `Expected register, got: "${args[0]}"`);
        const maxVal = parseOperand(args[1]);
        if (!maxVal) throw new AssemblyError(lineNum, `Invalid max: "${args[1]}"`);
        return { op, operands: [{ type: "lit", val: reg }, maxVal] };
      }

      case Opcode.MARK: {
        if (args.length !== 2) throw new AssemblyError(lineNum, "MARK requires 2 args: <channel> <intensity>");
        const ch = parseOperand(args[0]);
        const intensity = parseOperand(args[1]);
        if (!ch) throw new AssemblyError(lineNum, `Invalid channel: "${args[0]}"`);
        if (!intensity) throw new AssemblyError(lineNum, `Invalid intensity: "${args[1]}"`);
        return { op, operands: [ch, intensity] };
      }

      case Opcode.JMP: {
        if (args.length !== 1) throw new AssemblyError(lineNum, "JMP requires 1 arg: <label> or <register>");
        const reg = parseRegister(args[0]);
        if (reg !== null) return { op, operands: [{ type: "reg", val: reg }] };
        const target = labels.get(args[0]);
        if (target === undefined) throw new AssemblyError(lineNum, `Unknown label: "${args[0]}"`);
        return { op, operands: [{ type: "lit", val: target }] };
      }

      case Opcode.CALL: {
        if (args.length !== 2) throw new AssemblyError(lineNum, "CALL requires 2 args: <reg> <label>");
        const reg = parseRegister(args[0]);
        if (reg === null) throw new AssemblyError(lineNum, `Expected register, got: "${args[0]}"`);
        const target = labels.get(args[1]);
        if (target === undefined) throw new AssemblyError(lineNum, `Unknown label: "${args[1]}"`);
        return { op, operands: [{ type: "lit", val: reg }, { type: "lit", val: target }] };
      }

      case Opcode.JEQ:
      case Opcode.JNE:
      case Opcode.JGT:
      case Opcode.JLT: {
        if (args.length !== 3) throw new AssemblyError(lineNum, `${mnemonic} requires 3 args: <val> <val> <label>`);
        const a = parseOperand(args[0]);
        const b = parseOperand(args[1]);
        if (!a) throw new AssemblyError(lineNum, `Invalid operand: "${args[0]}"`);
        if (!b) throw new AssemblyError(lineNum, `Invalid operand: "${args[1]}"`);
        const target = labels.get(args[2]);
        if (target === undefined) throw new AssemblyError(lineNum, `Unknown label: "${args[2]}"`);
        return { op, operands: [a, b, { type: "lit", val: target }] };
      }

      case Opcode.TAG: {
        if (args.length !== 1) throw new AssemblyError(lineNum, "TAG requires 1 arg: <value> or <register>");
        const val = parseOperand(args[0]);
        if (!val) throw new AssemblyError(lineNum, `Invalid TAG value: "${args[0]}"`);
        return { op, operands: [val] };
      }

      default:
        throw new AssemblyError(lineNum, `Unhandled opcode: ${mnemonic}`);
    }
  });

  if (instructions.length === 0) throw new AssemblyError(0, "Program is empty");

  const sourceLines = rawInstructions.map(({ lineNum }) => lineNum);

  // If there's a `main:` label that isn't at position 0, prepend a JMP to it
  const mainLabel = labels.get("main");
  if (mainLabel !== undefined && mainLabel !== 0) {
    const jmpMain = { op: Opcode.JMP, operands: [{ type: "lit", val: mainLabel + 1 }] };
    // Adjust all jump targets by +1
    for (const instr of instructions) {
      if (instr.op === Opcode.JMP && instr.operands[0].type === "lit") {
        instr.operands[0].val++;
      } else if (instr.op === Opcode.CALL) {
        instr.operands[1].val++;
      } else if (instr.op === Opcode.JEQ || instr.op === Opcode.JNE ||
                 instr.op === Opcode.JGT || instr.op === Opcode.JLT) {
        instr.operands[2].val++;
      }
    }
    instructions.unshift(jmpMain);
    sourceLines.unshift(0);
  }

  // Build register alias reverse-map
  const registerAliases = new Map();
  for (const [name, regStr] of aliases) {
    const idx = parseRegister(regStr);
    if (idx !== null && !registerAliases.has(idx)) registerAliases.set(idx, name);
  }

  return {
    instructions,
    sourceLines,
    tagNames: tagNames.size > 0 ? tagNames : undefined,
    registerAliases: registerAliases.size > 0 ? registerAliases : undefined,
  };
}

/**
 * Compile a program IR to a flat Int32Array bytecode buffer.
 * Layout per instruction: [opcode, regFlags, operand0, operand1, operand2]
 */
function compileBytecode(program) {
  const instrs = program.instructions;
  const buf = new Int32Array(instrs.length * BC_STRIDE);
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i];
    const base = i * BC_STRIDE;
    buf[base] = instr.op;
    let regFlags = 0;
    const ops = instr.operands;
    for (let j = 0; j < ops.length && j < 3; j++) {
      if (ops[j].type === "reg") regFlags |= (1 << j);
      buf[base + 2 + j] = ops[j].val;
    }
    buf[base + 1] = regFlags;
  }
  return buf;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VM  —  world state, ant stepping, tick execution
// ═══════════════════════════════════════════════════════════════════════════════

// Scratch arrays for SENSE and SMELL (shared across all stepAnt calls within a tick)
const _senseBuf = new Int32Array(32);
const _smellBuf = new Int32Array(32);

// Pheromone tracking globals (set per-tick by runTick)
let _pheroActive = null;
let _pheroList = null;
let _pheroListLen = 0;

// Shared RNG instance (re-seeded per tick from world.rngState)
const _tickRng = new RNG(1);

/**
 * Execute one ant's turn (up to maxOps instructions or one action).
 * Returns true if the ant successfully dropped food at the nest.
 */
function stepAnt(ant, antIndex, bytecode, instrCount, map, _unused, rng, maxOps, antGrid, senseRange = 1, stopAtPc = -1) {
  ant._stalled = false;
  if (instrCount === 0) return false;

  const mapW = map.width;
  const mapH = map.height;
  const cells = map.cells;
  const food = map.food;
  const pheromones = map.pheromones;
  const regs = ant.regs;
  let opsUsed = 0;
  let pc = ant.pc;

  while (opsUsed < maxOps) {
    if (pc >= instrCount) pc = 0;
    if (stopAtPc >= 0 && pc === stopAtPc && opsUsed > 0) { ant.pc = pc; return false; }

    const base = pc * BC_STRIDE;
    const op = bytecode[base];
    const flags = bytecode[base + 1];
    const a0 = bytecode[base + 2];
    const a1 = bytecode[base + 3];
    const a2 = bytecode[base + 4];

    opsUsed++;

    switch (op) {
      // ─── Sensing ───────────────────────────────────────────────────────
      case Opcode.SENSE: {
        let count = 0;
        const ax = ant.x, ay = ant.y;
        for (let dir = 1; dir <= 4; dir++) {
          const nx = ax + DIR_DX[dir];
          const ny = ay + DIR_DY[dir];
          if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) {
            if (a0 === SenseTarget.WALL) _senseBuf[count++] = dir;
            continue;
          }
          const idx = ny * mapW + nx;
          let match = false;
          switch (a0) {
            case SenseTarget.FOOD:  match = food[idx] > 0; break;
            case SenseTarget.WALL:  match = cells[idx] === CellType.WALL; break;
            case SenseTarget.NEST:  match = cells[idx] === CellType.NEST; break;
            case SenseTarget.EMPTY: match = cells[idx] !== CellType.WALL; break;
            case SenseTarget.ANT:   match = antGrid[idx] > 0; break;
          }
          if (match) _senseBuf[count++] = dir;
        }
        if (count === 0)      regs[a1] = 0;
        else if (count === 1) regs[a1] = _senseBuf[0];
        else                  regs[a1] = _senseBuf[rng.nextInt(count)];
        pc++;
        break;
      }

      case Opcode.SMELL: {
        const channel = (flags & 1) ? regs[a0] : a0;
        const ch = channel < 0 ? 0 : channel >= NUM_PHEROMONE_CHANNELS ? NUM_PHEROMONE_CHANNELS - 1 : channel;
        const ax = ant.x, ay = ant.y;
        const pN = ay > 0     ? pheromones[((ay - 1) * mapW + ax) * NUM_PHEROMONE_CHANNELS + ch] : 0;
        const pE = ax < mapW - 1 ? pheromones[(ay * mapW + ax + 1) * NUM_PHEROMONE_CHANNELS + ch] : 0;
        const pS = ay < mapH - 1 ? pheromones[((ay + 1) * mapW + ax) * NUM_PHEROMONE_CHANNELS + ch] : 0;
        const pW = ax > 0     ? pheromones[(ay * mapW + ax - 1) * NUM_PHEROMONE_CHANNELS + ch] : 0;

        let best = 0, nBest = 0;
        if (pN > 0)            { best = pN; nBest = 0; _smellBuf[nBest++] = 1; }
        if (pN === best && pN > 0 && nBest === 0) { _smellBuf[nBest++] = 1; } // handled above
        if (pE > best)         { best = pE; nBest = 0; _smellBuf[nBest++] = 2; }
        else if (pE === best && pE > 0) { _smellBuf[nBest++] = 2; }
        if (pS > best)         { best = pS; nBest = 0; _smellBuf[nBest++] = 3; }
        else if (pS === best && pS > 0) { _smellBuf[nBest++] = 3; }
        if (pW > best)         { best = pW; nBest = 0; _smellBuf[nBest++] = 4; }
        else if (pW === best && pW > 0) { _smellBuf[nBest++] = 4; }

        if (nBest === 0)      regs[a1] = 0;
        else if (nBest === 1) regs[a1] = _smellBuf[0];
        else                  regs[a1] = _smellBuf[rng.nextInt(nBest)];
        pc++;
        break;
      }

      case Opcode.SNIFF: {
        const channel = (flags & 1) ? regs[a0] : a0;
        const ch = channel < 0 ? 0 : channel >= NUM_PHEROMONE_CHANNELS ? NUM_PHEROMONE_CHANNELS - 1 : channel;
        const dir = (flags & 2) ? regs[a1] : a1;
        if (dir < 0 || dir > DIR_HERE) {
          regs[a2] = 0;
        } else {
          const nx = ant.x + DIR_DX[dir];
          const ny = ant.y + DIR_DY[dir];
          if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) {
            regs[a2] = 0;
          } else {
            regs[a2] = pheromones[(ny * mapW + nx) * NUM_PHEROMONE_CHANNELS + ch];
          }
        }
        pc++;
        break;
      }

      case Opcode.PROBE: {
        let dir = (flags & 1) ? regs[a0] : a0;
        if (dir === DIR_RANDOM) dir = rng.nextInt(4) + 1;
        if (dir < 0 || dir > DIR_HERE) {
          regs[a1] = 0;
        } else {
          const nx = ant.x + DIR_DX[dir];
          const ny = ant.y + DIR_DY[dir];
          if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) {
            regs[a1] = CellType.WALL;
          } else {
            const idx = ny * mapW + nx;
            const c = cells[idx];
            if (c === CellType.WALL)       regs[a1] = CellType.WALL;
            else if (food[idx] > 0)        regs[a1] = CellType.FOOD;
            else if (c === CellType.NEST)   regs[a1] = CellType.NEST;
            else                            regs[a1] = CellType.EMPTY;
          }
        }
        pc++;
        break;
      }

      case Opcode.CARRYING:
        regs[a0] = ant.carrying ? 1 : 0;
        pc++;
        break;

      // ─── Arithmetic / Logic ────────────────────────────────────────────
      case Opcode.SET:    regs[a0] = (flags & 2) ? regs[a1] : a1; pc++; break;
      case Opcode.ADD:    regs[a0] = (regs[a0] + ((flags & 2) ? regs[a1] : a1)) | 0; pc++; break;
      case Opcode.SUB:    regs[a0] = (regs[a0] - ((flags & 2) ? regs[a1] : a1)) | 0; pc++; break;
      case Opcode.MOD:    { const v = (flags & 2) ? regs[a1] : a1; if (v !== 0) regs[a0] = ((regs[a0] % v) + v) % v; pc++; break; }
      case Opcode.MUL:    regs[a0] = (regs[a0] * ((flags & 2) ? regs[a1] : a1)) | 0; pc++; break;
      case Opcode.DIV:    { const v = (flags & 2) ? regs[a1] : a1; if (v !== 0) regs[a0] = (regs[a0] / v) | 0; pc++; break; }
      case Opcode.AND:    regs[a0] = regs[a0] & ((flags & 2) ? regs[a1] : a1); pc++; break;
      case Opcode.OR:     regs[a0] = regs[a0] | ((flags & 2) ? regs[a1] : a1); pc++; break;
      case Opcode.XOR:    regs[a0] = regs[a0] ^ ((flags & 2) ? regs[a1] : a1); pc++; break;
      case Opcode.LSHIFT: regs[a0] = regs[a0] << ((flags & 2) ? regs[a1] : a1); pc++; break;
      case Opcode.RSHIFT: regs[a0] = regs[a0] >> ((flags & 2) ? regs[a1] : a1); pc++; break;

      case Opcode.RANDOM: {
        const max = (flags & 2) ? regs[a1] : a1;
        regs[a0] = max > 0 ? rng.nextInt(max) : 0;
        pc++;
        break;
      }

      // ─── Pheromones ────────────────────────────────────────────────────
      case Opcode.MARK: {
        const channel = (flags & 1) ? regs[a0] : a0;
        const ch = channel < 0 ? 0 : channel >= NUM_PHEROMONE_CHANNELS ? NUM_PHEROMONE_CHANNELS - 1 : channel;
        const rawAmount = (flags & 2) ? regs[a1] : a1;
        const amount = rawAmount < 0 ? 0 : rawAmount > 255 ? 255 : rawAmount;
        const cellIdx = ant.y * mapW + ant.x;
        const pheroIdx = cellIdx * NUM_PHEROMONE_CHANNELS + ch;
        const newVal = pheromones[pheroIdx] + amount;
        pheromones[pheroIdx] = newVal > 255 ? 255 : newVal;
        if (amount > 0 && _pheroActive !== null && !_pheroActive[cellIdx]) {
          _pheroActive[cellIdx] = 1;
          _pheroList[_pheroListLen++] = cellIdx;
        }
        pc++;
        break;
      }

      // ─── Control Flow ──────────────────────────────────────────────────
      case Opcode.JMP:
        pc = (flags & 1) ? regs[a0] : a0;
        break;

      case Opcode.CALL:
        regs[a0] = pc + 1;
        pc = a1;
        break;

      case Opcode.JEQ:
        pc = ((flags & 1) ? regs[a0] : a0) === ((flags & 2) ? regs[a1] : a1) ? a2 : pc + 1;
        break;

      case Opcode.JNE:
        pc = ((flags & 1) ? regs[a0] : a0) !== ((flags & 2) ? regs[a1] : a1) ? a2 : pc + 1;
        break;

      case Opcode.JGT:
        pc = ((flags & 1) ? regs[a0] : a0) > ((flags & 2) ? regs[a1] : a1) ? a2 : pc + 1;
        break;

      case Opcode.JLT:
        pc = ((flags & 1) ? regs[a0] : a0) < ((flags & 2) ? regs[a1] : a1) ? a2 : pc + 1;
        break;

      // ─── Actions (end tick) ────────────────────────────────────────────
      case Opcode.MOVE: {
        let dir = (flags & 1) ? regs[a0] : a0;
        if (dir === DIR_RANDOM) dir = rng.nextInt(4) + 1;
        if (dir >= 1 && dir <= 4) {
          const nx = ant.x + DIR_DX[dir];
          const ny = ant.y + DIR_DY[dir];
          if (nx >= 0 && nx < mapW && ny >= 0 && ny < mapH && cells[ny * mapW + nx] !== CellType.WALL) {
            antGrid[ant.y * mapW + ant.x]--;
            antGrid[ny * mapW + nx]++;
            ant.x = nx;
            ant.y = ny;
          }
        }
        ant.pc = ++pc;
        return false;
      }

      case Opcode.PICKUP:
        if (!ant.carrying) {
          const idx = ant.y * mapW + ant.x;
          if (food[idx] > 0) { food[idx]--; ant.carrying = true; }
        }
        ant.pc = ++pc;
        return false;

      case Opcode.DROP:
        if (ant.carrying) {
          ant.carrying = false;
          const idx = ant.y * mapW + ant.x;
          if (cells[idx] === CellType.NEST) {
            ant.pc = ++pc;
            return true;  // food delivered!
          }
          food[idx]++;
        }
        ant.pc = ++pc;
        return false;

      // ─── Misc ──────────────────────────────────────────────────────────
      case Opcode.ID:
        regs[a0] = antIndex;
        pc++;
        break;

      case Opcode.NOP:
        pc++;
        break;

      case Opcode.TAG: {
        const val = (flags & 1) ? regs[a0] : a0;
        ant.tag = val < 0 ? 0 : val > 7 ? (val & 7) : val;
        opsUsed--;  // TAG doesn't count against op budget
        pc++;
        break;
      }
    }
  }

  // Op-limit stall: exhausted maxOps without executing an action (MOVE/PICKUP/DROP)
  ant._stalled = true;
  ant._stalledOps = opsUsed;
  ant.pc = pc;
  return false;
}

/**
 * Decay pheromones. Uses the active-cell list for efficiency.
 * Returns the new pheroListLen.
 */
function decayPheromones(map, pheroList, pheroActive, listLen) {
  const pheromones = map.pheromones;
  let writeIdx = 0;
  for (let i = 0; i < listLen; i++) {
    const cellIdx = pheroList[i];
    if (!pheroActive[cellIdx]) continue;
    const base = cellIdx * NUM_PHEROMONE_CHANNELS;
    let anyAlive = false;
    for (let ch = 0; ch < NUM_PHEROMONE_CHANNELS; ch++) {
      const val = pheromones[base + ch];
      if (val > 0) {
        pheromones[base + ch] = val - 1;
        if (val > 1) anyAlive = true;
      }
    }
    if (anyAlive) {
      pheroList[writeIdx++] = cellIdx;
    } else {
      pheroActive[cellIdx] = 0;
    }
  }
  return writeIdx;
}

/**
 * Create a world state from a map and a parsed program.
 */
function createWorld(map, program, config = DEFAULT_CONFIG) {
  const rng = new RNG(map.seed);
  const ants = [];
  for (let i = 0; i < config.antCount; i++) {
    ants.push({
      x: map.nestX,
      y: map.nestY,
      carrying: false,
      regs: Array(NUM_REGISTERS).fill(0),
      pc: 0,
      tag: 0,
    });
  }
  const totalCells = map.width * map.height;

  // Build initial ant grid
  const antGrid = new Uint8Array(totalCells);
  for (const ant of ants) antGrid[ant.y * map.width + ant.x]++;

  return {
    map,
    ants,
    tick: 0,
    foodCollected: 0,
    program,
    bytecode: compileBytecode(program),
    antGrid,
    rngState: rng.state,
    pheroActive: new Uint8Array(totalCells),
    pheroList: new Uint32Array(totalCells),
    pheroListLen: 0,
  };
}

/**
 * Run one tick of the simulation: step all ants, then decay pheromones.
 */
function runTick(world, config = DEFAULT_CONFIG) {
  const { map, ants, bytecode, antGrid } = world;
  const instrCount = world.program.instructions.length;

  // Restore RNG and pheromone tracking state
  _tickRng.state = world.rngState;
  _pheroActive = world.pheroActive;
  _pheroList = world.pheroList;
  _pheroListLen = world.pheroListLen;

  let stallCount = 0;
  for (let i = 0; i < ants.length; i++) {
    const ant = ants[i];
    const pcBefore = ant.pc;
    const delivered = stepAnt(ant, i, bytecode, instrCount, map, 0, _tickRng, config.maxOpsPerTick, antGrid, config.senseRange);
    if (delivered) world.foodCollected++;
    map.visitCounts[ant.y * map.width + ant.x]++;

    // Detect op-limit stall: stepAnt exhausted maxOps without executing an action
    if (ant._stalled) {
      stallCount++;
      // Track stalls by tag
      if (!world.stallsByTag) world.stallsByTag = {};
      const tag = ant.tag;
      world.stallsByTag[tag] = (world.stallsByTag[tag] || 0) + 1;
    }
  }

  if (!world.stallCounts) world.stallCounts = 0;
  world.stallCounts += stallCount;

  world.pheroListLen = decayPheromones(map, world.pheroList, world.pheroActive, _pheroListLen);
  world.rngState = _tickRng.state;
  world.tick++;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAP UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Deep-clone a map (cells, food, pheromones, visitCounts). */
function cloneMap(map) {
  return {
    ...map,
    cells: new Uint8Array(map.cells),
    food: new Uint16Array(map.food),
    pheromones: new Uint16Array(map.pheromones),
    visitCounts: new Uint32Array(map.visitCounts),
  };
}

/** Create a blank map. */
function createEmptyMap(width, height, seed, name) {
  const area = width * height;
  return {
    width,
    height,
    cells: new Uint8Array(area),
    food: new Uint16Array(area),
    pheromones: new Uint16Array(area * NUM_PHEROMONE_CHANNELS),
    visitCounts: new Uint32Array(area),
    nestX: Math.floor(width / 2),
    nestY: Math.floor(height / 2),
    totalFood: 0,
    seed,
    name,
  };
}

/** Cell index from (x, y). */
function cellIndex(map, x, y) {
  return y * map.width + x;
}

/** Set a cell's type. */
function setCell(map, x, y, type) {
  map.cells[cellIndex(map, x, y)] = type;
}

/** Place food at a cell (only if currently EMPTY). */
function placeFood(map, x, y, amount) {
  const idx = cellIndex(map, x, y);
  if (map.cells[idx] === CellType.EMPTY) {
    map.cells[idx] = CellType.FOOD;
    map.food[idx] = amount;
    map.totalFood += amount;
  }
}

/** Add walls around the map border. */
function addBorderWalls(map) {
  for (let x = 0; x < map.width; x++) {
    setCell(map, x, 0, CellType.WALL);
    setCell(map, x, map.height - 1, CellType.WALL);
  }
  for (let y = 0; y < map.height; y++) {
    setCell(map, 0, y, CellType.WALL);
    setCell(map, map.width - 1, y, CellType.WALL);
  }
}

/** Place a 3×3 nest centered at map.nestX, map.nestY. */
function placeNest(map) {
  const cx = map.nestX, cy = map.nestY;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && nx < map.width && ny >= 0 && ny < map.height) {
        setCell(map, nx, ny, CellType.NEST);
      }
    }
  }
}

/** Euclidean distance. */
function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

/** Is (x, y) inside the map (excluding border)? */
function inBounds(map, x, y) {
  return x > 0 && x < map.width - 1 && y > 0 && y < map.height - 1;
}

/** Randomize nest position with a margin. */
function randomizeNest(map, rng, margin) {
  const m = margin ?? Math.floor(0.15 * Math.min(map.width, map.height));
  map.nestX = m + rng.nextInt(map.width - 2 * m);
  map.nestY = m + rng.nextInt(map.height - 2 * m);
}

/**
 * Ensure all food is reachable from the nest by carving paths through walls.
 * BFS from nest to find reachable cells, then BFS from each unreachable food
 * cluster toward the reachable set, carving a path.
 */
function ensureFoodReachable(map) {
  const W = map.width, H = map.height;
  const reachable = new Uint8Array(W * H);
  const queue = [map.nestX, map.nestY];
  reachable[map.nestY * W + map.nestX] = 1;
  let qi = 0;

  while (qi < queue.length) {
    const qx = queue[qi++];
    const qy = queue[qi++];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = qx + dx, ny = qy + dy;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
      const ni = ny * W + nx;
      if (reachable[ni] || map.cells[ni] === CellType.WALL) continue;
      reachable[ni] = 1;
      queue.push(nx, ny);
    }
  }

  for (let idx = 0; idx < W * H; idx++) {
    if (map.cells[idx] === CellType.FOOD && !reachable[idx]) {
      const fy = Math.floor(idx / W);
      const fx = idx % W;
      const visited = new Uint8Array(W * H);
      const parent = new Int32Array(W * H).fill(-1);
      const bfs = [fx, fy];
      visited[idx] = 1;
      let target = -1;
      let bi = 0;

      while (bi < bfs.length && target < 0) {
        const bx = bfs[bi++];
        const by = bfs[bi++];
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
          const nx = bx + dx, ny = by + dy;
          if (nx < 1 || nx >= W - 1 || ny < 1 || ny >= H - 1) continue;
          const ni = ny * W + nx;
          if (visited[ni]) continue;
          visited[ni] = 1;
          parent[ni] = by * W + bx;
          if (reachable[ni]) { target = ni; break; }
          bfs.push(nx, ny);
        }
      }

      if (target >= 0) {
        let cur = target;
        while (cur >= 0) {
          if (map.cells[cur] === CellType.WALL) map.cells[cur] = CellType.EMPTY;
          reachable[cur] = 1;
          cur = parent[cur];
        }
      }
    }
  }
}

/**
 * Randomly mirror/transpose a square map for variety.
 */
function randomSymmetry(map, rng) {
  if (map.width !== map.height) return;
  const size = map.width;
  const flipH = rng.nextInt(2) === 1;
  const flipV = rng.nextInt(2) === 1;
  const transpose = rng.nextInt(2) === 1;
  if (!flipH && !flipV && !transpose) return;

  const newCells = new Uint8Array(size * size);
  const newFood = new Uint16Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tx = flipH ? size - 1 - x : x;
      let ty = flipV ? size - 1 - y : y;
      if (transpose) { const tmp = tx; tx = ty; ty = tmp; }
      newCells[ty * size + tx] = map.cells[y * size + x];
      newFood[ty * size + tx] = map.food[y * size + x];
    }
  }
  map.cells.set(newCells);
  map.food.set(newFood);

  let nx = flipH ? size - 1 - map.nestX : map.nestX;
  let ny = flipV ? size - 1 - map.nestY : map.nestY;
  if (transpose) { const tmp = nx; nx = ny; ny = tmp; }
  map.nestX = nx;
  map.nestY = ny;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAP GENERATORS
// ═══════════════════════════════════════════════════════════════════════════════

const MAP_GENERATORS = {

  open(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `open-${seed}`);
    const rng = new RNG(seed);
    const scale = width / 128;
    addBorderWalls(map);
    randomizeNest(map, rng);
    placeNest(map);
    const numClusters = 5 + rng.nextInt(4);
    for (let i = 0; i < numClusters; i++) {
      const cx = 4 + rng.nextInt(width - 8);
      const cy = 4 + rng.nextInt(height - 8);
      if (dist(cx, cy, map.nestX, map.nestY) < 15 * scale) continue;
      const radius = 3 + rng.nextInt(3);
      const amount = 2 + rng.nextInt(3);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const px = cx + dx, py = cy + dy;
          if (inBounds(map, px, py)) placeFood(map, px, py, amount);
        }
      }
    }
    return map;
  },

  maze(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `maze-${seed}`);
    const rng = new RNG(seed);
    const scale = width / 128;
    addBorderWalls(map);
    // Fill interior with walls
    for (let y = 1; y < height - 1; y++)
      for (let x = 1; x < width - 1; x++)
        setCell(map, x, y, CellType.WALL);

    const cellsW = Math.floor((width - 2) / 4);
    const cellsH = Math.floor((height - 2) / 4);
    const visited = new Uint8Array(cellsW * cellsH);
    const stack = [];

    function cellCorner(cx, cy) { return [1 + 4 * cx + 1, 1 + 4 * cy + 1]; }

    function carveCell(cx, cy) {
      const [sx, sy] = cellCorner(cx, cy);
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++)
          if (sx + dx < width - 1 && sy + dy < height - 1)
            setCell(map, sx + dx, sy + dy, CellType.EMPTY);
      visited[cy * cellsW + cx] = 1;
    }

    function carveBetween(x1, y1, x2, y2) {
      const [sx1, sy1] = cellCorner(x1, y1);
      const [sx2, sy2] = cellCorner(x2, y2);
      const minX = Math.min(sx1, sx2), minY = Math.min(sy1, sy2);
      const maxX = Math.max(sx1, sx2) + 1, maxY = Math.max(sy1, sy2) + 1;
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++)
          if (x > 0 && x < width - 1 && y > 0 && y < height - 1)
            setCell(map, x, y, CellType.EMPTY);
    }

    // DFS maze generation
    const startX = Math.floor(cellsW / 2), startY = Math.floor(cellsH / 2);
    carveCell(startX, startY);
    stack.push(startX, startY);
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];

    while (stack.length > 0) {
      const cy = stack[stack.length - 1];
      const cx = stack[stack.length - 2];
      const neighbors = [];
      for (let d = 0; d < 4; d++) {
        const nx = cx + dirs[d][0], ny = cy + dirs[d][1];
        if (nx >= 0 && nx < cellsW && ny >= 0 && ny < cellsH && !visited[ny * cellsW + nx])
          neighbors.push(d);
      }
      if (neighbors.length === 0) { stack.length -= 2; continue; }
      const dir = neighbors[rng.nextInt(neighbors.length)];
      const nx = cx + dirs[dir][0], ny = cy + dirs[dir][1];
      carveBetween(cx, cy, nx, ny);
      carveCell(nx, ny);
      stack.push(nx, ny);
    }

    // Random extra passages
    for (let cy = 0; cy < cellsH; cy++) {
      for (let cx = 0; cx < cellsW; cx++) {
        if (!visited[cy * cellsW + cx]) continue;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= cellsW || ny >= cellsH) continue;
          if (!visited[ny * cellsW + nx]) continue;
          if (rng.next() < 0.25) carveBetween(cx, cy, nx, ny);
        }
      }
    }

    // Place nest
    for (let attempt = 0; attempt < 100; attempt++) {
      const nx = 4 + rng.nextInt(width - 8);
      const ny = 4 + rng.nextInt(height - 8);
      if (map.cells[cellIndex(map, nx, ny)] === CellType.EMPTY) {
        map.nestX = nx; map.nestY = ny;
        break;
      }
    }
    placeNest(map);

    // Place food clusters
    const numClusters = 16 + rng.nextInt(7);
    for (let i = 0; i < numClusters; i++) {
      for (let attempt = 0; attempt < 50; attempt++) {
        const fx = 2 + rng.nextInt(width - 4);
        const fy = 2 + rng.nextInt(height - 4);
        if (map.cells[cellIndex(map, fx, fy)] === CellType.EMPTY &&
            dist(fx, fy, map.nestX, map.nestY) > 12 * scale) {
          const radius = 1 + rng.nextInt(3);
          const amount = 3 + rng.nextInt(6);
          for (let dy = -radius; dy <= radius; dy++)
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx * dx + dy * dy > radius * radius) continue;
              if (inBounds(map, fx + dx, fy + dy) &&
                  map.cells[cellIndex(map, fx + dx, fy + dy)] === CellType.EMPTY)
                placeFood(map, fx + dx, fy + dy, amount);
            }
          break;
        }
      }
    }
    ensureFoodReachable(map);
    return map;
  },

  spiral(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `spiral-${seed}`);
    const rng = new RNG(seed);
    addBorderWalls(map);
    placeNest(map);
    const cx = width / 2, cy = height / 2;
    const maxR = Math.min(width, height) / 2 - 2;
    const ringSpacing = Math.max(5, Math.floor(0.06 * width));

    for (let r = ringSpacing + 2; r < maxR; r += ringSpacing) {
      const gapAngle = rng.next() * Math.PI * 2;
      const gapWidth = 0.6 + 0.4 * rng.next();
      const wobbleFreq = 2 + rng.nextInt(3);
      const wobbleAmp = 1 + 1.5 * rng.next();
      const wobblePhase = rng.next() * Math.PI * 2;
      for (let a = 0; a < 2 * Math.PI; a += 0.02) {
        const distFromGap = Math.abs(((a - gapAngle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
        if (distFromGap < gapWidth) continue;
        const wobble = wobbleAmp * Math.min(1, (distFromGap - gapWidth) / 0.5) * Math.sin(a * wobbleFreq + wobblePhase);
        const effectiveR = r + wobble;
        const px = Math.floor(cx + Math.cos(a) * effectiveR);
        const py = Math.floor(cy + Math.sin(a) * effectiveR);
        if (inBounds(map, px, py)) setCell(map, px, py, CellType.WALL);
      }
    }

    // Place food between rings
    for (let r = ringSpacing; r < maxR; r += ringSpacing) {
      const foodR = r + ringSpacing / 2;
      const numClusters = 3 + rng.nextInt(3);
      for (let i = 0; i < numClusters; i++) {
        const angle = rng.next() * Math.PI * 2;
        const fr = foodR + (rng.next() - 0.5) * (0.3 * ringSpacing);
        const fx = Math.floor(cx + Math.cos(angle) * fr);
        const fy = Math.floor(cy + Math.sin(angle) * fr);
        const radius = 1 + rng.nextInt(2);
        const amount = 3 + rng.nextInt(3);
        for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const px = fx + dx, py = fy + dy;
            if (inBounds(map, px, py)) placeFood(map, px, py, amount);
          }
      }
    }
    ensureFoodReachable(map);
    return map;
  },

  field(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `field-${seed}`);
    const rng = new RNG(seed);
    const scale = width / 128;
    addBorderWalls(map);
    randomizeNest(map, rng);
    placeNest(map);

    // Random wandering walls
    const numWalls = 3 + rng.nextInt(3);
    for (let w = 0; w < numWalls; w++) {
      let wx = 4 + rng.nextInt(width - 8);
      let wy = 4 + rng.nextInt(height - 8);
      if (dist(wx, wy, map.nestX, map.nestY) < 8) continue;
      const len = 70 + rng.nextInt(60);  // [70, 130)
      let angle = rng.next() * Math.PI * 2;
      let segLen = 0;
      let isGap = false;
      for (let s = 0; s < len; s++) {
        angle += (rng.next() - 0.5) * 1;
        wx += Math.round(Math.cos(angle));
        wy += Math.round(Math.sin(angle));
        if (!inBounds(map, wx, wy)) break;
        if (dist(wx, wy, map.nestX, map.nestY) < 5) continue;
        segLen++;
        if (!isGap && segLen > 8 + rng.nextInt(12)) { isGap = true; segLen = 0; }
        else if (isGap && segLen > 2 + rng.nextInt(3)) { isGap = false; segLen = 0; }
        if (!isGap) setCell(map, wx, wy, CellType.WALL);
      }
    }

    // Food clusters
    const numClusters = 6 + rng.nextInt(3);
    for (let i = 0; i < numClusters; i++) {
      const fx = 4 + rng.nextInt(width - 8);
      const fy = 4 + rng.nextInt(height - 8);
      if (dist(fx, fy, map.nestX, map.nestY) < 12 * scale) continue;
      const radius = 2 + rng.nextInt(4);
      const amount = 2 + rng.nextInt(4);
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const px = fx + dx, py = fy + dy;
          if (inBounds(map, px, py)) placeFood(map, px, py, amount);
        }
    }
    ensureFoodReachable(map);
    return map;
  },

  bridge(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `bridge-${seed}`);
    const rng = new RNG(seed);
    addBorderWalls(map);

    const midX = Math.floor(width / 2);
    const maxWander = Math.floor(0.1 * width);
    const wallX = new Int32Array(height);
    let cx = midX;

    for (let y = 1; y < height - 1; y++) {
      if (rng.next() < 0.3) cx += rng.nextInt(3) - 1;
      cx = Math.max(midX - maxWander, Math.min(midX + maxWander, cx));
      wallX[y] = cx;
      for (let dx = -1; dx <= 1; dx++) {
        const wx = cx + dx;
        if (wx > 0 && wx < width - 1) setCell(map, wx, y, CellType.WALL);
      }
    }

    // Bridges
    const numBridges = 2 + rng.nextInt(3);
    const bridgeSpacing = Math.floor(height / (numBridges + 1));
    for (let b = 0; b < numBridges; b++) {
      const by = bridgeSpacing * (b + 1);
      const halfWidth = 2 + rng.nextInt(2);
      for (let dy = -halfWidth; dy <= halfWidth; dy++) {
        const y = by + dy;
        if (y > 0 && y < height - 1) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = wallX[y] + dx;
            if (x > 0 && x < width - 1) setCell(map, x, y, CellType.EMPTY);
          }
        }
      }
    }

    map.nestX = Math.floor(width / 4);
    map.nestY = Math.floor(height / 2);
    placeNest(map);

    // Food on the right side
    const numClusters = 6 + rng.nextInt(4);
    for (let i = 0; i < numClusters; i++) {
      const fx = midX + 4 + rng.nextInt(Math.floor(width / 2) - 6);
      const fy = 4 + rng.nextInt(height - 8);
      const radius = 2 + rng.nextInt(3);
      const amount = 3 + rng.nextInt(4);
      for (let dy = -radius; dy <= radius; dy++)
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const px = fx + dx, py = fy + dy;
          if (inBounds(map, px, py) && map.cells[cellIndex(map, px, py)] !== CellType.WALL)
            placeFood(map, px, py, amount);
        }
    }
    randomSymmetry(map, rng);
    return map;
  },

  gauntlet(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `gauntlet-${seed}`);
    const rng = new RNG(seed);
    addBorderWalls(map);
    map.nestX = 5;
    map.nestY = Math.floor(height / 2);
    placeNest(map);

    const numWalls = 3 + rng.nextInt(2);
    const wallSpacing = Math.floor((width - 20) / (numWalls + 1));

    for (let w = 0; w < numWalls; w++) {
      const wallX = 12 + wallSpacing * (w + 1);
      const gapY = w % 2 === 0
        ? 4 + rng.nextInt(Math.floor(height / 3))
        : Math.floor((2 * height) / 3) + rng.nextInt(Math.floor(height / 3) - 4);
      const gapSize = 4 + rng.nextInt(4);
      for (let y = 1; y < height - 1; y++) {
        if (Math.abs(y - gapY) >= gapSize && wallX > 0 && wallX < width - 1)
          setCell(map, wallX, y, CellType.WALL);
      }
    }

    // Food in chambers between walls, more food in later chambers
    for (let chamber = 1; chamber <= numWalls; chamber++) {
      const startX = 12 + chamber * wallSpacing + 4;
      const endX = chamber < numWalls ? 12 + (chamber + 1) * wallSpacing - 4 : width - 6;
      if (endX <= startX) continue;
      const progress = (chamber - 1) / Math.max(1, numWalls - 1);
      const numClusters = 2 + rng.nextInt(2) + Math.round(2 * progress);
      const clusterRadius = 1 + Math.round(2 * progress);
      const foodAmount = 2 + rng.nextInt(2) + Math.round(3 * progress);
      for (let i = 0; i < numClusters; i++) {
        const fx = startX + rng.nextInt(Math.max(1, endX - startX));
        const fy = 4 + rng.nextInt(height - 8);
        for (let dy = -clusterRadius; dy <= clusterRadius; dy++)
          for (let dx = -clusterRadius; dx <= clusterRadius; dx++) {
            if (dx * dx + dy * dy > clusterRadius * clusterRadius) continue;
            const px = fx + dx, py = fy + dy;
            if (inBounds(map, px, py)) placeFood(map, px, py, foodAmount);
          }
      }
    }
    randomSymmetry(map, rng);
    return map;
  },

  pockets(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `pockets-${seed}`);
    const rng = new RNG(seed);
    addBorderWalls(map);
    randomizeNest(map, rng);
    placeNest(map);

    const pockets = [];
    const numPockets = 7 + rng.nextInt(4);
    for (let attempt = 0; attempt < 300 && pockets.length < numPockets; attempt++) {
      const r = 7 + rng.nextInt(6);
      const px = r + 4 + rng.nextInt(width - 2 * r - 8);
      const py = r + 4 + rng.nextInt(height - 2 * r - 8);
      if (dist(px, py, map.nestX, map.nestY) < r + 8) continue;
      let overlap = false;
      for (const p of pockets) {
        if (dist(px, py, p.cx, p.cy) < r + p.r + 5) { overlap = true; break; }
      }
      if (overlap) continue;
      pockets.push({ cx: px, cy: py, r });

      // Draw circular wall with a gap
      const gapAngle = rng.next() * Math.PI * 2;
      const gapWidth = 0.2 + 0.1 * rng.next();
      for (let a = 0; a < 2 * Math.PI; a += 0.025) {
        if (Math.abs(((a - gapAngle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < gapWidth) continue;
        const wx = Math.round(px + Math.cos(a) * r);
        const wy = Math.round(py + Math.sin(a) * r);
        if (inBounds(map, wx, wy)) setCell(map, wx, wy, CellType.WALL);
      }

      // Food inside pocket
      const foodR = 3 + rng.nextInt(2);
      const amount = 2 + rng.nextInt(3);
      for (let dy = -foodR; dy <= foodR; dy++)
        for (let dx = -foodR; dx <= foodR; dx++) {
          if (dx * dx + dy * dy > foodR * foodR) continue;
          const fx = px + dx, fy = py + dy;
          if (inBounds(map, fx, fy) && map.cells[cellIndex(map, fx, fy)] === CellType.EMPTY)
            placeFood(map, fx, fy, amount);
        }
    }
    ensureFoodReachable(map);
    return map;
  },

  fortress(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `fortress-${seed}`);
    const rng = new RNG(seed);
    addBorderWalls(map);
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2);
    const numRings = 3 + rng.nextInt(2);
    const ringSpacing = Math.max(4, Math.floor(Math.min(width, height) / (2 * numRings + 4)));
    map.nestX = 4; map.nestY = 4;
    placeNest(map);

    for (let ring = 1; ring <= numRings; ring++) {
      const r = ring * ringSpacing;
      const gapAngle = rng.next() * Math.PI * 2;
      const gapWidth = 0.35 + 0.2 * rng.next();
      const wobbleFreq = 3 + rng.nextInt(3);
      const wobbleAmp = 1.5 + 2 * rng.next();
      const wobblePhase = rng.next() * Math.PI * 2;
      for (let a = 0; a < 2 * Math.PI; a += 0.015) {
        if (Math.abs(((a - gapAngle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) < gapWidth) continue;
        const effectiveR = r + Math.sin(a * wobbleFreq + wobblePhase) * wobbleAmp;
        const wx = Math.floor(cx + Math.cos(a) * effectiveR);
        const wy = Math.floor(cy + Math.sin(a) * effectiveR);
        if (inBounds(map, wx, wy)) setCell(map, wx, wy, CellType.WALL);
      }
    }

    // Food in center
    const centerR = ringSpacing - 2;
    for (let dy = -centerR; dy <= centerR; dy++)
      for (let dx = -centerR; dx <= centerR; dx++) {
        if (dx * dx + dy * dy > centerR * centerR) continue;
        const fx = cx + dx, fy = cy + dy;
        if (inBounds(map, fx, fy)) placeFood(map, fx, fy, 3 + rng.nextInt(3));
      }

    // Food between rings
    for (let ring = 1; ring < numRings; ring++) {
      const midR = ring * ringSpacing + Math.floor(ringSpacing / 2);
      const numClusters = 4 + rng.nextInt(4);
      for (let i = 0; i < numClusters; i++) {
        const angle = rng.next() * Math.PI * 2;
        const fx = Math.floor(cx + Math.cos(angle) * midR);
        const fy = Math.floor(cy + Math.sin(angle) * midR);
        if (fx > 1 && fx < width - 2 && fy > 1 && fy < height - 2 &&
            map.cells[cellIndex(map, fx, fy)] === CellType.EMPTY)
          placeFood(map, fx, fy, 2 + rng.nextInt(4));
      }
    }
    ensureFoodReachable(map);
    return map;
  },

  islands(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `islands-${seed}`);
    const rng = new RNG(seed);
    // Fill everything with walls
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        setCell(map, x, y, CellType.WALL);

    const islandW = Math.floor((width - 2) / 4);
    const islandH = Math.floor((height - 2) / 4);
    const islands = [];

    // Create 4×4 grid of open islands
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const left = 1 + col * islandW + 2;
        const top = 1 + row * islandH + 2;
        const right = 1 + (col + 1) * islandW - 2;
        const bottom = 1 + (row + 1) * islandH - 2;
        const cx = Math.floor((left + right) / 2);
        const cy = Math.floor((top + bottom) / 2);
        islands.push({ cx, cy, ri: row, ci: col });
        for (let y = top; y <= bottom; y++)
          for (let x = left; x <= right; x++)
            if (inBounds(map, x, y)) setCell(map, x, y, CellType.EMPTY);
      }
    }

    // Create bridges between adjacent islands
    const bridges = islands.map(() => []);
    const bridgeWidth = 2 + rng.nextInt(2);

    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const idx = 4 * row + col;
        if (col < 3) {
          const bx = 1 + (col + 1) * islandW;
          const by = 1 + row * islandH + 2 + rng.nextInt(Math.max(1, islandH - 4 - bridgeWidth));
          const bcy = by + Math.floor(bridgeWidth / 2);
          bridges[idx].push({ x: bx, y: bcy });
          bridges[idx + 1].push({ x: bx, y: bcy });
          for (let d = 0; d < bridgeWidth; d++)
            for (let dx = -2; dx <= 2; dx++)
              if (inBounds(map, bx + dx, by + d)) setCell(map, bx + dx, by + d, CellType.EMPTY);
        }
        if (row < 3) {
          const by = 1 + (row + 1) * islandH;
          const bx = 1 + col * islandW + 2 + rng.nextInt(Math.max(1, islandW - 4 - bridgeWidth));
          const bcx = bx + Math.floor(bridgeWidth / 2);
          bridges[idx].push({ x: bcx, y: by });
          bridges[idx + 4].push({ x: bcx, y: by });
          for (let d = 0; d < bridgeWidth; d++)
            for (let dx = -2; dx <= 2; dx++)
              if (inBounds(map, bx + d, by + dx)) setCell(map, bx + d, by + dx, CellType.EMPTY);
        }
      }
    }

    // Nest on a random island
    const nestIsland = islands[rng.nextInt(islands.length)];
    map.nestX = nestIsland.cx;
    map.nestY = nestIsland.cy;
    placeNest(map);

    // Food patterns on other islands
    const iw = islandW - 4, ih = islandH - 4;
    const patterns = ["empty", "blob", "walls", "diffuse", "corners"];
    const patternQueue = [];
    const bridgeClearance = bridgeWidth + 5;

    for (let i = 0; i < islands.length; i++) {
      const island = islands[i];
      if (island === nestIsland) continue;
      if (patternQueue.length === 0) { patternQueue.push(...patterns); rng.shuffle(patternQueue); }
      const pattern = patternQueue.pop();
      const left = island.cx - Math.floor(iw / 2);
      const top = island.cy - Math.floor(ih / 2);
      const myBridges = bridges[i];

      if (pattern === "blob") {
        const r = Math.max(1, Math.floor(Math.min(iw, ih) / 8));
        const bx = island.cx + rng.nextInt(5) - 2;
        const by = island.cy + rng.nextInt(5) - 2;
        const amt = 1 + rng.nextInt(2);
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++)
            if (dx * dx + dy * dy <= r * r && inBounds(map, bx + dx, by + dy))
              placeFood(map, bx + dx, by + dy, amt);
      } else if (pattern === "walls") {
        const right = left + iw - 1;
        const bottom = top + ih - 1;
        const nearBridge = (x, y) => myBridges.some(b => Math.abs(x - b.x) + Math.abs(y - b.y) < bridgeClearance);
        for (let x = left; x <= right; x++) {
          if (rng.next() < 0.5 && inBounds(map, x, top) && !nearBridge(x, top)) placeFood(map, x, top, 1);
          if (rng.next() < 0.5 && inBounds(map, x, bottom) && !nearBridge(x, bottom)) placeFood(map, x, bottom, 1);
        }
        for (let y = top + 1; y < bottom; y++) {
          if (rng.next() < 0.5 && inBounds(map, left, y) && !nearBridge(left, y)) placeFood(map, left, y, 1);
          if (rng.next() < 0.5 && inBounds(map, right, y) && !nearBridge(right, y)) placeFood(map, right, y, 1);
        }
      } else if (pattern === "diffuse") {
        for (let y = top; y < top + ih; y++)
          for (let x = left; x < left + iw; x++)
            if (rng.next() < 0.12 && inBounds(map, x, y)) placeFood(map, x, y, 1);
      } else if (pattern === "corners") {
        const cr = Math.max(1, Math.floor(Math.min(iw, ih) / 7));
        for (const [ccx, ccy] of [
          [left + cr + 1, top + cr + 1],
          [left + iw - cr - 2, top + cr + 1],
          [left + cr + 1, top + ih - cr - 2],
          [left + iw - cr - 2, top + ih - cr - 2],
        ]) {
          if (rng.next() < 0.3) continue;
          const amt = 1 + rng.nextInt(3);
          for (let dy = -cr; dy <= cr; dy++)
            for (let dx = -cr; dx <= cr; dx++)
              if (dx * dx + dy * dy <= cr * cr && inBounds(map, ccx + dx, ccy + dy))
                placeFood(map, ccx + dx, ccy + dy, amt);
        }
      }
      // "empty" pattern = no food
    }
    return map;
  },

  chambers(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `chambers-${seed}`);
    const rng = new RNG(seed);
    // Fill with walls
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        setCell(map, x, y, CellType.WALL);

    // Place random rectangular chambers
    const chambers = [];
    const numChambers = 11 + rng.nextInt(3);
    for (let i = 0; i < numChambers; i++) {
      const hw = 4 + rng.nextInt(4);
      const hh = 4 + rng.nextInt(4);
      const cx = hw + 2 + rng.nextInt(Math.max(1, width - 2 * hw - 4));
      const cy = hh + 2 + rng.nextInt(Math.max(1, height - 2 * hh - 4));
      let overlap = false;
      for (const c of chambers) {
        if (Math.abs(cx - c.cx) < hw + c.hw + 2 && Math.abs(cy - c.cy) < hh + c.hh + 2) {
          overlap = true; break;
        }
      }
      if (!overlap) {
        chambers.push({ cx, cy, hw, hh });
        for (let y = cy - hh; y <= cy + hh; y++)
          for (let x = cx - hw; x <= cx + hw; x++)
            if (inBounds(map, x, y)) setCell(map, x, y, CellType.EMPTY);
      }
    }

    // Connect chambers in sequence with corridors
    for (let i = 1; i < chambers.length; i++) {
      const prev = chambers[i - 1], cur = chambers[i];
      let x = prev.cx, y = prev.cy;
      while (x !== cur.cx) {
        for (let d = -1; d <= 1; d++)
          if (inBounds(map, x, y + d)) setCell(map, x, y + d, CellType.EMPTY);
        x += x < cur.cx ? 1 : -1;
      }
      while (y !== cur.cy) {
        for (let d = -1; d <= 1; d++)
          if (inBounds(map, x + d, y)) setCell(map, x + d, y, CellType.EMPTY);
        y += y < cur.cy ? 1 : -1;
      }
    }
    // Close the loop
    {
      const last = chambers[chambers.length - 1], first = chambers[0];
      let x = last.cx, y = last.cy;
      while (x !== first.cx) {
        for (let d = -1; d <= 1; d++)
          if (inBounds(map, x, y + d)) setCell(map, x, y + d, CellType.EMPTY);
        x += x < first.cx ? 1 : -1;
      }
      while (y !== first.cy) {
        for (let d = -1; d <= 1; d++)
          if (inBounds(map, x + d, y)) setCell(map, x + d, y, CellType.EMPTY);
        y += y < first.cy ? 1 : -1;
      }
    }

    // Nest in the most central chamber
    const bestChamber = chambers.reduce((best, c) => {
      const d = dist(c.cx, c.cy, width / 2, height / 2);
      return d < best.d ? { c, d } : best;
    }, { c: chambers[0], d: Infinity });
    map.nestX = bestChamber.c.cx;
    map.nestY = bestChamber.c.cy;
    placeNest(map);

    // Food in other chambers
    for (const c of chambers) {
      if (c === bestChamber.c) continue;
      const r = Math.min(Math.min(c.hw, c.hh) - 1, 3);
      if (r < 1) continue;
      const amount = 3 + rng.nextInt(3);
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const fx = c.cx + dx, fy = c.cy + dy;
          if (inBounds(map, fx, fy)) placeFood(map, fx, fy, amount);
        }
    }
    return map;
  },

  prairie(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `prairie-${seed}`);
    const rng = new RNG(seed);
    addBorderWalls(map);
    randomizeNest(map, rng);
    placeNest(map);

    // Density hotspots
    const numHotspots = 6 + rng.nextInt(4);
    const hotspots = [];
    for (let i = 0; i < numHotspots; i++) {
      hotspots.push({
        x: 4 + rng.nextInt(width - 8),
        y: 4 + rng.nextInt(height - 8),
        strength: 0.25 + 0.3 * rng.next(),
        radius: 6 + rng.nextInt(10),
      });
    }

    for (let y = 2; y < height - 2; y++) {
      for (let x = 2; x < width - 2; x++) {
        if (dist(x, y, map.nestX, map.nestY) < 5) continue;
        let density = 0.016;
        for (const hs of hotspots) {
          const d = dist(x, y, hs.x, hs.y);
          if (d < hs.radius) density += hs.strength * (1 - d / hs.radius);
        }
        density = Math.min(density, 0.25);
        if (rng.next() < density)
          placeFood(map, x, y, density > 0.12 ? 1 + rng.nextInt(3) : 1 + rng.nextInt(2));
      }
    }
    return map;
  },

  brush(width, height, seed) {
    const map = createEmptyMap(width, height, seed, `brush-${seed}`);
    const rng = new RNG(seed);
    const scale = width / 128;
    addBorderWalls(map);
    randomizeNest(map, rng);
    placeNest(map);

    // Dense random walls
    for (let y = 2; y < height - 2; y++)
      for (let x = 2; x < width - 2; x++)
        if (dist(x, y, map.nestX, map.nestY) >= 5 && rng.next() < 0.28)
          setCell(map, x, y, CellType.WALL);

    // Clear area around nest
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const nx = map.nestX + dx, ny = map.nestY + dy;
        if (inBounds(map, nx, ny) && map.cells[cellIndex(map, nx, ny)] === CellType.WALL)
          setCell(map, nx, ny, CellType.EMPTY);
      }

    // Food clusters
    const numClusters = 10 + rng.nextInt(3);
    for (let i = 0; i < numClusters; i++) {
      for (let attempt = 0; attempt < 80; attempt++) {
        const fx = 4 + rng.nextInt(width - 8);
        const fy = 4 + rng.nextInt(height - 8);
        if (dist(fx, fy, map.nestX, map.nestY) < 10 * scale ||
            map.cells[cellIndex(map, fx, fy)] !== CellType.EMPTY) continue;
        const radius = 2 + rng.nextInt(3);
        const amount = 3 + rng.nextInt(3);
        for (let dy = -radius; dy <= radius; dy++)
          for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy > radius * radius) continue;
            const px = fx + dx, py = fy + dy;
            if (inBounds(map, px, py)) placeFood(map, px, py, amount);
          }
        break;
      }
    }
    ensureFoodReachable(map);
    return map;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MAP SET GENERATION (deterministic from seed)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a single evaluation map given a global seed and map index.
 */
function generateSingleMap(width, height, globalSeed, mapIndex) {
  const rng = new RNG(0x5A5A5A5A ^ globalSeed);
  const entries = Object.entries(MAP_GENERATORS);
  rng.shuffle(entries);
  const [genName, genFn] = entries[mapIndex % entries.length];

  // Derive a per-map seed
  let hash = Math.imul(0x45D9F3B ^ globalSeed, 0x9E3779B9) ^ Math.imul(mapIndex + 1, 0x6C62272E);
  const mapSeed = (0xFFFFFFF & Math.imul(hash ^ (hash >>> 16), 0x85EBCA6B)) || 1;

  const map = genFn(width, height, mapSeed);
  map.name = `${genName}-${mapSeed.toString(36)}`;
  return map;
}

/**
 * Generate a set of evaluation maps.
 */
function generateEvalMaps(width, height, globalSeed, count) {
  const maps = [];
  for (let i = 0; i < count; i++) {
    maps.push(generateSingleMap(width, height, globalSeed, i));
  }
  return maps;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNAPSHOT / STATE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Take a deep snapshot of the world state (for replay). */
function snapshotWorld(world) {
  return {
    tick: world.tick,
    foodCollected: world.foodCollected,
    rngState: world.rngState,
    cells: new Uint8Array(world.map.cells),
    food: new Uint16Array(world.map.food),
    pheromones: new Uint16Array(world.map.pheromones),
    visitCounts: new Uint32Array(world.map.visitCounts),
    ants: world.ants.map(a => ({
      x: a.x, y: a.y, carrying: a.carrying,
      regs: [...a.regs], pc: a.pc, tag: a.tag,
    })),
  };
}

/** Restore a world from a snapshot. */
function restoreSnapshot(world, snapshot) {
  world.tick = snapshot.tick;
  world.foodCollected = snapshot.foodCollected;
  world.rngState = snapshot.rngState;
  world.map.cells.set(snapshot.cells);
  world.map.food.set(snapshot.food);
  world.map.pheromones.set(snapshot.pheromones);
  world.map.visitCounts.set(snapshot.visitCounts);
  for (let i = 0; i < snapshot.ants.length && i < world.ants.length; i++) {
    const src = snapshot.ants[i], dst = world.ants[i];
    dst.x = src.x; dst.y = src.y;
    dst.carrying = src.carrying;
    dst.regs = [...src.regs];
    dst.pc = src.pc;
    dst.tag = src.tag ?? 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL HARNESS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run a full simulation: compile source, run across maps, return scores.
 *
 * @param {string} source - Assembly source code
 * @param {object} [options]
 * @param {number} [options.seed=42] - Global map seed
 * @param {number} [options.numMaps=12] - Number of maps to evaluate
 * @param {object} [options.config] - Override DEFAULT_CONFIG
 * @param {boolean} [options.verbose=false] - Print per-map results
 * @returns {{ scores: Array<{map: string, collected: number, total: number, ratio: number}>, averageScore: number }}
 */
function runSimulation(source, options = {}) {
  const {
    seed = 42,
    numMaps = 12,
    config = DEFAULT_CONFIG,
    verbose = false,
  } = options;

  const program = parseAssembly(source);
  const maps = generateEvalMaps(config.mapWidth, config.mapHeight, seed, numMaps);
  const scores = [];

  for (let i = 0; i < maps.length; i++) {
    const world = createWorld(cloneMap(maps[i]), program, config);
    for (let t = 0; t < config.maxTicks; t++) {
      runTick(world, config);
    }
    const collected = world.foodCollected;
    const total = maps[i].totalFood;
    const ratio = total > 0 ? collected / total : 0;
    scores.push({ map: maps[i].name, collected, total, ratio });
    if (verbose) {
      console.log(`  Map ${i + 1}/${maps.length} [${maps[i].name}]: ${collected}/${total} (${(ratio * 100).toFixed(1)}%)`);
    }
  }

  const averageRatio = scores.reduce((s, r) => s + r.ratio, 0) / scores.length;
  const averageScore = Math.round(averageRatio * 1000);

  if (verbose) {
    console.log(`\n  Score: ${averageScore}/1000 (${(averageRatio * 100).toFixed(1)}% average collection)`);
  }

  return { scores, averageScore };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Constants
  CellType,
  SenseTarget,
  Opcode,
  BC_STRIDE,
  DIR_DX,
  DIR_DY,
  DIR_HERE,
  DIR_RANDOM,
  NUM_PHEROMONE_CHANNELS,
  NUM_REGISTERS,
  EVAL_MAP_COUNT,
  DEFAULT_CONFIG,

  // Core classes
  RNG,
  AssemblyError,

  // Assembler
  parseAssembly,
  compileBytecode,

  // VM
  createWorld,
  runTick,
  stepAnt,

  // Map utilities
  cloneMap,
  createEmptyMap,
  setCell,
  placeFood,
  addBorderWalls,
  placeNest,
  MAP_GENERATORS,
  generateEvalMaps,
  generateSingleMap,

  // State utilities
  snapshotWorld,
  restoreSnapshot,

  // High-level
  runSimulation,
};
