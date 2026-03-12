// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Entry Point
// ═══════════════════════════════════════════════════════════════
//
// Pipeline: Source → Tokenize → Parse → AST
//   → Phase 1: Macro Expansion (AST → AST)
//   → Phase 2: Metadata Collection (AST → AST + tags/aliases)
//   → Phase 3: SSA Lowering (AST → SSA IR)
//   → Phase 4: Optimization Passes (SSA IR → SSA IR)
//   → Phase 5: Register Allocation (SSA IR → allocated IR)
//   → Phase 6: Code Generation (allocated IR → assembly text)
//   → Phase 7: Peephole (assembly text → assembly text)

import { tokenize, parse } from './parse';
import { expandMacros } from './expand';
import { collectMetadata } from './metadata';
import { lowerToSSA, printSSA } from './ssa';
import { optimize } from './optimize';
import { linearizeBlocks, numberInstructions, computeLiveIntervals, linearScan, applyAllocation, buildVarMap, VarMapEntry } from './regalloc';
import { generateCode, computeLiveRegsAtEnd } from './codegen';
import { peephole } from './peephole';

// Build .varmap directives from post-peephole assembly lines and their
// instrIndex mappings. Each instruction line maps to a regalloc numbered
// instruction index via instrIndex. We use this to look up the variable
// state (register → varName) at each post-peephole PC.
function buildVarMapDirectives(
  lines: string[],
  instrIndex: number[],
  varMapEntries: VarMapEntry[],
): string[] {
  if (varMapEntries.length === 0) return [];

  // Build lookup: instrIndex → varmap regs (the entry that applies AT that index)
  // An entry at instrIndex N means "starting at N, these registers hold these vars".
  // For a given numbered instruction index, find the latest entry with instrIndex <= it.
  const sortedEntries = [...varMapEntries].sort((a, b) => a.instrIndex - b.instrIndex);

  function lookupVarMap(idx: number): Record<string, string> | null {
    if (idx < 0) return null;
    // Binary search for latest entry with instrIndex <= idx
    let lo = 0, hi = sortedEntries.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedEntries[mid].instrIndex <= idx) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best >= 0 ? sortedEntries[best].regs : null;
  }

  // Walk post-peephole lines, counting PCs for instruction lines
  const directives: string[] = [];
  let pc = 0;
  let prevKey = '';

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    // Skip non-instruction lines
    if (!trimmed || trimmed.endsWith(':') || trimmed.startsWith('.') || trimmed.startsWith(';')) {
      continue;
    }
    // This is an instruction line at the current PC
    const idx = instrIndex[i];
    // Only update varmap when we have a valid instrIndex.
    // Lines with instrIndex -1 (phi copies, synthetic JMPs) inherit
    // the previous varmap — they don't mean "no variables in scope".
    if (idx >= 0) {
      const regs = lookupVarMap(idx);
      if (regs) {
        const parts = Object.entries(regs)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([reg, name]) => `${reg}=${name}`);
        const key = parts.join(' ');
        if (key !== prevKey) {
          directives.push(key ? `.varmap ${pc} ${key}` : `.varmap ${pc}`);
          prevKey = key;
        }
      }
    }

    pc++;
  }

  return directives;
}

export interface CompileOptions {
  constOverrides?: Record<string, string>;
  sourceFile?: string;
  emitVarMap?: boolean;  // emit .varmap directives (default: true)
}

export function compileAntLisp(source: string, options: CompileOptions = {}): string {
  const { asm } = compileAntLispDebug(source, { ...options, emitVarMap: false });
  return asm;
}

export function compileAntLispDebug(source: string, options: CompileOptions = {}): { asm: string; varMap: Map<string, string> } {
  // Parse
  const tokens = tokenize(source);
  const ast = parse(tokens, { source, sourceFile: options.sourceFile });

  // Phase 1: Macro expansion
  const constOverrides = options.constOverrides
    ? new Map(Object.entries(options.constOverrides))
    : undefined;
  const expanded = expandMacros(ast.body, {
    constOverrides,
    impliedConsts: new Map([['DEBUG', '0']]),
    sourceFile: options.sourceFile,
  });

  // Phase 2: Metadata collection
  const metadata = collectMetadata(expanded.forms);

  // Phase 3: SSA lowering
  const ssaProgram = lowerToSSA(
    metadata.forms,
    metadata.tags,
    expanded.constValues,
    options.sourceFile ?? '',
  );

  // Phase 4: Optimization passes
  optimize(ssaProgram);

  // Phase 5: Register allocation
  const linearized = linearizeBlocks(ssaProgram);
  const numbered = numberInstructions(linearized);
  const intervals = computeLiveIntervals(linearized, numbered);
  const allocResult = linearScan(ssaProgram, intervals);

  // Compute live registers at block exits BEFORE applyAllocation
  // (blocks still have %t names that computeBlockLiveness needs)
  const liveRegsAtEnd = computeLiveRegsAtEnd(ssaProgram, allocResult.allocation);

  // Build per-instruction variable map BEFORE applyAllocation
  // (while temps still have their original names)
  const varMapEntries = buildVarMap(numbered, intervals, allocResult.allocation, ssaProgram.tempNames);

  applyAllocation(ssaProgram, allocResult.allocation);

  // Phase 6: Code generation (returns lines + parallel instrIndex array)
  const codegen = generateCode(ssaProgram, linearized, allocResult, liveRegsAtEnd, numbered);

  // Phase 7: Peephole (threads instrIndex through all transformations)
  const peepholeResult = peephole(codegen.lines, codegen.instrIndex);

  // Build .varmap directives from post-peephole instrIndex values (debug only)
  const finalLines = [...peepholeResult.lines];
  if (options.emitVarMap !== false) {
    const varMapDirectives = buildVarMapDirectives(peepholeResult.lines, peepholeResult.instrIndex, varMapEntries);
    if (varMapDirectives.length > 0) {
      let insertIdx = 0;
      for (let i = 0; i < finalLines.length; i++) {
        if (finalLines[i].startsWith('.tag')) { insertIdx = i + 1; continue; }
        if (finalLines[i] === '' && insertIdx > 0) { insertIdx = i + 1; break; }
        if (!finalLines[i].startsWith('.')) break;
      }
      finalLines.splice(insertIdx, 0, ...varMapDirectives);
    }
  }

  const asm = finalLines.join('\n');

  // Build varMap from allBindings (map var names to allocated registers)
  const varMap = new Map<string, string>();
  for (const [name, temp] of ssaProgram.allBindings) {
    const reg = allocResult.allocation.get(temp);
    if (reg) varMap.set(name, reg);
  }

  return { asm, varMap };
}


// ─── CLI ─────────────────────────────────────────────────────

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const args = process.argv.slice(2);
  const constOverrides: Record<string, string> = {};
  const positional: string[] = [];
  let dumpSSA = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dump-ssa') {
      dumpSSA = true;
    } else if (args[i] === '-D' && i + 1 < args.length) {
      const eq = args[++i].indexOf('=');
      if (eq === -1) { console.error(`error: -D argument must be NAME=VALUE`); process.exit(1); }
      constOverrides[args[i].slice(0, eq)] = args[i].slice(eq + 1);
    } else if (args[i].startsWith('-D')) {
      const rest = args[i].slice(2);
      const eq = rest.indexOf('=');
      if (eq === -1) { console.error(`error: -D argument must be NAME=VALUE`); process.exit(1); }
      constOverrides[rest.slice(0, eq)] = rest.slice(eq + 1);
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 0) {
    console.log('Usage: npx tsx compiler/antlisp.ts [--dump-ssa] [-D NAME=VALUE]... <source.alisp>');
  } else {
    try {
      const sourceFile = path.resolve(positional[0]);
      const source = fs.readFileSync(sourceFile, 'utf-8');
      if (dumpSSA) {
        const tokens = tokenize(source);
        const ast = parse(tokens, { source, sourceFile });
        const constMap = constOverrides ? new Map(Object.entries(constOverrides)) : undefined;
        const expanded = expandMacros(ast.body, { constOverrides: constMap, impliedConsts: new Map([['DEBUG', '0']]), sourceFile });
        const metadata = collectMetadata(expanded.forms);
        const ssaProgram = lowerToSSA(metadata.forms, metadata.tags, expanded.constValues, sourceFile);
        optimize(ssaProgram);
        console.log(printSSA(ssaProgram));
      } else {
        // Emit .varmap directives only when compiling for debug (DEBUG != 0)
        const emitVarMap = constOverrides['DEBUG'] !== undefined && constOverrides['DEBUG'] !== '0';
        const { asm } = compileAntLispDebug(source, { constOverrides, sourceFile, emitVarMap });
        console.log(asm);
        const instrCount = asm.split('\n').filter(l => {
          l = l.replace(/;.*/, '').trim();
          return l && !l.endsWith(':') && !l.startsWith('.');
        }).length;
        console.error(`Assembled ${instrCount} instructions`);
      }
    } catch (err: any) {
      if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) {
        // Internal compiler error — dump stack trace for debugging
        console.error('Internal compiler error:');
        console.error(err.stack);
      } else {
        console.error(err.message);
      }
      process.exit(1);
    }
  }
}
