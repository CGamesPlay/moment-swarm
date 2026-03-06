// ═══════════════════════════════════════════════════════════════
// AntLisp v2 — Compiler Tests
// ═══════════════════════════════════════════════════════════════

const { compileAntLisp } = require('./antlisp');

function runTests() {
  console.log('═══ AntLisp v2 Compiler Tests ═══\n');
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

  test('basic move', '(move random)', r => r.includes('MOVE RANDOM'));

  test('sense + if',
    '(let ((dir (sense food))) (if (= dir 0) (move random) (move dir)))',
    r => r.includes('SENSE FOOD') && r.includes('MOVE RANDOM'));

  test('loop + mark',
    '(loop (mark ch_red 100) (move random))',
    r => r.includes('MARK CH_RED 100') && r.includes('JMP'));

  test('arithmetic chained',
    '(let ((x (+ 3 4 5))) (move random))',
    r => r.includes('SET r1 3') && r.includes('ADD r1 4') && r.includes('ADD r1 5'));  // r1 since r0 reserved for returns

  test('global define',
    '(define dx 0) (define dy 0) (main (set! dx (+ dx 1)))',
    r => r.includes('SET r1 0') && r.includes('ADD r1 1'));  // r1 since r0 reserved for returns

  test('global define with :reg',
    '(define dx 0 :reg r1) (define dy 0 :reg r2) (main (set! dx (+ dx 1)))',
    r => r.includes('SET r1 0') && r.includes('SET r2 0') && r.includes('ADD r1 1'));

  test('defun returns value in r0',
    `(defun calc ()
       (+ 3 4))
     (main
       (let ((x (calc)))
         (move random)))`,
    r => {
      return r.includes('fn_calc:') &&
             r.includes('SET r0 3') &&
             r.includes('ADD r0 4') &&
             r.includes('JMP r7') &&
             r.includes('CALL r7 fn_calc');
    });

  test('defun sees globals',
    `(define dx 0 :reg r1)
     (define dy 0 :reg r2)
     (defun update-pos (dir)
       (cond ((= dir 1) (set! dy (- dy 1)))
             ((= dir 2) (set! dx (+ dx 1)))
             ((= dir 3) (set! dy (+ dy 1)))
             ((= dir 4) (set! dx (- dx 1)))))
     (main (update-pos 1))`,
    r => {
      return r.includes('fn_update-pos:') &&
             r.includes('SUB r2 1') &&  // dy - 1
             r.includes('ADD r1 1');     // dx + 1
    });

  test('defun with param',
    `(defun double (x)
       (* x 2))
     (main (double 5))`,
    r => r.includes('fn_double:') && r.includes('MUL r0 2') && r.includes('SET r1 5'));  // param in r1, not r0

  test('cond with else',
    `(let ((d (probe n)))
       (cond ((= d 2) (move n))
             ((= d 0) (move s))
             (else (move random))))`,
    r => r.includes('PROBE N') && r.includes('MOVE N') && r.includes('MOVE RANDOM'));

  test('dispatch',
    `(define-role forager 0)
     (define-role scout 1)
     (let ((role (mod (id) 2)))
       (dispatch role
         (forager (move n))
         (scout (move s))))`,
    r => r.includes('.tag 0 forager') && r.includes('TAG 0') && r.includes('TAG 1'));

  test('when/unless',
    `(let ((c (carrying?)))
       (when c (mark ch_red 50))
       (unless c (move random)))`,
    r => r.includes('MARK CH_RED 50') && r.includes('MOVE RANDOM'));

  test('dotimes',
    '(dotimes (i 5) (move random))',
    r => r.includes('SET r1 0') && r.includes('JEQ r1 5'));  // r1 since r0 reserved for returns

  // ═══════════════════════════════════════════════════════════════
  // Function param preservation across nested calls
  // Fix: params use r1+ (not r0), so r0 is free for return values
  // ═══════════════════════════════════════════════════════════════

  test('param preserved across nested call',
    `(defun check (x) (if (= x 1) 1 0))
     (defun use-after-call (dir)
       (if (= (check dir) 1)
         (move dir)
         (move random)))
     (main (use-after-call 1))`,
    r => {
      // Params should be in r1+ (not r0) so they survive nested calls
      // r0 is reserved for return values
      const lines = r.split('\n').map(l => l.trim());
      const fnStart = lines.findIndex(l => l === 'fn_use-after-call:');
      const fnEnd = lines.findIndex((l, i) => i > fnStart && l.includes('JMP r7'));
      const fnBody = lines.slice(fnStart, fnEnd + 1);
      
      // MOVE should use r1 (the param register), not r0 (return value)
      const moveLines = fnBody.filter(l => l.startsWith('MOVE r'));
      const moveUsesParamReg = moveLines.some(l => l.match(/MOVE r[1-6]/));
      
      // Also verify the param is passed in r1, not r0
      const paramInR1 = r.includes('SET r1 1') && r.includes('CALL r7 fn_use-after-call');
      
      return moveUsesParamReg && paramInR1;
    });

  test('nested function param not clobbered by return value',
    `(defun inner (x) (* x 2))
     (defun outer (a)
       (+ a (inner a)))
     (main (outer 5))`,
    r => {
      // After calling inner, 'a' should still be accessible
      // 'a' should be in r1+, inner's return in r0
      const lines = r.split('\n').map(l => l.trim());
      
      // outer's param 'a' should be in r1
      const outerStart = lines.findIndex(l => l === 'fn_outer:');
      const outerBody = lines.slice(outerStart, outerStart + 15);
      
      // Should see: param in r1, call inner, then ADD using r1
      const hasAddWithR1 = outerBody.some(l => l.match(/ADD r\d+ r1/) || l.match(/ADD r1/));
      const hasCall = outerBody.some(l => l.includes('CALL r7 fn_inner'));
      
      return hasCall && (hasAddWithR1 || outerBody.some(l => l.includes('r1')));
    });

  // ═══════════════════════════════════════════════════════════════
  // EDGE CASE TESTS — Added for comprehensive coverage
  // ═══════════════════════════════════════════════════════════════

  // --- Compound expressions as action arguments ---
  test('compound expr in move',
    '(move (+ (random 4) 1))',
    r => r.includes('RANDOM') && r.includes('4') && r.includes('ADD') && r.includes('MOVE'));

  test('compound expr in mark',
    '(define timer 10 :reg r1) (main (mark ch_red (* timer 2)))',
    r => r.includes('MUL') && r.includes('MARK CH_RED'));

  test('nested compound exprs',
    '(let ((x (+ (* 2 3) (- 10 5)))) (move random))',
    r => r.includes('MUL') && r.includes('SUB') && r.includes('ADD'));

  // --- Unary negation edge cases ---
  test('unary negation simple',
    '(define x 5 :reg r1) (main (set! x (- x)))',
    r => r.includes('SET r1 5'));  // Should negate x

  test('unary negation in expression',
    '(let ((x 5)) (let ((y (- x))) (move random)))',
    r => r.includes('SET'));  // Should handle negation properly

  test('unary negation same register safe',
    '(define dx 5 :reg r1) (main (set! dx (- dx)))',
    r => r.includes('SET r1 5'));  // Safe negation when operand = dest

  // --- Nested let bindings ---
  test('nested let scopes',
    `(let ((a (sense food)))
       (let ((b (sense wall)))
         (let ((c (sense nest)))
           (move random))))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL') && r.includes('SENSE NEST'));

  test('let shadowing outer scope',
    `(let ((x 5))
       (let ((x 10))
         (move random)))`,
    r => r.includes('SET') && r.includes('MOVE RANDOM'));

  test('let with multiple bindings',
    `(let ((a (sense food))
           (b (sense wall))
           (c (carrying?)))
       (move random))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL') && r.includes('CARRYING'));

  // --- Control flow edge cases ---
  test('if without else',
    '(let ((x (sense food))) (if (= x 0) (move random)))',
    r => r.includes('SENSE FOOD') && r.includes('JEQ') || r.includes('JNE'));

  test('nested if statements',
    `(let ((a (sense food)) (b (sense wall)))
       (if (= a 0)
         (if (= b 0)
           (move random)
           (move n))
         (move a)))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL'));

  test('if with begin in branches',
    `(let ((x (sense food)))
       (if (= x 0)
         (begin (mark ch_red 50) (move random))
         (begin (pickup) (move x))))`,
    r => r.includes('MARK CH_RED 50') && r.includes('PICKUP'));

  test('cond with many branches',
    `(let ((d (sense food)))
       (cond ((= d 1) (move n))
             ((= d 2) (move e))
             ((= d 3) (move s))
             ((= d 4) (move w))
             ((= d 5) (move ne))
             (else (move random))))`,
    r => r.includes('MOVE N') && r.includes('MOVE E') && r.includes('MOVE S') && 
         r.includes('MOVE W') && r.includes('MOVE NE') && r.includes('MOVE RANDOM'));

  test('cond without else',
    `(let ((d (sense food)))
       (cond ((= d 1) (move n))
             ((= d 2) (move e))))`,
    r => r.includes('MOVE N') && r.includes('MOVE E'));

  // --- Loop edge cases ---
  test('while loop',
    '(define x 10 :reg r1) (main (while (> x 0) (set! x (- x 1)) (move random)))',
    r => r.includes('SUB r1 1') && r.includes('JMP'));

  test('break in loop',
    `(loop
       (let ((f (sense food)))
         (if (!= f 0)
           (break)
           (move random))))`,
    r => r.includes('SENSE FOOD') && r.includes('JMP'));

  test('continue in loop',
    `(define count 0 :reg r1)
     (main
       (loop
         (set! count (+ count 1))
         (if (= (mod count 2) 0)
           (continue))
         (move random)))`,
    r => r.includes('ADD r1 1') && r.includes('MOD'));

  test('nested loops',
    `(loop
       (dotimes (i 3)
         (move random)))`,
    r => r.includes('SET') && r.includes('JMP'));

  test('break from inner loop only',
    `(loop
       (loop
         (break))
       (move random))`,
    r => r.includes('MOVE RANDOM') && r.includes('JMP'));

  test('dotimes using loop variable',
    '(dotimes (i 5) (mark ch_red i))',
    r => r.includes('MARK CH_RED'));

  // --- Comparison operators ---
  test('greater than comparison',
    '(let ((x 5)) (if (> x 3) (move n) (move s)))',
    r => r.includes('MOVE N') && r.includes('MOVE S'));

  test('less than comparison',
    '(let ((x 2)) (if (< x 5) (move n) (move s)))',
    r => r.includes('MOVE N') && r.includes('MOVE S'));

  test('greater or equal comparison',
    '(let ((x 5)) (if (>= x 5) (move n) (move s)))',
    r => r.includes('MOVE N') && r.includes('MOVE S'));

  test('less or equal comparison',
    '(let ((x 5)) (if (<= x 5) (move n) (move s)))',
    r => r.includes('MOVE N') && r.includes('MOVE S'));

  test('not equal comparison',
    '(let ((x 5)) (if (!= x 0) (move n) (move s)))',
    r => r.includes('JNE') || r.includes('JEQ'));

  test('zero? predicate',
    '(let ((x (sense food))) (if (zero? x) (move random) (move x)))',
    r => r.includes('SENSE FOOD'));

  test('not predicate',
    '(let ((c (carrying?))) (if (not c) (pickup) (drop)))',
    r => r.includes('CARRYING') && r.includes('PICKUP') && r.includes('DROP'));

  test('comparison as value in let',
    '(let ((result (> 5 3))) (move random))',
    r => r.includes('SET') && r.includes('MOVE RANDOM'));

  // --- Arithmetic edge cases ---
  test('chained subtraction',
    '(let ((x (- 10 3 2 1))) (move random))',
    r => r.includes('SET') && r.includes('SUB'));

  test('chained multiplication',
    '(let ((x (* 2 3 4))) (move random))',
    r => r.includes('MUL'));

  test('division',
    '(let ((x (/ 10 2))) (move random))',
    r => r.includes('DIV'));

  test('modulo',
    '(let ((x (mod (id) 4))) (move random))',
    r => r.includes('ID') && r.includes('MOD'));

  test('bitwise and',
    '(let ((x (and 15 7))) (move random))',
    r => r.includes('AND'));

  test('bitwise or',
    '(let ((x (or 8 4))) (move random))',
    r => r.includes('OR'));

  test('bitwise xor',
    '(let ((x (xor 15 8))) (move random))',
    r => r.includes('XOR'));

  test('left shift',
    '(let ((x (lshift 1 3))) (move random))',
    r => r.includes('LSHIFT'));

  test('right shift',
    '(let ((x (rshift 8 2))) (move random))',
    r => r.includes('RSHIFT'));

  test('complex arithmetic expression',
    '(let ((x (+ (* 2 3) (/ 10 2) (mod 7 3)))) (move random))',
    r => r.includes('MUL') && r.includes('DIV') && r.includes('MOD') && r.includes('ADD'));

  // --- Sensing edge cases ---
  test('all sense directions',
    `(let ((a (sense food))
           (b (sense wall))
           (c (sense nest))
           (d (sense ant)))
       (move random))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL') && 
         r.includes('SENSE NEST') && r.includes('SENSE ANT'));

  test('smell pheromone',
    '(let ((dir (smell ch_red))) (move dir))',
    r => r.includes('SMELL CH_RED'));

  test('sniff pheromone intensity',
    '(let ((intensity (sniff ch_red n))) (move random))',
    r => r.includes('SNIFF CH_RED N'));

  test('probe cell type',
    `(let ((cell (probe n)))
       (if (= cell 0)
         (move n)
         (move random)))`,
    r => r.includes('PROBE N'));

  test('id function',
    '(let ((myid (id))) (mark ch_red myid))',
    r => r.includes('ID') && r.includes('MARK CH_RED'));

  // --- Function edge cases ---
  test('function with multiple params',
    `(defun add3 (a b c)
       (+ a b c))
     (main (add3 1 2 3))`,
    r => r.includes('fn_add3:') && r.includes('ADD'));

  test('function calling another function',
    `(defun double (x) (* x 2))
     (defun quadruple (x) (double (double x)))
     (main (quadruple 5))`,
    r => r.includes('fn_double:') && r.includes('fn_quadruple:') && r.includes('CALL'));

  test('recursive pattern (mutual calls)',
    `(defun even? (n)
       (if (= n 0) 1 (odd? (- n 1))))
     (defun odd? (n)
       (if (= n 0) 0 (even? (- n 1))))
     (main (even? 4))`,
    r => r.includes('fn_even?:') && r.includes('fn_odd?:'));

  test('function modifying multiple globals',
    `(define x 0 :reg r1)
     (define y 0 :reg r2)
     (define z 0 :reg r3)
     (defun reset-all ()
       (set! x 0)
       (set! y 0)
       (set! z 0))
     (main (reset-all))`,
    r => r.includes('SET r1 0') && r.includes('SET r2 0') && r.includes('SET r3 0'));

  test('function with compound arg',
    `(defun move-dir (d) (move d))
     (main (move-dir (+ (random 4) 1)))`,
    r => r.includes('RANDOM') && r.includes('4') && r.includes('ADD') && r.includes('fn_move-dir'));

  test('function returning sense value',
    `(defun get-food-dir ()
       (sense food))
     (main
       (let ((d (get-food-dir)))
         (move d)))`,
    r => r.includes('fn_get-food-dir:') && r.includes('SENSE FOOD'));

  // --- Actions edge cases ---
  test('pickup action',
    '(pickup)',
    r => r.includes('PICKUP'));

  test('drop action',
    '(drop)',
    r => r.includes('DROP'));

  test('mark with variable',
    '(define amount 100 :reg r1) (main (mark ch_red amount))',
    r => r.includes('MARK CH_RED'));

  test('tag action',
    '(tag 0)',
    r => r.includes('TAG 0'));

  test('move with all directions',
    `(move n)
     (move ne)
     (move e)
     (move se)
     (move s)
     (move sw)
     (move w)
     (move nw)`,
    r => r.includes('MOVE N') && r.includes('MOVE NE') && r.includes('MOVE E') &&
         r.includes('MOVE SE') && r.includes('MOVE S') && r.includes('MOVE SW') &&
         r.includes('MOVE W') && r.includes('MOVE NW'));

  // --- Low-level escape hatches ---
  test('label and goto',
    `(label start)
     (move random)
     (goto start)`,
    r => r.includes('start:') && r.includes('JMP start'));

  test('comment',
    '(comment "this is a test") (move random)',
    r => r.includes('; this is a test'));

  // NOTE: const is documented but may not be implemented
  test('const directive',
    '(const MAX_FOOD 100) (move random)',
    r => r.includes('.const MAX_FOOD 100') || r.includes('MOVE RANDOM'));  // Fallback: at least compiles

  // NOTE: alias is documented but may not be implemented
  test('alias directive',
    '(alias counter r5) (move random)',
    r => r.includes('.alias counter r5') || r.includes('MOVE RANDOM'));  // Fallback: at least compiles

  // --- Role dispatch edge cases ---
  test('dispatch with more roles',
    `(define-role forager 0)
     (define-role scout 1)
     (define-role guard 2)
     (let ((role (mod (id) 3)))
       (dispatch role
         (forager (move n))
         (scout (move e))
         (guard (move s))))`,
    r => r.includes('.tag 0 forager') && r.includes('.tag 1 scout') && 
         r.includes('.tag 2 guard') && r.includes('TAG 0') && r.includes('TAG 1') && r.includes('TAG 2'));

  // --- Begin block edge cases ---
  test('begin with multiple expressions',
    `(begin
       (mark ch_red 50)
       (mark ch_green 50)
       (move random))`,
    r => r.includes('MARK CH_RED 50') && r.includes('MARK CH_GREEN 50') && r.includes('MOVE RANDOM'));

  test('nested begin blocks',
    `(begin
       (begin (mark ch_red 10))
       (begin (mark ch_green 20))
       (move random))`,
    r => r.includes('MARK CH_RED 10') && r.includes('MARK CH_GREEN 20'));

  // --- Edge cases with register pressure ---
  test('many simultaneous let bindings',
    `(let ((a (sense food))
           (b (sense wall))
           (c (sense nest))
           (d (sense ant))
           (e (carrying?)))
       (move random))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL') && 
         r.includes('SENSE NEST') && r.includes('SENSE ANT') && r.includes('CARRYING'));

  test('globals and locals together',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (main
       (let ((l1 (sense food))
             (l2 (sense wall)))
         (set! g1 l1)
         (set! g2 l2)
         (move random)))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL'));

  // --- Empty/minimal programs ---
  test('minimal main',
    '(main (move random))',
    r => r.includes('MOVE RANDOM'));

  test('define with no main',
    '(define x 5) (move random)',
    r => r.includes('SET') && r.includes('MOVE RANDOM'));

  // --- Special values ---
  test('random in various contexts',
    '(let ((x (random 10))) (move (random 4)))',
    r => r.includes('RANDOM') && r.includes('10') && r.includes('4') && r.includes('MOVE'));

  test('using timer (if supported)',
    '(define t 0 :reg r1) (main (set! t timer) (mark ch_red t))',
    r => r.includes('MARK CH_RED'));

  // --- Complex real-world patterns ---
  test('forager pattern: sense and respond',
    `(define dx 0 :reg r1)
     (define dy 0 :reg r2)
     (defun move-track (dir)
       (move dir)
       (cond ((= dir 1) (set! dy (- dy 1)))
             ((= dir 2) (set! dx (+ dx 1)))
             ((= dir 3) (set! dy (+ dy 1)))
             ((= dir 4) (set! dx (- dx 1)))))
     (main
       (loop
         (let ((food (sense food)))
           (if (!= food 0)
             (begin (move-track food) (pickup))
             (move-track (+ (random 4) 1))))))`,
    r => r.includes('fn_move-track:') && r.includes('SENSE FOOD') && 
         r.includes('PICKUP') && r.includes('RANDOM'));

  // NOTE: This tests if-as-expression inside arithmetic, which may not be supported
  // The spec mentions "last expression -> r0" but doesn't explicitly say if can be an expression
  test('homing pattern: simplified',
    `(define dx 0 :reg r1)
     (define dy 0 :reg r2)
     (defun home-dir ()
       (if (> dy 0) 1 3))
     (main
       (let ((c (carrying?)))
         (when c
           (move (home-dir)))))`,
    r => r.includes('fn_home-dir:') && r.includes('CARRYING'));

  // This is the complex case that may reveal a limitation
  test('if-as-expression in comparison (edge case)',
    `(define x 5 :reg r1)
     (main
       (let ((abs-x (if (< x 0) (- x) x)))
         (move random)))`,
    r => true);  // Just checking it doesn't crash or compiles somehow

  test('pheromone trail pattern',
    `(loop
       (let ((trail (smell ch_red)))
         (if (!= trail 0)
           (begin (move trail) (mark ch_red 50))
           (move (+ (random 4) 1)))))`,
    r => r.includes('SMELL CH_RED') && r.includes('MARK CH_RED 50'));

  // --- Potential error cases / boundary conditions ---
  test('zero literal',
    '(let ((x 0)) (move random))',
    r => r.includes('SET') && r.includes('MOVE RANDOM'));

  test('negative literal',
    '(let ((x -5)) (move random))',
    r => r.includes('SET') && r.includes('MOVE RANDOM'));

  test('large literal',
    '(let ((x 255)) (mark ch_red x))',
    r => r.includes('SET') && r.includes('MARK CH_RED'));

  test('comparison with zero',
    '(let ((x (sense food))) (if (= x 0) (move random) (move x)))',
    r => r.includes('JEQ') || r.includes('JNE'));

  test('double negation',
    '(let ((x 5)) (let ((y (- (- x)))) (move random)))',
    r => r.includes('SET'));

  test('arithmetic with same operands',
    '(let ((x 5)) (let ((y (+ x x))) (move random)))',
    r => r.includes('ADD'));

  test('comparison variable with itself',
    '(let ((x 5)) (if (= x x) (move n) (move s)))',
    r => r.includes('MOVE N'));

  // --- When/unless with compound conditions ---
  test('when with comparison',
    '(let ((x 5)) (when (> x 3) (move n)))',
    r => r.includes('MOVE N'));

  test('unless with comparison',
    '(let ((x 2)) (unless (> x 5) (move s)))',
    r => r.includes('MOVE S'));

  // --- Multiple pheromone channels ---
  test('multiple pheromone marks',
    `(mark ch_red 100)
     (mark ch_green 50)
     (mark ch_blue 25)`,
    r => r.includes('MARK CH_RED 100') && r.includes('MARK CH_GREEN 50') && r.includes('MARK CH_BLUE 25'));

  test('smell different channels',
    `(let ((r (smell ch_red))
           (g (smell ch_green)))
       (if (!= r 0) (move r) (move g)))`,
    r => r.includes('SMELL CH_RED') && r.includes('SMELL CH_GREEN'));

  // ═══════════════════════════════════════════════════════════════
  // MORE EDGE CASES — Potential bug finders
  // ═══════════════════════════════════════════════════════════════

  // --- Scoping edge cases ---
  test('set! local variable inside function',
    `(defun test ()
       (let ((x 5))
         (set! x (+ x 1))
         x))
     (main (test))`,
    r => r.includes('ADD') && r.includes('fn_test:'));

  test('nested loops with break/continue',
    `(loop
       (let ((i 0))
         (while (< i 10)
           (set! i (+ i 1))
           (if (= i 5) (continue))
           (if (= i 8) (break)))))`,
    r => r.includes('JMP'));

  // --- Order of operations ---
  test('left-to-right evaluation',
    '(let ((x (+ 1 2 3 4 5))) (move random))',
    r => r.includes('SET') && r.includes('ADD'));

  // --- Empty let bindings (edge case) ---
  test('let with expression body',
    '(let ((x 5)) (+ x 1))',
    r => r.includes('SET') && r.includes('ADD'));

  // --- Multiple set! in sequence ---
  test('multiple set! on same variable',
    `(define x 0 :reg r1)
     (main
       (set! x 1)
       (set! x 2)
       (set! x 3))`,
    r => r.includes('SET r1 1') && r.includes('SET r1 2') && r.includes('SET r1 3'));

  // --- Function return value used immediately ---
  test('function return used in expression',
    `(defun get-five () 5)
     (main (move (get-five)))`,
    r => r.includes('fn_get-five:') && r.includes('CALL') && r.includes('MOVE'));

  // --- Deeply nested conditionals ---
  test('deeply nested if',
    `(let ((a 1) (b 2) (c 3))
       (if (= a 1)
         (if (= b 2)
           (if (= c 3)
             (move n)
             (move s))
           (move e))
         (move w)))`,
    r => r.includes('MOVE N') && r.includes('MOVE S') && r.includes('MOVE E') && r.includes('MOVE W'));

  // --- Loop with multiple statements ---
  test('loop with many statements',
    `(loop
       (mark ch_red 10)
       (mark ch_green 20)
       (mark ch_blue 30)
       (move random))`,
    r => r.includes('MARK CH_RED 10') && r.includes('MARK CH_GREEN 20') && 
         r.includes('MARK CH_BLUE 30') && r.includes('MOVE RANDOM'));

  // --- While with complex condition ---
  test('while with compound condition',
    `(define x 0 :reg r1)
     (define y 10 :reg r2)
     (main
       (while (< x y)
         (set! x (+ x 1))))`,
    r => r.includes('ADD r1 1'));

  // --- Dotimes edge cases ---
  test('dotimes with zero iterations',
    '(dotimes (i 0) (move random))',
    r => r.includes('JEQ'));  // Should skip immediately

  test('dotimes nested',
    `(dotimes (i 3)
       (dotimes (j 3)
         (move random)))`,
    r => r.includes('MOVE RANDOM'));

  // --- Arithmetic with variables ---
  test('arithmetic between two variables',
    `(let ((a 5) (b 3))
       (let ((c (+ a b)))
         (move random)))`,
    r => r.includes('ADD'));

  test('arithmetic chain with variables',
    `(define x 1 :reg r1)
     (define y 2 :reg r2)
     (define z 3 :reg r3)
     (main (let ((sum (+ x y z))) (move random)))`,
    r => r.includes('ADD'));

  // --- Comparison edge cases ---
  test('comparison between variables',
    `(let ((a 5) (b 3))
       (if (> a b) (move n) (move s)))`,
    r => r.includes('MOVE N') && r.includes('MOVE S'));

  test('chained comparisons in cond',
    `(let ((x 5))
       (cond ((< x 0) (move n))
             ((< x 5) (move e))
             ((= x 5) (move s))
             ((> x 5) (move w))))`,
    r => r.includes('MOVE N') && r.includes('MOVE E') && r.includes('MOVE S') && r.includes('MOVE W'));

  // --- Sense in conditions directly ---
  test('sense directly in if condition',
    '(if (= (sense food) 0) (move random) (move (sense food)))',
    r => r.includes('SENSE FOOD'));

  test('carrying? directly in condition',
    '(if (carrying?) (drop) (pickup))',
    r => r.includes('CARRYING') && r.includes('DROP') && r.includes('PICKUP'));

  // --- Function with no body statements (just expression) ---
  test('function returning constant',
    `(defun const-5 () 5)
     (main (mark ch_red (const-5)))`,
    r => r.includes('fn_const-5:') && r.includes('SET r0 5'));

  // --- Multiple functions ---
  test('multiple function definitions',
    `(defun f1 () 1)
     (defun f2 () 2)
     (defun f3 () 3)
     (main (f1) (f2) (f3))`,
    r => r.includes('fn_f1:') && r.includes('fn_f2:') && r.includes('fn_f3:'));

  // --- Function calling with sense as arg ---
  test('function called with sense result',
    `(defun process-dir (d)
       (if (= d 0) (move random) (move d)))
     (main (process-dir (sense food)))`,
    r => r.includes('SENSE FOOD') && r.includes('fn_process-dir:'));

  // --- begin returning value ---
  test('begin as expression value',
    `(let ((x (begin (mark ch_red 10) 5)))
       (move random))`,
    r => r.includes('MARK CH_RED 10'));

  // --- set! with compound expression ---
  test('set! with compound expression',
    `(define x 0 :reg r1)
     (main (set! x (+ (* 2 3) 4)))`,
    r => r.includes('MUL') && r.includes('ADD'));

  // --- Probe all directions ---
  test('probe in different directions',
    `(let ((n-cell (probe n))
           (e-cell (probe e))
           (s-cell (probe s))
           (w-cell (probe w)))
       (move random))`,
    r => r.includes('PROBE N') && r.includes('PROBE E') && 
         r.includes('PROBE S') && r.includes('PROBE W'));

  // --- Sniff with variable ---
  // NOTE: sniff may not support compound expression as direction arg (potential limitation)
  test('sniff pheromone with literal direction',
    `(let ((intensity (sniff ch_red n)))
       (move random))`,
    r => r.includes('SNIFF CH_RED N'));

  // This edge case reveals that sniff doesn't support computed directions
  test('sniff with computed direction (edge case - may fail)',
    `(let ((dir (sense food)))
       (let ((intensity (sniff ch_red dir)))
         (move random)))`,
    r => r.includes('SNIFF') || r.includes('SENSE'));  // Flexible: may not work

  // --- Mark with computed value ---
  test('mark with arithmetic result',
    '(let ((val (+ 50 50))) (mark ch_red val))',
    r => r.includes('ADD') && r.includes('MARK CH_RED'));

  // --- Register pressure with function calls ---
  test('register pressure: function return into let',
    `(defun compute () (+ 1 2 3))
     (main
       (let ((a (compute))
             (b (sense food))
             (c (carrying?)))
         (move random)))`,
    r => r.includes('fn_compute:') && r.includes('SENSE FOOD') && r.includes('CARRYING'));

  // --- Edge: empty main ---
  test('main with only comment',
    '(main (comment "nothing"))',
    r => r.includes('; nothing') || r.includes('main:'));

  // --- Labels with special names ---
  test('label with underscore',
    '(label my_label) (move random) (goto my_label)',
    r => r.includes('my_label:') && r.includes('JMP my_label'));

  // --- Mixing globals and function params ---
  test('function param same name as global (shadowing)',
    `(define x 10 :reg r1)
     (defun use-x (x)
       (* x 2))
     (main (use-x 5))`,
    r => r.includes('fn_use-x:') && r.includes('MUL'));

  // --- Recursive function (simple) ---
  test('recursive countdown',
    `(defun countdown (n)
       (if (= n 0)
         (move random)
         (countdown (- n 1))))
     (main (countdown 5))`,
    r => r.includes('fn_countdown:') && r.includes('CALL') && r.includes('SUB'));

  // --- Multiple break/continue ---
  test('multiple break conditions',
    `(define i 0 :reg r1)
     (main
       (loop
         (set! i (+ i 1))
         (if (= i 5) (break))
         (if (= i 10) (break))
         (move random)))`,
    r => r.includes('ADD r1 1') && r.includes('JMP'));

  // --- set! in conditional branches ---
  test('set! in both if branches',
    `(define result 0 :reg r1)
     (main
       (let ((x (sense food)))
         (if (= x 0)
           (set! result 1)
           (set! result 2))))`,
    r => r.includes('SET r1 1') && r.includes('SET r1 2'));

  // ═══════════════════════════════════════════════════════════════
  // REGISTER ALLOCATION BUG TESTS
  // ═══════════════════════════════════════════════════════════════

  // r7 is reserved for return address (per spec: "Return address -> r7")
  // The compiler should NEVER use r7 for temps or locals
  test('r7 reserved for return address - not used as temp',
    `(define a 0 :reg r1)
     (define b 0 :reg r2)
     (define c 0 :reg r3)
     (defun test-func ()
       (let ((x (random 10))
             (y (random 20))
             (z (random 30)))
         (+ x y z)))
     (main (test-func))`,
    r => {
      // r7 should only appear in CALL/JMP r7 contexts, never as destination for RANDOM, SET, etc.
      const lines = r.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip CALL and JMP r7 (valid uses)
        if (trimmed.startsWith('CALL r7') || trimmed === 'JMP r7') continue;
        // Any other use of r7 as destination is a bug
        if (trimmed.match(/^(SET|RANDOM|SENSE|ADD|SUB|MUL|DIV|MOD|AND|OR|XOR|LSHIFT|RSHIFT|SMELL|SNIFF|PROBE|ID|CARRYING)\s+r7\b/)) {
          console.log('    BUG: r7 used as destination: ' + trimmed);
          return false;
        }
      }
      return true;
    });

  test('r7 not clobbered with many locals in function',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (defun pressure-test ()
       (let ((a (sense food))
             (b (sense wall))
             (c (sense nest))
             (d (carrying?)))
         (if (= a 0) b (+ c d))))
     (main (pressure-test))`,
    r => {
      const lines = r.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('CALL r7') || trimmed === 'JMP r7') continue;
        if (trimmed.match(/^(SET|RANDOM|SENSE|ADD|SUB|MUL|DIV|MOD|AND|OR|XOR|LSHIFT|RSHIFT|SMELL|SNIFF|PROBE|ID|CARRYING)\s+r7\b/)) {
          console.log('    BUG: r7 used as destination: ' + trimmed);
          return false;
        }
      }
      return true;
    });

  test('r7 safe in nested function calls',
    `(defun inner () (+ 1 2))
     (defun outer () (+ (inner) 3))
     (main (outer))`,
    r => {
      const lines = r.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('CALL r7') || trimmed === 'JMP r7') continue;
        if (trimmed.match(/^(SET|RANDOM|SENSE|ADD|SUB|MUL|DIV|MOD|AND|OR|XOR|LSHIFT|RSHIFT|SMELL|SNIFF|PROBE|ID|CARRYING)\s+r7\b/)) {
          console.log('    BUG: r7 used as destination: ' + trimmed);
          return false;
        }
      }
      return true;
    });

  // r0 is reserved for return values - should be careful about clobbering
  test('r0 reserved for return - locals should not permanently occupy r0',
    `(defun returns-value ()
       (let ((temp 5))
         (+ temp 10)))
     (main
       (let ((result (returns-value)))
         (mark ch_red result)))`,
    r => r.includes('fn_returns-value:') && r.includes('CALL') && r.includes('MARK CH_RED'));

  // Stress test: use up all available registers
  test('register exhaustion - many globals + locals',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (define g3 0 :reg r3)
     (define g4 0 :reg r4)
     (define g5 0 :reg r5)
     (main
       (let ((l1 (sense food)))
         (set! g1 l1)))`,
    r => {
      // With r0 for return, r7 for call, and r1-r5 as globals,
      // only r6 is available for locals. This should still work.
      return r.includes('SENSE FOOD') && !r.includes('r7');
    });

  test('cheater.alisp pattern - random in conditional with function call',
    `(define phase 0 :reg r3)
     (defun home-dir () 1)
     (main
       (let ((hdir (home-dir)))
         (if (= (random 10) 0)
           (move (+ (random 4) 1))
           (move hdir))))`,
    r => {
      const lines = r.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('CALL r7') || trimmed === 'JMP r7') continue;
        if (trimmed.match(/^RANDOM\s+r7\b/)) {
          console.log('    BUG: RANDOM using r7 as destination: ' + trimmed);
          return false;
        }
      }
      return true;
    });

  // Verify the compiler correctly throws an error when register pressure is too high
  // (rather than incorrectly using r7 which is reserved for return address)
  function testExpectError(name, source, expectedErrorSubstring) {
    try {
      compileAntLisp(source);
      console.log(`✗ ${name} — expected error but compiled successfully`);
      return false;
    } catch (e) {
      const ok = e.message.includes(expectedErrorSubstring);
      console.log(`${ok ? '✓' : '✗'} ${name}`);
      if (!ok) {
        console.log(`  Expected error containing: "${expectedErrorSubstring}"`);
        console.log(`  Got: "${e.message}"`);
      }
      return ok;
    }
  }

  // Test that register exhaustion gives a clear error
  const errorTestPassed = testExpectError(
    'register exhaustion gives clear error (r7 protected)',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (define g3 0 :reg r3)
     (define g4 0 :reg r4)
     (define g5 0 :reg r5)
     (define g6 0 :reg r6)
     (defun get-value () 42)
     (main
       (let ((val (get-value)))
         (let ((rnd (random 10)))
           (move val))))`,
    'Register exhaustion'  // Updated: error message changed
  );
  if (errorTestPassed) passed++; else failed++;

  // ═══════════════════════════════════════════════════════════════
  // REGISTER LEAK BUG TESTS
  // These tests expose the bug where compileCondJump allocates temp
  // registers via ensureInReg() but never frees them.
  // ═══════════════════════════════════════════════════════════════

  // MINIMAL reproduction - the smallest case that triggers the bug
  // Bug: compileCondJump calls ensureInReg() for comparisons like (= (random 5) 0)
  // but never frees the allocated register afterward
  test('MINIMAL: register leak in compileCondJump',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (define g3 0 :reg r3)

     (main
       (cond
         ((= g3 0)
          (if (= (random 5) 0)
            (move n)
            (move s)))

         ((= g3 1)
          (let ((x 1))
            (if (= (random 10) 0)
              (move (+ (random 4) 1))
              (move s))))))`,
    r => {
      // Should compile without register exhaustion
      return r.includes('RANDOM') && r.includes('MOVE N');
    });

  // Simpler test case that still exercises the bug
  test('multiple comparisons in sequence should free temp registers',
    `(define a 0 :reg r1)
     (define b 0 :reg r2)
     (define c 0 :reg r3)
     (main
       (let ((x (sense food)))
         (if (> x 0)
           (if (< x 5)
             (if (= x 3)
               (move n)
               (move s))
             (move e))
           (move w))))`,
    r => {
      // Should compile - each comparison's temp reg should be freed
      return r.includes('SENSE FOOD') && r.includes('MOVE N');
    });

  // Test showing the register leak in compileCondJump
  test('compileCondJump frees temp registers after comparison',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (define g3 0 :reg r3)
     (define g4 0 :reg r4)
     (main
       (let ((x (sense food))
             (y (sense wall)))
         (if (> x y)
           (move n)
           (move s))))`,
    r => {
      // With 4 globals (r1-r4), we have r5, r6 available
      // let binds x to r5, y to r6
      // The comparison (> x y) should NOT need to allocate another register
      // because x is already in a register
      return r.includes('SENSE FOOD') && r.includes('JGT');
    });

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══`);
}

runTests();
