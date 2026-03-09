// ═══════════════════════════════════════════════════════════════
// Optimize Tests — optimization passes
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, assertIncludes, assertNotIncludes,
         lowerAndOptimize, lowerSource, printSSA,
         makeBlock, makeInstr, makeProgram, link } from './test-helpers';
import { constantFolding, copyPropagation, deadCodeElimination,
         deadBlockElimination, comparisonRewriting } from './optimize';
import type { SSAProgram, BasicBlock } from './ssa';

function optSSA(src: string): string {
  return printSSA(lowerAndOptimize(src));
}

function hasOp(program: SSAProgram, op: string): boolean {
  return program.blocks.some(b => b.instrs.some(i => i.op === op));
}

runSuite('Optimize', () => {
  // ── Migrated tests: check SSA after optimization ──

  test('const fold: (+ 1 1) → const 2', () => {
    const ir = optSSA('(let ((x (+ 1 1))) (move x))');
    assertIncludes(ir, 'const 2');
    assertNotIncludes(ir, ' add ');
  });

  test('const fold: (* CONST 2) folds through const', () => {
    const ir = optSSA('(const N 5) (let ((x (* N 2))) (move x))');
    assertIncludes(ir, 'const 10');
    assertNotIncludes(ir, ' mul ');
  });

  test('const fold: unary (- 5) folds', () => {
    const ir = optSSA('(let ((x (- 5))) (move x))');
    assertIncludes(ir, 'const -5');
  });

  test('const fold: compound expr in comparison operand', () => {
    // Should not crash
    const program = lowerAndOptimize('(const R 7) (let ((age 14)) (when (>= age (* 2 R)) (move 1)))');
    assert(program.blocks.length > 0);
  });

  test('short-circuit and: no and instruction', () => {
    const ir = optSSA(`(let ((a 1) (b 2))
       (if (and (= a 1) (= b 2)) (move n) (move s)))`);
    assertNotIncludes(ir, ' and ');  // No bitwise AND — short-circuit branches
  });

  test('short-circuit or: no or instruction', () => {
    const ir = optSSA(`(let ((a 1) (b 2))
       (if (or (= a 1) (= b 2)) (move n) (move s)))`);
    assertNotIncludes(ir, ' or ');
  });

  test('comparison of variable with itself', () => {
    const program = lowerAndOptimize('(let ((x 5)) (if (= x x) (move n) (move s)))');
    // After const folding, the branch on 5==5 should be folded
    // Only one move should remain
    const moves = program.blocks.flatMap(b => b.instrs.filter(i => i.op === 'move'));
    assertEq(moves.length, 1);
  });

  // ── Synthetic tests using SSA builders ──

  test('constantFolding: add with const operands', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 3),
      makeInstr('const', '%t1', 4),
      makeInstr('add', '%t2', '%t0', '%t1'),
      makeInstr('move', null, '%t2'),
    ]);
    const program = makeProgram([entry]);
    constantFolding(program);
    const addInstr = entry.instrs.find(i => i.dest === '%t2')!;
    assertEq(addInstr.op, 'const');
    assertEq(addInstr.args[0], 7);
  });

  test('copyPropagation: copy eliminated, uses replaced', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 42),
      makeInstr('copy', '%t1', '%t0'),
      makeInstr('move', null, '%t1'),
    ]);
    const program = makeProgram([entry]);
    copyPropagation(program);
    const moveInstr = entry.instrs.find(i => i.op === 'move')!;
    assertEq(moveInstr.args[0], '%t0');
  });

  test('deadCodeElimination: unused pure op removed', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 42),
      makeInstr('add', '%t1', '%t0', 1),  // unused
      makeInstr('move', null, '%t0'),
    ]);
    const program = makeProgram([entry]);
    deadCodeElimination(program);
    assert(!entry.instrs.some(i => i.dest === '%t1'), 'dead add should be removed');
  });

  test('deadCodeElimination: side-effectful preserved', () => {
    const entry = makeBlock('entry', [
      makeInstr('move', null, 'RANDOM'),
      makeInstr('pickup', null),
    ]);
    const program = makeProgram([entry]);
    deadCodeElimination(program);
    assertEq(entry.instrs.length, 2);
  });

  test('deadBlockElimination: unreachable block removed', () => {
    const entry = makeBlock('entry', [makeInstr('move', null, 'N')]);
    const dead = makeBlock('dead', [makeInstr('move', null, 'S')]);
    // entry has no terminator, dead has no preds
    const program = makeProgram([entry, dead]);
    deadBlockElimination(program);
    assertEq(program.blocks.length, 1);
    assertEq(program.blocks[0].label, 'entry');
  });

  test('comparisonRewriting: gt with constant → ge', () => {
    const entry = makeBlock('entry');
    const thenB = makeBlock('then');
    const elseB = makeBlock('else');
    entry.terminator = { op: 'br_cmp', cmpOp: 'gt', a: '%t0', b: 5, thenBlock: thenB, elseBlock: elseB };
    link(entry, thenB);
    link(entry, elseB);
    const program = makeProgram([entry, thenB, elseB]);
    comparisonRewriting(program);
    assert(entry.terminator.op === 'br_cmp');
    if (entry.terminator.op === 'br_cmp') {
      assertEq(entry.terminator.cmpOp, 'ge');
      assertEq(entry.terminator.b, 6);
    }
  });

  test('comparisonRewriting: lt with constant → le', () => {
    const entry = makeBlock('entry');
    const thenB = makeBlock('then');
    const elseB = makeBlock('else');
    entry.terminator = { op: 'br_cmp', cmpOp: 'lt', a: '%t0', b: 10, thenBlock: thenB, elseBlock: elseB };
    link(entry, thenB);
    link(entry, elseB);
    const program = makeProgram([entry, thenB, elseB]);
    comparisonRewriting(program);
    assert(entry.terminator.op === 'br_cmp');
    if (entry.terminator.op === 'br_cmp') {
      assertEq(entry.terminator.cmpOp, 'le');
      assertEq(entry.terminator.b, 9);
    }
  });

  // ── Constant propagation into operands ──

  test('const prop: inline into partial-const add', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 5),
      makeInstr('add', '%t2', '%t0', '%t1'),
      makeInstr('move', null, '%t2'),
    ]);
    const program = makeProgram([entry]);
    constantFolding(program);
    const addInstr = entry.instrs.find(i => i.dest === '%t2')!;
    assertEq(addInstr.op, 'add');
    assertEq(addInstr.args[0], 5, 'first arg should be numeric 5');
    assertEq(addInstr.args[1], '%t1', 'second arg should remain a temp');
  });

  test('const prop: inline 0 into sub (motivating case)', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 0),
      makeInstr('sub', '%t2', '%t0', '%t1'),
      makeInstr('move', null, '%t2'),
    ]);
    const program = makeProgram([entry]);
    constantFolding(program);
    const subInstr = entry.instrs.find(i => i.dest === '%t2')!;
    assertEq(subInstr.op, 'sub');
    assertEq(subInstr.args[0], 0, 'first arg should be numeric 0');
    assertEq(subInstr.args[1], '%t1', 'second arg should remain a temp');
  });

  test('const prop: inline into br_cmp operand', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 10),
    ]);
    const thenB = makeBlock('then', [makeInstr('move', null, 'N')]);
    const elseB = makeBlock('else', [makeInstr('move', null, 'S')]);
    entry.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: '%t1', thenBlock: thenB, elseBlock: elseB };
    link(entry, thenB);
    link(entry, elseB);
    const program = makeProgram([entry, thenB, elseB]);
    constantFolding(program);
    assert(entry.terminator.op === 'br_cmp', 'should still be br_cmp');
    if (entry.terminator.op === 'br_cmp') {
      assertEq(entry.terminator.a, 10, 'a should be inlined to 10');
      assertEq(entry.terminator.b, '%t1', 'b should remain a temp');
    }
  });

  test('const prop: all-const still folds (regression)', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 3),
      makeInstr('const', '%t1', 7),
      makeInstr('add', '%t2', '%t0', '%t1'),
      makeInstr('move', null, '%t2'),
    ]);
    const program = makeProgram([entry]);
    constantFolding(program);
    const addInstr = entry.instrs.find(i => i.dest === '%t2')!;
    assertEq(addInstr.op, 'const', 'should fold to const');
    assertEq(addInstr.args[0], 10, 'should fold to 10');
  });

  test('const prop: dead const removed by DCE after propagation', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 5),
      makeInstr('add', '%t2', '%t0', '%t1'),
      makeInstr('move', null, '%t2'),
    ]);
    const program = makeProgram([entry]);
    constantFolding(program);
    deadCodeElimination(program);
    assert(!entry.instrs.some(i => i.dest === '%t0'), 'dead const %t0 should be removed');
  });
});
