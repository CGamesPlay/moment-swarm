/**
 * debug.ts — Interactive debugger for compiled .ant programs.
 *
 * Usage:
 *   npx tsx compiler/debug.ts [options] <file.ant>
 *
 * Options:
 *   -m, --map <name>    Select map generator (default: first eval map)
 *   -s, --seed <n>      Map seed (default: 42)
 *   -a, --ants <n>      Ant count (default: 200)
 *   --allow-abort       Allow ABORT opcodes (default: enabled)
 *   --no-debug          Use production ISA (disables ABORT opcodes)
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

const engine = require("./node-engine");

const {
  CellType,
  Opcode,
  BC_STRIDE,
  DIR_DX,
  DIR_DY,
  DIR_HERE,
  DIR_RANDOM,
  NUM_PHEROMONE_CHANNELS,
  NUM_REGISTERS,
  NUM_TOTAL_REGISTERS,
  REG_FD,
  REG_CL,
  REG_PX,
  REG_PY,
  REG_PC,
  DEFAULT_CONFIG,
  parseAssembly,
  compileBytecode,
  createWorld,
  beginTick,
  endTick,
  getTickRng,
  stepAnt,
  cloneMap,
  MAP_GENERATORS,
  generateEvalMaps,
  snapshotWorld,
  restoreSnapshot,
} = engine;

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface Breakpoint {
  id: number;
  antId?: number;
  tick?: number;
  pc?: number;
  stall?: true;
  regConditions: Array<{ reg: number; val: number }>;
}

interface Watchpoint {
  id: number;
  action?: string; // "MOVE" | "PICKUP" | "DROP"
  x?: number;
  y?: number;
}

interface TickProgress {
  nextAntIndex: number;
  tickStarted: boolean; // whether beginTick was called for current tick
  skipBreakOnResume: boolean; // skip breakpoint check for the first ant after a break
}

interface DebugState {
  world: any;
  config: any;
  program: any;
  source: string;
  sourceLines: string[];
  bytecode: Int32Array;
  instrCount: number;
  currentAntId: number;
  breakpoints: Breakpoint[];
  watchpoints: Watchpoint[];
  nextBreakpointId: number;
  nextWatchpointId: number;
  tickProgress: TickProgress;
  snapshots: Map<number, any>; // tick → snapshot
  maxSnapshots: number;
  maxTicks: number;
  isa: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI parsing
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let mapName: string | undefined;
  let seed = 42;
  let antCount = 200;
  let file: string | undefined;
  let allowAbort = true;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-m" || a === "--map") { mapName = args[++i]; continue; }
    if (a === "-s" || a === "--seed") { seed = parseInt(args[++i], 10); continue; }
    if (a === "-a" || a === "--ants") { antCount = parseInt(args[++i], 10); continue; }
    if (a === "--allow-abort") { allowAbort = true; continue; }
    if (a === "--no-debug") { allowAbort = false; continue; }
    if (a.startsWith("-")) { console.error(`Unknown option: ${a}`); process.exit(1); }
    file = a;
  }

  if (!file) {
    console.error("Usage: npx tsx compiler/debug.ts [options] <file.ant>");
    console.error("Options:");
    console.error("  -m, --map <name>    Select map (default: first eval map)");
    console.error("  -s, --seed <n>      Map seed (default: 42)");
    console.error("  -a, --ants <n>      Ant count (default: 200)");
    console.error("  --no-debug          Use production ISA (disables ABORT opcodes)");
    process.exit(1);
  }

  return { mapName, seed, antCount, file: file!, allowAbort };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Snapshot management
// ═══════════════════════════════════════════════════════════════════════════════

function saveAutoSnapshot(state: DebugState) {
  const snap = snapshotWorld(state.world);
  // Also snapshot antGrid and phero tracking state
  snap.antGrid = new Uint8Array(state.world.antGrid);
  snap.pheroActive = new Uint8Array(state.world.pheroActive);
  snap.pheroList = new Uint32Array(state.world.pheroList);
  snap.pheroListLen = state.world.pheroListLen;
  // Snapshot abort state per ant
  snap.abortState = state.world.ants.map((a: any) => ({
    _aborted: a._aborted,
    _abortedCounted: a._abortedCounted,
  }));
  state.snapshots.set(state.world.tick, snap);

  // Evict oldest if over limit
  if (state.snapshots.size > state.maxSnapshots) {
    const oldest = state.snapshots.keys().next().value!;
    state.snapshots.delete(oldest);
  }
}

function restoreToTick(state: DebugState, targetTick: number) {
  const snap = state.snapshots.get(targetTick);
  if (!snap) {
    console.log(`No snapshot at tick ${targetTick}. Available: ${[...state.snapshots.keys()].join(", ")}`);
    return false;
  }
  restoreSnapshot(state.world, snap);
  state.world.antGrid.set(snap.antGrid);
  state.world.pheroActive.set(snap.pheroActive);
  state.world.pheroList.set(snap.pheroList);
  state.world.pheroListLen = snap.pheroListLen;
  // Restore abort state
  for (let i = 0; i < snap.abortState.length && i < state.world.ants.length; i++) {
    state.world.ants[i]._aborted = snap.abortState[i]._aborted;
    state.world.ants[i]._abortedCounted = snap.abortState[i]._abortedCounted;
  }
  // Reset stall tracking
  state.world.stallCounts = 0;
  state.world.stallsByTag = undefined;
  state.world.abortCounts = 0;
  state.world.abortsByCode = undefined;
  state.tickProgress = { nextAntIndex: 0, tickStarted: false, skipBreakOnResume: false };
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Breakpoint / watchpoint matching
// ═══════════════════════════════════════════════════════════════════════════════

function matchesBreakpoint(state: DebugState, ant: any, antIndex: number, didStall: boolean = false): boolean {
  for (const bp of state.breakpoints) {
    let match = true;
    if (bp.antId !== undefined && bp.antId !== antIndex) match = false;
    if (bp.tick !== undefined && bp.tick !== state.world.tick) match = false;
    if (bp.pc !== undefined && bp.pc !== ant.pc) match = false;
    if (bp.stall && !didStall) match = false;
    for (const rc of bp.regConditions) {
      if (ant.regs[rc.reg] !== rc.val) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

function matchesWatchpoint(state: DebugState, ant: any, antIndex: number, prevX: number, prevY: number, prevCarrying: boolean, delivered: boolean): Watchpoint | null {
  for (const wp of state.watchpoints) {
    let actionMatch = true;
    if (wp.action) {
      // Detect what action occurred
      const moved = ant.x !== prevX || ant.y !== prevY;
      const pickedUp = !prevCarrying && ant.carrying;
      const dropped = prevCarrying && !ant.carrying;
      switch (wp.action) {
        case "MOVE": actionMatch = moved; break;
        case "PICKUP": actionMatch = pickedUp; break;
        case "DROP": actionMatch = dropped || delivered; break;
        default: actionMatch = false;
      }
    }
    if (!actionMatch) continue;
    if (wp.x !== undefined && wp.y !== undefined) {
      if (ant.x !== wp.x || ant.y !== wp.y) continue;
    }
    return wp;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Custom tick loop
// ═══════════════════════════════════════════════════════════════════════════════

interface PauseResult {
  reason: "breakpoint" | "watchpoint" | "abort" | "stall" | "end";
  antId?: number;
  watchpoint?: Watchpoint;
}

function runUntilBreak(state: DebugState): PauseResult {
  const { world, config } = state;
  const { ants, bytecode, antGrid, map } = world;
  const instrCount = state.instrCount;
  const rng = getTickRng();

  while (world.tick < state.maxTicks) {
    // Start new tick if needed
    if (!state.tickProgress.tickStarted) {
      saveAutoSnapshot(state);
      beginTick(world);
      state.tickProgress.tickStarted = true;
    }

    const tickFoodCollected = world.foodCollected;
    const currentTick = world.tick;

    for (let i = state.tickProgress.nextAntIndex; i < ants.length; i++) {
      const ant = ants[i];

      // Skip aborted ants
      if (ant._aborted !== undefined) {
        if (!ant._abortedCounted) {
          ant._abortedCounted = true;
          if (!world.abortCounts) world.abortCounts = 0;
          world.abortCounts++;
          if (!world.abortsByCode) world.abortsByCode = {};
          const code = ant._aborted;
          world.abortsByCode[code] = (world.abortsByCode[code] || 0) + 1;
        }
        continue;
      }

      // Populate magic registers
      ant.regs[REG_FD] = tickFoodCollected;
      ant.regs[REG_CL] = currentTick;
      ant.regs[REG_PX] = ant.x;
      ant.regs[REG_PY] = ant.y;
      ant.regs[REG_PC] = ant.pc;

      // Check breakpoints BEFORE stepping.
      // Skip on the very first ant after resuming from a break (that position
      // already fired; we don't want to re-fire before the ant has stepped).
      if (state.tickProgress.skipBreakOnResume) {
        state.tickProgress.skipBreakOnResume = false;
      } else if (matchesBreakpoint(state, ant, i)) {
        state.currentAntId = i;
        state.tickProgress.nextAntIndex = i;
        state.tickProgress.skipBreakOnResume = true;
        return { reason: "breakpoint", antId: i };
      }

      // Save pre-step state for watchpoint detection
      const prevX = ant.x, prevY = ant.y, prevCarrying = ant.carrying;
      const delivered = stepAnt(ant, i, bytecode, instrCount, map, 0, rng, config.maxOpsPerTick, antGrid, config.senseRange, -1, state.isa === 'debug');
      if (delivered) world.foodCollected++;
      map.visitCounts[ant.y * map.width + ant.x]++;

      if (ant._aborted !== undefined) {
        state.currentAntId = i;
        state.tickProgress.nextAntIndex = i + 1;
        return { reason: "abort", antId: i };
      }

      if (ant._stalled) {
        if (!world.stallsByTag) world.stallsByTag = {};
        world.stallsByTag[ant.tag] = (world.stallsByTag[ant.tag] || 0) + 1;
        if (!world.stallCounts) world.stallCounts = 0;
        world.stallCounts++;

        // Check stall breakpoints
        if (matchesBreakpoint(state, ant, i, true)) {
          state.currentAntId = i;
          state.tickProgress.nextAntIndex = i + 1;
          return { reason: "stall", antId: i };
        }
      }

      // Check watchpoints AFTER stepping
      const wp = matchesWatchpoint(state, ant, i, prevX, prevY, prevCarrying, delivered);
      if (wp) {
        state.currentAntId = i;
        state.tickProgress.nextAntIndex = i + 1; // ant already stepped
        return { reason: "watchpoint", antId: i, watchpoint: wp };
      }
    }

    endTick(world);
    state.tickProgress.nextAntIndex = 0;
    state.tickProgress.tickStarted = false;
  }

  return { reason: "end" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Opcode names for disassembly
// ═══════════════════════════════════════════════════════════════════════════════

const OPCODE_NAME_TABLE: string[] = [];
for (const [name, val] of Object.entries(Opcode) as [string, number][]) {
  OPCODE_NAME_TABLE[val] = name;
}

const DIR_NAMES = ["???", "N", "E", "S", "W", "HERE"];
const SENSE_NAMES = ["FOOD", "WALL", "NEST", "ANT", "EMPTY"];
const CH_NAMES = ["CH_RED", "CH_BLUE", "CH_GREEN", "CH_YELLOW"];

function formatOperand(val: number, flags: number, bit: number, context: string): string {
  if (flags & (1 << bit)) return `r${val}`;
  switch (context) {
    case "dir":
      if (val === 6) return "RANDOM";
      return DIR_NAMES[val] ?? String(val);
    case "sense": return SENSE_NAMES[val] ?? String(val);
    case "channel": return CH_NAMES[val] ?? String(val);
    case "reg": return `r${val}`;
    case "magicreg": {
      const names: Record<number, string> = { 8: "RD_FD", 9: "RD_CL", 10: "RD_PX", 11: "RD_PY", 12: "RD_PC" };
      return names[val] ?? `r${val}`;
    }
    default: return String(val);
  }
}

function getVarNamesAtPC(program: any, pc: number): Map<number, string> | undefined {
  if (!program.varMaps?.length) return undefined;
  let best: any = undefined;
  for (const entry of program.varMaps) {
    if (entry.pc <= pc) best = entry;
    else break;
  }
  if (!best) return undefined;
  const map = new Map<number, string>();
  for (const [k, v] of Object.entries(best.regs)) {
    map.set(Number(k), v as string);
  }
  return map;
}

function disassembleInstr(bytecode: Int32Array, pc: number, program: any): string {
  const base = pc * BC_STRIDE;
  const op = bytecode[base];
  const flags = bytecode[base + 1];
  const a0 = bytecode[base + 2];
  const a1 = bytecode[base + 3];
  const a2 = bytecode[base + 4];
  const name = OPCODE_NAME_TABLE[op] ?? `OP${op}`;

  // Prefer per-PC variable names from .varmap, fall back to static .alias
  const varNames = getVarNamesAtPC(program, pc);
  const aliases = program.registerAliases;
  function regName(r: number): string {
    if (varNames?.has(r)) return `${varNames.get(r)}(r${r})`;
    if (aliases?.has(r)) return `${aliases.get(r)}(r${r})`;
    return `r${r}`;
  }

  switch (op) {
    case Opcode.SENSE: return `SENSE ${SENSE_NAMES[a0] ?? a0} ${regName(a1)}`;
    case Opcode.SMELL: return `SMELL ${formatOperand(a0, flags, 0, "channel")} ${regName(a1)}`;
    case Opcode.SNIFF: return `SNIFF ${formatOperand(a0, flags, 0, "channel")} ${formatOperand(a1, flags, 1, "dir")} ${regName(a2)}`;
    case Opcode.PROBE: return `PROBE ${formatOperand(a0, flags, 0, "dir")} ${regName(a1)}`;
    case Opcode.CARRYING: return `CARRYING ${regName(a0)}`;
    case Opcode.ID: return `ID ${regName(a0)}`;
    case Opcode.SET: {
      const src = (flags & 2) ? formatOperand(a1, flags, 1, "magicreg") : String(a1);
      return `SET ${regName(a0)} ${src}`;
    }
    case Opcode.ADD: return `ADD ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.SUB: return `SUB ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.MOD: return `MOD ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.MUL: return `MUL ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.DIV: return `DIV ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.AND: return `AND ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.OR:  return `OR ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.XOR: return `XOR ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.LSHIFT: return `LSHIFT ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.RSHIFT: return `RSHIFT ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.RANDOM: return `RANDOM ${regName(a0)} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.MARK: return `MARK ${formatOperand(a0, flags, 0, "channel")} ${formatOperand(a1, flags, 1, "lit")}`;
    case Opcode.JMP: return `JMP ${formatOperand(a0, flags, 0, "lit")}`;
    case Opcode.CALL: return `CALL ${regName(a0)} ${a1}`;
    case Opcode.JEQ: return `JEQ ${formatOperand(a0, flags, 0, "lit")} ${formatOperand(a1, flags, 1, "lit")} ${a2}`;
    case Opcode.JNE: return `JNE ${formatOperand(a0, flags, 0, "lit")} ${formatOperand(a1, flags, 1, "lit")} ${a2}`;
    case Opcode.JGT: return `JGT ${formatOperand(a0, flags, 0, "lit")} ${formatOperand(a1, flags, 1, "lit")} ${a2}`;
    case Opcode.JLT: return `JLT ${formatOperand(a0, flags, 0, "lit")} ${formatOperand(a1, flags, 1, "lit")} ${a2}`;
    case Opcode.MOVE: return `MOVE ${formatOperand(a0, flags, 0, "dir")}`;
    case Opcode.PICKUP: return "PICKUP";
    case Opcode.DROP: return "DROP";
    case Opcode.NOP: return "NOP";
    case Opcode.TAG: return `TAG ${formatOperand(a0, flags, 0, "lit")}`;
    case Opcode.ABORT: return `ABORT ${formatOperand(a0, flags, 0, "lit")}`;
    default: return `${name} ${a0} ${a1} ${a2}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Sensor computation (mirrors stepAnt's sensing logic)
// ═══════════════════════════════════════════════════════════════════════════════

function computeSensors(ant: any, map: any, antGrid: any) {
  const mapW = map.width, mapH = map.height;
  const cells = map.cells, food = map.food, pheromones = map.pheromones;
  const ax = ant.x, ay = ant.y;

  // SNIFF for each channel — raw pheromone values in all directions + HERE
  const sniffResults: { here: number; n: number; e: number; s: number; w: number }[] = [];
  for (let ch = 0; ch < NUM_PHEROMONE_CHANNELS; ch++) {
    const here = pheromones[(ay * mapW + ax) * NUM_PHEROMONE_CHANNELS + ch];
    const n = ay > 0       ? pheromones[((ay - 1) * mapW + ax) * NUM_PHEROMONE_CHANNELS + ch] : 0;
    const e = ax < mapW - 1 ? pheromones[(ay * mapW + ax + 1) * NUM_PHEROMONE_CHANNELS + ch] : 0;
    const s = ay < mapH - 1 ? pheromones[((ay + 1) * mapW + ax) * NUM_PHEROMONE_CHANNELS + ch] : 0;
    const w = ax > 0       ? pheromones[(ay * mapW + ax - 1) * NUM_PHEROMONE_CHANNELS + ch] : 0;
    sniffResults.push({ here, n, e, s, w });
  }

  // PROBE for each direction
  const probeResults: string[] = [];
  for (let dir = 1; dir <= 4; dir++) {
    const nx = ax + DIR_DX[dir], ny = ay + DIR_DY[dir];
    if (nx < 0 || nx >= mapW || ny < 0 || ny >= mapH) {
      probeResults.push("WALL");
      continue;
    }
    const idx = ny * mapW + nx;
    const c = cells[idx];
    if (c === CellType.WALL) probeResults.push("WALL");
    else if (food[idx] > 0) probeResults.push("FOOD");
    else if (c === CellType.NEST) probeResults.push("NEST");
    else probeResults.push("EMPTY");
  }

  return { sniffResults, probeResults };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Display helpers
// ═══════════════════════════════════════════════════════════════════════════════

function printInfo(state: DebugState, antId?: number) {
  const id = antId ?? state.currentAntId;
  const ant = state.world.ants[id];
  if (!ant) { console.log(`Invalid ant ID: ${id}`); return; }

  const tagName = state.program.tagNames?.get(ant.tag) ?? `tag${ant.tag}`;
  // Prefer per-PC variable names from .varmap, fall back to static .alias
  const varNames = getVarNamesAtPC(state.program, ant.pc);
  const aliases = state.program.registerAliases;

  console.log(`Ant #${id}  tick=${state.world.tick}  pc=${ant.pc}  tag=${tagName}  pos=(${ant.x},${ant.y})  carrying=${ant.carrying}  aborted=${ant._aborted ?? "no"}`);

  // GP registers
  let regLine = "Registers:\n";
  for (let r = 0; r < NUM_REGISTERS; r++) {
    const varName = varNames?.get(r);
    const alias = aliases?.get(r);
    const label = varName ? `${varName}(r${r})` : alias ? `${alias}(r${r})` : `r${r}`;
    const uval = (ant.regs[r] >>> 0).toString(16).padStart(8, "0");
    const dval = ant.regs[r].toString(10).padStart(10);
    regLine += `  ${label.padEnd(10)} = 0x${uval} (${dval})`;
    if (r === 1 || r === 3 || r === 5 || r === 7) regLine += "\n";
  }
  console.log(regLine);

  // Sensors
  const { sniffResults, probeResults } = computeSensors(ant, state.world.map, state.world.antGrid);
  console.log("Sensors:");
  console.log(`  PROBE N=${probeResults[0]}  E=${probeResults[1]}  S=${probeResults[2]}  W=${probeResults[3]}`);
  for (let ch = 0; ch < NUM_PHEROMONE_CHANNELS; ch++) {
    const s = sniffResults[ch];
    console.log(`  SNIFF ${CH_NAMES[ch].padEnd(12)} HERE(${s.here}) N(${s.n}) E(${s.e}) S(${s.s}) W(${s.w})`);
  }
  console.log(`  CARRYING=${ant.carrying ? 1 : 0}  ID=${id}`);
}

function printList(state: DebugState, addr?: number) {
  const ant = state.world.ants[state.currentAntId];
  const center = addr ?? (ant ? ant.pc : 0);
  const start = Math.max(0, center - 10);
  const end = Math.min(state.instrCount, center + 11);
  const lines = state.source.split("\n");
  const sourceLineNums = state.program.sourceLines;

  for (let pc = start; pc < end; pc++) {
    const marker = pc === (ant?.pc ?? -1) ? " > " : "   ";
    const srcLineNum = sourceLineNums[pc];
    const srcLine = srcLineNum > 0 ? lines[srcLineNum - 1]?.trim() ?? "" : "";
    const disasm = disassembleInstr(state.bytecode, pc, state.program);
    console.log(`${marker}${String(srcLineNum).padStart(4)}:  ${String(pc).padStart(4)}    ${disasm.padEnd(30)} ; ${srcLine}`);
  }
}

function printMapView(state: DebugState, antId?: number, what?: string) {
  const id = antId ?? state.currentAntId;
  const ant = state.world.ants[id];
  if (!ant) { console.log(`Invalid ant ID: ${id}`); return; }

  const map = state.world.map;
  const { width, height, cells, food, pheromones } = map;
  const antGrid = state.world.antGrid;
  const cx = ant.x, cy = ant.y;
  const show = what ?? "all";

  if (show === "all" || show === "space") {
    console.log("Space:");
    for (let dy = -2; dy <= 2; dy++) {
      let row = "";
      for (let dx = -2; dx <= 2; dx++) {
        if (dx > -2) row += " ";
        const x = cx + dx, y = cy + dy;
        if (dx === 0 && dy === 0) { row += "@"; continue; }
        if (x < 0 || x >= width || y < 0 || y >= height) { row += "#"; continue; }
        const idx = y * width + x;
        const c = cells[idx];
        if (c === CellType.WALL) row += "#";
        else if (c === CellType.NEST) row += "N";
        else if (food[idx] > 0) row += "*";
        else row += ".";
      }
      console.log(row);
    }
  }

  if (show === "all" || show === "ants") {
    console.log("Ants:");
    for (let dy = -2; dy <= 2; dy++) {
      let row = "";
      for (let dx = -2; dx <= 2; dx++) {
        if (dx > -2) row += " ";
        const x = cx + dx, y = cy + dy;
        if (dx === 0 && dy === 0) { row += "@"; continue; }
        if (x < 0 || x >= width || y < 0 || y >= height) { row += "#"; continue; }
        const idx = y * width + x;
        if (cells[idx] === CellType.WALL) row += "#";
        else if (antGrid[idx] > 0) row += antGrid[idx] > 9 ? "+" : String(antGrid[idx]);
        else row += ".";
      }
      console.log(row);
    }
  }

  if (show === "all" || show === "ph") {
    console.log("Pheromones (ch0  ch1  ch2  ch3):");
    for (let dy = -2; dy <= 2; dy++) {
      const parts: string[][] = [[], [], [], []];
      for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || x >= width || y < 0 || y >= height) {
          for (let ch = 0; ch < 4; ch++) parts[ch].push("##");
          continue;
        }
        const idx = y * width + x;
        if (cells[idx] === CellType.WALL) {
          for (let ch = 0; ch < 4; ch++) parts[ch].push("##");
          continue;
        }
        for (let ch = 0; ch < 4; ch++) {
          const val = pheromones[idx * NUM_PHEROMONE_CHANNELS + ch];
          parts[ch].push(val.toString(16).padStart(2, "0"));
        }
      }
      console.log(parts.map(p => p.join(" ")).join("   "));
    }
  }
}

function printWorld(state: DebugState) {
  const w = state.world;
  const totalFood = w.map.totalFood;
  const remaining = Array.from(w.map.food as Uint16Array).reduce((s: number, v: number) => s + v, 0);
  console.log(`Tick: ${w.tick}/${state.maxTicks}  Food: ${w.foodCollected} collected, ${remaining} remaining, ${totalFood} total`);
  console.log(`Map: ${w.map.name}  Size: ${w.map.width}x${w.map.height}  Nest: (${w.map.nestX},${w.map.nestY})  Ants: ${w.ants.length}`);
  if (w.stallCounts) console.log(`Stalls: ${w.stallCounts}`);
  if (w.abortCounts) console.log(`Aborts: ${w.abortCounts}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Command parsing and execution
// ═══════════════════════════════════════════════════════════════════════════════

function parseBreakArgs(tokens: string[]): Breakpoint | null {
  const bp: Breakpoint = { id: 0, regConditions: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--id") { bp.antId = parseInt(tokens[++i], 10); continue; }
    if (t === "--tick") { bp.tick = parseInt(tokens[++i], 10); continue; }
    if (t === "--pc") { bp.pc = parseInt(tokens[++i], 10); continue; }
    if (t === "--stall") { bp.stall = true; continue; }
    const regMatch = /^--r(\d)=(\d+)$/.exec(t);
    if (regMatch) {
      bp.regConditions.push({ reg: parseInt(regMatch[1]), val: parseInt(regMatch[2]) });
      continue;
    }
    console.log(`Unknown breakpoint flag: ${t}`);
    return null;
  }
  return bp;
}

function parseWatchArgs(tokens: string[]): Watchpoint | null {
  const wp: Watchpoint = { id: 0 };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--action") { wp.action = tokens[++i]?.toUpperCase(); continue; }
    if (t === "--pos") {
      const [x, y] = tokens[++i].split(",").map(Number);
      wp.x = x; wp.y = y;
      continue;
    }
    console.log(`Unknown watchpoint flag: ${t}`);
    return null;
  }
  return wp;
}

function executeCommand(state: DebugState, line: string): "continue" | "quit" | "prompt" {
  const trimmed = line.trim();
  if (!trimmed) return "prompt";

  const tokens = trimmed.split(/\s+/);
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  switch (cmd) {
    case "help":
    case "h":
      console.log(`
Simulation control:
  continue (c)         Run until breakpoint or end
  forward N            Run N ticks forward
  tick                 Run one full tick; pause before current ant in next tick
  rewind N             Rewind N ticks
  world                Print world info
  quit (q)             Exit

Breakpoints:
  break [flags]        Add breakpoint (--id N, --tick N, --pc N, --stall, --rX=Y)
  break list           List breakpoints
  break del ID         Delete breakpoint

Watchpoints:
  watch [flags]        Add watchpoint (--action MOVE|PICKUP|DROP, --pos X,Y)
  watch list           List watchpoints
  watch del ID         Delete watchpoint

Inspection (when paused):
  info (i) [ID]        Ant status + sensors
  list (l) [ADDR]      Disassembly around PC or ADDR
  step (s)             Step one instruction
  map [ID] [space|ants|ph|all]   5×5 map views around ant
`);
      return "prompt";

    case "continue":
    case "c": {
      const result = runUntilBreak(state);
      if (result.reason === "breakpoint") {
        console.log(`Breakpoint hit: ant #${result.antId} at tick ${state.world.tick}, pc=${state.world.ants[result.antId!].pc}`);
      } else if (result.reason === "watchpoint") {
        const wp = result.watchpoint!;
        const ant = state.world.ants[result.antId!];
        console.log(`Watchpoint #${wp.id} hit: ant #${result.antId} ${wp.action ?? "action"} at (${ant.x},${ant.y}), tick ${state.world.tick}`);
      } else if (result.reason === "abort") {
        const ant = state.world.ants[result.antId!];
        console.log(`Ant #${result.antId} aborted (code ${ant._aborted}) at tick ${state.world.tick}, pc=${ant.pc}`);
      } else if (result.reason === "stall") {
        const ant = state.world.ants[result.antId!];
        console.log(`Ant #${result.antId} stalled at tick ${state.world.tick}, pc=${ant.pc}`);
      } else {
        console.log(`Simulation ended at tick ${state.world.tick}. Food collected: ${state.world.foodCollected}/${state.world.map.totalFood}`);
      }
      return "prompt";
    }

    case "forward": {
      const n = parseInt(rest[0], 10) || 1;
      const targetTick = state.world.tick + n;
      // Set a temporary tick breakpoint
      const tempBp: Breakpoint = { id: -1, tick: targetTick, antId: 0, regConditions: [] };
      state.breakpoints.push(tempBp);
      const result = runUntilBreak(state);
      state.breakpoints = state.breakpoints.filter(b => b !== tempBp);
      if (result.reason === "breakpoint" && state.world.tick === targetTick) {
        console.log(`Advanced to tick ${state.world.tick}.`);
      } else if (result.reason === "breakpoint") {
        console.log(`Breakpoint hit at tick ${state.world.tick}, ant #${result.antId}`);
      } else if (result.reason === "watchpoint") {
        const wp = result.watchpoint!;
        console.log(`Watchpoint #${wp.id} hit at tick ${state.world.tick}, ant #${result.antId}`);
      } else if (result.reason === "abort") {
        const ant = state.world.ants[result.antId!];
        console.log(`Ant #${result.antId} aborted (code ${ant._aborted}) at tick ${state.world.tick}, pc=${ant.pc}`);
      } else if (result.reason === "stall") {
        const ant = state.world.ants[result.antId!];
        console.log(`Ant #${result.antId} stalled at tick ${state.world.tick}, pc=${ant.pc}`);
      } else {
        console.log(`Simulation ended at tick ${state.world.tick}.`);
      }
      return "prompt";
    }

    case "tick": {
      const resumeAntId = state.currentAntId;
      const targetTick = state.world.tick + 1;

      const tempBp: Breakpoint = {
        id: -1,
        tick: targetTick,
        antId: resumeAntId,
        regConditions: [],
      };
      state.breakpoints.push(tempBp);
      const result = runUntilBreak(state);
      state.breakpoints = state.breakpoints.filter(b => b !== tempBp);

      if (result.reason === "breakpoint" && state.world.tick === targetTick) {
        console.log(`Tick complete. Paused at tick ${state.world.tick} before ant #${resumeAntId}.`);
      } else if (result.reason === "abort") {
        const ant = state.world.ants[result.antId!];
        console.log(`Ant #${result.antId} aborted (code ${ant._aborted}) at tick ${state.world.tick}, pc=${ant.pc}`);
      } else if (result.reason === "stall") {
        const ant = state.world.ants[result.antId!];
        console.log(`Ant #${result.antId} stalled at tick ${state.world.tick}, pc=${ant.pc}`);
      } else if (result.reason === "watchpoint") {
        const wp = result.watchpoint!;
        const ant = state.world.ants[result.antId!];
        console.log(`Watchpoint #${wp.id} hit: ant #${result.antId} at (${ant.x},${ant.y}), tick ${state.world.tick}`);
      } else {
        console.log(`Simulation ended at tick ${state.world.tick}.`);
      }
      return "prompt";
    }

    case "rewind": {
      const n = parseInt(rest[0], 10) || 1;
      const targetTick = Math.max(0, state.world.tick - n);
      // Find closest snapshot at or before targetTick
      let bestTick = -1;
      for (const t of state.snapshots.keys()) {
        if (t <= targetTick && t > bestTick) bestTick = t;
      }
      if (bestTick < 0) {
        console.log(`No snapshot available at or before tick ${targetTick}.`);
        return "prompt";
      }
      restoreToTick(state, bestTick);
      if (bestTick < targetTick) {
        // Replay forward to exact tick
        const tempBp: Breakpoint = { id: -1, tick: targetTick, antId: 0, regConditions: [] };
        state.breakpoints.push(tempBp);
        runUntilBreak(state);
        state.breakpoints = state.breakpoints.filter(b => b !== tempBp);
      }
      console.log(`Rewound to tick ${state.world.tick}.`);
      return "prompt";
    }

    case "world":
      printWorld(state);
      return "prompt";

    case "quit":
    case "q":
      return "quit";

    case "break":
    case "b": {
      if (rest[0] === "list") {
        if (state.breakpoints.length === 0) { console.log("No breakpoints."); return "prompt"; }
        for (const bp of state.breakpoints) {
          const parts: string[] = [`#${bp.id}`];
          if (bp.antId !== undefined) parts.push(`id=${bp.antId}`);
          if (bp.tick !== undefined) parts.push(`tick=${bp.tick}`);
          if (bp.pc !== undefined) parts.push(`pc=${bp.pc}`);
          if (bp.stall) parts.push(`stall`);
          for (const rc of bp.regConditions) parts.push(`r${rc.reg}=${rc.val}`);
          console.log(`  ${parts.join(" ")}`);
        }
        return "prompt";
      }
      if (rest[0] === "del") {
        if (rest[1] === "all") {
          const count = state.breakpoints.length;
          state.breakpoints.length = 0;
          console.log(`Deleted ${count} breakpoint${count !== 1 ? "s" : ""}`);
          return "prompt";
        }
        const delId = parseInt(rest[1], 10);
        const idx = state.breakpoints.findIndex(b => b.id === delId);
        if (idx < 0) { console.log(`No breakpoint #${delId}`); return "prompt"; }
        state.breakpoints.splice(idx, 1);
        console.log(`Deleted breakpoint #${delId}`);
        return "prompt";
      }
      const bp = parseBreakArgs(rest);
      if (!bp) return "prompt";
      bp.id = state.nextBreakpointId++;
      state.breakpoints.push(bp);
      const desc: string[] = [];
      if (bp.antId !== undefined) desc.push(`id=${bp.antId}`);
      if (bp.tick !== undefined) desc.push(`tick=${bp.tick}`);
      if (bp.pc !== undefined) desc.push(`pc=${bp.pc}`);
      if (bp.stall) desc.push(`stall`);
      for (const rc of bp.regConditions) desc.push(`r${rc.reg}=${rc.val}`);
      console.log(`Breakpoint #${bp.id} added: ${desc.join(" ") || "(always)"}`);
      return "prompt";
    }

    case "watch":
    case "w": {
      if (rest[0] === "list") {
        if (state.watchpoints.length === 0) { console.log("No watchpoints."); return "prompt"; }
        for (const wp of state.watchpoints) {
          const parts: string[] = [`#${wp.id}`];
          if (wp.action) parts.push(`action=${wp.action}`);
          if (wp.x !== undefined) parts.push(`pos=${wp.x},${wp.y}`);
          console.log(`  ${parts.join(" ")}`);
        }
        return "prompt";
      }
      if (rest[0] === "del") {
        const delId = parseInt(rest[1], 10);
        const idx = state.watchpoints.findIndex(w => w.id === delId);
        if (idx < 0) { console.log(`No watchpoint #${delId}`); return "prompt"; }
        state.watchpoints.splice(idx, 1);
        console.log(`Deleted watchpoint #${delId}`);
        return "prompt";
      }
      const wp = parseWatchArgs(rest);
      if (!wp) return "prompt";
      wp.id = state.nextWatchpointId++;
      state.watchpoints.push(wp);
      const desc: string[] = [];
      if (wp.action) desc.push(`action=${wp.action}`);
      if (wp.x !== undefined) desc.push(`pos=${wp.x},${wp.y}`);
      console.log(`Watchpoint #${wp.id} added: ${desc.join(" ") || "(always)"}`);
      return "prompt";
    }

    case "info":
    case "i": {
      const id = rest.length > 0 ? parseInt(rest[0], 10) : undefined;
      printInfo(state, id);
      return "prompt";
    }

    case "list":
    case "l": {
      const addr = rest.length > 0 ? parseInt(rest[0], 10) : undefined;
      printList(state, addr);
      return "prompt";
    }

    case "step":
    case "s": {
      const ant = state.world.ants[state.currentAntId];
      if (ant._aborted !== undefined) {
        console.log(`Ant #${state.currentAntId} is aborted (code ${ant._aborted}).`);
        return "prompt";
      }
      // Ensure tick state is initialized
      if (!state.tickProgress.tickStarted) {
        beginTick(state.world);
        state.tickProgress.tickStarted = true;
      }
      // Populate magic registers
      ant.regs[REG_FD] = state.world.foodCollected;
      ant.regs[REG_CL] = state.world.tick;
      ant.regs[REG_PX] = ant.x;
      ant.regs[REG_PY] = ant.y;
      ant.regs[REG_PC] = ant.pc;

      const prevPc = ant.pc;
      const prevX = ant.x, prevY = ant.y, prevCarrying = ant.carrying;
      const rng = getTickRng();
      const delivered = stepAnt(ant, state.currentAntId, state.bytecode, state.instrCount,
        state.world.map, 0, rng, 1, state.world.antGrid, state.config.senseRange, -1, state.isa === 'debug');
      if (delivered) state.world.foodCollected++;

      const disasm = disassembleInstr(state.bytecode, prevPc, state.program);

      if (ant._aborted !== undefined) {
        console.log(`  ${String(prevPc).padStart(4)}  ${disasm} → ABORTED (code ${ant._aborted})`);
        return "prompt";
      }

      const moved = ant.x !== prevX || ant.y !== prevY;
      const pickedUp = !prevCarrying && ant.carrying;
      const dropped = prevCarrying && !ant.carrying;

      let actionMsg = "";
      if (moved) actionMsg = ` → moved to (${ant.x},${ant.y})`;
      if (pickedUp) actionMsg = " → picked up food";
      if (dropped) actionMsg = delivered ? " → delivered food to nest!" : " → dropped food";

      console.log(`  ${String(prevPc).padStart(4)}  ${disasm}${actionMsg}`);

      if (moved || pickedUp || dropped) {
        console.log("  (action executed — tick ended for this ant)");
        state.world.map.visitCounts[ant.y * state.world.map.width + ant.x]++;
      }
      return "prompt";
    }

    case "map": {
      let id: number | undefined;
      let what: string | undefined;
      for (const r of rest) {
        if (/^\d+$/.test(r)) id = parseInt(r, 10);
        else what = r;
      }
      printMapView(state, id, what);
      return "prompt";
    }

    default:
      console.log(`Unknown command: "${cmd}". Type "help" for commands.`);
      return "prompt";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs(process.argv);

  // Load and assemble
  const filePath = path.resolve(opts.file);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  const source = fs.readFileSync(filePath, "utf-8");
  const isa = opts.allowAbort ? 'debug' : 'prod';
  const program = parseAssembly(source, { isa });
  const bytecode = compileBytecode(program);
  const instrCount = program.instructions.length;

  // Generate map — use the same eval-map derivation as the test runner
  const allMaps = generateEvalMaps(DEFAULT_CONFIG.mapWidth, DEFAULT_CONFIG.mapHeight, opts.seed, 12);
  let map: any;
  if (opts.mapName) {
    // Try exact match first, then prefix match (e.g. "open" matches "open-38bs6g")
    let match = allMaps.find((m: any) => m.name === opts.mapName);
    if (!match) {
      const prefix = opts.mapName + "-";
      const prefixMatches = allMaps.filter((m: any) => m.name.startsWith(prefix));
      if (prefixMatches.length === 1) {
        match = prefixMatches[0];
      } else if (prefixMatches.length > 1) {
        console.error(`Multiple maps match "${opts.mapName}":`);
        for (const m of prefixMatches) console.error(`  ${m.name}`);
        process.exit(1);
      }
    }
    if (!match) {
      console.error(`Map "${opts.mapName}" not found. Available maps:`);
      for (const m of allMaps) console.error(`  ${m.name}`);
      process.exit(1);
    }
    map = match;
  } else {
    map = allMaps[0];
  }

  const config = { ...DEFAULT_CONFIG, antCount: opts.antCount };
  const world = createWorld(cloneMap(map), program, config);

  const state: DebugState = {
    world,
    config,
    program,
    source,
    sourceLines: source.split("\n"),
    bytecode,
    instrCount,
    currentAntId: 0,
    breakpoints: [],
    watchpoints: [],
    nextBreakpointId: 1,
    nextWatchpointId: 1,
    tickProgress: { nextAntIndex: 0, tickStarted: false, skipBreakOnResume: false },
    snapshots: new Map(),
    maxSnapshots: 2000,
    maxTicks: config.maxTicks,
    isa,
  };

  console.log(`Loaded ${filePath}`);
  console.log(`  ${instrCount} instructions, map=${map.name}, seed=${opts.seed}, ants=${config.antCount}`);
  console.log(`  Food: ${map.totalFood} total, ticks: ${config.maxTicks}`);
  console.log(`Type "help" for commands.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "dbg> ",
  });

  rl.prompt();

  rl.on("line", (line: string) => {
    const result = executeCommand(state, line);
    if (result === "quit") {
      rl.close();
      return;
    }
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("Goodbye.");
    process.exit(0);
  });
}

main();
