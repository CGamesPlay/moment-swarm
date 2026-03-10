// ═══════════════════════════════════════════════════════════════
// Peephole Tests — peephole optimization on assembly lines
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assertEq } from './test-helpers';
import { peephole } from './peephole';

runSuite('Peephole', () => {
  test('dead store: consecutive SET to same register', () => {
    const result = peephole(['  SET r0 5', '  SET r0 10']);
    assertEq(result, ['  SET r0 10']);
  });

  test('dead store: NOT eliminated with intervening referenced label', () => {
    // The JEQ can jump to label from elsewhere, so both SETs must survive
    const result = peephole(['  JEQ r1 0 label', '  SET r0 5', 'label:', '  SET r0 10']);
    assertEq(result, ['  JEQ r1 0 label', '  SET r0 5', 'label:', '  SET r0 10']);
  });

  test('dead store: skips blank lines and comments', () => {
    const result = peephole(['  SET r0 5', '', '  ; comment', '  SET r0 10']);
    // Only the dead SET is removed; blank lines and comments are preserved
    assertEq(result, ['', '  ; comment', '  SET r0 10']);
  });

  test('redundant JMP: jump to next label eliminated, orphan label removed', () => {
    const result = peephole(['  JMP __next_0', '__next_0:']);
    assertEq(result, []);
  });

  test('redundant JMP: jump to non-adjacent label preserved', () => {
    const result = peephole(['  JMP __far_0', '  MOVE N', '__far_0:']);
    assertEq(result, ['  JMP __far_0', '  MOVE N', '__far_0:']);
  });

  test('mixed patterns', () => {
    const result = peephole([
      '  SET r0 5',
      '  SET r0 10',
      '  JMP __end_0',
      '__end_0:',
      '  MOVE r0',
    ]);
    assertEq(result, [
      '  SET r0 10',
      '  MOVE r0',
    ]);
  });

  test('empty input', () => {
    const result = peephole([]);
    assertEq(result, []);
  });

  test('dead store: different registers not eliminated', () => {
    const result = peephole(['  SET r0 5', '  SET r1 10']);
    assertEq(result, ['  SET r0 5', '  SET r1 10']);
  });

  test('dead label: unreferenced label removed', () => {
    const result = peephole(['__unused_0:', '  MOVE r0']);
    assertEq(result, ['  MOVE r0']);
  });

  test('dead label: referenced label preserved', () => {
    // Non-redundant JMP (instruction between JMP and label)
    const result = peephole(['  JMP __target_0', '  SET r0 5', '__target_0:', '  MOVE r0']);
    assertEq(result, ['  JMP __target_0', '  SET r0 5', '__target_0:', '  MOVE r0']);
  });

  test('dead label: conditional branch reference preserves label', () => {
    const result = peephole(['  JEQ r0 0 __target_0', '__other_0:', '__target_0:', '  MOVE r0']);
    assertEq(result, ['  JEQ r0 0 __target_0', '__target_0:', '  MOVE r0']);
  });

  test('dead label: chain of unreferenced labels all removed', () => {
    const result = peephole(['__a_0:', '__b_1:', '__c_2:', '  MOVE r0']);
    assertEq(result, ['  MOVE r0']);
  });

  test('dead label: interacts with redundant JMP elimination', () => {
    // JMP to next label is removed (pass 2), then orphaned label is removed (pass 3)
    const result = peephole(['  JMP __mid_0', '__mid_0:', '  JMP __end_0', '__end_0:', '  MOVE r0']);
    assertEq(result, ['  MOVE r0']);
  });
});
