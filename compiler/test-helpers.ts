// ═══════════════════════════════════════════════════════════════
// Test Helpers — shared harness + pipeline helpers + SSA builders
// ═══════════════════════════════════════════════════════════════

import { tokenize, parse, ASTNode, Program } from './parse';
import { expandMacros, ExpandResult, tryEvalConst } from './expand';
import { collectMetadata, Metadata } from './metadata';
import { lowerToSSA, SSAProgram, BasicBlock, SSAInstr, PhiNode, Terminator, printSSA } from './ssa';
import { optimize } from './optimize';
import { linearizeBlocks, numberInstructions, computeLiveIntervals, linearScan, applyAllocation } from './regalloc';
import { generateCode } from './codegen';
import { peephole } from './peephole2';

// ─── Test Harness ───────────────────────────────────────────

let _passed = 0;
let _failed = 0;

export function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`✓ ${name}`);
    _passed++;
  } catch (e: any) {
    console.log(`✗ ${name} — ${e.message}`);
    _failed++;
  }
}

export function runSuite(name: string, fn: () => void): void {
  _passed = 0;
  _failed = 0;
  fn();
  console.log(`  ${_failed > 0 ? '✗' : '✓'} ${name}: ${_passed} passed, ${_failed} failed`);
  if (_failed > 0) process.exit(1);
}

export function assert(condition: boolean, msg?: string): void {
  if (!condition) throw new Error(msg ?? 'Assertion failed');
}

export function assertEq(actual: any, expected: any, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
  }
}

export function assertMatch(str: string, regex: RegExp, msg?: string): void {
  if (!regex.test(str)) {
    throw new Error(`${msg ? msg + ': ' : ''}"${str}" does not match ${regex}`);
  }
}

export function assertIncludes(str: string, substr: string, msg?: string): void {
  if (!str.includes(substr)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected to include "${substr}" in:\n${str}`);
  }
}

export function assertNotIncludes(str: string, substr: string, msg?: string): void {
  if (str.includes(substr)) {
    throw new Error(`${msg ? msg + ': ' : ''}expected NOT to include "${substr}" in:\n${str}`);
  }
}

export function assertThrows(fn: () => void, msgMatch?: string | RegExp): void {
  let threw = false;
  try {
    fn();
  } catch (e: any) {
    threw = true;
    if (msgMatch) {
      const matches = typeof msgMatch === 'string'
        ? e.message.includes(msgMatch)
        : msgMatch.test(e.message);
      if (!matches) {
        throw new Error(`Exception message "${e.message}" does not match "${msgMatch}"`);
      }
    }
  }
  if (!threw) {
    throw new Error('Expected an exception but none was thrown');
  }
}

// ─── Pipeline Helpers ───────────────────────────────────────

export function parseSource(src: string): Program {
  return parse(tokenize(src));
}

export function expandSource(src: string, opts?: { constOverrides?: Record<string, string> }): ExpandResult {
  const ast = parseSource(src);
  const constOverrides = opts?.constOverrides
    ? new Map(Object.entries(opts.constOverrides))
    : undefined;
  return expandMacros(ast.body, { constOverrides });
}

export function collectMeta(src: string): Metadata & { constValues: Map<string, string> } {
  const expanded = expandSource(src);
  const meta = collectMetadata(expanded.forms);
  return { ...meta, constValues: expanded.constValues };
}

export function lowerSource(src: string, opts?: { testing?: boolean }): SSAProgram {
  const expanded = expandSource(src);
  const meta = collectMetadata(expanded.forms);
  return lowerToSSA(meta.forms, meta.tags, meta.aliases, expanded.constValues, opts);
}

export function lowerAndOptimize(src: string, opts?: { testing?: boolean }): SSAProgram {
  const program = lowerSource(src, opts);
  optimize(program);
  return program;
}

export function compileSource(src: string, opts?: { constOverrides?: Record<string, string>; testing?: boolean }): string {
  const ast = parseSource(src);
  const constOverrides = opts?.constOverrides
    ? new Map(Object.entries(opts.constOverrides))
    : undefined;
  const expanded = expandMacros(ast.body, { constOverrides });
  const meta = collectMetadata(expanded.forms);
  const program = lowerToSSA(meta.forms, meta.tags, meta.aliases, expanded.constValues, { testing: opts?.testing });
  optimize(program);
  const linearized = linearizeBlocks(program);
  const numbered = numberInstructions(linearized);
  const intervals = computeLiveIntervals(linearized, numbered);
  const allocResult = linearScan(program, intervals);
  applyAllocation(program, allocResult.allocation);
  const rawAsm = generateCode(program, linearized, allocResult);
  const lines = rawAsm.split('\n');
  return peephole(lines).join('\n');
}


// ─── SSA Builders ───────────────────────────────────────────

export function makeBlock(label: string, instrs?: SSAInstr[], terminator?: Terminator | null): BasicBlock {
  return {
    label,
    phis: [],
    instrs: instrs ?? [],
    terminator: terminator ?? null,
    preds: [],
    succs: [],
  };
}

export function makeInstr(op: string, dest: string | null, ...args: (string | number)[]): SSAInstr {
  return { op, dest, args };
}

export function makePhi(dest: string, entries: { block: BasicBlock; value: string }[]): PhiNode {
  return { dest, entries };
}

export function makeProgram(blocks: BasicBlock[]): SSAProgram {
  return {
    blocks,
    entryBlock: blocks[0],
    nextTemp: 100,
    tags: [],
    aliases: [],
    allBindings: new Map(),
  };
}

export function link(from: BasicBlock, to: BasicBlock): void {
  from.succs.push(to);
  to.preds.push(from);
}

// Re-export for convenience
export { printSSA, tryEvalConst, tokenize, parse };
export type { ASTNode, Program, SSAProgram, BasicBlock, SSAInstr, PhiNode, Terminator };
