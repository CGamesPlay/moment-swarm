// ═══════════════════════════════════════════════════════════════
// AntLisp v2 — Integration Tests + Old-Compiler Analysis Tests
// ═══════════════════════════════════════════════════════════════
//
// Per-stage unit tests live in *.test.ts files. This file keeps:
//   - End-to-end integration tests that exercise cross-stage interactions
//   - Old-compiler analysis utility tests (until old compiler is retired)

const { compileAntLisp } = require('./antlisp2');

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

  test('comment',
    '(comment "this is a test") (move random)',
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
      const doneLabels = r.match(/__tag_done_\d+:/g) || [];
      return doneLabels.length === 2 && doneLabels[0] !== doneLabels[1];
    });

  test('macro called multiple times',
    `(defmacro wander ()
       (move (+ (random 4) 1)))
     (wander) (wander) (wander)`,
    r => {
      const moves = (r.match(/MOVE/g) || []).length;
      return moves === 3;
    });

  // ═══════════════════════════════════════════════════════════════
  // OLD-COMPILER ANALYSIS UTILITY TESTS
  // (keep until old compiler is retired)
  // ═══════════════════════════════════════════════════════════════

  {
    const { Compiler, tokenize, parse } = require('./antlisp');
    function makeAST(src) {
      return parse(tokenize(src)).body[0];
    }
    function makeCompiler() { return new Compiler(); }

    // countSymbolRefs
    {
      const c = makeCompiler();
      const node = makeAST('(let ((x 1)) x x x)');
      const body = node.value.slice(2);
      const count = body.reduce((n, f) => n + c.countSymbolRefs('x', f), 0);
      const ok = count === 3;
      console.log(`${ok ? '✓' : '✗'} countSymbolRefs: 3 refs to x`);
      if (!ok) { console.log(`  got: ${count}`); failed++; } else passed++;
    }
    {
      const c = makeCompiler();
      const node = makeAST('(let ((x 1)) (+ x 1))');
      const body = node.value.slice(2);
      const count = body.reduce((n, f) => n + c.countSymbolRefs('x', f), 0);
      const ok = count === 1;
      console.log(`${ok ? '✓' : '✗'} countSymbolRefs: 1 ref to x in (+ x 1)`);
      if (!ok) { console.log(`  got: ${count}`); failed++; } else passed++;
    }
    {
      const c = makeCompiler();
      const node = makeAST('(let ((x 1)) (if (= x 0) x 1))');
      const body = node.value.slice(2);
      const count = body.reduce((n, f) => n + c.countSymbolRefs('x', f), 0);
      const ok = count === 2;
      console.log(`${ok ? '✓' : '✗'} countSymbolRefs: 2 refs to x in if`);
      if (!ok) { console.log(`  got: ${count}`); failed++; } else passed++;
    }

    // bodyContainsGo
    {
      const c = makeCompiler();
      const body1 = [makeAST('(go label)')];
      const ok1 = c.bodyContainsGo(body1) === true;
      console.log(`${ok1 ? '✓' : '✗'} bodyContainsGo: (go label) returns true`);
      if (!ok1) failed++; else passed++;
    }
    {
      const c = makeCompiler();
      const body2 = [makeAST('(move random)')];
      const ok2 = c.bodyContainsGo(body2) === false;
      console.log(`${ok2 ? '✓' : '✗'} bodyContainsGo: (move random) returns false`);
      if (!ok2) failed++; else passed++;
    }
    {
      const c = makeCompiler();
      const body3 = [makeAST('(when (= x 0) (go label))')];
      const ok3 = c.bodyContainsGo(body3) === true;
      console.log(`${ok3 ? '✓' : '✗'} bodyContainsGo: nested go returns true`);
      if (!ok3) failed++; else passed++;
    }

    // findLastUseIndex
    {
      const c = makeCompiler();
      const forms = [makeAST('(+ x 1)'), makeAST('(move y)'), makeAST('(+ x 2)')];
      const idx = c.findLastUseIndex('x', forms);
      const ok = idx === 2;
      console.log(`${ok ? '✓' : '✗'} findLastUseIndex: x last used at index 2`);
      if (!ok) { console.log(`  got: ${idx}`); failed++; } else passed++;
    }
    {
      const c = makeCompiler();
      const forms = [makeAST('(+ x 1)'), makeAST('(move y)')];
      const idx = c.findLastUseIndex('x', forms);
      const ok = idx === 0;
      console.log(`${ok ? '✓' : '✗'} findLastUseIndex: x last used at index 0`);
      if (!ok) { console.log(`  got: ${idx}`); failed++; } else passed++;
    }

    // isSingleSetUse
    {
      const c = makeCompiler();
      const forms = [makeAST('(set! dir food-dir)'), makeAST('(move dir)')];
      const result = c.isSingleSetUse('food-dir', forms);
      const ok = result !== null && result.target === 'dir';
      console.log(`${ok ? '✓' : '✗'} isSingleSetUse: (set! dir food-dir) returns target=dir`);
      if (!ok) { console.log(`  got: ${JSON.stringify(result)}`); failed++; } else passed++;
    }
    {
      const c = makeCompiler();
      const forms = [makeAST('(+ food-dir 1)'), makeAST('(move dir)')];
      const result = c.isSingleSetUse('food-dir', forms);
      const ok = result === null;
      console.log(`${ok ? '✓' : '✗'} isSingleSetUse: non-set! usage returns null`);
      if (!ok) { console.log(`  got: ${JSON.stringify(result)}`); failed++; } else passed++;
    }
  }

  console.log(`  ${failed > 0 ? '✗' : '✓'} ${suiteName}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests();
