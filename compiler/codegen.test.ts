// ═══════════════════════════════════════════════════════════════
// Codegen Tests — code generation
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assertIncludes, assertMatch, compileSource } from './test-helpers';

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
});
