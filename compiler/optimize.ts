// ═══════════════════════════════════════════════════════════════
// AntLisp Pipeline — Phase 4: Optimization Passes
// ═══════════════════════════════════════════════════════════════

import { SSAProgram, BasicBlock, SSAInstr, PhiNode, isSideEffectFree, CmpOp } from './ssa';

// ─── 4a: Constant Folding ───────────────────────────────────

export function constantFolding(program: SSAProgram): void {
  const constMap = new Map<string, number>();  // temp → constant value

  for (const block of program.blocks) {
    // Process phis — if all entries are the same constant, fold
    for (const phi of block.phis) {
      const values = phi.entries.map(e => {
        if (constMap.has(e.value)) return constMap.get(e.value)!;
        const n = parseInt(e.value, 10);
        return isNaN(n) ? null : n;
      });
      if (values.length > 0 && values.every(v => v !== null && v === values[0])) {
        constMap.set(phi.dest, values[0] as number);
      }
    }

    for (const instr of block.instrs) {
      if (instr.op === 'const' && instr.dest) {
        const val = instr.args[0];
        if (typeof val === 'number') {
          constMap.set(instr.dest, val);
        }
        continue;
      }

      if (!instr.dest) continue;

      // Try to fold arithmetic with all-constant operands
      const args = instr.args.map(a => {
        if (typeof a === 'number') return a;
        if (constMap.has(a)) return constMap.get(a)!;
        return null;
      });

      const allConst = args.every(a => a !== null);
      if (!allConst) {
        instr.args = instr.args.map(a => {
          if (typeof a === 'string' && constMap.has(a)) return constMap.get(a)!;
          return a;
        });
        continue;
      }

      const vals = args as number[];
      let result: number | null = null;

      switch (instr.op) {
        case 'add': result = vals[0] + vals[1]; break;
        case 'sub': result = vals[0] - vals[1]; break;
        case 'mul': result = vals[0] * vals[1]; break;
        case 'div': result = vals[1] !== 0 ? Math.trunc(vals[0] / vals[1]) : null; break;
        case 'mod': result = vals[1] !== 0 ? vals[0] % vals[1] : null; break;
        case 'and': result = vals[0] & vals[1]; break;
        case 'or': result = vals[0] | vals[1]; break;
        case 'xor': result = vals[0] ^ vals[1]; break;
        case 'lshift': result = vals[0] << vals[1]; break;
        case 'rshift': result = vals[0] >> vals[1]; break;
        case 'copy':
          if (vals.length === 1) result = vals[0];
          break;
      }

      if (result !== null) {
        instr.op = 'const';
        instr.args = [result];
        constMap.set(instr.dest, result);
      }
    }

    // Fold constant branches
    if (block.terminator?.op === 'br_cmp') {
      const term = block.terminator;
      if (typeof term.a === 'string' && constMap.has(term.a)) {
        term.a = constMap.get(term.a)!;
      }
      if (typeof term.b === 'string' && constMap.has(term.b)) {
        term.b = constMap.get(term.b)!;
      }
      const a = typeof term.a === 'number' ? term.a : null;
      const b = typeof term.b === 'number' ? term.b : null;

      if (a !== null && b !== null) {
        let result: boolean;
        switch (term.cmpOp) {
          case 'eq': result = a === b; break;
          case 'ne': result = a !== b; break;
          case 'lt': result = a < b; break;
          case 'gt': result = a > b; break;
          case 'le': result = a <= b; break;
          case 'ge': result = a >= b; break;
        }
        const target = result ? term.thenBlock : term.elseBlock;
        const removed = result ? term.elseBlock : term.thenBlock;
        block.terminator = { op: 'jmp', target };
        // Remove edge to the untaken branch
        block.succs = block.succs.filter(b => b !== removed);
        removed.preds = removed.preds.filter(b => b !== block);
      }
    }
  }
}

// ─── 4b: Copy Propagation ──────────────────────────────────

export function copyPropagation(program: SSAProgram): void {
  // Build copy map: dest → source
  const copyMap = new Map<string, string>();

  // Collect copies
  for (const block of program.blocks) {
    for (const instr of block.instrs) {
      if (instr.op === 'copy' && instr.dest && instr.args.length === 1 && typeof instr.args[0] === 'string') {
        copyMap.set(instr.dest, instr.args[0] as string);
      }
    }
  }

  // Resolve chains: if %t5 = copy %t3 and %t3 = copy %t1, then %t5 → %t1
  function resolve(temp: string): string {
    const visited = new Set<string>();
    let current = temp;
    while (copyMap.has(current) && !visited.has(current)) {
      visited.add(current);
      current = copyMap.get(current)!;
    }
    return current;
  }

  // Replace uses
  function replaceUse(val: string | number): string | number {
    if (typeof val === 'string' && copyMap.has(val)) {
      return resolve(val);
    }
    return val;
  }

  for (const block of program.blocks) {
    // Replace in phis
    for (const phi of block.phis) {
      for (const entry of phi.entries) {
        entry.value = resolve(entry.value);
      }
    }

    // Replace in instructions
    for (const instr of block.instrs) {
      instr.args = instr.args.map(a => replaceUse(a));
    }

    // Replace in terminator
    if (block.terminator?.op === 'br_cmp') {
      block.terminator.a = replaceUse(block.terminator.a);
      block.terminator.b = replaceUse(block.terminator.b);
    }
  }

  // Remove trivial phis (all entries same value)
  for (const block of program.blocks) {
    block.phis = block.phis.filter(phi => {
      const values = phi.entries.map(e => e.value);
      const allSame = values.length > 0 && values.every(v => v === values[0]);
      if (allSame) {
        // Replace all uses of this phi's dest with the common value
        copyMap.set(phi.dest, values[0]);
        return false;
      }
      return true;
    });
  }

  // Second pass to propagate newly discovered copies from trivial phi elimination
  for (const block of program.blocks) {
    for (const phi of block.phis) {
      for (const entry of phi.entries) {
        if (copyMap.has(entry.value)) {
          entry.value = resolve(entry.value);
        }
      }
    }
    for (const instr of block.instrs) {
      instr.args = instr.args.map(a => replaceUse(a));
    }
    if (block.terminator?.op === 'br_cmp') {
      block.terminator.a = replaceUse(block.terminator.a);
      block.terminator.b = replaceUse(block.terminator.b);
    }
  }

  // Update allBindings so debug var→temp mappings follow copy chains
  for (const [name, temp] of program.allBindings) {
    if (copyMap.has(temp)) {
      program.allBindings.set(name, resolve(temp));
    }
  }
}

// ─── 4c: Dead Code Elimination ──────────────────────────────

export function deadCodeElimination(program: SSAProgram): void {
  let changed = true;
  while (changed) {
    changed = false;

    // Collect all used temps
    const used = new Set<string>();
    for (const block of program.blocks) {
      for (const phi of block.phis) {
        for (const entry of phi.entries) {
          used.add(entry.value);
        }
      }
      for (const instr of block.instrs) {
        for (const arg of instr.args) {
          if (typeof arg === 'string') used.add(arg);
        }
      }
      if (block.terminator?.op === 'br_cmp') {
        if (typeof block.terminator.a === 'string') used.add(block.terminator.a);
        if (typeof block.terminator.b === 'string') used.add(block.terminator.b);
      }
    }

    // Remove dead instructions
    for (const block of program.blocks) {
      const newInstrs: SSAInstr[] = [];
      for (const instr of block.instrs) {
        if (instr.dest && !used.has(instr.dest) && isSideEffectFree(instr.op)) {
          changed = true;
          continue;
        }
        newInstrs.push(instr);
      }
      block.instrs = newInstrs;

      // Remove dead phis
      const newPhis: PhiNode[] = [];
      for (const phi of block.phis) {
        if (!used.has(phi.dest)) {
          changed = true;
          continue;
        }
        newPhis.push(phi);
      }
      block.phis = newPhis;
    }
  }
}

// ─── 4d: Dead Block Elimination ─────────────────────────────

export function deadBlockElimination(program: SSAProgram): void {
  // Remove blocks with no predecessors (except entry)
  let changed = true;
  while (changed) {
    changed = false;
    const newBlocks: BasicBlock[] = [];
    for (const block of program.blocks) {
      if (block === program.entryBlock || block.preds.length > 0) {
        newBlocks.push(block);
      } else {
        changed = true;
        // Remove this block from successor's pred lists
        for (const succ of block.succs) {
          succ.preds = succ.preds.filter(p => p !== block);
          // Remove phi entries from this block
          for (const phi of succ.phis) {
            phi.entries = phi.entries.filter(e => e.block !== block);
          }
        }
      }
    }
    program.blocks = newBlocks;
  }
}

// ─── 4e: Comparison Rewriting ───────────────────────────────

export function comparisonRewriting(program: SSAProgram): void {
  for (const block of program.blocks) {
    if (block.terminator?.op !== 'br_cmp') continue;
    const term = block.terminator;

    // (gt a N) → (ge a N+1) when N is a constant
    if (term.cmpOp === 'gt' && typeof term.b === 'number' && term.b < 2147483647) {
      term.cmpOp = 'ge';
      term.b = term.b + 1;
    }
    // (lt a N) → (le a N-1) when N is a constant
    else if (term.cmpOp === 'lt' && typeof term.b === 'number' && term.b > -2147483648) {
      term.cmpOp = 'le';
      term.b = term.b - 1;
    }
  }
}

// ─── Run All Passes ─────────────────────────────────────────

export function optimize(program: SSAProgram): void {
  constantFolding(program);
  copyPropagation(program);
  deadCodeElimination(program);
  deadBlockElimination(program);
  comparisonRewriting(program);
  // Run DCE again after dead block elimination
  deadCodeElimination(program);
}
