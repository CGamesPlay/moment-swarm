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
import { linearizeBlocks, numberInstructions, computeLiveIntervals, linearScan, applyAllocation } from './regalloc';
import { generateCode } from './codegen';
import { peephole } from './peephole';

export interface CompileOptions {
  constOverrides?: Record<string, string>;
  sourceFile?: string;
}

export function compileAntLisp(source: string, options: CompileOptions = {}): string {
  const { asm } = compileAntLispDebug(source, options);
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
  applyAllocation(ssaProgram, allocResult.allocation);

  // Phase 6: Code generation
  const rawAsm = generateCode(ssaProgram, linearized, allocResult);

  // Phase 7: Peephole
  const lines = rawAsm.split('\n');
  const optimizedLines = peephole(lines);
  const asm = optimizedLines.join('\n');

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
        console.log(compileAntLisp(source, { constOverrides, sourceFile }));
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
