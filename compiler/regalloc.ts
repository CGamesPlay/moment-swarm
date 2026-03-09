// ═══════════════════════════════════════════════════════════════
// AntLisp v2 Pipeline — Phase 5: Register Allocation
// ═══════════════════════════════════════════════════════════════

import { SSAProgram, BasicBlock, SSAInstr, PhiNode, Terminator } from './ssa';

// ─── Linearize Blocks (Reverse Postorder) ───────────────────

export function linearizeBlocks(program: SSAProgram): BasicBlock[] {
  const visited = new Set<BasicBlock>();
  const postorder: BasicBlock[] = [];
  const blockIndex = new Map<BasicBlock, number>();
  for (let i = 0; i < program.blocks.length; i++) {
    blockIndex.set(program.blocks[i], i);
  }

  function dfs(block: BasicBlock): void {
    if (visited.has(block)) return;
    visited.add(block);
    // Visit higher-indexed successors first so that lower-indexed ones
    // (typically loop bodies) appear first in the reversed-postorder layout.
    const succs = [...block.succs].sort((a, b) =>
      (blockIndex.get(b) ?? 0) - (blockIndex.get(a) ?? 0));
    for (const succ of succs) {
      dfs(succ);
    }
    postorder.push(block);
  }

  dfs(program.entryBlock);
  return postorder.reverse();
}

// ─── Instruction Numbering ──────────────────────────────────

interface NumberedInstr {
  index: number;
  block: BasicBlock;
  kind: 'phi' | 'instr' | 'terminator';
  phi?: PhiNode;
  instr?: SSAInstr;
  terminator?: Terminator;
}

function numberInstructions(blocks: BasicBlock[]): NumberedInstr[] {
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

// ─── Live Intervals ─────────────────────────────────────────

export interface LiveInterval {
  temp: string;
  start: number;
  end: number;
}

export function computeLiveIntervals(numbered: NumberedInstr[]): LiveInterval[] {
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();

  for (const item of numbered) {
    // Defs
    if (item.kind === 'phi' && item.phi) {
      const dest = item.phi.dest;
      if (!starts.has(dest)) starts.set(dest, item.index);
    } else if (item.kind === 'instr' && item.instr?.dest) {
      const dest = item.instr.dest;
      if (!starts.has(dest)) starts.set(dest, item.index);
    }

    // Uses
    const uses: string[] = [];
    if (item.kind === 'phi' && item.phi) {
      for (const entry of item.phi.entries) {
        if (entry.value.startsWith('%t')) uses.push(entry.value);
      }
    } else if (item.kind === 'instr' && item.instr) {
      for (const arg of item.instr.args) {
        if (typeof arg === 'string' && arg.startsWith('%t')) uses.push(arg);
      }
    } else if (item.kind === 'terminator' && item.terminator) {
      const term = item.terminator;
      if (term.op === 'br_cmp') {
        if (typeof term.a === 'string' && term.a.startsWith('%t')) uses.push(term.a);
        if (typeof term.b === 'string' && term.b.startsWith('%t')) uses.push(term.b);
      }
    }

    for (const use of uses) {
      ends.set(use, item.index);
      // If used before defined (phi back-edge), set start to 0
      if (!starts.has(use)) starts.set(use, 0);
    }
  }

  const intervals: LiveInterval[] = [];
  for (const [temp, start] of starts) {
    const end = ends.get(temp) ?? start;
    intervals.push({ temp, start, end });
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

    // Try to honor coalescing hint
    let assigned = -1;
    const hintTemp = hints.get(interval.temp);
    if (hintTemp && allocation.has(hintTemp)) {
      const hintReg = parseInt(allocation.get(hintTemp)!.slice(1), 10);
      if (freeRegs.has(hintReg)) {
        assigned = hintReg;
      }
    }

    if (assigned === -1) {
      // Assign lowest free register
      if (freeRegs.size === 0) {
        throw new Error(
          `Register exhaustion — all 8 registers in use. ` +
          `Cannot allocate ${interval.temp} (live from ${interval.start} to ${interval.end}). ` +
          `Active: ${active.map(a => `${a.temp}=r${a.reg}`).join(', ')}`
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
