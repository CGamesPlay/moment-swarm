// ═══════════════════════════════════════════════════════════════
// Register Allocation Tests
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, assertIncludes,
         compileSource, makeBlock, makeInstr, makeProgram, link } from './test-helpers';
import { linearizeBlocks, computeLiveIntervals, linearScan } from './regalloc';
import type { BasicBlock } from './ssa';

runSuite('Register Allocation', () => {
  // ── Let-forwarding tests (migrated from antlisp.test.js) ──

  test('let-forwarding: single-use binding into set!', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((food-dir (sense food)))
         (set! dir food-dir)
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r0');
    assert(!asm.includes('SET r0 r1'), 'should not have copy');
  });

  test('let-forwarding: no forward when set! is conditional (when)', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((food-dir (sense food)))
         (when (!= food-dir 0)
           (set! dir food-dir))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r1');
  });

  test('let-forwarding: no forward when binding is set! target', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((x (sense food)))
         (set! x 5)
         (set! dir x)
         (move dir)))`);
    assert(!asm.includes('SENSE FOOD r0'), 'should not forward into dir');
  });

  test('let-forwarding: no forward when set! is conditional (target in cond)', () => {
    const asm = compileSource(`(let ((dir 3))
       (let ((x (sense food)))
         (when (!= dir 0)
           (set! dir x))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r1');
  });

  test('let-forwarding: no forward when set! is conditional (target read before)', () => {
    const asm = compileSource(`(let ((dir 3))
       (let ((x (sense food)))
         (when (!= x 0)
           (move dir)
           (set! dir x))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r1');
  });

  test('let-forwarding: no forward when set! is conditional (intervening forms)', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((x (sense food)))
         (when (!= x 0)
           (move random)
           (set! dir x))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r1');
  });

  test('let-forwarding: no forward when set! is deeply nested in conditionals', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((x (sense food)))
         (when (!= x 0)
           (when (!= x 3)
             (set! dir x)))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r1');
  });

  test('let-forwarding: no forward for trail-dir pattern', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((x (sense food)))
         (when (!= x 0)
           (when (!= (probe x) 1)
             (set! dir x)))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r1');
  });

  test('let-forwarding: no forward when target read in earlier body form', () => {
    const asm = compileSource(`(let ((dir 3))
       (let ((x (sense food)))
         (move dir)
         (when (!= x 0)
           (set! dir x))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r1');
  });

  test('let-forwarding: unconditional set! in begin', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((x (sense food)))
         (begin
           (move random)
           (set! dir x))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r0');
  });

  test('let-forwarding: multi-ref unconditional', () => {
    const asm = compileSource(`(let ((dir 0))
       (let ((x (sense food)))
         (mark ch_red x)
         (set! dir x)
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r0');
  });

  // ── Register leak tests ──

  test('register leak in compileCondJump', () => {
    const asm = compileSource(`(let ((g1 0) (g2 0) (g3 0))
       (cond
         ((= g3 0)
          (if (= (random 5) 0)
            (move n)
            (move s)))
         ((= g3 1)
          (let ((x 1))
            (if (= (random 10) 0)
              (move (+ (random 4) 1))
              (move s))))))`);
    assertIncludes(asm, 'RANDOM');
    assertIncludes(asm, 'MOVE N');
  });

  test('multiple comparisons in sequence should free temp registers', () => {
    const asm = compileSource(`(let ((a 0) (b 0) (c 0))
       (let ((x (sense food)))
         (if (> x 0)
           (if (< x 5)
             (if (= x 3)
               (move n)
               (move s))
             (move e))
           (move w))))`);
    assertIncludes(asm, 'SENSE FOOD');
    assertIncludes(asm, 'MOVE N');
  });

  test('compileCondJump frees temp registers after comparison', () => {
    const asm = compileSource(`(let ((g1 0) (g2 0) (g3 0) (g4 0))
       (let ((x (sense food))
             (y (sense wall)))
         (if (> x y)
           (move n)
           (move s))))`);
    assertIncludes(asm, 'SENSE FOOD');
    assertIncludes(asm, 'JGT');
  });

  test('dead-reg: unconsumed clobberable reg freed at scope exit', () => {
    const asm = compileSource(`(let ((packed 0))
       (let ((tmp 0))
         (set! tmp (and packed 255))
         (set! packed (or packed tmp)))
       (let ((tmp2 0))
         (move random)))`);
    assertIncludes(asm, 'MOVE RANDOM');
  });

  // ── Synthetic tests ──

  test('linearizeBlocks: diamond CFG in reverse postorder', () => {
    const entry = makeBlock('entry');
    const left = makeBlock('left');
    const right = makeBlock('right');
    const merge = makeBlock('merge');

    entry.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 0, thenBlock: left, elseBlock: right };
    link(entry, left);
    link(entry, right);
    left.terminator = { op: 'jmp', target: merge };
    link(left, merge);
    right.terminator = { op: 'jmp', target: merge };
    link(right, merge);

    const program = makeProgram([entry, left, right, merge]);
    const order = linearizeBlocks(program);
    assertEq(order[0].label, 'entry');
    assertEq(order[order.length - 1].label, 'merge');
  });

  test('computeLiveIntervals: simple temps', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 42),
      makeInstr('const', '%t1', 10),
      makeInstr('add', '%t2', '%t0', '%t1'),
      makeInstr('move', null, '%t2'),
    ]);
    const program = makeProgram([entry]);
    const linearized = linearizeBlocks(program);
    // Number instructions manually
    const numbered: any[] = [];
    let index = 0;
    for (const block of linearized) {
      for (const phi of block.phis) numbered.push({ index: index++, block, kind: 'phi', phi });
      for (const instr of block.instrs) numbered.push({ index: index++, block, kind: 'instr', instr });
      if (block.terminator) numbered.push({ index: index++, block, kind: 'terminator', terminator: block.terminator });
    }
    const intervals = computeLiveIntervals(numbered);
    const t0 = intervals.find(i => i.temp === '%t0')!;
    const t2 = intervals.find(i => i.temp === '%t2')!;
    assert(t0.start === 0, `t0 should start at 0, got ${t0.start}`);
    assert(t2.end === 3, `t2 should end at 3 (used in move), got ${t2.end}`);
  });

  test('linearScan: no register conflicts', () => {
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 1),
      makeInstr('const', '%t1', 2),
      makeInstr('add', '%t2', '%t0', '%t1'),
      makeInstr('move', null, '%t2'),
    ]);
    const program = makeProgram([entry]);
    const linearized = linearizeBlocks(program);
    const numbered: any[] = [];
    let index = 0;
    for (const block of linearized) {
      for (const instr of block.instrs) numbered.push({ index: index++, block, kind: 'instr', instr });
    }
    const intervals = computeLiveIntervals(numbered);
    const result = linearScan(program, intervals);
    // All temps should be allocated
    assert(result.allocation.has('%t0'));
    assert(result.allocation.has('%t1'));
    assert(result.allocation.has('%t2'));
    // No two simultaneously-live temps should share a register
    const r0 = result.allocation.get('%t0');
    const r1 = result.allocation.get('%t1');
    assert(r0 !== r1, `t0 and t1 should get different registers (both got ${r0})`);
  });
});
