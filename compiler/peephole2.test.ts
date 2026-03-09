// ═══════════════════════════════════════════════════════════════
// Peephole Tests — peephole optimization on assembly lines
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assertEq } from './test-helpers';
import { peephole } from './peephole2';

runSuite('Peephole', () => {
  test('dead store: consecutive SET to same register', () => {
    const result = peephole(['  SET r0 5', '  SET r0 10']);
    assertEq(result, ['  SET r0 10']);
  });

  test('dead store: NOT eliminated with intervening label', () => {
    const result = peephole(['  SET r0 5', 'label:', '  SET r0 10']);
    assertEq(result, ['  SET r0 5', 'label:', '  SET r0 10']);
  });

  test('dead store: skips blank lines and comments', () => {
    const result = peephole(['  SET r0 5', '', '  ; comment', '  SET r0 10']);
    // Only the dead SET is removed; blank lines and comments are preserved
    assertEq(result, ['', '  ; comment', '  SET r0 10']);
  });

  test('redundant JMP: jump to next label eliminated', () => {
    const result = peephole(['  JMP __next_0', '__next_0:']);
    assertEq(result, ['__next_0:']);
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
      '__end_0:',
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
});
