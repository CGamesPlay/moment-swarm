// ═══════════════════════════════════════════════════════════════
// AntLisp v2 Pipeline — Phase 6: Code Generation
// ═══════════════════════════════════════════════════════════════

import { SSAProgram, BasicBlock, SSAInstr, Terminator, CmpOp } from './ssa';
import { AllocationResult } from './regalloc';

// ─── Code Generation ────────────────────────────────────────

export function generateCode(
  program: SSAProgram,
  linearized: BasicBlock[],
  allocResult: AllocationResult,
): string {
  const output: string[] = [];

  // Emit directives
  for (const t of program.tags) output.push(`.tag ${t.id} ${t.name}`);
  for (const a of program.aliases) output.push(`.alias ${a.name} ${a.reg}`);
  if (program.tags.length || program.aliases.length) output.push('');

  // Build phi copy map: block → copies to insert at end
  const phiCopiesPerBlock = new Map<BasicBlock, { from: string; to: string }[]>();
  for (const { block, from, to } of allocResult.phiCopies) {
    if (!phiCopiesPerBlock.has(block)) phiCopiesPerBlock.set(block, []);
    phiCopiesPerBlock.get(block)!.push({ from, to });
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

    // Emit phi copies before terminator
    const copies = phiCopiesPerBlock.get(block);
    if (copies) {
      for (const { from, to } of copies) {
        output.push(`  SET ${to} ${from}`);
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
    case 'asserteq':
      return `  ASSERTEQ ${args[0]} ${args[1]}`;
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
