// ═══════════════════════════════════════════════════════════════
// SSA Tests — SSA lowering
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, assertThrows, assertMatch,
         assertIncludes, assertNotIncludes, lowerSource, printSSA } from './test-helpers';
import type { SSAProgram, BasicBlock } from './ssa';

function ssa(src: string): string {
  return printSSA(lowerSource(src));
}

function blocks(src: string): BasicBlock[] {
  return lowerSource(src).blocks;
}

function hasOp(program: SSAProgram, op: string): boolean {
  return program.blocks.some(b => b.instrs.some(i => i.op === op));
}

function hasTerminator(program: SSAProgram, op: string): boolean {
  return program.blocks.some(b => b.terminator?.op === op);
}

function countBlocks(src: string): number {
  return lowerSource(src).blocks.length;
}

runSuite('SSA', () => {
  // ── Control flow: if ──

  test('if/else creates then+else+merge blocks', () => {
    const ir = ssa('(let ((x (sense food))) (if (= x 0) (move random) (move x)))');
    assertIncludes(ir, 'br_cmp eq');
    assertIncludes(ir, '__then_');
    assertIncludes(ir, '__else_');
    assertIncludes(ir, '__endif_');
  });

  test('if without else', () => {
    const ir = ssa('(let ((x (sense food))) (if (= x 0) (move random)))');
    assertIncludes(ir, 'br_cmp eq');
    assertIncludes(ir, '__then_');
    assertIncludes(ir, '__endif_');
  });

  test('nested if', () => {
    const ir = ssa(`(let ((a (sense food)) (b (sense wall)))
       (if (= a 0) (if (= b 0) (move random) (move n)) (move a)))`);
    // Should have two br_cmp instructions
    const brCount = (ir.match(/br_cmp/g) || []).length;
    assertEq(brCount, 2);
  });

  test('if with begin in branches', () => {
    const ir = ssa(`(let ((x (sense food)))
       (if (= x 0)
         (begin (mark ch_red 50) (move random))
         (begin (pickup) (move x))))`);
    assertIncludes(ir, 'mark');
    assertIncludes(ir, 'pickup');
  });

  // ── Control flow: cond ──

  test('cond with many branches', () => {
    const ir = ssa(`(let ((d (sense food)))
       (cond ((= d 1) (move n))
             ((= d 2) (move e))
             ((= d 3) (move s))
             (else (move random))))`);
    const brCount = (ir.match(/br_cmp/g) || []).length;
    assert(brCount >= 3);
  });

  test('cond without else', () => {
    const ir = ssa(`(let ((d (sense food)))
       (cond ((= d 1) (move n))
             ((= d 2) (move e))))`);
    assertIncludes(ir, '__endcond_');
  });

  // ── Control flow: when/unless ──

  test('when', () => {
    const ir = ssa('(let ((c (carrying?))) (when c (mark ch_red 50)))');
    assertIncludes(ir, 'br_cmp ne');
    assertIncludes(ir, 'mark');
  });

  test('unless', () => {
    const ir = ssa('(let ((c (carrying?))) (unless c (move random)))');
    // unless flips: condition true → skip body
    assertIncludes(ir, '__unless_body_');
  });

  // ── Control flow: loops ──

  test('loop', () => {
    const ir = ssa('(loop (mark ch_red 100) (move random))');
    // loop has a header block that jumps back to itself
    assertIncludes(ir, '__loop_');
    assertIncludes(ir, 'jmp __loop_');
  });

  test('while', () => {
    const ir = ssa('(let ((x 10)) (while (> x 0) (set! x (- x 1)) (move random)))');
    assertIncludes(ir, '__while_');
    assertIncludes(ir, 'br_cmp gt');
  });

  test('dotimes', () => {
    const ir = ssa('(dotimes (i 5) (move random))');
    assertIncludes(ir, '__dotimes_');
    assertIncludes(ir, 'br_cmp eq');
    // Should have increment instruction
    assertIncludes(ir, 'add');
  });

  test('dotimes zero iterations', () => {
    const ir = ssa('(dotimes (i 0) (move random))');
    // Should still have the exit condition
    assertIncludes(ir, 'br_cmp eq');
  });

  test('dotimes nested', () => {
    const program = lowerSource('(dotimes (i 3) (dotimes (j 3) (move random)))');
    // Two dotimes header blocks (not body/end blocks)
    const headerBlocks = program.blocks.filter(b =>
      /^__dotimes_\d+$/.test(b.label));
    assertEq(headerBlocks.length, 2);
  });

  // ── Control flow: break/continue ──

  test('break in loop', () => {
    const ir = ssa(`(loop
       (let ((f (sense food)))
         (if (!= f 0) (break) (move random))))`);
    // break should jump to the exit block
    assertIncludes(ir, '__endloop_');
  });

  test('continue in loop', () => {
    const ir = ssa(`(let ((count 0))
       (loop
         (set! count (+ count 1))
         (if (= (mod count 2) 0) (continue))
         (move random)))`);
    // continue should jump to the loop header
    const program = lowerSource(`(let ((count 0))
       (loop
         (set! count (+ count 1))
         (if (= (mod count 2) 0) (continue))
         (move random)))`);
    // Find a jmp back to loop header from a dead block context
    assertIncludes(printSSA(program), '__loop_');
  });

  test('nested loops with break', () => {
    const ir = ssa('(loop (loop (break)) (move random))');
    // Inner break exits inner loop only; outer loop still runs
    assertIncludes(ir, 'move');
  });

  test('nested loops with break/continue', () => {
    const ir = ssa(`(loop
       (let ((i 0))
         (while (< i 10)
           (set! i (+ i 1))
           (if (= i 5) (continue))
           (if (= i 8) (break)))))`);
    assertIncludes(ir, '__while_');
    assertIncludes(ir, '__loop_');
  });

  // ── Control flow: tagbody/go ──

  test('tagbody: forward jump', () => {
    const ir = ssa(`(tagbody
       (go skip) (move n) skip (move s))`);
    assertIncludes(ir, '__tag_skip_');
    assertIncludes(ir, 'jmp __tag_skip_');
  });

  test('tagbody: backward jump', () => {
    const ir = ssa(`(let ((x 0))
       (tagbody
         top
         (set! x (+ x 1))
         (when (< x 5) (go top))
         (move random)))`);
    assertIncludes(ir, '__tag_top_');
    assertIncludes(ir, 'jmp __tag_top_');
  });

  test('tagbody: multiple tags', () => {
    const ir = ssa(`(tagbody
       first (move n)
       second (move s)
       third (move e))`);
    assertIncludes(ir, '__tag_first_');
    assertIncludes(ir, '__tag_second_');
    assertIncludes(ir, '__tag_third_');
  });

  test('tagbody: underscore tag', () => {
    const ir = ssa(`(tagbody my_label (move random) (go my_label))`);
    assertIncludes(ir, '__tag_my_label_');
  });

  test('nested tagbody: innermost resolution', () => {
    const program = lowerSource(`(tagbody
       point (move n)
       (tagbody
         point (move s) (go point)))`);
    // Find the two point tag blocks
    const pointBlocks = program.blocks.filter(b => b.label.startsWith('__tag_point_'));
    assertEq(pointBlocks.length, 2);
    // The inner go should target the inner (second) tag block
    const innerTag = pointBlocks[1];
    // Check that some block jumps to the inner tag
    const jumpersToInner = program.blocks.filter(b =>
      b.terminator?.op === 'jmp' && b.terminator.target === innerTag);
    assert(jumpersToInner.length > 0, 'inner go should target inner point');
  });

  test('nested tagbody: outer tag access', () => {
    const program = lowerSource(`(tagbody
       outer (move n)
       (tagbody (move s) (go outer)))`);
    const outerTag = program.blocks.find(b => b.label.startsWith('__tag_outer_'));
    assert(!!outerTag, 'outer tag should exist');
    // Some block should jump to the outer tag
    const jumpers = program.blocks.filter(b =>
      b.terminator?.op === 'jmp' && b.terminator.target === outerTag);
    assert(jumpers.length > 0, 'go outer should target outer tag');
  });

  test('go: error on unknown tag', () => {
    assertThrows(() => lowerSource('(go nowhere)'), 'no such tag');
  });

  test('tagbody: error on duplicate tag', () => {
    assertThrows(() => lowerSource('(tagbody dup (move n) dup (move s))'), 'Duplicate tag');
  });

  // ── Expression/action lowering ──

  test('basic move', () => {
    const program = lowerSource('(move random)');
    assert(hasOp(program, 'move'));
  });

  test('compound expr in move', () => {
    const program = lowerSource('(move (+ (random 4) 1))');
    assert(hasOp(program, 'random'));
    assert(hasOp(program, 'add'));
    assert(hasOp(program, 'move'));
  });

  test('move with all directions', () => {
    const program = lowerSource(`(move n) (move ne) (move e) (move se)
       (move s) (move sw) (move w) (move nw)`);
    const moveInstrs = program.blocks.flatMap(b =>
      b.instrs.filter(i => i.op === 'move'));
    assertEq(moveInstrs.length, 8);
  });

  test('sense', () => {
    const program = lowerSource('(let ((x (sense food))) (move x))');
    assert(hasOp(program, 'sense'));
  });

  test('smell', () => {
    const program = lowerSource('(let ((x (smell ch_red))) (move x))');
    assert(hasOp(program, 'smell'));
  });

  test('probe', () => {
    const program = lowerSource('(let ((x (probe n))) (move x))');
    assert(hasOp(program, 'probe'));
  });

  test('carrying?', () => {
    const program = lowerSource('(let ((c (carrying?))) (move c))');
    assert(hasOp(program, 'carrying'));
  });

  test('id', () => {
    const program = lowerSource('(let ((myid (id))) (mark ch_red myid))');
    assert(hasOp(program, 'id'));
  });

  test('pickup and drop', () => {
    const program = lowerSource('(pickup) (drop)');
    assert(hasOp(program, 'pickup'));
    assert(hasOp(program, 'drop'));
  });

  test('mark', () => {
    const program = lowerSource('(mark ch_red 100)');
    assert(hasOp(program, 'mark'));
    const markInstr = program.blocks[0].instrs.find(i => i.op === 'mark')!;
    assertEq(markInstr.args[0], 'CH_RED');
    assertEq(markInstr.args[1], 100);
  });

  test('set-tag', () => {
    const program = lowerSource('(set-tag 0)');
    assert(hasOp(program, 'tag'));
  });

  test('random', () => {
    const program = lowerSource('(let ((x (random 10))) (move x))');
    assert(hasOp(program, 'random'));
  });

  test('begin sequencing', () => {
    const program = lowerSource('(begin (mark ch_red 50) (mark ch_green 50) (move random))');
    const marks = program.blocks.flatMap(b => b.instrs.filter(i => i.op === 'mark'));
    assertEq(marks.length, 2);
  });

  test('begin as expression value', () => {
    const program = lowerSource('(let ((x (begin (mark ch_red 10) 5))) (move random))');
    assert(hasOp(program, 'mark'));
  });

  test('sense directly in if condition', () => {
    const ir = ssa('(if (= (sense food) 0) (move random) (move (sense food)))');
    assertIncludes(ir, 'sense');
  });

  test('carrying in condition', () => {
    const ir = ssa('(if (carrying?) (drop) (pickup))');
    assertIncludes(ir, 'carrying');
    assertIncludes(ir, 'drop');
    assertIncludes(ir, 'pickup');
  });

  // ── Loop phi correctness ──

  test('while: phi entries reference predecessor blocks, not the header', () => {
    const program = lowerSource('(let ((x 10)) (while (> x 5) (set! x (- x 1))))');
    const header = program.blocks.find(b => b.label.startsWith('__while_'))!;
    assert(header.phis.length > 0, 'header should have phis');
    for (const phi of header.phis) {
      for (const entry of phi.entries) {
        assert(entry.block !== header,
          `phi ${phi.dest} has entry from header block itself (${entry.block.label}), should reference a predecessor`);
      }
    }
  });

  test('loop: phi entries reference predecessor blocks, not the header', () => {
    const program = lowerSource('(let ((x 0)) (loop (set! x (+ x 1)) (if (= x 5) (break))))');
    const header = program.blocks.find(b => b.label.startsWith('__loop_'))!;
    assert(header.phis.length > 0, 'header should have phis');
    for (const phi of header.phis) {
      for (const entry of phi.entries) {
        assert(entry.block !== header,
          `phi ${phi.dest} has entry from header block itself (${entry.block.label}), should reference a predecessor`);
      }
    }
  });

  test('dotimes: phi entries reference predecessor blocks, not the header', () => {
    const program = lowerSource('(let ((count 0)) (dotimes (i 5) (set! count (+ count 1))))');
    const header = program.blocks.find(b => b.label.startsWith('__dotimes_'))!;
    assert(header.phis.length > 0, 'header should have phis');
    for (const phi of header.phis) {
      for (const entry of phi.entries) {
        assert(entry.block !== header,
          `phi ${phi.dest} has entry from header block itself (${entry.block.label}), should reference a predecessor`);
      }
    }
  });

  test('dotimes: post-loop code references phi temps, not pre-loop values', () => {
    // After dotimes, "count" should resolve to the header phi temp,
    // not the original %t for the initial value
    const program = lowerSource(
      '(let ((count 0)) (dotimes (i 5) (set! count (+ count 1))) (mark ch_red count))');
    const exitBlock = program.blocks.find(b => b.label.startsWith('__enddotimes_'))!;
    const header = program.blocks.find(b => b.label.startsWith('__dotimes_'))!;
    // The mark instruction in the exit block should use a phi temp from the header,
    // not the initial const temp from the entry block
    const markInstr = exitBlock.instrs.find(i => i.op === 'mark');
    assert(!!markInstr, 'exit block should have a mark instruction');
    const phiDests = new Set(header.phis.map(p => p.dest));
    const markArg = markInstr!.args[1];
    assert(phiDests.has(markArg as string),
      `mark's value arg (${markArg}) should be a header phi temp, not a pre-loop value`);
  });

  // ── set! through let scope in if branches ──

  test('set! to outer var inside let propagates through if merge', () => {
    // When set! modifies an outer variable inside a let block,
    // the update must be visible after the let scope ends.
    // Bug: lowerLet restores savedEnv, discarding the set! update.
    const program = lowerSource(`
      (let ((x 0))
        (if (carrying?)
          (let ((a (sense nest)))
            (set! x (+ x 1)))
          (let ((b (sense food)))
            (set! x (- x 1))))
        (move x))`);
    // The move at the end should use a phi that merges the two set! results,
    // not the original x value
    const mergeBlock = program.blocks.find(b => b.label.startsWith('__endif_'))!;
    assert(mergeBlock.phis.length > 0,
      'endif merge block must have a phi for x (set! in both branches inside let)');
  });

  test('loop phi picks up set! inside let in if branches', () => {
    // Minimal reproduction of the cheater.alisp bug:
    // set! inside let inside both if branches within a loop
    // should produce non-self-referencing loop header phis.
    const program = lowerSource(`
      (let ((x 0))
        (loop
          (if (carrying?)
            (begin
              (let ((a (sense nest)))
                (if (!= a 0)
                  (set! x (+ x 1))
                  (set! x (- x 1))))
              (move 1))
            (begin
              (let ((b (sense food)))
                (if (!= b 0)
                  (set! x (+ x 10))
                  (set! x (- x 10))))
              (move 2)))))`);
    const header = program.blocks.find(b => b.label.startsWith('__loop_'))!;
    assert(header.phis.length > 0, 'loop header should have phis for x');
    for (const phi of header.phis) {
      for (const entry of phi.entries) {
        assert(entry.value !== phi.dest,
          `loop phi ${phi.dest} self-references via ${entry.block.label} — ` +
          `set! inside let is being lost`);
      }
    }
  });

  test('comment is no-op', () => {
    const program = lowerSource('(comment "test") (move random)');
    assert(hasOp(program, 'move'));
    // No comment instruction emitted
    assert(!hasOp(program, 'comment'));
  });
});
