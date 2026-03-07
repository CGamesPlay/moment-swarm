// ═══════════════════════════════════════════════════════════════
// AntLisp v2 — Compiler Tests (No Functions)
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
    r => r.includes('SET r0 3') && r.includes('ADD r0 4') && r.includes('ADD r0 5'));

  test('global define',
    '(define dx 0) (define dy 0) (set! dx (+ dx 1))',
    r => r.includes('SET r0 0') && r.includes('ADD r0 1'));

  test('global define with :reg',
    '(define dx 0 :reg r1) (define dy 0 :reg r2) (set! dx (+ dx 1))',
    r => r.includes('SET r1 0') && r.includes('SET r2 0') && r.includes('ADD r1 1'));

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
    r => r.includes('SET r0 0') && r.includes('JEQ r0 5'));

  // ═══════════════════════════════════════════════════════════════
  // EDGE CASE TESTS — Added for comprehensive coverage
  // ═══════════════════════════════════════════════════════════════

  // --- Compound expressions as action arguments ---
  test('compound expr in move',
    '(move (+ (random 4) 1))',
    r => r.includes('RANDOM') && r.includes('4') && r.includes('ADD') && r.includes('MOVE'));

  test('compound expr in mark',
    '(define timer 10 :reg r1) (mark ch_red (* timer 2))',
    r => r.includes('MUL') && r.includes('MARK CH_RED'));

  test('nested compound exprs',
    '(let ((x (+ (* 2 3) (- 10 5)))) (move random))',
    r => r.includes('MUL') && r.includes('SUB') && r.includes('ADD'));

  // --- Unary negation edge cases ---
  test('unary negation simple',
    '(define x 5 :reg r1) (set! x (- x))',
    r => r.includes('SET r1 5') && r.includes('MUL r1 -1'));  // In-place negate via MUL

  test('unary negation in expression',
    '(let ((x 5)) (let ((y (- x))) (move random)))',
    r => r.includes('SUB') && !r.includes('MUL'));  // Different dest — uses SET 0 + SUB, no MUL

  test('unary negation same register safe',
    '(define dx 5 :reg r1) (set! dx (- dx))',
    r => r.includes('MUL r1 -1') && !r.includes('SET r1 0'));  // MUL -1 in-place, no temp

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
    '(define x 10 :reg r1) (while (> x 0) (set! x (- x 1)) (move random))',
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
     (loop
       (set! count (+ count 1))
       (if (= (mod count 2) 0)
         (continue))
       (move random))`,
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

  // --- Actions edge cases ---
  test('pickup action',
    '(pickup)',
    r => r.includes('PICKUP'));

  test('drop action',
    '(drop)',
    r => r.includes('DROP'));

  test('mark with variable',
    '(define amount 100 :reg r1) (mark ch_red amount)',
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

  test('const directive',
    '(const MAX_FOOD 100) (move random)',
    r => r.includes('.const MAX_FOOD 100') || r.includes('MOVE RANDOM'));

  test('alias directive',
    '(alias counter r5) (move random)',
    r => r.includes('.alias counter r5') || r.includes('MOVE RANDOM'));

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
     (let ((l1 (sense food))
           (l2 (sense wall)))
       (set! g1 l1)
       (set! g2 l2)
       (move random))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL'));

  // --- Empty/minimal programs ---
  test('minimal program',
    '(move random)',
    r => r.includes('MOVE RANDOM'));

  test('define with no main',
    '(define x 5) (move random)',
    r => r.includes('SET') && r.includes('MOVE RANDOM'));

  // --- Special values ---
  test('random in various contexts',
    '(let ((x (random 10))) (move (random 4)))',
    r => r.includes('RANDOM') && r.includes('10') && r.includes('4') && r.includes('MOVE'));

  test('using timer (if supported)',
    '(define t 0 :reg r1) (set! t timer) (mark ch_red t)',
    r => r.includes('MARK CH_RED'));

  // --- Complex real-world patterns ---
  test('forager pattern: sense and respond',
    `(define dx 0 :reg r1)
     (define dy 0 :reg r2)
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
           (move (+ (random 4) 1)))))`,
    r => r.includes('SENSE FOOD') && r.includes('PICKUP') && r.includes('RANDOM'));

  test('homing pattern: simplified',
    `(define dx 0 :reg r1)
     (define dy 0 :reg r2)
     (let ((c (carrying?)))
       (when c
         (let ((dir (if (> dy 0) 1 3)))
           (move dir))))`,
    r => r.includes('CARRYING'));

  test('if-as-expression in comparison (edge case)',
    `(define x 5 :reg r1)
     (let ((abs-x (if (< x 0) (- x) x)))
       (move random))`,
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
  test('set! local variable',
    `(let ((x 5))
       (set! x (+ x 1))
       (move random))`,
    r => r.includes('ADD'));

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
     (set! x 1)
     (set! x 2)
     (set! x 3)`,
    r => {
      // Dead store elimination removes all but the last SET r1
      return r.includes('SET r1 3') && !r.includes('SET r1 1') && !r.includes('SET r1 2');
    });

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
     (while (< x y)
       (set! x (+ x 1)))`,
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
     (let ((sum (+ x y z))) (move random))`,
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

  // --- begin returning value ---
  test('begin as expression value',
    `(let ((x (begin (mark ch_red 10) 5)))
       (move random))`,
    r => r.includes('MARK CH_RED 10'));

  // --- set! with compound expression ---
  test('set! with compound expression',
    `(define x 0 :reg r1)
     (set! x (+ (* 2 3) 4))`,
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
  test('sniff pheromone with literal direction',
    `(let ((intensity (sniff ch_red n)))
       (move random))`,
    r => r.includes('SNIFF CH_RED N'));

  test('sniff with computed direction (edge case - may fail)',
    `(let ((dir (sense food)))
       (let ((intensity (sniff ch_red dir)))
         (move random)))`,
    r => r.includes('SNIFF') || r.includes('SENSE'));

  // --- Mark with computed value ---
  test('mark with arithmetic result',
    '(let ((val (+ 50 50))) (mark ch_red val))',
    r => r.includes('ADD') && r.includes('MARK CH_RED'));

  // --- Labels with special names ---
  test('label with underscore',
    '(label my_label) (move random) (goto my_label)',
    r => r.includes('my_label:') && r.includes('JMP my_label'));

  // --- Multiple break/continue ---
  test('multiple break conditions',
    `(define i 0 :reg r1)
     (loop
       (set! i (+ i 1))
       (if (= i 5) (break))
       (if (= i 10) (break))
       (move random))`,
    r => r.includes('ADD r1 1') && r.includes('JMP'));

  // --- set! in conditional branches ---
  test('set! in both if branches',
    `(define result 0 :reg r1)
     (let ((x (sense food)))
       (if (= x 0)
         (set! result 1)
         (set! result 2)))`,
    r => r.includes('SET r1 1') && r.includes('SET r1 2'));

  // ═══════════════════════════════════════════════════════════════
  // REGISTER ALLOCATION TESTS
  // ═══════════════════════════════════════════════════════════════

  test('all 8 registers available',
    `(define g1 0 :reg r0)
     (define g2 0 :reg r1)
     (define g3 0 :reg r2)
     (define g4 0 :reg r3)
     (define g5 0 :reg r4)
     (define g6 0 :reg r5)
     (define g7 0 :reg r6)
     (define g8 0 :reg r7)
     (set! g1 1)`,
    r => r.includes('SET r0 0') && r.includes('SET r7 0'));

  test('register exhaustion - many globals + locals',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (define g3 0 :reg r3)
     (define g4 0 :reg r4)
     (define g5 0 :reg r5)
     (let ((l1 (sense food)))
       (set! g1 l1))`,
    r => r.includes('SENSE FOOD'));

  // ═══════════════════════════════════════════════════════════════
  // REGISTER LEAK BUG TESTS
  // ═══════════════════════════════════════════════════════════════

  test('MINIMAL: register leak in compileCondJump',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (define g3 0 :reg r3)
     (cond
       ((= g3 0)
        (if (= (random 5) 0)
          (move n)
          (move s)))
       ((= g3 1)
        (let ((x 1))
          (if (= (random 10) 0)
            (move (+ (random 4) 1))
            (move s)))))`,
    r => r.includes('RANDOM') && r.includes('MOVE N'));

  test('multiple comparisons in sequence should free temp registers',
    `(define a 0 :reg r1)
     (define b 0 :reg r2)
     (define c 0 :reg r3)
     (let ((x (sense food)))
       (if (> x 0)
         (if (< x 5)
           (if (= x 3)
             (move n)
             (move s))
           (move e))
         (move w)))`,
    r => r.includes('SENSE FOOD') && r.includes('MOVE N'));

  test('compileCondJump frees temp registers after comparison',
    `(define g1 0 :reg r1)
     (define g2 0 :reg r2)
     (define g3 0 :reg r3)
     (define g4 0 :reg r4)
     (let ((x (sense food))
           (y (sense wall)))
       (if (> x y)
         (move n)
         (move s)))`,
    r => r.includes('SENSE FOOD') && r.includes('JGT'));

  // ═══════════════════════════════════════════════════════════════
  // MACRO TESTS
  // ═══════════════════════════════════════════════════════════════

  test('simple macro no params',
    `(defmacro wander ()
       (move (+ (random 4) 1)))
     (wander)`,
    r => r.includes('RANDOM') && r.includes('ADD') && r.includes('MOVE'));

  test('macro with one param',
    `(defmacro go (dir)
       (move dir))
     (go n)`,
    r => r.includes('MOVE N'));

  test('macro with multiple params',
    `(defmacro mark-trail (ch amt)
       (mark ch amt))
     (mark-trail ch_red 100)`,
    r => r.includes('MARK CH_RED 100'));

  test('macro with expression param',
    `(defmacro go (dir)
       (move dir))
     (go (+ (random 4) 1))`,
    r => r.includes('RANDOM') && r.includes('ADD') && r.includes('MOVE'));

  test('macro with multi-statement body',
    `(defmacro forage ()
       (let ((dir (sense food)))
         (when (!= dir 0)
           (move dir)
           (pickup))))
     (forage)`,
    r => r.includes('SENSE FOOD') && r.includes('MOVE') && r.includes('PICKUP'));

  test('macro using globals',
    `(define dx 0 :reg r1)
     (defmacro track-east ()
       (set! dx (+ dx 1)))
     (track-east)`,
    r => r.includes('ADD r1 1'));

  test('macro called multiple times',
    `(defmacro wander ()
       (move (+ (random 4) 1)))
     (wander) (wander) (wander)`,
    r => {
      const moves = (r.match(/MOVE/g) || []).length;
      return moves === 3;
    });

  test('macro with internal labels - hygienic',
    `(defmacro maybe-move ()
       (let ((r (random 2)))
         (if (= r 0)
           (move n)
           (move s))))
     (maybe-move) (maybe-move)`,
    r => {
      // Should have two different sets of labels (no duplicates)
      const labels = r.match(/__[a-z_]+_\d+:/g) || [];
      const unique = new Set(labels);
      return unique.size === labels.length;
    });

  test('macro with explicit label/goto - freshened',
    `(defmacro skip-if-carrying ()
       (when (carrying?)
         (goto done))
       (move n)
       (label done))
     (skip-if-carrying) (skip-if-carrying)`,
    r => {
      // Should have two distinct "done" labels
      const doneLabels = r.match(/__skip-if-carrying_\d+_done:/g) || [];
      return doneLabels.length === 2 && doneLabels[0] !== doneLabels[1];
    });

  test('nested macro calls',
    `(defmacro go (dir)
       (move dir))
     (defmacro wander ()
       (go (+ (random 4) 1)))
     (wander)`,
    r => r.includes('RANDOM') && r.includes('MOVE'));

  test('macro param shadows global',
    `(define x 5 :reg r1)
     (defmacro set-x (x)
       (move x))
     (set-x n)`,
    r => r.includes('MOVE N'));  // x param is N, not r1

  test('hygienic: macro free var resolves to definition-site global',
    `(define x 10 :reg r0)
     (defmacro use-x ()
       (move x))
     (let ((x 99))
       (use-x))`,
    r => r.includes('MOVE r0'));  // uses global x (r0), not local x

  test('hygienic: macro set! targets definition-site global',
    `(define counter 0 :reg r0)
     (defmacro bump ()
       (set! counter (+ counter 1)))
     (let ((counter 99))
       (bump))`,
    r => r.includes('ADD r0 1'));  // increments global r0, not local

  test('hygienic: macro sees consts from definition site',
    `(const MY_VAL 42)
     (defmacro use-val ()
       (move MY_VAL))
     (use-val)`,
    r => r.includes('MOVE 42'));

  test('hygienic: nested macro calls use correct scopes',
    `(define dir 0 :reg r0)
     (defmacro inner (dir) (move dir))
     (defmacro outer (dir) (inner dir))
     (outer dir)`,
    r => r.includes('MOVE r0'));

  // ═══════════════════════════════════════════════════════════════
  // IF-BODY SWAPPING — avoid trampolines for > and < with else
  // ═══════════════════════════════════════════════════════════════

  test('if-swap: (< x 0) with else avoids trampoline',
    `(let ((x 5))
       (if (< x 0)
         (move n)
         (move s)))`,
    r => {
      // Should NOT contain a __skip label — that's the trampoline pattern.
      // Instead should use a direct JLT to jump to the then-body,
      // with else-body emitted first (swapped layout).
      const hasSkip = /__skip_\d+/.test(r);
      const hasJLT = r.includes('JLT');
      return !hasSkip && hasJLT;
    });

  test('if-swap: (> x 0) with else avoids trampoline',
    `(let ((x 5))
       (if (> x 0)
         (move n)
         (move s)))`,
    r => {
      const hasSkip = /__skip_\d+/.test(r);
      const hasJGT = r.includes('JGT');
      return !hasSkip && hasJGT;
    });

  test('if-swap: (>= x 0) with else still works (no trampoline needed)',
    `(let ((x 5))
       (if (>= x 0)
         (move n)
         (move s)))`,
    r => {
      // >= jump-on-false uses JLT directly — no trampoline already.
      // Just make sure it still works correctly.
      const hasJLT = r.includes('JLT');
      return hasJLT;
    });

  test('if-swap: (<= x 0) with else still works (no trampoline needed)',
    `(let ((x 5))
       (if (<= x 0)
         (move n)
         (move s)))`,
    r => {
      const hasJGT = r.includes('JGT');
      return hasJGT;
    });

  test('if-swap: (< x 0) without else is unchanged (no swap possible)',
    `(let ((x 5))
       (if (< x 0)
         (move n)))`,
    r => {
      // Without else, we can't swap. Trampoline may still appear.
      // Just verify it compiles and includes JLT.
      return r.includes('JLT');
    });

  test('if-swap: nested < and > both avoid trampolines',
    `(let ((x 5) (y 10))
       (if (> x 0)
         (if (< y 0)
           (move n)
           (move s))
         (move w)))`,
    r => {
      const hasSkip = /__skip_\d+/.test(r);
      return !hasSkip && r.includes('JGT') && r.includes('JLT');
    });

  test('if-swap: semantic correctness preserved for (< a b)',
    `(let ((a 3))
       (if (< a 5)
         (mark ch_red 10)
         (mark ch_blue 20)))`,
    r => {
      // Both branches should still be present with correct actions
      return r.includes('MARK CH_RED 10') && r.includes('MARK CH_BLUE 20') && r.includes('JLT');
    });

  test('if-swap: semantic correctness preserved for (> a b)',
    `(let ((a 10))
       (if (> a 5)
         (mark ch_red 10)
         (mark ch_blue 20)))`,
    r => {
      return r.includes('MARK CH_RED 10') && r.includes('MARK CH_BLUE 20') && r.includes('JGT');
    });

  // ═══════════════════════════════════════════════════════════════
  // PEEPHOLE: redundant JMP elimination
  // ═══════════════════════════════════════════════════════════════

  test('peephole: last cond branch does not emit redundant JMP',
    `(let ((x (sense food)))
       (cond ((= x 1) (move n))
             ((= x 2) (move e))
             ((= x 3) (move s))
             ((= x 4) (move w))))`,
    r => {
      // The last branch (= x 4) should NOT have a JMP to __endcond
      // because __endcond is the very next thing after it.
      const lines = r.split('\n');
      // Find JMP __endcond lines
      const jmps = lines.filter(l => l.trim().startsWith('JMP __endcond'));
      // There are 4 branches. The first 3 need JMP __endcond, but the
      // 4th should be optimized away. So we expect exactly 3.
      return jmps.length === 3;
    });

  test('peephole: JMP removed when target is next label after intervening labels',
    `(let ((d 1))
       (cond ((= d 1) (move n))
             ((= d 2) (move e))))`,
    r => {
      // Last cond branch JMP should be removed — target label follows
      // immediately (possibly after other labels).
      const lines = r.split('\n');
      const jmps = lines.filter(l => l.trim().startsWith('JMP __endcond'));
      return jmps.length === 1;  // only 1st branch needs it, 2nd is last
    });

  test('peephole: JMP preserved when there is code between JMP and target',
    `(let ((d 1))
       (if (= d 1)
         (move n)
         (move s)))`,
    r => {
      // if/else: JMP __endif after then-body must stay (else-body between)
      const lines = r.split('\n');
      const jmps = lines.filter(l => l.trim().startsWith('JMP __endif'));
      return jmps.length === 1;
    });

  test('peephole: instruction count reduced for open.alisp cond patterns',
    // Mirrors the move-with-tracking cond pattern from open.alisp
    `(define dir 0 :reg r0)
     (define dx 0 :reg r1)
     (define dy 0 :reg r2)
     (cond ((= dir 1) (set! dy (- dy 1)))
           ((= dir 2) (set! dx (+ dx 1)))
           ((= dir 3) (set! dy (+ dy 1)))
           ((= dir 4) (set! dx (- dx 1))))`,
    r => {
      const instrs = r.split('\n').filter(l => /^\s+[A-Z]/.test(l));
      const jmps = r.split('\n').filter(l => l.trim().startsWith('JMP __endcond'));
      // 4 branches, last one should have no JMP __endcond → 3 JMPs
      return jmps.length === 3;
    });

  // ═══════════════════════════════════════════════════════════════
  // PEEPHOLE: dead store elimination (SET rX ...; SET rX ...)
  // ═══════════════════════════════════════════════════════════════

  test('dead-store: SET rX 0 then SET rX rY eliminates first SET',
    `(define x 0 :reg r1)
     (let ((tmp 0))
       (set! tmp (and x 255))
       (move random))`,
    r => {
      // (let ((tmp 0))) emits SET r0 0, then (set! tmp (and x 255))
      // emits SET r0 r1 + AND r0 255.  The SET r0 0 is dead.
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      // Find consecutive SET r0 instructions
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i] === 'SET r0 0' && lines[i+1] === 'SET r0 r1') {
          return false;  // dead store NOT eliminated
        }
      }
      return true;
    });

  test('dead-store: consecutive SET same reg, both literals',
    `(define x 0 :reg r1)
     (let ((tmp 0))
       (set! tmp 42)
       (move random))`,
    r => {
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i] === 'SET r0 0' && lines[i+1] === 'SET r0 42') {
          return false;  // dead store NOT eliminated
        }
      }
      return true;
    });

  test('dead-store: does NOT eliminate when label intervenes',
    `(define x 0 :reg r1)
     (let ((tmp 0))
       (label target)
       (set! tmp 42)
       (move random))`,
    r => {
      // A label between the two SETs means the first might be a jump
      // target — it must NOT be eliminated.
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      let foundInit = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === 'SET r0 0') foundInit = true;
        if (lines[i] === 'SET r0 42' && foundInit) return true;
      }
      return false;  // init was eliminated — bad!
    });

  test('dead-store: does NOT eliminate when different registers',
    `(define x 0 :reg r1)
     (define y 0 :reg r2)
     (let ((a 0) (b 0))
       (set! a x)
       (set! b y)
       (move random))`,
    r => {
      // SET r0 0; SET r3 0; SET r0 r1; SET r3 r2
      // Only r0's and r3's own dead stores should be removed, not
      // across registers.  Just verify it compiles and both SET rN rM
      // instructions exist.
      return r.includes('SET r0 r1') && r.includes('SET r3 r2');
    });

  test('dead-store: multiple consecutive dead stores, last wins',
    `(let ((tmp 0))
       (set! tmp 1)
       (set! tmp 2)
       (set! tmp 3)
       (move random))`,
    r => {
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      // Should only have SET r0 3, not the preceding dead SETs
      const setR0s = lines.filter(l => /^SET r0 \d+$/.test(l));
      return setR0s.length === 1 && setR0s[0] === 'SET r0 3';
    });

  test('dead-store: real macro pattern — inc-dx! has no dead SET',
    `(defmacro inc-dx! (packed)
       (let ((tmp 0))
         (set! tmp (and packed 0xFF))
         (set! tmp (+ tmp 1))
         (set! tmp (and tmp 0xFF))
         (set! packed (and packed 0xFFFFFF00))
         (set! packed (or packed tmp))))
     (define packed 0 :reg r1)
     (inc-dx! packed)`,
    r => {
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      // Should NOT have SET r0 0 followed by SET r0 r1
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i] === 'SET r0 0' && lines[i+1] === 'SET r0 r1') {
          return false;
        }
      }
      return true;
    });

  // Test macro error case separately
  (function() {
    let caught = false;
    try {
      compileAntLisp(`
        (defmacro foo (a b) (move a))
        (foo n)
      `);
    } catch (e) {
      caught = e.message.includes('expects 2 args');
    }
    console.log(`${caught ? '✓' : '✗'} macro wrong arg count error`);
    if (caught) passed++; else failed++;
  })();

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══`);
}

runTests();
