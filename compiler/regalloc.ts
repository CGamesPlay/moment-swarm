// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 5: Register Allocation
// ═══════════════════════════════════════════════════════════════

import { SSAProgram, BasicBlock, SSAInstr, PhiNode, Terminator } from './ssa';

// ─── Linearize Blocks (Reverse Postorder) ───────────────────

function isTrivialJmp(block: BasicBlock): boolean {
  return block.instrs.length === 0
    && block.phis.length === 0
    && block.terminator?.op === 'jmp';
}

export function linearizeBlocks(program: SSAProgram): BasicBlock[] {
  // Greedy layout: start from entry, always choose the preferred fall-through
  // successor next.  For br_cmp with gt/lt (true-jump only), elseBlock is the
  // preferred fall-through; for ge/le (false-jump only), thenBlock is.
  // For eq/ne (both jumps available), prefer non-trivial successors over
  // trivial jmp-only blocks, then fall back to the lower-indexed successor.
  //
  // When the preferred successor is already placed, fall back to the other
  // successor, then to reverse-postorder for the remaining blocks.

  const blockIndex = new Map<BasicBlock, number>();
  for (let i = 0; i < program.blocks.length; i++) {
    blockIndex.set(program.blocks[i], i);
  }

  // First compute reverse-postorder as a fallback ordering.
  const visited = new Set<BasicBlock>();
  const postorder: BasicBlock[] = [];
  function dfs(block: BasicBlock): void {
    if (visited.has(block)) return;
    visited.add(block);
    const succs = [...block.succs].sort((a, b) =>
      (blockIndex.get(b) ?? 0) - (blockIndex.get(a) ?? 0));
    for (const succ of succs) {
      dfs(succ);
    }
    postorder.push(block);
  }
  dfs(program.entryBlock);
  const rpo = postorder.reverse();

  // Build the layout greedily.
  const placed = new Set<BasicBlock>();
  const layout: BasicBlock[] = [];

  // Queue of blocks to lay out, seeded with RPO order.
  // We use a worklist: process the first unplaced block, lay it out,
  // then follow fall-through chains.
  const rpoQueue = [...rpo];

  while (rpoQueue.length > 0 || layout.length < rpo.length) {
    // Pick the next unplaced block from RPO order
    let next: BasicBlock | undefined;
    while (rpoQueue.length > 0) {
      const candidate = rpoQueue.shift()!;
      if (!placed.has(candidate)) {
        next = candidate;
        break;
      }
    }
    if (!next) break;

    // Follow the fall-through chain from this block
    let current: BasicBlock | undefined = next;
    while (current && !placed.has(current)) {
      placed.add(current);
      layout.push(current);

      // Determine the preferred fall-through successor
      const term: Terminator | null = current.terminator;
      current = undefined;
      if (!term) continue;

      if (term.op === 'jmp') {
        // Follow jmp fall-through when all predecessors of the target are
        // already placed — the last predecessor can safely claim fall-through
        // without stealing it from br_cmp predecessors that still need it.
        if (!placed.has(term.target) && term.target.preds.every(p => placed.has(p))) {
          current = term.target;
        }
      } else if (term.op === 'br_cmp') {
        const { cmpOp, thenBlock, elseBlock } = term;
        let preferred: BasicBlock;
        let other: BasicBlock;
        if (cmpOp === 'gt' || cmpOp === 'lt') {
          // Only true-jump exists → elseBlock must be fall-through
          preferred = elseBlock;
          other = thenBlock;
        } else if (cmpOp === 'ge' || cmpOp === 'le') {
          // Only false-jump exists → thenBlock must be fall-through
          preferred = thenBlock;
          other = elseBlock;
        } else {
          // eq/ne: both jumps available.
          // Prefer non-trivial successor (has instructions/phis) over a
          // trivial jmp-only block.  Fall back to lower-indexed.
          const tTrivial = isTrivialJmp(thenBlock);
          const eTrivial = isTrivialJmp(elseBlock);
          if (tTrivial !== eTrivial) {
            preferred = tTrivial ? elseBlock : thenBlock;
            other = tTrivial ? thenBlock : elseBlock;
          } else {
            const ti = blockIndex.get(thenBlock) ?? 0;
            const ei = blockIndex.get(elseBlock) ?? 0;
            preferred = ti < ei ? thenBlock : elseBlock;
            other = ti < ei ? elseBlock : thenBlock;
          }
        }
        if (!placed.has(preferred)) {
          current = preferred;
        } else if (!placed.has(other)) {
          current = other;
        }
      }
    }
  }

  return layout;
}

// ─── Instruction Numbering ──────────────────────────────────

export interface NumberedInstr {
  index: number;
  block: BasicBlock;
  kind: 'phi' | 'instr' | 'terminator';
  phi?: PhiNode;
  instr?: SSAInstr;
  terminator?: Terminator;
}

export function numberInstructions(blocks: BasicBlock[]): NumberedInstr[] {
  const numbered: NumberedInstr[] = [];
  let index = 0;

  for (const block of blocks) {
    for (const phi of block.phis) {
      numbered.push({ index: index++, block, kind: 'phi', phi });
    }
    for (const instr of block.instrs) {
      numbered.push({ index: index++, block, kind: 'instr', instr });
    }
    if (block.terminator) {
      numbered.push({ index: index++, block, kind: 'terminator', terminator: block.terminator });
    }
  }

  return numbered;
}

// ─── Block-Level Liveness Analysis ──────────────────────────

interface BlockLiveness {
  def: Set<string>;
  use: Set<string>;
  liveIn: Set<string>;
  liveOut: Set<string>;
}

function isTemp(v: string | number): v is string {
  return typeof v === 'string' && v.startsWith('%t');
}

export function computeBlockLiveness(blocks: BasicBlock[]): Map<BasicBlock, BlockLiveness> {
  const liveness = new Map<BasicBlock, BlockLiveness>();
  for (const block of blocks) {
    liveness.set(block, { def: new Set(), use: new Set(), liveIn: new Set(), liveOut: new Set() });
  }

  // Compute local def/use sets for each block
  for (const block of blocks) {
    const info = liveness.get(block)!;

    // Phi defs go in def set (phi uses are attributed to predecessors)
    for (const phi of block.phis) {
      info.def.add(phi.dest);
    }

    // Regular instructions
    for (const instr of block.instrs) {
      for (const arg of instr.args) {
        if (isTemp(arg) && !info.def.has(arg)) {
          info.use.add(arg);
        }
      }
      if (instr.dest) {
        info.def.add(instr.dest);
      }
    }

    // Terminator uses
    if (block.terminator?.op === 'br_cmp') {
      if (isTemp(block.terminator.a) && !info.def.has(block.terminator.a)) {
        info.use.add(block.terminator.a);
      }
      if (isTemp(block.terminator.b) && !info.def.has(block.terminator.b)) {
        info.use.add(block.terminator.b);
      }
    }
  }

  // Attribute phi uses to predecessor blocks' liveOut
  // (done during fixpoint iteration below)

  // Fixpoint iteration (backward dataflow)
  let changed = true;
  while (changed) {
    changed = false;
    // Iterate in reverse order for faster convergence
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const info = liveness.get(block)!;

      // liveOut = union of liveIn of all successors + phi uses attributed to this block
      const newLiveOut = new Set<string>();

      for (const succ of block.succs) {
        const succInfo = liveness.get(succ)!;
        for (const temp of succInfo.liveIn) {
          newLiveOut.add(temp);
        }
        // Phi uses: if succ has a phi with an entry from this block, that use is live-out here
        for (const phi of succ.phis) {
          for (const entry of phi.entries) {
            if (entry.block === block && isTemp(entry.value)) {
              newLiveOut.add(entry.value);
            }
          }
        }
      }

      // liveIn = use union (liveOut - def)
      const newLiveIn = new Set(info.use);
      for (const temp of newLiveOut) {
        if (!info.def.has(temp)) {
          newLiveIn.add(temp);
        }
      }

      // Check for changes
      if (newLiveOut.size !== info.liveOut.size || newLiveIn.size !== info.liveIn.size) {
        changed = true;
      } else {
        for (const t of newLiveOut) {
          if (!info.liveOut.has(t)) { changed = true; break; }
        }
        if (!changed) {
          for (const t of newLiveIn) {
            if (!info.liveIn.has(t)) { changed = true; break; }
          }
        }
      }

      info.liveOut = newLiveOut;
      info.liveIn = newLiveIn;
    }
  }

  return liveness;
}

// ─── Live Intervals ─────────────────────────────────────────

export interface LiveInterval {
  temp: string;
  start: number;
  end: number;
}

export function computeLiveIntervals(blocks: BasicBlock[], numbered: NumberedInstr[]): LiveInterval[] {
  const liveness = computeBlockLiveness(blocks);

  // Group numbered instructions by block
  const blockInstrs = new Map<BasicBlock, NumberedInstr[]>();
  for (const block of blocks) blockInstrs.set(block, []);
  for (const item of numbered) {
    blockInstrs.get(item.block)!.push(item);
  }

  // Collect per-block sub-ranges for each temp
  const ranges = new Map<string, [number, number][]>();

  function addRange(temp: string, start: number, end: number) {
    let list = ranges.get(temp);
    if (!list) { list = []; ranges.set(temp, list); }
    list.push([start, end]);
  }

  for (const block of blocks) {
    const info = liveness.get(block)!;
    const instrs = blockInstrs.get(block)!;
    if (instrs.length === 0) continue;

    const bStart = instrs[0].index;
    const bEnd = instrs[instrs.length - 1].index;

    // Initialize live set from liveOut
    const live = new Set(info.liveOut);

    // Track end point for each temp within this block
    const blockEnd = new Map<string, number>();

    // Everything in liveOut is live at block end
    for (const temp of live) {
      blockEnd.set(temp, bEnd);
    }

    // Walk instructions backward within the block
    for (let i = instrs.length - 1; i >= 0; i--) {
      const item = instrs[i];

      // Process defs: temp is defined here, remove from live set
      if (item.kind === 'phi' && item.phi) {
        const dest = item.phi.dest;
        if (live.delete(dest)) {
          addRange(dest, item.index, blockEnd.get(dest)!);
          blockEnd.delete(dest);
        } else {
          // Defined but not live after — still need an interval for it
          addRange(dest, item.index, item.index);
        }
      } else if (item.kind === 'instr' && item.instr?.dest) {
        const dest = item.instr.dest;
        if (live.delete(dest)) {
          addRange(dest, item.index, blockEnd.get(dest)!);
          blockEnd.delete(dest);
        } else {
          addRange(dest, item.index, item.index);
        }
      }

      // Process uses: temp is used here, add to live set
      const uses: string[] = [];
      if (item.kind === 'instr' && item.instr) {
        for (const arg of item.instr.args) {
          if (isTemp(arg)) uses.push(arg);
        }
      } else if (item.kind === 'terminator' && item.terminator) {
        if (item.terminator.op === 'br_cmp') {
          if (isTemp(item.terminator.a)) uses.push(item.terminator.a);
          if (isTemp(item.terminator.b)) uses.push(item.terminator.b);
        }
      }
      // Phi uses are NOT processed here — they're attributed to predecessors

      for (const use of uses) {
        if (!live.has(use)) {
          live.add(use);
          blockEnd.set(use, item.index);
        }
      }
    }

    // Anything still in live set is liveIn — emit range from block start
    for (const temp of live) {
      addRange(temp, bStart, blockEnd.get(temp)!);
    }
  }

  // Sort each temp's ranges by start and merge overlapping/adjacent ones
  const intervals: LiveInterval[] = [];
  for (const [temp, rawRanges] of ranges) {
    rawRanges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [rawRanges[0]];
    for (let i = 1; i < rawRanges.length; i++) {
      const prev = merged[merged.length - 1];
      const [s, e] = rawRanges[i];
      if (s <= prev[1] + 1) {
        // Overlapping or adjacent — merge
        prev[1] = Math.max(prev[1], e);
      } else {
        merged.push([s, e]);
      }
    }
    for (const [start, end] of merged) {
      intervals.push({ temp, start, end });
    }
  }

  return intervals;
}

// ─── Linear Scan Allocator ──────────────────────────────────

export interface AllocationResult {
  allocation: Map<string, string>;  // temp → register (r0-r7)
  phiCopies: { block: BasicBlock; from: string; to: string }[];
}

export function linearScan(
  program: SSAProgram,
  intervals: LiveInterval[],
): AllocationResult {
  // Helper to format a register allocation with variable name if available
  const regLabel = (reg: number, temp: string) => {
    const varName = program.tempNames?.get(temp);
    return varName ? `r${reg}=${varName}(${temp})` : `r${reg}=${temp}`;
  };

  // Helper to format a register allocation with source location on separate line
  const regLabelWithLocation = (reg: number, temp: string, indent: string = '  ') => {
    const varName = program.tempNames?.get(temp);
    const label = varName ? `${varName}(${temp})` : temp;
    const loc = program.tempLocs?.get(temp);
    const locStr = loc ? `${loc.file}:${loc.line}:${loc.col}` : '<unknown>';
    return `${indent}${locStr}: ${label} into r${reg}`;
  };

  // Sort by start
  const sorted = [...intervals].sort((a, b) => a.start - b.start);

  const allocation = new Map<string, string>();
  const active: { temp: string; end: number; reg: number }[] = [];
  const freeRegs = new Set([0, 1, 2, 3, 4, 5, 6, 7]);

  // Coalescing hints: collect phi pairs and copy pairs
  const hints = new Map<string, string>();  // temp → desired register (if already allocated)

  // First pass: collect coalescing hints from phis
  for (const block of program.blocks) {
    for (const phi of block.phis) {
      for (const entry of phi.entries) {
        if (entry.value.startsWith('%t')) {
          hints.set(phi.dest, entry.value);
        }
      }
    }
  }
  // Copy hints
  for (const block of program.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === 'copy' && instr.dest && instr.args.length === 1 && typeof instr.args[0] === 'string') {
        hints.set(instr.dest, instr.args[0] as string);
      }
    }
  }

  // Arithmetic operand hints: prefer dest in same register as first arg
  const arithOps = new Set([
    'add', 'sub', 'mul', 'div', 'mod',
    'and', 'or', 'xor', 'lshift', 'rshift',
  ]);
  for (const block of program.blocks) {
    for (const instr of block.instrs) {
      if (arithOps.has(instr.op) && instr.dest && typeof instr.args[0] === 'string') {
        if (!hints.has(instr.dest)) {
          hints.set(instr.dest, instr.args[0] as string);
        }
      }
    }
  }

  for (const interval of sorted) {
    // Expire old intervals
    const expired: number[] = [];
    for (let i = 0; i < active.length; i++) {
      if (active[i].end < interval.start) {
        freeRegs.add(active[i].reg);
        expired.push(i);
      }
    }
    // Remove expired (reverse order to preserve indices)
    for (let i = expired.length - 1; i >= 0; i--) {
      active.splice(expired[i], 1);
    }

    // Re-activation: if this temp was already allocated (previous range),
    // reclaim the same register for consistency
    if (allocation.has(interval.temp)) {
      const prevReg = parseInt(allocation.get(interval.temp)!.slice(1), 10);
      if (!freeRegs.has(prevReg)) {
        const varName = program.tempNames?.get(interval.temp);
        const failLabel = varName ? `${varName}(${interval.temp})` : interval.temp;
        const loc = program.tempLocs?.get(interval.temp);
        const prefix = loc ? `${loc.file}:${loc.line}:${loc.col}: ` : '';
        const activeLines = active.map(a => regLabelWithLocation(a.reg, a.temp)).join('\n');
        throw new Error(
          `${prefix}Register conflict — ${failLabel} was previously allocated r${prevReg} but it is not free. Active:\n${activeLines}`
        );
      }
      freeRegs.delete(prevReg);
      active.push({ temp: interval.temp, end: interval.end, reg: prevReg });
      active.sort((a, b) => a.end - b.end);
      continue;
    }

    // Try to honor coalescing hint
    let assigned = -1;
    const hintTemp = hints.get(interval.temp);
    if (hintTemp && allocation.has(hintTemp)) {
      const hintReg = parseInt(allocation.get(hintTemp)!.slice(1), 10);
      if (freeRegs.has(hintReg)) {
        assigned = hintReg;
      } else {
        // The hinted register is occupied. If the occupant's interval ends at
        // exactly this instruction (last use is the instruction that defines
        // interval.temp), we can expire it early — the two-operand instruction
        // reads the source before writing the dest, so the register is safe to
        // reuse.
        const occupantIdx = active.findIndex(a => a.reg === hintReg && a.end === interval.start);
        if (occupantIdx !== -1) {
          active.splice(occupantIdx, 1);
          freeRegs.add(hintReg);
          assigned = hintReg;
        }
      }
    }

    if (assigned === -1) {
      // Assign lowest free register
      if (freeRegs.size === 0) {
        const varName = program.tempNames?.get(interval.temp);
        const failLabel = varName ? `${varName}(${interval.temp})` : interval.temp;
        const loc = program.tempLocs?.get(interval.temp);
        const prefix = loc ? `${loc.file}:${loc.line}:${loc.col}: ` : '';
        const activeLines = active.map(a => regLabelWithLocation(a.reg, a.temp)).join('\n');
        throw new Error(
          `${prefix}Register exhaustion — all 8 registers in use. Cannot allocate ${failLabel}. Active:\n${activeLines}`
        );
      }
      assigned = Math.min(...freeRegs);
    }

    freeRegs.delete(assigned);
    allocation.set(interval.temp, `r${assigned}`);
    active.push({ temp: interval.temp, end: interval.end, reg: assigned });
    // Sort active by end
    active.sort((a, b) => a.end - b.end);
  }

  // Phi resolution: insert copies for phi entries that didn't coalesce
  const phiCopies: { block: BasicBlock; from: string; to: string }[] = [];
  for (const block of program.blocks) {
    for (const phi of block.phis) {
      const destReg = allocation.get(phi.dest);
      if (!destReg) continue;
      for (const entry of phi.entries) {
        let sourceReg: string;
        if (entry.value.startsWith('%t')) {
          sourceReg = allocation.get(entry.value) ?? entry.value;
        } else {
          sourceReg = entry.value;
        }
        if (sourceReg !== destReg) {
          phiCopies.push({ block: entry.block, from: sourceReg, to: destReg });
        }
      }
    }
  }

  return { allocation, phiCopies };
}

// ─── Apply Allocation ───────────────────────────────────────
// Replace all %tN with allocated registers in place

// ─── Per-Instruction Variable Map ────────────────────────────
// Build a mapping from numbered instruction index to the register→varName
// state at that point. Only records entries where the mapping changes.

export interface VarMapEntry {
  instrIndex: number;
  regs: Record<string, string>;  // register (e.g. "r0") → variable name
}

export function buildVarMap(
  numbered: NumberedInstr[],
  intervals: LiveInterval[],
  allocation: Map<string, string>,
  tempNames: Map<string, string>,
): VarMapEntry[] {
  // Sort intervals by start
  const sorted = [...intervals].sort((a, b) => a.start - b.start);

  // For each numbered instruction index, compute the set of active intervals
  // and derive register → varName. Record only at change points.
  const entries: VarMapEntry[] = [];
  const active: { temp: string; end: number }[] = [];
  let prevRegs: Record<string, string> = {};
  let intervalIdx = 0;

  for (const ni of numbered) {
    // Expire intervals that ended before this instruction
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].end < ni.index) {
        active.splice(i, 1);
      }
    }

    // Activate intervals that start at this instruction
    while (intervalIdx < sorted.length && sorted[intervalIdx].start <= ni.index) {
      const iv = sorted[intervalIdx];
      if (iv.end >= ni.index) {
        active.push({ temp: iv.temp, end: iv.end });
      }
      intervalIdx++;
    }

    // Build current register → varName mapping
    const regs: Record<string, string> = {};
    for (const a of active) {
      if (a.end < ni.index) continue;
      const reg = allocation.get(a.temp);
      const name = tempNames.get(a.temp);
      if (reg && name) {
        // If multiple temps map to the same register, prefer the one with the
        // latest start (most recently defined)
        regs[reg] = name;
      }
    }

    // Check if mapping changed
    const keys = Object.keys(regs).sort();
    const prevKeys = Object.keys(prevRegs).sort();
    let changed = keys.length !== prevKeys.length;
    if (!changed) {
      for (const k of keys) {
        if (regs[k] !== prevRegs[k]) { changed = true; break; }
      }
    }

    if (changed) {
      entries.push({ instrIndex: ni.index, regs: { ...regs } });
      prevRegs = { ...regs };
    }
  }

  return entries;
}

// ─── Apply Allocation ───────────────────────────────────────
// Replace all %tN with allocated registers in place

export function applyAllocation(program: SSAProgram, allocation: Map<string, string>): void {
  function replace(val: string | number): string | number {
    if (typeof val === 'string' && allocation.has(val)) {
      return allocation.get(val)!;
    }
    return val;
  }

  function replaceStr(val: string): string {
    return allocation.get(val) ?? val;
  }

  for (const block of program.blocks) {
    for (const phi of block.phis) {
      phi.dest = replaceStr(phi.dest);
      for (const entry of phi.entries) {
        entry.value = replaceStr(entry.value);
      }
    }

    for (const instr of block.instrs) {
      if (instr.dest) instr.dest = replaceStr(instr.dest);
      instr.args = instr.args.map(a => replace(a));
    }

    if (block.terminator?.op === 'br_cmp') {
      block.terminator.a = replace(block.terminator.a);
      block.terminator.b = replace(block.terminator.b);
    }
  }
}
