// ═══════════════════════════════════════════════════════════════
// Codegen Tests — code generation
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, assertIncludes, assertMatch, compileSource } from './test-helpers';
import { resolveParallelMoves } from './codegen';

runSuite('Codegen', () => {
  test('move with all directions: direction name mapping', () => {
    const asm = compileSource(`(move n) (move ne) (move e) (move se)
       (move s) (move sw) (move w) (move nw)`);
    assertIncludes(asm, 'MOVE N');
    assertIncludes(asm, 'MOVE NE');
    assertIncludes(asm, 'MOVE E');
    assertIncludes(asm, 'MOVE SE');
    assertIncludes(asm, 'MOVE S');
    assertIncludes(asm, 'MOVE SW');
    assertIncludes(asm, 'MOVE W');
    assertIncludes(asm, 'MOVE NW');
  });

  test('comparison with zero: jump instruction selection', () => {
    const asm = compileSource('(let ((x (sense food))) (if (= x 0) (move random) (move x)))');
    // Should have JEQ or JNE for the equality check
    const hasJump = asm.includes('JEQ') || asm.includes('JNE');
    if (!hasJump) throw new Error('Expected JEQ or JNE in:\n' + asm);
  });

  test('mark with arithmetic result: constant folded', () => {
    const asm = compileSource('(let ((val (+ 50 50))) (mark ch_red val))');
    assertIncludes(asm, 'SET r0 100');
    assertIncludes(asm, 'MARK CH_RED');
  });

  test('multiple pheromone channels', () => {
    const asm = compileSource(`(mark ch_red 100)
       (mark ch_green 50)
       (mark ch_blue 25)`);
    assertIncludes(asm, 'MARK CH_RED 100');
    assertIncludes(asm, 'MARK CH_GREEN 50');
    assertIncludes(asm, 'MARK CH_BLUE 25');
  });

  test('set-tag emits TAG instruction', () => {
    const asm = compileSource('(set-tag 0)');
    assertIncludes(asm, 'TAG 0');
  });

  // ── resolveParallelMoves tests ──

  test('resolveParallelMoves: 3-element cycle emits correct order', () => {
    // Cycle: r0→r1, r1→r2, r2→r0
    // After resolution, each register should hold the original value of its source.
    // Simulate by tracking register values through the emitted SET instructions.
    const copies = [
      { from: 'r0', to: 'r1' },
      { from: 'r1', to: 'r2' },
      { from: 'r2', to: 'r0' },
    ];
    const lines = resolveParallelMoves(copies, new Set());

    // Simulate execution: start with r0=10, r1=20, r2=30
    const regs: Record<string, number> = { r0: 10, r1: 20, r2: 30, r3: 0, r4: 0, r5: 0, r6: 0, r7: 0 };
    for (const line of lines) {
      const m = line.match(/SET (r\d+) (r\d+)/);
      assert(!!m, `Expected SET instruction, got: ${line}`);
      regs[m![1]] = regs[m![2]];
    }

    // After parallel move: r1 should have old r0 (10), r2 should have old r1 (20),
    // r0 should have old r2 (30)
    assertEq(regs.r1, 10, `r1 should be old r0 (10), got ${regs.r1}. Lines: ${lines.join(' | ')}`);
    assertEq(regs.r2, 20, `r2 should be old r1 (20), got ${regs.r2}. Lines: ${lines.join(' | ')}`);
    assertEq(regs.r0, 30, `r0 should be old r2 (30), got ${regs.r0}. Lines: ${lines.join(' | ')}`);
  });

  test('resolveParallelMoves: 2-element swap avoids live register as temp', () => {
    // Swap r0↔r1 with r2 marked live — temp must NOT use r2
    const copies = [
      { from: 'r0', to: 'r1' },
      { from: 'r1', to: 'r0' },
    ];
    const lines = resolveParallelMoves(copies, new Set(['r2']));

    const regs: Record<string, number> = { r0: 10, r1: 20, r2: 99, r3: 0, r4: 0, r5: 0, r6: 0, r7: 0 };
    for (const line of lines) {
      const m = line.match(/SET (r\d+) (r\d+)/);
      assert(!!m, `Expected SET instruction, got: ${line}`);
      regs[m![1]] = regs[m![2]];
    }

    assertEq(regs.r0, 20, `r0 should be old r1 (20), got ${regs.r0}`);
    assertEq(regs.r1, 10, `r1 should be old r0 (10), got ${regs.r1}`);
    assertEq(regs.r2, 99, `r2 (live) should be unchanged (99), got ${regs.r2}`);
  });

  test('phi swap in loop does not clobber live-through variable', () => {
    // End-to-end: 3 vars in a loop, 2 get swapped on one path, third is live-through.
    // The liveRegsAtEnd computation must include the live-through register so the
    // swap temp doesn't clobber it.
    // c is used in `mark` so it can't be optimized away.
    const asm = compileSource(`
      (let ((a 10) (b 20) (c 99))
        (loop
          (when (= a 10)
            (let ((tmp a))
              (set! a b)
              (set! b tmp)))
          (mark ch_red c)
          (move n)))
    `);
    const lines = asm.split('\n').map(l => l.trim());

    // Find the initial SET for c (99)
    const cInit = lines.find(l => l.includes('SET') && l.includes('99'));
    assert(!!cInit, `Expected SET r? 99 for c, got nothing in:\n${asm}`);
    const cReg = cInit!.match(/SET (r\d+) 99/)?.[1];
    assert(!!cReg, `Could not parse c register from: ${cInit}`);

    // Find the swap block: look for consecutive SETs that form the swap
    // pattern (3 SETs using a temp register for r0↔r1 swap)
    const swapLines = lines.filter(l => /^SET r\d+ r\d+$/.test(l));

    // None of the swap SET destinations should be cReg
    const clobbered = swapLines.some(l => {
      const dest = l.match(/SET (r\d+)/)?.[1];
      return dest === cReg;
    });

    if (clobbered) {
      throw new Error(
        `Swap clobbers ${cReg} (c=99). Swap lines: ${swapLines.join(' | ')}. Full asm:\n${asm}`
      );
    }
  });

  test('resolveParallelMoves: 3-element cycle with live regs', () => {
    // Same cycle but with r3 marked live — temp must not use r3
    const copies = [
      { from: 'r0', to: 'r1' },
      { from: 'r1', to: 'r2' },
      { from: 'r2', to: 'r0' },
    ];
    const lines = resolveParallelMoves(copies, new Set(['r3']));

    const regs: Record<string, number> = { r0: 10, r1: 20, r2: 30, r3: 99, r4: 0, r5: 0, r6: 0, r7: 0 };
    for (const line of lines) {
      const m = line.match(/SET (r\d+) (r\d+)/);
      assert(!!m, `Expected SET instruction, got: ${line}`);
      regs[m![1]] = regs[m![2]];
    }

    assertEq(regs.r1, 10, `r1 should be old r0 (10), got ${regs.r1}`);
    assertEq(regs.r2, 20, `r2 should be old r1 (20), got ${regs.r2}`);
    assertEq(regs.r0, 30, `r0 should be old r2 (30), got ${regs.r0}`);
    assertEq(regs.r3, 99, `r3 (live) should be unchanged, got ${regs.r3}`);
  });
});
