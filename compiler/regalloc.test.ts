// ═══════════════════════════════════════════════════════════════
// Register Allocation Tests
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, assertIncludes,
         compileSource, makeBlock, makeInstr, makePhi, makeProgram, link } from './test-helpers';
import { linearizeBlocks, numberInstructions, computeLiveIntervals, linearScan } from './regalloc';
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
    // With dir=3, the condition (!= dir 0) is constant-folded to true,
    // so dir is always overwritten by x. The allocator correctly coalesces them.
    const asm = compileSource(`(let ((dir 3))
       (let ((x (sense food)))
         (when (!= dir 0)
           (set! dir x))
         (move dir)))`);
    assertIncludes(asm, 'SENSE FOOD r0');
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

  test('linearizeBlocks: loop body before exit (body is then-branch)', () => {
    // Models a while loop: header branches to body (then) or exit (else)
    const entry = makeBlock('entry');
    const header = makeBlock('header');
    const body = makeBlock('body');
    const exit = makeBlock('exit');

    entry.terminator = { op: 'jmp', target: header };
    link(entry, header);
    header.terminator = { op: 'br_cmp', cmpOp: 'gt', a: '%t0', b: 0, thenBlock: body, elseBlock: exit };
    link(header, body);
    link(header, exit);
    body.terminator = { op: 'jmp', target: header };
    link(body, header);

    const program = makeProgram([entry, header, body, exit]);
    const order = linearizeBlocks(program);
    const bodyIdx = order.indexOf(body);
    const exitIdx = order.indexOf(exit);
    assert(bodyIdx < exitIdx,
      `body (idx ${bodyIdx}) should come before exit (idx ${exitIdx}) to avoid fall-through into body`);
  });

  test('linearizeBlocks: loop body before exit (body is else-branch)', () => {
    // Models a dotimes loop: header branches to exit (then) or body (else)
    const entry = makeBlock('entry');
    const header = makeBlock('header');
    const body = makeBlock('body');
    const exit = makeBlock('exit');

    entry.terminator = { op: 'jmp', target: header };
    link(entry, header);
    header.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 5, thenBlock: exit, elseBlock: body };
    link(header, exit);
    link(header, body);
    body.terminator = { op: 'jmp', target: header };
    link(body, header);

    const program = makeProgram([entry, header, body, exit]);
    const order = linearizeBlocks(program);
    const bodyIdx = order.indexOf(body);
    const exitIdx = order.indexOf(exit);
    assert(bodyIdx < exitIdx,
      `body (idx ${bodyIdx}) should come before exit (idx ${exitIdx}) to avoid fall-through into body`);
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
    const numbered = numberInstructions(linearized);
    const intervals = computeLiveIntervals(linearized, numbered);
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
    const numbered = numberInstructions(linearized);
    const intervals = computeLiveIntervals(linearized, numbered);
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

  // ── Phi copy ordering (parallel move) tests ──

  test('phi copies: cond set! inside if does not clobber via sequential copies', () => {
    // Minimal reproduction of the cheater.alisp bug:
    // Two outer variables (dx, dy) mutated in different cond branches,
    // nested inside an if that creates an outer join point with phi nodes.
    // The phi copies at each cond branch must not clobber each other.
    const asm = compileSource(`(let ((dx 5) (dy 10))
       (let ((dir (+ (carrying?) 4)))
         (if (!= dir 0)
           (cond ((= dir 1) (set! dy (- dy 1)))
                 ((= dir 2) (set! dx (+ dx 1)))
                 ((= dir 3) (set! dy (+ dy 1)))
                 ((= dir 4) (set! dx (- dx 1))))
           (begin)))
       (mark ch_red dx)
       (mark ch_green dy))`);
    // After the cond with dir=4, dx should be 4 and dy should be 10.
    // The bug was that sequential phi copies would clobber: both end up as dy (10).
    // Verify that the assembly doesn't have a pattern where a phi copy
    // destination is immediately read as a source (lost copy).
    //
    // We check this end-to-end: the cond_body for dir=4 should compute
    // dx-1 = 4, and the value that reaches MARK CH_RED must be 4, not 10.
    // Since this is a compile-time test, we verify the assembly structure:
    // there should be no adjacent "SET rX rY; SET rZ rX" where the second
    // SET reads the just-written register (unless rX == source of first SET).

    // Simplest check: compile + run via the unit test harness already catches it,
    // but we can also verify that constants 4 and 10 appear correctly.
    // The key structural check: in any cond body block, if there are two
    // SET instructions for phi copies, they must not have a read-after-write hazard.
    const lines = asm.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const m1 = lines[i].match(/^\s*SET (r\d+) (r\d+)\s*$/);
      const m2 = lines[i + 1].match(/^\s*SET (r\d+) (r\d+)\s*$/);
      if (m1 && m2) {
        const [, dest1] = m1;
        const [, , src2] = m2;
        // If the second copy reads from the first copy's destination,
        // and they're both phi copies (back-to-back SETs), that's a lost copy.
        // Exception: if they're part of a swap (handled by temp), that's fine.
        if (dest1 === src2) {
          // Check if the original source is still available
          // This is the actual bug: SET r2 r1; SET r3 r2 loses the old r2 value
          const [, , src1] = m1;
          const [, dest2] = m2;
          assert(src1 === dest2,
            `Lost copy hazard at line ${i + 1}: "${lines[i].trim()}" then "${lines[i + 1].trim()}" — ` +
            `${dest1} is overwritten before ${src2} is read`);
        }
      }
    }
  });

  test('phi copies: swap cycle (r0 ↔ r1) uses temp register correctly', () => {
    // When two variables need to swap registers at a tagbody transition,
    // resolveParallelMoves must emit 3 SET instructions to swap via a temp.
    // Bug: the final restore wrote to the wrong destination, producing only
    // 2 instructions after peephole (a no-op) instead of a proper 3-instruction swap.
    //
    // A correct swap of r0↔r1 via temp r2:
    //   SET r2 r1    ; save r1 to temp
    //   SET r1 r0    ; r1 = old r0
    //   SET r0 r2    ; r0 = temp = old r1
    //
    // The bug produced (before peephole):
    //   SET r2 r1    ; save r1 to temp
    //   SET r1 r0    ; r1 = old r0
    //   SET r1 r2    ; r1 = temp — WRONG, overwrites r1, r0 never written
    //
    // After peephole, the redundant SET r1 r0 / SET r1 r2 collapsed to:
    //   SET r2 r1
    //   SET r1 r2    ; this is a no-op — r0 and r1 are unchanged
    const asm = compileSource(`
      (defmacro inc-dx! (packed)
        (let ((tmp 0))
          (set! tmp (and packed 255))
          (set! tmp (+ tmp 1))
          (set! tmp (and tmp 255))
          (set! packed (and packed 0xFFFFFF00))
          (set! packed (or packed tmp))))
      (defmacro dec-dy! (packed)
        (let ((tmp 0))
          (set! tmp (rshift packed 8))
          (set! tmp (and tmp 255))
          (set! tmp (- tmp 1))
          (set! tmp (and tmp 255))
          (set! tmp (lshift tmp 8))
          (set! packed (and packed 0xFFFF00FF))
          (set! packed (or packed tmp))))
      (defmacro inc-dy! (packed)
        (let ((tmp 0))
          (set! tmp (rshift packed 8))
          (set! tmp (and tmp 255))
          (set! tmp (+ tmp 1))
          (set! tmp (and tmp 255))
          (set! tmp (lshift tmp 8))
          (set! packed (and packed 0xFFFF00FF))
          (set! packed (or packed tmp))))
      (defmacro dec-dx! (packed)
        (let ((tmp 0))
          (set! tmp (and packed 255))
          (set! tmp (- tmp 1))
          (set! tmp (and tmp 255))
          (set! packed (and packed 0xFFFFFF00))
          (set! packed (or packed tmp))))
      (defmacro move-with-tracking-packed (dir packed)
        (unless (= (probe dir) 1)
          (move dir)
          (cond ((= dir 1) (dec-dy! packed))
                ((= dir 2) (inc-dx! packed))
                ((= dir 3) (inc-dy! packed))
                ((= dir 4) (dec-dx! packed)))))
      (let ((dir 0) (homepos 0))
        (tagbody
          exploring
          (set! dir (sense food))
          (when (!= dir 0)
            (move-with-tracking-packed dir homepos)
            (pickup)
            (go returning))
          (move random)
          (go exploring)
          returning
          (let ((nest-dir (sense nest)))
            (when (!= nest-dir 0)
              (set! dir nest-dir)
              (move-with-tracking-packed dir homepos)
              (drop)
              (set! homepos 0)
              (go exploring)))
          (move-with-tracking-packed dir homepos)
          (go returning)))`);

    // Find the PICKUP instruction. The phi copies immediately after it must
    // be a 3-instruction swap (SET temp src; SET dst1 src2; SET dst2 temp).
    // With the bug, peephole collapses the broken sequence to 2 instructions.
    const lines = asm.split('\n').map(l => l.trim());
    const pickupIdx = lines.findIndex(l => l === 'PICKUP');
    assert(pickupIdx !== -1, 'Expected PICKUP instruction in assembly');

    // Count consecutive SET rX rY instructions after PICKUP
    let setCount = 0;
    for (let i = pickupIdx + 1; i < lines.length; i++) {
      if (lines[i].match(/^SET r\d+ r\d+$/)) {
        setCount++;
      } else {
        break;
      }
    }

    assertEq(setCount, 3,
      `Expected 3 SET instructions after PICKUP (a proper swap), got ${setCount}: ` +
      lines.slice(pickupIdx, pickupIdx + setCount + 2).join(' | '));
  });

  test('phi copies: swap temp register must not clobber live values', () => {
    // When resolveParallelMoves breaks a cycle with a temp register, the temp
    // must not be a register that holds a live value not involved in the swap.
    //
    // This models the LOST→EXPLORING transition in bridge.alisp:
    // - dir (r0), counter (r1), explore-age (r2) are live at exploring header
    // - counter and explore-age are both set to 0 (new const temps in r1, r2)
    // - The phi swap of r1↔r2 picks r0 (dir) as temp, clobbering dir
    //
    // At __tag_lost_, the phi copies should only write to the two registers
    // being swapped plus the temp. The temp must NOT be a register that holds
    // a value needed after the transition (dir in r0).
    //
    // We detect this by counting how many distinct registers are written as
    // SET destinations between __tag_lost_ and the JMP. A correct swap of
    // r1↔r2 writes exactly 3 SETs to {r1, r2, temp} where temp != r0.
    // The bug writes to {r0, r1, r2} — 3 registers when only 2 should change.
    const asm = compileSource(`
      (let ((dir 0) (counter 0) (explore-age 0))
        (tagbody
          exploring
          (when (>= explore-age 10)
            (go lost))
          (set! dir (+ (random 4) 1))
          (mark ch_red dir)
          (set! counter (- counter 1))
          (set! explore-age (+ explore-age 1))
          (go exploring)
          lost
          (set! explore-age 0)
          (set! counter 0)
          (go exploring)))`);

    const lines = asm.split('\n').map(l => l.trim());
    const lostIdx = lines.findIndex(l => l.includes('__tag_lost_'));
    assert(lostIdx !== -1, 'Expected __tag_lost_ label in assembly');

    // Collect all SET destinations between __tag_lost_ and JMP
    const setDests = new Set<string>();
    for (let i = lostIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('JMP')) break;
      const setMatch = lines[i].match(/^SET (r\d+)/);
      if (setMatch) {
        setDests.add(setMatch[1]);
      }
    }

    // The swap involves 2 registers (counter and explore-age).
    // A correct implementation writes to those 2 registers plus a temp that
    // is NOT dir's register. With the bug, it writes to 3 registers including
    // dir's register (r0). We check that the SET destinations are at most
    // the 2 swap registers plus 1 temp, and that the temp is not used as a
    // source of the final value at the exploring header.
    //
    // Simplest check: the number of distinct registers written should be <= 3,
    // and they should not include a register that is unchanged by the transition
    // (dir). Dir's register at the tag header is r0 (first phi, first allocated).
    // After the lost block sets const 0 into r1 and r2, the swap should only
    // touch r1, r2, and a temp that is r3+ (not r0).
    assert(!setDests.has('r0'),
      `Swap temp clobbered r0 (dir) at __tag_lost_: writes to {${[...setDests].join(', ')}} — ` +
      `resolveParallelMoves used dir's register as temp`);
  });

  test('lifetime holes: temp captured by phi has shorter interval than merge output', () => {
    // Models the bridge.alisp pattern: a temp defined before a branch is captured
    // by a phi node, so its interval ends at the phi rather than spanning the
    // entire post-branch code. With per-block sub-ranges, the temp's interval
    // is tight to where it's actually live.
    //
    // entry: define %t0, define %t1, branch on %t0
    // left:  phi %t2 = [entry: %t1, right: %t3], use %t2, define %t3, jmp right
    // right: use %t1 directly
    //
    // %t1's interval should end no later than its last use, NOT span to the end
    // of the program. The old min/max approach would extend it too far.
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 1),
      makeInstr('const', '%t1', 42),
    ]);
    const left = makeBlock('left', [
      makeInstr('move', null, '%t1'),
      makeInstr('const', '%t3', 99),
    ]);
    const right = makeBlock('right', [
      makeInstr('move', null, '%t1'),
      makeInstr('const', '%t4', 0),
      makeInstr('move', null, '%t4'),
    ]);

    entry.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 0, thenBlock: left, elseBlock: right };
    left.terminator = { op: 'jmp', target: right };
    link(entry, left);
    link(entry, right);
    link(left, right);

    const program = makeProgram([entry, left, right]);
    const linearized = linearizeBlocks(program);
    const numbered = numberInstructions(linearized);
    const intervals = computeLiveIntervals(linearized, numbered);

    const t1intervals = intervals.filter(i => i.temp === '%t1');
    // %t1 is used in left (instr 3) and right (instr 5). It should NOT span
    // past its last use at instruction 5 to the end of the program.
    const lastInstrIdx = numbered[numbered.length - 1].index;
    for (const iv of t1intervals) {
      assert(iv.end < lastInstrIdx,
        `%t1 interval [${iv.start},${iv.end}] should not extend to last instruction ${lastInstrIdx}`);
    }
  });

  // ── Arithmetic coalescing tests ──

  test('arithmetic coalescing: no SET between ADD and AND in simple chain', () => {
    // When (and (+ x 1) 255) is compiled, the AND should reuse the same
    // register as the ADD result, eliminating the SET between them.
    const asm = compileSource('(let ((x (sense food))) (set! x (and (+ x 1) 255)) (move x))');
    const lines = asm.split('\n').map(l => l.trim());

    // Find the ADD instruction
    const addIdx = lines.findIndex(l => l.match(/^ADD r\d+ 1$/));
    assert(addIdx !== -1, 'Expected ADD instruction');

    // Find the AND instruction after the ADD
    const andIdx = lines.findIndex((l, i) => i > addIdx && l.match(/^AND r\d+ 255$/));
    assert(andIdx !== -1, 'Expected AND instruction after ADD');

    // Count SET instructions between ADD and AND
    let setCount = 0;
    for (let i = addIdx + 1; i < andIdx; i++) {
      if (lines[i].match(/^SET r\d+ r\d+$/)) {
        setCount++;
      }
    }
    assertEq(setCount, 0,
      `Expected no SET between ADD and AND, got ${setCount}: ${lines.slice(addIdx, andIdx + 1).join(' | ')}`);
  });

  test('arithmetic coalescing: packed field update reduces SETs', () => {
    // The dec-dy! pattern generates many redundant SETs without arithmetic
    // coalescing hints. With hints, the count should drop significantly.
    const asm = compileSource(`(let ((packed (sense food)))
      (let ((tmp 0))
        (set! tmp (rshift packed 8))
        (set! tmp (and tmp 255))
        (set! tmp (- tmp 1))
        (set! tmp (and tmp 255))
        (set! tmp (lshift tmp 8))
        (set! packed (and packed 16711935))
        (set! packed (or packed tmp)))
      (mark ch_red packed))`);

    const setCount = asm.split('\n').filter(l => l.trim().match(/^SET r\d+ r\d+$/)).length;
    // Before arithmetic coalescing: 7 register-to-register SETs
    // After: should be significantly fewer (3 or less)
    assert(setCount <= 3,
      `Expected at most 3 register-to-register SETs, got ${setCount}:\n${asm}`);
  });

  test('diamond CFG: exclusive branch temps get non-overlapping intervals', () => {
    // Diamond: entry -> left/right -> merge
    // %t0 defined in entry (condition)
    // %t1 defined and used only in left branch
    // %t2 defined and used only in right branch
    // %t3 is the phi merge result
    const entry = makeBlock('entry', [
      makeInstr('const', '%t0', 1),
    ]);
    const left = makeBlock('left', [
      makeInstr('const', '%t1', 10),
      makeInstr('move', null, '%t1'),
    ]);
    const right = makeBlock('right', [
      makeInstr('const', '%t2', 20),
      makeInstr('move', null, '%t2'),
    ]);
    const merge = makeBlock('merge', [
      makeInstr('nop', null),
    ]);

    entry.terminator = { op: 'br_cmp', cmpOp: 'eq', a: '%t0', b: 0, thenBlock: left, elseBlock: right };
    left.terminator = { op: 'jmp', target: merge };
    right.terminator = { op: 'jmp', target: merge };

    link(entry, left);
    link(entry, right);
    link(left, merge);
    link(right, merge);

    const program = makeProgram([entry, left, right, merge]);
    const linearized = linearizeBlocks(program);
    const numbered = numberInstructions(linearized);
    const intervals = computeLiveIntervals(linearized, numbered);

    const t1 = intervals.find(i => i.temp === '%t1')!;
    const t2 = intervals.find(i => i.temp === '%t2')!;
    // t1 and t2 are in exclusive branches, so their intervals should not overlap
    const overlaps = t1.start <= t2.end && t2.start <= t1.end;
    assert(!overlaps,
      `t1 [${t1.start},${t1.end}] and t2 [${t2.start},${t2.end}] should NOT overlap (exclusive branches)`);
  });
});
