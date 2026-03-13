// ═══════════════════════════════════════════════════════════════
// Peephole Tests — peephole optimization on assembly lines
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assertEq } from './test-helpers';
import { peephole } from './peephole';

// Convenience wrapper: pass lines without instrIndex
function runPeephole(lines: string[]): string[] {
  return peephole(lines).lines;
}

runSuite('Peephole', () => {
  test('dead store: consecutive SET to same register', () => {
    const result = runPeephole(['  SET r0 5', '  SET r0 10']);
    assertEq(result, ['  SET r0 10']);
  });

  test('dead store: NOT eliminated with intervening referenced label', () => {
    // The JEQ can jump to label from elsewhere, so both SETs must survive
    const result = runPeephole(['  JEQ r1 0 label', '  SET r0 5', 'label:', '  SET r0 10']);
    assertEq(result, ['  JEQ r1 0 label', '  SET r0 5', 'label:', '  SET r0 10']);
  });

  test('dead store: skips blank lines and comments', () => {
    const result = runPeephole(['  SET r0 5', '', '  ; comment', '  SET r0 10']);
    // Only the dead SET is removed; blank lines and comments are preserved
    assertEq(result, ['', '  ; comment', '  SET r0 10']);
  });

  test('redundant JMP: jump to next label eliminated, orphan label removed', () => {
    const result = runPeephole(['  JMP __next_0', '__next_0:']);
    assertEq(result, []);
  });

  test('redundant JMP: jump to non-adjacent label preserved', () => {
    // MOVE N between JMP and __far_0 is unreachable dead code — removed.
    // Then JMP __far_0 becomes redundant (falls through to __far_0) — removed.
    // Then __far_0 is a dead label — removed.
    const result = runPeephole(['  JMP __far_0', '  MOVE N', '__far_0:']);
    assertEq(result, []);
  });

  test('mixed patterns', () => {
    const result = runPeephole([
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
    const result = runPeephole([]);
    assertEq(result, []);
  });

  test('dead store: different registers not eliminated', () => {
    const result = runPeephole(['  SET r0 5', '  SET r1 10']);
    assertEq(result, ['  SET r0 5', '  SET r1 10']);
  });

  test('dead label: unreferenced label removed', () => {
    const result = runPeephole(['__unused_0:', '  MOVE r0']);
    assertEq(result, ['  MOVE r0']);
  });

  test('dead label: referenced label preserved', () => {
    // SET r0 5 is unreachable (after JMP) — removed.
    // Then JMP __target_0 becomes redundant (falls through) — removed.
    // Then __target_0 is a dead label — removed.
    const result = runPeephole(['  JMP __target_0', '  SET r0 5', '__target_0:', '  MOVE r0']);
    assertEq(result, ['  MOVE r0']);
  });

  test('dead label: conditional branch reference preserves label', () => {
    const result = runPeephole(['  JEQ r0 0 __target_0', '__other_0:', '__target_0:', '  MOVE r0']);
    assertEq(result, ['  JEQ r0 0 __target_0', '__target_0:', '  MOVE r0']);
  });

  test('dead label: chain of unreferenced labels all removed', () => {
    const result = runPeephole(['__a_0:', '__b_1:', '__c_2:', '  MOVE r0']);
    assertEq(result, ['  MOVE r0']);
  });

  test('dead label: interacts with redundant JMP elimination', () => {
    // JMP to next label is removed (pass 2), then orphaned label is removed (pass 3)
    const result = runPeephole(['  JMP __mid_0', '__mid_0:', '  JMP __end_0', '__end_0:', '  MOVE r0']);
    assertEq(result, ['  MOVE r0']);
  });

  // ─── Tail merging ───────────────────────────────────────────

  test('tail merge: two blocks sharing 3-instruction tail', () => {
    // Two blocks with different prefixes but identical 3-instruction tails.
    // savings = (2-1)*3 - 2 = 1
    const result = runPeephole([
      '  JEQ r2 0 block_a',
      '  JEQ r2 1 block_b',
      '  MOVE r2',
      'block_a:',
      '  SET r0 1',
      '  SET r1 r3',
      '  SUB r1 1',
      '  JMP __target',
      'block_b:',
      '  SET r0 2',
      '  SET r1 r3',
      '  SUB r1 1',
      '  JMP __target',
      '__target:',
      '  MOVE r0',
    ]);
    // Shared tail extracted; each block gets JMP to shared tail
    const tailLabel = result.find(l => l.trim().startsWith('__tail_'))?.trim().slice(0, -1);
    // Verify: two JMPs to the tail label, and the shared instructions appear once
    const tailJmps = result.filter(l => l.trim() === `JMP ${tailLabel}`);
    assertEq(tailJmps.length, 2);
    // The shared body (SET r1 r3, SUB r1 1) appears exactly once
    const setSubs = result.filter(l => l.trim() === 'SET r1 r3');
    assertEq(setSubs.length, 1);
  });

  test('tail merge: two blocks sharing 2-instruction tail NOT merged', () => {
    // savings = (2-1)*2 - 2 = 0, not worth it
    const result = runPeephole([
      '  JEQ r2 0 block_a',
      '  JEQ r2 1 block_b',
      '  MOVE r2',
      'block_a:',
      '  SET r0 1',
      '  SUB r1 1',
      '  JMP __target',
      'block_b:',
      '  SET r0 2',
      '  SUB r1 1',
      '  JMP __target',
      '__target:',
      '  MOVE r0',
    ]);
    // No tail merging should occur; SUB r1 1 still appears twice
    const subs = result.filter(l => l.trim() === 'SUB r1 1');
    assertEq(subs.length, 2);
  });

  test('tail merge: three blocks sharing 2-instruction tail', () => {
    // savings = (3-1)*2 - 3 = 1
    const result = runPeephole([
      'block_a:',
      '  SET r0 1',
      '  SUB r1 1',
      '  JMP __target',
      'block_b:',
      '  SET r0 2',
      '  SUB r1 1',
      '  JMP __target',
      'block_c:',
      '  SET r0 3',
      '  SUB r1 1',
      '  JMP __target',
      '__target:',
      '  MOVE r0',
    ]);
    const subs = result.filter(l => l.trim() === 'SUB r1 1');
    assertEq(subs.length, 1);  // shared tail has it once
  });

  test('tail merge: identical blocks deduplicated', () => {
    // Two blocks with fully identical bodies — all jumps rewritten to canonical
    const result = runPeephole([
      '  JEQ r0 0 block_a',
      '  JEQ r0 1 block_b',
      '  MOVE r0',
      'block_a:',
      '  SET r1 5',
      '  ADD r1 1',
      '  JMP __target',
      'block_b:',
      '  SET r1 5',
      '  ADD r1 1',
      '  JMP __target',
      '__target:',
      '  MOVE r1',
    ]);
    // block_b should be eliminated; both JEQs should target block_a
    const jeqs = result.filter(l => l.trim().startsWith('JEQ'));
    assertEq(jeqs.length, 2);
    // Both should reference the same label
    const targets = jeqs.map(l => l.trim().split(/\s+/)[3]);
    assertEq(targets[0], targets[1]);
    // SET r1 5 appears only once
    const sets = result.filter(l => l.trim() === 'SET r1 5');
    assertEq(sets.length, 1);
  });

  test('tail merge: action terminator in shared tail', () => {
    // Blocks ending with MOVE (tick-ender) as part of shared tail
    // savings = (2-1)*3 - 2 = 1
    const result = runPeephole([
      'block_a:',
      '  SET r0 1',
      '  SET r1 3',
      '  ADD r1 1',
      '  MOVE r1',
      'block_b:',
      '  SET r0 2',
      '  SET r1 3',
      '  ADD r1 1',
      '  MOVE r1',
    ]);
    // Shared tail: SET r1 3, ADD r1 1, MOVE r1
    const moves = result.filter(l => l.trim() === 'MOVE r1');
    assertEq(moves.length, 1);
  });

  test('tail merge: fall-through block included', () => {
    // block_a falls through to __target (no explicit JMP)
    // block_b has explicit JMP __target with same tail
    // savings = (2-1)*3 - 2 = 1
    const result = runPeephole([
      '  JNE r0 0 block_b',
      'block_a:',
      '  SET r0 1',
      '  SET r1 r3',
      '  SUB r1 1',
      '__target:',
      '  MOVE r0',
      'block_b:',
      '  SET r0 2',
      '  SET r1 r3',
      '  SUB r1 1',
      '  JMP __target',
    ]);
    // Both blocks share tail: SET r1 r3, SUB r1 1, JMP __target
    // (block_a's fall-through is equivalent to JMP __target)
    const setSubs = result.filter(l => l.trim() === 'SET r1 r3');
    assertEq(setSubs.length, 1);
  });

  // ─── instrIndex threading ──────────────────────────────────

  test('instrIndex: survives dead store elimination', () => {
    const { lines, instrIndex } = peephole(
      ['  SET r0 5', '  SET r0 10', '  MOVE r0'],
      [10, 20, 30],
    );
    assertEq(lines, ['  SET r0 10', '  MOVE r0']);
    assertEq(instrIndex, [20, 30]);
  });

  test('instrIndex: survives redundant JMP removal', () => {
    const { lines, instrIndex } = peephole(
      ['  SET r0 1', '  JMP __next', '__next:', '  MOVE r0'],
      [10, 20, -1, 30],
    );
    assertEq(lines, ['  SET r0 1', '  MOVE r0']);
    assertEq(instrIndex, [10, 30]);
  });

  test('instrIndex: survives dead label elimination', () => {
    const { lines, instrIndex } = peephole(
      ['__dead:', '  MOVE r0'],
      [-1, 10],
    );
    assertEq(lines, ['  MOVE r0']);
    assertEq(instrIndex, [10]);
  });

  test('instrIndex: default fills with -1 when not provided', () => {
    const { instrIndex } = peephole(['  SET r0 5', '  SET r0 10']);
    assertEq(instrIndex, [-1]);
  });

  // ─── Dead code after unconditional JMP ─────────────────────

  test('dead code after JMP: unreachable JMP removed', () => {
    const result = runPeephole([
      '  JEQ r0 0 __other',
      '  JMP __target',
      '  SET r0 5',
      '  JMP __other',
      '__target:',
      '  MOVE r0',
      '__other:',
      '  MOVE r1',
    ]);
    // SET r0 5 and JMP __other after JMP __target are unreachable — removed.
    // Then JMP __target falls through to __target, so it's also removed.
    assertEq(result.filter(l => l.trim() === 'SET r0 5').length, 0);
    // Only the conditional jump to __other should remain (no unconditional JMPs)
    const jmps = result.filter(l => l.trim().startsWith('JMP'));
    assertEq(jmps.length, 0);
  });

  test('dead code after JMP: multiple unreachable instructions removed', () => {
    const result = runPeephole([
      '  JMP __target',
      '  SET r0 5',
      '  ADD r0 1',
      '  JMP __other',
      '__target:',
      '  MOVE r0',
      '__other:',
      '  MOVE r1',
    ]);
    // SET, ADD, JMP after the first JMP are all unreachable
    assertEq(result.filter(l => l.trim() === 'SET r0 5').length, 0);
    assertEq(result.filter(l => l.trim() === 'ADD r0 1').length, 0);
  });

  test('dead code after JMP: label between JMPs stops removal', () => {
    const result = runPeephole([
      '  JMP __target',
      '__mid:',
      '  SET r0 42',
      '  JMP __other',
      '__target:',
      '  JEQ r0 0 __mid',
      '  MOVE r0',
      '__other:',
      '  MOVE r1',
    ]);
    // __mid label is reachable (via JEQ), so instructions after it survive.
    // Only code between JMP __target and __mid: is dead — but there's nothing there.
    assertEq(result.filter(l => l.trim() === 'SET r0 42').length, 1);
    assertEq(result.filter(l => l.trim() === 'JMP __other').length, 1);
    assertEq(result.filter(l => l.trim() === '__mid:').length, 1);
  });

  test('dead code after JMP: instrIndex updated', () => {
    // JMP __far jumps over __mid block, so it can't be simplified to fall-through
    const { lines, instrIndex } = peephole(
      ['  JEQ r0 0 __mid', '  JMP __far', '  SET r0 5', '  JMP __mid', '__mid:', '  SET r1 1', '  MOVE r0', '__far:', '  MOVE r1'],
      [5, 10, 20, 30, -1, 35, 40, -1, 50],
    );
    // SET r0 5 and JMP __mid (after JMP __far) are dead
    assertEq(lines.filter(l => l.trim() === 'SET r0 5').length, 0);
    assertEq(lines.filter(l => l.trim() === 'JMP __far').length, 1);
    // instrIndex for JMP __far should be preserved
    const jmpIdx = lines.findIndex(l => l.trim() === 'JMP __far');
    assertEq(instrIndex[jmpIdx], 10);
  });
});
