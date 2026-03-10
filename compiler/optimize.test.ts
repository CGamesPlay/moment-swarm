// ═══════════════════════════════════════════════════════════════
// Optimize Tests — optimization passes
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, assertIncludes, assertNotIncludes,
         lowerAndOptimize, lowerSource, printSSA,
         makeBlock, makeInstr, makePhi, makeProgram, link } from './test-helpers';
import { constantFolding, copyPropagation, deadCodeElimination,
         deadBlockElimination, comparisonRewriting, deadBranchChainElimination } from './optimize';
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

  test('copyPropagation: transfers tempNames and tempLocs from eliminated copy', () => {
    // When a set! creates a copy temp with a name and binding location,
    // and copy propagation eliminates the copy, the name and location
    // should be transferred to the source temp.
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 1),   // source of copy (no name/loc yet)
      makeInstr('copy', '%t1', '%t0'), // copy temp (will have name and binding loc)
      makeInstr('move', null, '%t1'),  // use the copy
    ]);
    const program = makeProgram([entry]);

    // Simulate set! behavior: the copy temp has a name and binding location
    program.tempNames.set('%t1', 'x');
    program.tempLocs.set('%t1', { file: 'test.alisp', line: 1, col: 5 });
    program.allBindings.set('x', '%t1');

    copyPropagation(program);

    // After copy propagation, %t0 should have inherited the name and location
    assertEq(program.tempNames.get('%t0'), 'x', 'source temp should be named x');
    const loc = program.tempLocs.get('%t0');
    assert(loc !== undefined, '%t0 should have a location');
    assertEq(loc!.line, 1, 'source temp should have binding location');
    assertEq(loc!.col, 5, 'source temp should have binding location col');

    // allBindings should now point to %t0 instead of %t1
    assertEq(program.allBindings.get('x'), '%t0');
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

  // ── Dead Cond-Chain Elimination ──

  test('deadCodeElimination: self-referencing phi cycle eliminated', () => {
    // Simulates: while loop with unused loop variable (e.g. dotimes step)
    // entry: %t0 = const 0, %t1 = const 42, jmp → header
    // header: %dead = phi [entry: %t0] [body: %dead], br_cmp %t1 0 → body/exit
    // body: move %t1, jmp → header
    // exit: (empty)
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 0),
      makeInstr('const', '%t1', 42),
    ]);
    const header = makeBlock('header');
    const body = makeBlock('body', [makeInstr('move', null, '%t1')]);
    const exit = makeBlock('exit');

    entry.terminator = { op: 'jmp', target: header };
    link(entry, header);

    header.phis.push(makePhi('%dead', [
      { block: entry, value: '%t0' },
      { block: body, value: '%dead' },
    ]));
    header.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t1', b: 0, thenBlock: exit, elseBlock: body };
    link(header, body); link(header, exit);

    body.terminator = { op: 'jmp', target: header };
    link(body, header);

    const program = makeProgram([entry, header, body, exit]);
    deadCodeElimination(program);

    assertEq(header.phis.length, 0, 'self-referencing dead phi should be removed');
    assert(!entry.instrs.some(i => i.dest === '%t0'), 'dead const %t0 should be removed');
    assert(entry.instrs.some(i => i.dest === '%t1'), 'used const %t1 should remain');
  });

  test('deadCodeElimination: mutual phi cycle eliminated', () => {
    // Two phis reference each other but nothing outside uses either
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 0),
      makeInstr('const', '%t1', 1),
      makeInstr('const', '%t2', 42),
    ]);
    const header = makeBlock('header');
    const body = makeBlock('body');
    const exit = makeBlock('exit');

    entry.terminator = { op: 'jmp', target: header };
    link(entry, header);

    header.phis.push(makePhi('%a', [
      { block: entry, value: '%t0' },
      { block: body, value: '%b' },
    ]));
    header.phis.push(makePhi('%b', [
      { block: entry, value: '%t1' },
      { block: body, value: '%a' },
    ]));
    header.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t2', b: 0, thenBlock: exit, elseBlock: body };
    link(header, body); link(header, exit);

    body.terminator = { op: 'jmp', target: header };
    link(body, header);

    const program = makeProgram([entry, header, body, exit]);
    deadCodeElimination(program);

    assertEq(header.phis.length, 0, 'mutual phi cycle should be eliminated');
    assert(!entry.instrs.some(i => i.dest === '%t0'), 'dead const %t0 should be removed');
    assert(!entry.instrs.some(i => i.dest === '%t1'), 'dead const %t1 should be removed');
    assert(entry.instrs.some(i => i.dest === '%t2'), 'used const %t2 should remain');
  });

  test('deadBranchChainElimination: 3-clause empty chain → jmp merge', () => {
    // Build: entry → br_cmp → body1(jmp merge) / next1
    //        next1 → br_cmp → body2(jmp merge) / next2
    //        next2 → br_cmp → body3(jmp merge) / next3
    //        next3 → jmp merge
    //        merge: (no phis)
    const entry = makeBlock('entry');
    const body1 = makeBlock('body1');
    const next1 = makeBlock('next1');
    const body2 = makeBlock('body2');
    const next2 = makeBlock('next2');
    const body3 = makeBlock('body3');
    const next3 = makeBlock('next3');
    const merge = makeBlock('merge', [makeInstr('move', null, '%t0')]);

    // entry → body1 / next1
    entry.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 1, thenBlock: body1, elseBlock: next1 };
    link(entry, body1); link(entry, next1);

    // body1 → merge
    body1.terminator = { op: 'jmp', target: merge };
    link(body1, merge);

    // next1 → body2 / next2
    next1.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 2, thenBlock: body2, elseBlock: next2 };
    link(next1, body2); link(next1, next2);

    // body2 → merge
    body2.terminator = { op: 'jmp', target: merge };
    link(body2, merge);

    // next2 → body3 / next3
    next2.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 3, thenBlock: body3, elseBlock: next3 };
    link(next2, body3); link(next2, next3);

    // body3 → merge
    body3.terminator = { op: 'jmp', target: merge };
    link(body3, merge);

    // next3 → merge
    next3.terminator = { op: 'jmp', target: merge };
    link(next3, merge);

    const program = makeProgram([entry, body1, next1, body2, next2, body3, next3, merge]);
    deadBranchChainElimination(program);

    const term = entry.terminator!;
    assertEq(term.op, 'jmp');
    assertEq((term as any).target.label, 'merge');
  });

  test('deadBranchChainElimination: preserved when phi differs', () => {
    const entry = makeBlock('entry');
    const body1 = makeBlock('body1');
    const next1 = makeBlock('next1');
    const merge = makeBlock('merge');

    entry.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 1, thenBlock: body1, elseBlock: next1 };
    link(entry, body1); link(entry, next1);

    body1.terminator = { op: 'jmp', target: merge };
    link(body1, merge);

    next1.terminator = { op: 'jmp', target: merge };
    link(next1, merge);

    // Merge has a phi with different values from body1 vs next1
    merge.phis.push({
      dest: '%t5',
      entries: [
        { block: body1, value: '%t1' },
        { block: next1, value: '%t2' },
      ],
    });

    const program = makeProgram([entry, body1, next1, merge]);
    deadBranchChainElimination(program);

    assert(entry.terminator.op === 'br_cmp', 'entry should still be br_cmp');
  });

  test('deadBranchChainElimination: preserved when body has side effects', () => {
    const entry = makeBlock('entry');
    const body1 = makeBlock('body1', [makeInstr('mark', null, 1, 1)]);
    const next1 = makeBlock('next1');
    const merge = makeBlock('merge');

    entry.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 1, thenBlock: body1, elseBlock: next1 };
    link(entry, body1); link(entry, next1);

    body1.terminator = { op: 'jmp', target: merge };
    link(body1, merge);

    next1.terminator = { op: 'jmp', target: merge };
    link(next1, merge);

    const program = makeProgram([entry, body1, next1, merge]);
    deadBranchChainElimination(program);

    assert(entry.terminator.op === 'br_cmp', 'entry should still be br_cmp');
  });

  test('deadBranchChainElimination: integration with source-level cond', () => {
    // A cond with all-empty bodies should have chain eliminated
    const ir = optSSA(`
      (let ((x (sense here)))
        (cond
          ((= x 1))
          ((= x 2))
          ((= x 3))))
    `);
    // After optimization, the cond chain blocks should be gone
    // The br_cmp instructions from the chain should not appear
    const brCount = (ir.match(/br_cmp/g) || []).length;
    assert(brCount === 0, `expected 0 br_cmp in optimized IR, got ${brCount}:\n${ir}`);
  });
});
