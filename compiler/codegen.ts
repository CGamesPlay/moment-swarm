// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 6: Code Generation
// ═══════════════════════════════════════════════════════════════

import { SSAProgram, BasicBlock, SSAInstr, Terminator, CmpOp } from './ssa';
import { AllocationResult, computeBlockLiveness } from './regalloc';

// ─── Compute Live Registers at Block Exits ──────────────────
// Must be called BEFORE applyAllocation (while blocks still have %t names).
// Returns a map from block → set of physical registers live at block exit.

export function computeLiveRegsAtEnd(
  program: SSAProgram,
  allocation: Map<string, string>,
): Map<BasicBlock, Set<string>> {
  const blockLiveness = computeBlockLiveness(program.blocks);
  const liveRegsAtEnd = new Map<BasicBlock, Set<string>>();
  for (const block of program.blocks) {
    const info = blockLiveness.get(block);
    if (!info) continue;
    const regs = new Set<string>();
    // Map liveOut SSA temps to their allocated registers
    for (const temp of info.liveOut) {
      const reg = allocation.get(temp);
      if (reg) regs.add(reg);
    }
    // Also include phi source/dest registers from successor phis
    // (covers constants and values that might not be in liveOut)
    for (const succ of block.succs) {
      for (const phi of succ.phis) {
        const destReg = allocation.get(phi.dest);
        if (destReg) regs.add(destReg);
        for (const entry of phi.entries) {
          if (entry.block === block && typeof entry.value === 'string' && entry.value.startsWith('%t')) {
            const sourceReg = allocation.get(entry.value);
            if (sourceReg) regs.add(sourceReg);
          }
        }
      }
    }
    if (regs.size > 0) liveRegsAtEnd.set(block, regs);
  }
  return liveRegsAtEnd;
}

// ─── Code Generation ────────────────────────────────────────

export function generateCode(
  program: SSAProgram,
  linearized: BasicBlock[],
  allocResult: AllocationResult,
  liveRegsAtEnd?: Map<BasicBlock, Set<string>>,
): string {
  const output: string[] = [];

  // Emit directives
  for (const t of program.tags) output.push(`.tag ${t.id} ${t.name}`);
  if (program.tags.length) output.push('');

  // Build phi copy map: block → copies to insert at end
  const phiCopiesPerBlock = new Map<BasicBlock, { from: string; to: string }[]>();
  for (const { block, from, to } of allocResult.phiCopies) {
    if (!phiCopiesPerBlock.has(block)) phiCopiesPerBlock.set(block, []);
    phiCopiesPerBlock.get(block)!.push({ from, to });
  }

  // If liveRegsAtEnd was not pre-computed (backward compat), fall back to
  // phi-only approximation. Callers should prefer passing the pre-computed map
  // from computeLiveRegsAtEnd() for correctness.
  if (!liveRegsAtEnd) {
    liveRegsAtEnd = new Map<BasicBlock, Set<string>>();
    for (const block of program.blocks) {
      for (const phi of block.phis) {
        const destReg = allocResult.allocation.get(phi.dest) ?? phi.dest;
        for (const entry of phi.entries) {
          let sourceReg: string;
          if (typeof entry.value === 'string' && entry.value.startsWith('%t')) {
            sourceReg = allocResult.allocation.get(entry.value) ?? entry.value;
          } else {
            sourceReg = String(entry.value);
          }
          if (!liveRegsAtEnd.has(entry.block)) liveRegsAtEnd.set(entry.block, new Set());
          const regs = liveRegsAtEnd.get(entry.block)!;
          regs.add(sourceReg);
          regs.add(destReg);
        }
      }
    }
  }

  // Collect all labels that are actually jump targets (referenced by terminators)
  const referencedLabels = new Set<string>();
  for (const block of linearized) {
    if (block.terminator) {
      if (block.terminator.op === 'jmp') {
        referencedLabels.add(block.terminator.target.label);
      } else if (block.terminator.op === 'br_cmp') {
        referencedLabels.add(block.terminator.thenBlock.label);
        referencedLabels.add(block.terminator.elseBlock.label);
      }
    }
  }

  for (let blockIdx = 0; blockIdx < linearized.length; blockIdx++) {
    const block = linearized[blockIdx];
    const nextBlock = blockIdx + 1 < linearized.length ? linearized[blockIdx + 1] : null;

    // Only emit label if it's referenced by a jump
    if (referencedLabels.has(block.label)) {
      output.push(`${block.label}:`);
    }

    // Emit instructions
    for (const instr of block.instrs) {
      const line = emitInstr(instr);
      if (line) output.push(line);
    }

    // Emit phi copies before terminator, resolving parallel move conflicts
    const copies = phiCopiesPerBlock.get(block);
    if (copies) {
      const liveRegs = liveRegsAtEnd.get(block) ?? new Set<string>();
      for (const line of resolveParallelMoves(copies, liveRegs)) {
        output.push(line);
      }
    }

    // Emit terminator
    if (block.terminator) {
      const lines = emitTerminator(block.terminator, nextBlock);
      output.push(...lines);
    }
  }

  return output.join('\n');
}

// Resolve parallel move conflicts in phi copies.
// When multiple copies must happen "simultaneously", naive sequential emission
// can clobber a source before it's read. This function reorders copies so that
// each source is read before its register is overwritten, breaking cycles with
// a temporary register when necessary.
export function resolveParallelMoves(copies: { from: string; to: string }[], liveRegs: Set<string>): string[] {
  if (copies.length <= 1) {
    return copies.map(c => `  SET ${c.to} ${c.from}`);
  }

  const output: string[] = [];
  // Work on a mutable copy
  const pending = copies.map(c => ({ from: c.from, to: c.to }));

  // Build a map: register → copy that writes to it
  const writtenBy = new Map<string, number>();
  for (let i = 0; i < pending.length; i++) {
    writtenBy.set(pending[i].to, i);
  }

  // Emit copies where the destination is not a source of any other pending copy
  const emitted = new Set<number>();
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      if (emitted.has(i)) continue;
      const { from, to } = pending[i];
      // Check if 'to' is needed as a source by any other pending copy
      let blocked = false;
      for (let j = 0; j < pending.length; j++) {
        if (j === i || emitted.has(j)) continue;
        if (pending[j].from === to) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        output.push(`  SET ${to} ${from}`);
        emitted.add(i);
        progress = true;
      }
    }
  }

  // Any remaining copies form cycles — break with a temp register.
  // Find a register not used by any copy in the cycle AND not live as a temp.
  if (emitted.size < pending.length) {
    const usedRegs = new Set<string>(liveRegs);
    for (const c of pending) {
      usedRegs.add(c.from);
      usedRegs.add(c.to);
    }
    let tempReg = '';
    for (let i = 0; i < 8; i++) {
      if (!usedRegs.has(`r${i}`)) {
        tempReg = `r${i}`;
        break;
      }
    }

    for (let i = 0; i < pending.length; i++) {
      if (emitted.has(i)) continue;
      // Start of a cycle: save first source to temp, collect chain, emit reversed
      const cycleStart = i;
      output.push(`  SET ${tempReg} ${pending[cycleStart].from}`);
      emitted.add(cycleStart);

      // Collect chain copies: follow from cycleStart's destination forward
      const chain: number[] = [];
      let cur = cycleStart;
      while (true) {
        const { to } = pending[cur];
        let next = -1;
        for (let j = 0; j < pending.length; j++) {
          if (!emitted.has(j) && pending[j].from === to) {
            next = j;
            break;
          }
        }
        if (next === -1) break;
        chain.push(next);
        emitted.add(next);
        cur = next;
      }

      // Emit chain copies in reverse so each source is read before its
      // register is overwritten by an earlier copy in the chain
      for (let k = chain.length - 1; k >= 0; k--) {
        const c = pending[chain[k]];
        output.push(`  SET ${c.to} ${c.from}`);
      }
      // Restore temp to cycle start's destination
      output.push(`  SET ${pending[cycleStart].to} ${tempReg}`);
    }
  }

  return output;
}

function emitInstr(instr: SSAInstr): string | null {
  const { op, dest, args } = instr;

  switch (op) {
    case 'const': {
      if (!dest) return null;
      return `  SET ${dest} ${args[0]}`;
    }
    case 'copy': {
      if (!dest) return null;
      if (dest === args[0]) return null;  // same register, no-op
      return `  SET ${dest} ${args[0]}`;
    }
    case 'add': case 'sub': case 'mul': case 'div': case 'mod':
    case 'and': case 'or': case 'xor': case 'lshift': case 'rshift': {
      const asmOp = op.toUpperCase();
      if (!dest) return null;
      const lines: string[] = [];
      // If dest != first arg, copy first arg to dest
      if (dest !== String(args[0])) {
        lines.push(`  SET ${dest} ${args[0]}`);
      }
      lines.push(`  ${asmOp} ${dest} ${args[1]}`);
      return lines.join('\n');
    }
    case 'random': {
      if (!dest) return null;
      return `  RANDOM ${dest} ${args[0]}`;
    }
    case 'sense': {
      if (!dest) return null;
      return `  SENSE ${args[0]} ${dest}`;
    }
    case 'smell': {
      if (!dest) return null;
      return `  SMELL ${args[0]} ${dest}`;
    }
    case 'probe': {
      if (!dest) return null;
      return `  PROBE ${args[0]} ${dest}`;
    }
    case 'sniff': {
      if (!dest) return null;
      return `  SNIFF ${args[0]} ${args[1]} ${dest}`;
    }
    case 'carrying': {
      if (!dest) return null;
      return `  CARRYING ${dest}`;
    }
    case 'id': {
      if (!dest) return null;
      return `  ID ${dest}`;
    }
    case 'move':
      return `  MOVE ${args[0]}`;
    case 'pickup':
      return '  PICKUP';
    case 'drop':
      return '  DROP';
    case 'mark':
      return `  MARK ${args[0]} ${args[1]}`;
    case 'tag':
      return `  TAG ${args[0]}`;
    case 'abort':
      return `  ABORT ${args[0]}`;
    case 'reg': {
      if (!dest) return null;
      const magicNames: Record<number, string> = { 8: 'rD_FD', 9: 'rD_CL', 10: 'rD_PX', 11: 'rD_PY', 12: 'rD_PC' };
      return `  SET ${dest} ${magicNames[args[0] as number]}`;
    }
    default:
      return `  ; unknown op: ${op}`;
  }
}

function emitTerminator(term: Terminator, nextBlock: BasicBlock | null): string[] {
  if (term.op === 'jmp') {
    // Omit JMP if target is the next block (fall-through)
    if (nextBlock && term.target === nextBlock) return [];
    return [`  JMP ${term.target.label}`];
  }

  // br_cmp — choose the most efficient jump sequence
  const { cmpOp, a, b, thenBlock, elseBlock } = term;

  // Available direct jumps
  const jmpOps: Record<CmpOp, { t: string | null; f: string | null }> = {
    'eq': { t: 'JEQ', f: 'JNE' },
    'ne': { t: 'JNE', f: 'JEQ' },
    'gt': { t: 'JGT', f: null },
    'lt': { t: 'JLT', f: null },
    'ge': { t: null, f: 'JLT' },
    'le': { t: null, f: 'JGT' },
  };

  const info = jmpOps[cmpOp];
  const lines: string[] = [];

  // Strategy: prefer fall-through to whichever block is next
  if (nextBlock === elseBlock) {
    // Fall through to else — jump to then when true
    if (info.t) {
      lines.push(`  ${info.t} ${a} ${b} ${thenBlock.label}`);
    } else {
      // No direct true-jump — trampoline
      const skipLabel = `__skip_${thenBlock.label}`;
      lines.push(`  ${info.f} ${a} ${b} ${skipLabel}`);
      lines.push(`  JMP ${thenBlock.label}`);
      lines.push(`${skipLabel}:`);
    }
  } else if (nextBlock === thenBlock) {
    // Fall through to then — jump to else when false
    if (info.f) {
      lines.push(`  ${info.f} ${a} ${b} ${elseBlock.label}`);
    } else {
      // No direct false-jump — trampoline
      const skipLabel = `__skip_${elseBlock.label}`;
      lines.push(`  ${info.t} ${a} ${b} ${skipLabel}`);
      lines.push(`  JMP ${elseBlock.label}`);
      lines.push(`${skipLabel}:`);
    }
  } else {
    // Neither is next — jump to then, fall through JMP to else
    if (info.t) {
      lines.push(`  ${info.t} ${a} ${b} ${thenBlock.label}`);
      lines.push(`  JMP ${elseBlock.label}`);
    } else if (info.f) {
      lines.push(`  ${info.f} ${a} ${b} ${elseBlock.label}`);
      lines.push(`  JMP ${thenBlock.label}`);
    } else {
      // Neither available — this shouldn't happen after comparison rewriting
      lines.push(`  ; br_cmp ${cmpOp} ${a} ${b}`);
      lines.push(`  JMP ${thenBlock.label}`);
    }
  }

  return lines;
}
