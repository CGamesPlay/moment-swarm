// ═══════════════════════════════════════════════════════════════
// AntLisp — Integration Tests
// ═══════════════════════════════════════════════════════════════
//
// Per-stage unit tests live in *.test.ts files. This file keeps
// end-to-end integration tests that exercise cross-stage interactions.

const { compileAntLisp } = require('./antlisp');

function runTests() {
  const suiteName = 'Integration';
  let passed = 0, failed = 0;

  function test(name, source, check) {
    try {
      const result = compileAntLisp(source);
      const ok = check(result);
      console.log(`${ok ? '✓' : '✗'} ${name}`);
      if (!ok) {
        console.log('  OUTPUT:');
        result.split('\n').forEach(l => console.log('    ' + l));
        failed++;
      } else {
        passed++;
      }
    } catch (e) {
      console.log(`✗ ${name} — ERROR: ${e.message}`);
      failed++;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // INTEGRATION TESTS — cross-stage interactions
  // ═══════════════════════════════════════════════════════════════

  test('forager pattern: sense and respond',
    `(let ((dx 0) (dy 0))
       (loop
         (let ((food (sense food)))
           (if (!= food 0)
             (begin
               (move food)
               (cond ((= food 1) (set! dy (- dy 1)))
                     ((= food 2) (set! dx (+ dx 1)))
                     ((= food 3) (set! dy (+ dy 1)))
                     ((= food 4) (set! dx (- dx 1))))
               (pickup))
             (move (+ (random 4) 1))))))`,
    r => r.includes('SENSE FOOD') && r.includes('PICKUP') && r.includes('RANDOM'));

  test('homing pattern: simplified',
    `(let ((dx 0) (dy 0))
       (let ((c (carrying?)))
         (when c
           (let ((dir (if (> dy 0) 1 3)))
             (move dir)))))`,
    r => r.includes('CARRYING'));

  test('pheromone trail pattern',
    `(loop
       (let ((trail (smell ch_red)))
         (if (!= trail 0)
           (begin (move trail) (mark ch_red 50))
           (move (+ (random 4) 1)))))`,
    r => r.includes('SMELL CH_RED') && r.includes('MARK CH_RED 50'));

  test('if-as-expression in comparison (edge case)',
    `(let ((x 5))
       (let ((abs-x (if (< x 0) (- x) x)))
         (move random)))`,
    r => true);  // Just checking it doesn't crash

  test('smell different channels',
    `(let ((r (smell ch_red))
           (g (smell ch_green)))
       (if (!= r 0) (move r) (move g)))`,
    r => r.includes('SMELL CH_RED') && r.includes('SMELL CH_GREEN'));

  test('when with comparison',
    '(let ((x 5)) (when (> x 3) (move n)))',
    r => r.includes('MOVE N'));

  test('unless with comparison',
    '(let ((x 2)) (unless (> x 5) (move s)))',
    r => r.includes('MOVE S'));

  test('large literal',
    '(let ((x 255)) (mark ch_red x))',
    r => r.includes('SET') && r.includes('MARK CH_RED'));

  test('using timer (if supported)',
    '(let ((t 0)) (set! t timer) (mark ch_red t))',
    r => r.includes('MARK CH_RED'));

  test('mark with variable',
    '(let ((amount 100)) (mark ch_red amount))',
    r => r.includes('MARK CH_RED'));

  test('minimal program',
    '(move random)',
    r => r.includes('MOVE RANDOM'));

  test('let with no further body outside',
    '(let ((x 5)) (move random))',
    r => r.includes('MOVE RANDOM'));

  test('multiple break conditions',
    `(let ((i 0))
       (loop
         (set! i (+ i 1))
         (if (= i 5) (break))
         (if (= i 10) (break))
         (move random)))`,
    r => r.includes('ADD') && r.includes('1') && r.includes('JMP'));

  test('macro with internal labels - hygienic',
    `(defmacro maybe-move ()
       (let ((r (random 2)))
         (if (= r 0)
           (move n)
           (move s))))
     (maybe-move) (maybe-move)`,
    r => {
      const labels = r.match(/__[a-z_]+_\d+:/g) || [];
      const unique = new Set(labels);
      return unique.size === labels.length;
    });

  test('macro with tagbody/go - freshened',
    `(defmacro skip-if-carrying ()
       (tagbody
         (when (carrying?)
           (go done))
         (move n)
         done))
     (skip-if-carrying) (skip-if-carrying)`,
    r => {
      // Each macro invocation must produce freshened labels.
      // The tagbody done labels may be eliminated by linearization when they
      // become trivial jmp blocks, but the when-body labels (or any remaining
      // labels) must still be distinct across the two invocations.
      const allLabels = r.match(/__\w+_\d+:/g) || [];
      // Must have at least 2 labels, and no duplicates
      const unique = new Set(allLabels);
      return allLabels.length >= 2 && unique.size === allLabels.length;
    });

  test('macro called multiple times',
    `(defmacro wander ()
       (move (+ (random 4) 1)))
     (wander) (wander) (wander)`,
    r => {
      const moves = (r.match(/MOVE/g) || []).length;
      return moves === 3;
    });

  console.log(`  ${failed > 0 ? '✗' : '✓'} ${suiteName}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests();
