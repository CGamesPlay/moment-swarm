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
    r => r.includes('SET r0 12'));  // constant-folded

  test('let binding as global-style var',
    '(let ((dx 0) (dy 0)) (set! dx (+ dx 1)))',
    r => r.includes('ADD') && r.includes('1'));

  test('cond with else',
    `(let ((d (probe n)))
       (cond ((= d 2) (move n))
             ((= d 0) (move s))
             (else (move random))))`,
    r => r.includes('PROBE N') && r.includes('MOVE N') && r.includes('MOVE RANDOM'));

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
    '(let ((timer 10)) (mark ch_red (* timer 2)))',
    r => r.includes('MUL') && r.includes('MARK CH_RED'));

  test('nested compound exprs',
    '(let ((x (+ (* 2 3) (- 10 5)))) (move random))',
    r => r.includes('SET r0 11'));  // constant-folded

  // --- Unary negation edge cases ---
  test('unary negation simple',
    '(let ((x 5)) (set! x (- x)))',
    r => r.includes('MUL') && r.includes('-1'));  // In-place negate via MUL

  test('unary negation in expression',
    '(let ((x 5)) (let ((y (- x))) (move random)))',
    r => r.includes('SUB') && !r.includes('MUL'));  // Different dest — uses SET 0 + SUB, no MUL

  test('unary negation same register safe',
    '(let ((dx 5)) (set! dx (- dx)))',
    r => r.includes('MUL') && r.includes('-1') && !r.includes('SET r0 0'));  // MUL -1 in-place, no temp

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
    '(let ((x 10)) (while (> x 0) (set! x (- x 1)) (move random)))',
    r => r.includes('SUB') && r.includes('1') && r.includes('JMP'));

  test('break in loop',
    `(loop
       (let ((f (sense food)))
         (if (!= f 0)
           (break)
           (move random))))`,
    r => r.includes('SENSE FOOD') && r.includes('JMP'));

  test('continue in loop',
    `(let ((count 0))
       (loop
         (set! count (+ count 1))
         (if (= (mod count 2) 0)
           (continue))
         (move random)))`,
    r => r.includes('ADD') && r.includes('1') && r.includes('MOD'));

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
    r => r.includes('SET r0 4'));  // constant-folded

  test('chained multiplication',
    '(let ((x (* 2 3 4))) (move random))',
    r => r.includes('SET r0 24'));  // constant-folded

  test('division',
    '(let ((x (/ 10 2))) (move random))',
    r => r.includes('SET r0 5'));  // constant-folded

  test('modulo',
    '(let ((x (mod (id) 4))) (move random))',
    r => r.includes('ID') && r.includes('MOD'));

  test('bitwise and',
    '(let ((x (and 15 7))) (move random))',
    r => r.includes('AND'));

  test('bitwise or',
    '(let ((x (or 8 4))) (move random))',
    r => r.includes('SET r0 12'));  // constant-folded

  test('bitwise xor',
    '(let ((x (xor 15 8))) (move random))',
    r => r.includes('SET r0 7'));  // constant-folded

  test('left shift',
    '(let ((x (lshift 1 3))) (move random))',
    r => r.includes('SET r0 8'));  // constant-folded

  test('right shift',
    '(let ((x (rshift 8 2))) (move random))',
    r => r.includes('SET r0 2'));  // constant-folded

  test('complex arithmetic expression',
    '(let ((x (+ (* 2 3) (/ 10 2) (mod 7 3)))) (move random))',
    r => r.includes('SET r0 12'));  // constant-folded: 6 + 5 + 1

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
    '(let ((amount 100)) (mark ch_red amount))',
    r => r.includes('MARK CH_RED'));

  test('set-tag action',
    '(set-tag 0)',
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
  test('tagbody and go',
    `(tagbody
       start
       (move random)
       (go start))`,
    r => {
      const m = r.match(/(__tag_start_\d+):/);
      return m && r.includes(`JMP ${m[1]}`) && r.includes('MOVE RANDOM');
    });

  test('comment',
    '(comment "this is a test") (move random)',
    r => r.includes('; this is a test'));

  test('const inline substitution',
    '(const MAX_FOOD 100) (move random)',
    r => r.includes('MOVE RANDOM'));

  test('alias directive',
    '(alias counter r5) (move random)',
    r => r.includes('.alias counter r5') || r.includes('MOVE RANDOM'));

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

  test('outer and inner let bindings together',
    `(let ((g1 0) (g2 0))
       (let ((l1 (sense food))
             (l2 (sense wall)))
         (set! g1 l1)
         (set! g2 l2)
         (move random)))`,
    r => r.includes('SENSE FOOD') && r.includes('SENSE WALL'));

  // --- Empty/minimal programs ---
  test('minimal program',
    '(move random)',
    r => r.includes('MOVE RANDOM'));

  test('let with no further body outside',
    '(let ((x 5)) (move random))',
    r => r.includes('SET') && r.includes('MOVE RANDOM'));

  // --- Special values ---
  test('random in various contexts',
    '(let ((x (random 10))) (move (random 4)))',
    r => r.includes('RANDOM') && r.includes('10') && r.includes('4') && r.includes('MOVE'));

  test('using timer (if supported)',
    '(let ((t 0)) (set! t timer) (mark ch_red t))',
    r => r.includes('MARK CH_RED'));

  // --- Complex real-world patterns ---
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

  test('if-as-expression in comparison (edge case)',
    `(let ((x 5))
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
    r => r.includes('SET r0 15'));  // constant-folded

  // --- Empty let bindings (edge case) ---
  test('let with expression body',
    '(let ((x 5)) (+ x 1))',
    r => r.includes('SET') && r.includes('ADD'));

  // --- Multiple set! in sequence ---
  test('multiple set! on same variable',
    `(let ((x 0))
       (set! x 1)
       (set! x 2)
       (set! x 3))`,
    r => {
      // Dead store elimination removes all but the last SET rX
      const lines = r.split('\n').map(l => l.trim()).filter(l => /^SET r\d \d/.test(l));
      return lines.length === 1 && lines[0].endsWith('3');
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
    `(let ((x 0) (y 10))
       (while (< x y)
         (set! x (+ x 1))))`,
    r => r.includes('ADD') && r.includes('1'));

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
    `(let ((x 1) (y 2) (z 3))
       (let ((sum (+ x y z))) (move random)))`,
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
    `(let ((x 0))
       (set! x (+ (* 2 3) 4)))`,
    r => r.includes('SET r0 10'));  // constant-folded: 6 + 4

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
    r => r.includes('SET r0 100') && r.includes('MARK CH_RED'));  // constant-folded

  // --- tagbody / go ---
  test('tagbody with underscore tag',
    `(tagbody
       my_label
       (move random)
       (go my_label))`,
    r => {
      const m = r.match(/(__tag_my_label_\d+):/);
      return m && r.includes(`JMP ${m[1]}`);
    });

  test('tagbody: multiple tags',
    `(tagbody
       first
       (move n)
       second
       (move s)
       third
       (move e))`,
    r => r.includes('MOVE N') && r.includes('MOVE S') && r.includes('MOVE E') &&
         /__tag_first_\d+:/.test(r) && /__tag_second_\d+:/.test(r) && /__tag_third_\d+:/.test(r));

  test('tagbody: go jumps backward',
    `(let ((x 0))
       (tagbody
         top
         (set! x (+ x 1))
         (when (< x 5)
           (go top))
         (move random)))`,
    r => {
      const m = r.match(/(__tag_top_\d+):/);
      return m && r.includes(`JMP ${m[1]}`) && r.includes('ADD');
    });

  test('tagbody: go jumps forward',
    `(tagbody
       (go skip)
       (move n)
       skip
       (move s))`,
    r => {
      const m = r.match(/(__tag_skip_\d+):/);
      return m && r.includes(`JMP ${m[1]}`) && r.includes('MOVE N') && r.includes('MOVE S');
    });

  test('tagbody: two separate tagbodies with same tag names do not collide',
    `(tagbody
       start
       (move n)
       (go start))
     (tagbody
       start
       (move s)
       (go start))`,
    r => {
      const labels = r.match(/__tag_start_\d+:/g) || [];
      return labels.length === 2 && labels[0] !== labels[1];
    });

  test('nested tagbody: go resolves to innermost',
    `(tagbody
       point
       (move n)
       (tagbody
         point
         (move s)
         (go point)))`,
    r => {
      // The go should resolve to the inner tagbody's tag, not the outer
      const labels = r.match(/__tag_point_(\d+):/g) || [];
      if (labels.length !== 2) return false;
      // Extract the inner label (the second one in source order)
      const innerMatch = labels[1].match(/__tag_point_(\d+):/);
      const innerLabel = `__tag_point_${innerMatch[1]}`;
      return r.includes(`JMP ${innerLabel}`);
    });

  test('nested tagbody: go can reach outer tag',
    `(tagbody
       outer
       (move n)
       (tagbody
         (move s)
         (go outer)))`,
    r => {
      const outerMatch = r.match(/(__tag_outer_\d+):/);
      return outerMatch && r.includes(`JMP ${outerMatch[1]}`);
    });

  // Error cases for tagbody/go
  (function() {
    let caught = false;
    try {
      compileAntLisp('(go nowhere)');
    } catch (e) {
      caught = e.message.includes('no such tag');
    }
    console.log(`${caught ? '✓' : '✗'} go: error on unknown tag`);
    if (caught) passed++; else failed++;
  })();

  (function() {
    let caught = false;
    try {
      compileAntLisp('(tagbody dup (move n) dup (move s))');
    } catch (e) {
      caught = e.message.includes('Duplicate tag');
    }
    console.log(`${caught ? '✓' : '✗'} tagbody: error on duplicate tag`);
    if (caught) passed++; else failed++;
  })();

  // --- Multiple break/continue ---
  test('multiple break conditions',
    `(let ((i 0))
       (loop
         (set! i (+ i 1))
         (if (= i 5) (break))
         (if (= i 10) (break))
         (move random)))`,
    r => r.includes('ADD') && r.includes('1') && r.includes('JMP'));

  // --- set! in conditional branches ---
  test('set! in both if branches',
    `(let ((result 0))
       (let ((x (sense food)))
         (if (= x 0)
           (set! result 1)
           (set! result 2))))`,
    r => r.includes('SET') && r.includes('1') && r.includes('SET') && r.includes('2'));

  // ═══════════════════════════════════════════════════════════════
  // REGISTER ALLOCATION TESTS
  // ═══════════════════════════════════════════════════════════════

  test('all 8 registers used by nested let',
    `(let ((g1 0) (g2 0) (g3 0) (g4 0) (g5 0) (g6 0) (g7 0) (g8 0))
       (set! g1 1))`,
    r => r.includes('SET') && r.includes('1'));

  test('register exhaustion - many outer + inner let bindings',
    `(let ((g1 0) (g2 0) (g3 0) (g4 0) (g5 0))
       (let ((l1 (sense food)))
         (set! g1 l1)))`,
    r => r.includes('SENSE FOOD'));

  // ═══════════════════════════════════════════════════════════════
  // REGISTER LEAK BUG TESTS
  // ═══════════════════════════════════════════════════════════════

  test('MINIMAL: register leak in compileCondJump',
    `(let ((g1 0) (g2 0) (g3 0))
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
    r => r.includes('RANDOM') && r.includes('MOVE N'));

  test('multiple comparisons in sequence should free temp registers',
    `(let ((a 0) (b 0) (c 0))
       (let ((x (sense food)))
         (if (> x 0)
           (if (< x 5)
             (if (= x 3)
               (move n)
               (move s))
             (move e))
           (move w))))`,
    r => r.includes('SENSE FOOD') && r.includes('MOVE N'));

  test('compileCondJump frees temp registers after comparison',
    `(let ((g1 0) (g2 0) (g3 0) (g4 0))
       (let ((x (sense food))
             (y (sense wall)))
         (if (> x y)
           (move n)
           (move s))))`,
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
    `(defmacro step (dir)
       (move dir))
     (step n)`,
    r => r.includes('MOVE N'));

  test('macro with multiple params',
    `(defmacro mark-trail (ch amt)
       (mark ch amt))
     (mark-trail ch_red 100)`,
    r => r.includes('MARK CH_RED 100'));

  test('macro with expression param',
    `(defmacro step (dir)
       (move dir))
     (step (+ (random 4) 1))`,
    r => r.includes('RANDOM') && r.includes('ADD') && r.includes('MOVE'));

  test('macro with multi-statement body',
    `(defmacro forage ()
       (let ((dir (sense food)))
         (when (!= dir 0)
           (move dir)
           (pickup))))
     (forage)`,
    r => r.includes('SENSE FOOD') && r.includes('MOVE') && r.includes('PICKUP'));

  test('macro using outer let binding',
    `(let ((dx 0))
       (defmacro track-east ()
         (set! dx (+ dx 1)))
       (track-east))`,
    r => r.includes('ADD') && r.includes('1'));

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

  test('macro with tagbody/go - freshened',
    `(defmacro skip-if-carrying ()
       (tagbody
         (when (carrying?)
           (go done))
         (move n)
         done))
     (skip-if-carrying) (skip-if-carrying)`,
    r => {
      // Should have two distinct "done" labels (freshened by compileTagbody)
      const doneLabels = r.match(/__tag_done_\d+:/g) || [];
      return doneLabels.length === 2 && doneLabels[0] !== doneLabels[1];
    });

  test('nested macro calls',
    `(defmacro step (dir)
       (move dir))
     (defmacro wander ()
       (step (+ (random 4) 1)))
     (wander)`,
    r => r.includes('RANDOM') && r.includes('MOVE'));

  test('macro param shadows outer binding',
    `(let ((x 5))
       (defmacro set-x (x)
         (move x))
       (set-x n))`,
    r => r.includes('MOVE N'));  // x param is N, not the let-bound x

  test('hygienic: macro free var resolves to definition-site binding',
    `(let ((x 10))
       (defmacro use-x ()
         (move x))
       (let ((x 99))
         (use-x)))`,
    r => r.includes('MOVE r0'));  // uses outer x (r0), not inner x

  test('hygienic: macro set! targets definition-site binding',
    `(let ((counter 0))
       (defmacro bump ()
         (set! counter (+ counter 1)))
       (let ((counter 99))
         (bump)))`,
    r => r.includes('ADD r0 1'));  // increments outer counter (r0), not inner

  test('hygienic: macro sees consts from definition site',
    `(const MY_VAL 42)
     (defmacro use-val ()
       (move MY_VAL))
     (use-val)`,
    r => r.includes('MOVE 42'));

  test('hygienic: nested macro calls use correct scopes',
    `(let ((dir 0))
       (defmacro inner (dir) (move dir))
       (defmacro outer (dir) (inner dir))
       (outer dir))`,
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
      // Constant-folding rewrites (< x 0) to (<= x -1), which has a
      // direct false-jump JGT — no trampoline or if-swap needed.
      const hasSkip = /__skip_\d+/.test(r);
      const hasJGT = r.includes('JGT') && r.includes('-1');
      return !hasSkip && hasJGT;
    });

  test('if-swap: (> x 0) with else avoids trampoline',
    `(let ((x 5))
       (if (> x 0)
         (move n)
         (move s)))`,
    r => {
      // Constant-folding rewrites (> x 0) to (>= x 1), which has a
      // direct false-jump JLT — no trampoline or if-swap needed.
      const hasSkip = /__skip_\d+/.test(r);
      const hasJLT = r.includes('JLT') && r.includes(' 1 ');
      return !hasSkip && hasJLT;
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

  test('if-swap: (< x 0) without else benefits from constant-folding',
    `(let ((x 5))
       (if (< x 0)
         (move n)))`,
    r => {
      // Constant-folding rewrites (< x 0) to (<= x -1), which has a
      // direct false-jump JGT — no trampoline needed even without else.
      const hasSkip = /__skip_\d+/.test(r);
      return !hasSkip && r.includes('JGT') && r.includes('-1');
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
      // Constant-folding rewrites (< a 5) to (<= a 4), false-jump is JGT with 4
      return r.includes('MARK CH_RED 10') && r.includes('MARK CH_BLUE 20') && r.includes('JGT') && r.includes(' 4 ');
    });

  test('if-swap: semantic correctness preserved for (> a b)',
    `(let ((a 10))
       (if (> a 5)
         (mark ch_red 10)
         (mark ch_blue 20)))`,
    r => {
      // Constant-folding rewrites (> a 5) to (>= a 6), false-jump is JLT with 6
      return r.includes('MARK CH_RED 10') && r.includes('MARK CH_BLUE 20') && r.includes('JLT') && r.includes(' 6 ');
    });

  // ═══════════════════════════════════════════════════════════════
  // CONSTANT-FOLDING: (> a N) → (>= a N+1), (< a N) → (<= a N-1)
  // ═══════════════════════════════════════════════════════════════

  test('const-fold: (when (> x 3) ...) emits JLT with 4, no trampoline',
    `(let ((x 5))
       (when (> x 3) (move n)))`,
    r => {
      const hasSkip = /__skip_\d+/.test(r);
      return !hasSkip && r.includes('JLT') && r.includes(' 4 ');
    });

  test('const-fold: (when (< x 3) ...) emits JGT with 2, no trampoline',
    `(let ((x 5))
       (when (< x 3) (move n)))`,
    r => {
      const hasSkip = /__skip_\d+/.test(r);
      return !hasSkip && r.includes('JGT') && r.includes(' 2 ');
    });

  test('const-fold: (> x CONST) works through const resolution',
    `(const THRESHOLD 3)
     (let ((x 5))
       (when (> x THRESHOLD) (move n)))`,
    r => {
      const hasSkip = /__skip_\d+/.test(r);
      return !hasSkip && r.includes('JLT') && r.includes(' 4 ');
    });

  test('const-fold: (> x 2147483647) overflows — trampoline preserved',
    `(let ((x 5))
       (when (> x 2147483647) (move n)))`,
    r => {
      return /__skip_\d+/.test(r);
    });

  test('const-fold: (< x -2147483648) overflows — trampoline preserved',
    `(let ((x 5))
       (when (< x -2147483648) (move n)))`,
    r => {
      return /__skip_\d+/.test(r);
    });

  test('const-fold: (> x -1) rewrites to (>= x 0), emits JLT with 0',
    `(let ((x 5))
       (when (> x -1) (move n)))`,
    r => {
      const hasSkip = /__skip_\d+/.test(r);
      return !hasSkip && r.includes('JLT') && r.includes(' 0 ');
    });

  test('const-fold: (> x y) with register operand — no rewrite, trampoline preserved',
    `(let ((x 5) (y 3))
       (when (> x y) (move n)))`,
    r => {
      return /__skip_\d+/.test(r);
    });

  test('const-fold: (if (> x 3) then else) — no trampoline, emits JLT with 4',
    `(let ((x 5))
       (if (> x 3)
         (move n)
         (move s)))`,
    r => {
      const hasSkip = /__skip_\d+/.test(r);
      return !hasSkip && r.includes('JLT') && r.includes(' 4 ');
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
    `(let ((dir 0) (dx 0) (dy 0))
       (cond ((= dir 1) (set! dy (- dy 1)))
             ((= dir 2) (set! dx (+ dx 1)))
             ((= dir 3) (set! dy (+ dy 1)))
             ((= dir 4) (set! dx (- dx 1)))))`,
    r => {
      const jmps = r.split('\n').filter(l => l.trim().startsWith('JMP __endcond'));
      // 4 branches, last one should have no JMP __endcond → 3 JMPs
      return jmps.length === 3;
    });

  // ═══════════════════════════════════════════════════════════════
  // PEEPHOLE: dead store elimination (SET rX ...; SET rX ...)
  // ═══════════════════════════════════════════════════════════════

  test('dead-store: SET rX 0 then SET rX rY eliminates first SET',
    `(let ((x 0) (tmp 0))
       (set! tmp (and x 255))
       (move random))`,
    r => {
      // tmp gets r1, x gets r0. (let ((tmp 0))) emits SET r1 0,
      // then (set! tmp (and x 255)) emits SET r1 r0 + AND r1 255.
      // The SET r1 0 is a dead store and should be eliminated.
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      // Check no consecutive SET rN 0; SET rN <reg> for any register
      for (let i = 0; i < lines.length - 1; i++) {
        const m1 = lines[i].match(/^SET (r\d) 0$/);
        const m2 = lines[i+1].match(/^SET (r\d) r\d$/);
        if (m1 && m2 && m1[1] === m2[1]) return false;  // dead store NOT eliminated
      }
      return true;
    });

  test('dead-store: consecutive SET same reg, both literals',
    `(let ((tmp 0))
       (set! tmp 42)
       (move random))`,
    r => {
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < lines.length - 1; i++) {
        const m1 = lines[i].match(/^SET (r\d) 0$/);
        const m2 = lines[i+1].match(/^SET (r\d) 42$/);
        if (m1 && m2 && m1[1] === m2[1]) return false;  // dead store NOT eliminated
      }
      return true;
    });

  test('dead-store: does NOT eliminate when label intervenes',
    `(let ((tmp 0))
       (tagbody
         target
         (set! tmp 42)
         (move random)))`,
    r => {
      // A label between the two SETs means the first might be a jump
      // target — it must NOT be eliminated.
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      // Should still have the init SET rX 0
      return lines.some(l => /^SET r\d 0$/.test(l));
    });

  test('dead-store: does NOT eliminate when different registers',
    `(let ((x 0) (y 0) (a 0) (b 0))
       (set! a x)
       (set! b y)
       (move random))`,
    r => {
      // a and b get regs r2/r3, x and y get r0/r1.
      // After dead-store elim, the init SETs for a and b should be gone,
      // but the SET a x and SET b y instructions must still exist.
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      const setRegs = lines.filter(l => /^SET r\d r\d$/.test(l));
      return setRegs.length === 2;
    });

  test('dead-store: multiple consecutive dead stores, last wins',
    `(let ((tmp 0))
       (set! tmp 1)
       (set! tmp 2)
       (set! tmp 3)
       (move random))`,
    r => {
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      // Should only have one SET rX <literal> (the last one, value 3)
      const setLits = lines.filter(l => /^SET r\d \d+$/.test(l));
      return setLits.length === 1 && setLits[0].endsWith('3');
    });

  test('dead-store: real macro pattern — inc-dx! has no dead SET',
    `(defmacro inc-dx! (packed)
       (let ((tmp 0))
         (set! tmp (and packed 0xFF))
         (set! tmp (+ tmp 1))
         (set! tmp (and tmp 0xFF))
         (set! packed (and packed 0xFFFFFF00))
         (set! packed (or packed tmp))))
     (let ((packed 0))
       (inc-dx! packed))`,
    r => {
      const lines = r.split('\n').map(l => l.trim()).filter(l => l);
      // Should NOT have SET rX 0 immediately followed by SET rX rY (dead init)
      for (let i = 0; i < lines.length - 1; i++) {
        const m1 = lines[i].match(/^SET (r\d) 0$/);
        const m2 = lines[i+1].match(/^SET (r\d) r\d$/);
        if (m1 && m2 && m1[1] === m2[1]) return false;
      }
      return true;
    });

  test('macro with code fragment param',
    `(defmacro do-then (action after)
       (action)
       after)
     (tagbody
       top
       (do-then (move n) (go top)))`,
    r => r.includes('MOVE N') && r.includes('JMP'));

  test('macro: compound arg substituted multiple times',
    `(defmacro twice (expr)
       (let ((a expr) (b expr))
         (+ a b)))
     (let ((x 0))
       (twice (+ x 1)))`,
    r => {
      // Should have two ADD x 1 sequences (not one cached in a temp)
      const adds = (r.match(/ADD/g) || []).length;
      return adds >= 3;  // two (+ x 1) expansions + one (+ a b)
    });

  test('macro: set! on substituted variable',
    `(defmacro zero-out (v)
       (set! v 0))
     (let ((x 5))
       (zero-out x)
       (move x))`,
    r => r.includes('SET r0 0') && r.includes('MOVE r0'));

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

  // --- Compile-time constant expression evaluation ---

  test('const expr: (+ 3 4) evaluates to 7',
    '(const X (+ 3 4)) (let ((a X)) (move a))',
    r => r.includes('SET r0 7'));

  test('const expr: const referencing earlier const',
    '(const A 5) (const B (* A 2)) (let ((x B)) (move x))',
    r => r.includes('SET r0 10'));

  test('const expr: subtraction',
    '(const C (- 10 3)) (let ((x C)) (move x))',
    r => r.includes('SET r0 7'));

  test('const expr: integer division truncates',
    '(const D (/ 10 3)) (let ((x D)) (move x))',
    r => r.includes('SET r0 3'));

  test('const expr: bitwise lshift',
    '(const E (lshift 1 8)) (let ((x E)) (move x))',
    r => r.includes('SET r0 256'));

  test('const expr: variadic addition',
    '(const F (+ 1 2 3)) (let ((x F)) (move x))',
    r => r.includes('SET r0 6'));

  test('const expr: unary negation',
    '(const G (- 5)) (let ((x G)) (move x))',
    r => r.includes('SET r0 -5'));

  test('const expr: nested expressions',
    '(const H (+ (* 2 3) 1)) (let ((x H)) (move x))',
    r => r.includes('SET r0 7'));

  (function() {
    let caught = false;
    try {
      compileAntLisp('(const X (+ 1 y))');
    } catch (e) {
      caught = e.message.includes('not a compile-time constant');
    }
    console.log(`${caught ? '✓' : '✗'} const expr: error on non-const operand`);
    if (caught) passed++; else failed++;
  })();

  // --- Opportunistic constant folding in expressions ---

  test('const fold: (+ 1 1) folds to SET 2',
    '(let ((x (+ 1 1))) (move x))',
    r => r.includes('SET r0 2') && !r.includes('ADD'));

  test('const fold: (+ x 1) does NOT fold (variable operand)',
    '(let ((x 3)) (move (+ x 1)))',
    r => r.includes('ADD'));

  test('const fold: (* CONST 2) folds through const resolution',
    '(const N 5) (let ((x (* N 2))) (move x))',
    r => r.includes('SET r0 10') && !r.includes('MUL'));

  test('const fold: unary (- 5) folds to SET -5',
    '(let ((x (- 5))) (move x))',
    r => r.includes('SET r0 -5') && !r.includes('SUB'));

  test('const fold: compound expr in comparison operand',
    '(const R 7) (let ((age 14)) (when (>= age (* 2 R)) (move 1)))',
    r => !r.includes('Cannot resolve'));

  // --- Short-circuit and/or in conditional contexts ---

  test('short-circuit and in if: no AND opcode',
    `(let ((a 1) (b 2))
       (if (and (= a 1) (= b 2))
         (move n)
         (move s)))`,
    r => !r.includes(' AND ') && r.includes('JNE'));

  test('short-circuit or in if: no OR opcode',
    `(let ((a 1) (b 2))
       (if (or (= a 1) (= b 2))
         (move n)
         (move s)))`,
    r => !r.includes(' OR ') && r.includes('JEQ'));

  // --- Analysis utility tests ---

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

  // --- Register optimization tests ---

  // --- Let-forwarding ---
  test('let-forwarding: single-use binding into set!',
    `(let ((dir 0))
       (let ((food-dir (sense food)))
         (set! dir food-dir)
         (move dir)))`,
    r => {
      return r.includes('SENSE FOOD r0') && !r.includes('SET r0 r1');
    });

  test('let-forwarding: no forward when set! is conditional (when)',
    `(let ((dir 0))
       (let ((food-dir (sense food)))
         (when (!= food-dir 0)
           (set! dir food-dir))
         (move dir)))`,
    r => {
      // set! is inside when — conditional, so forwarding into dir's register
      // would clobber dir's old value when the condition is false
      return r.includes('SENSE FOOD r1');
    });

  // go only jumps upward out of let scopes, so forwarding IS safe here
  test('let-forwarding: forward still works with go in body',
    `(let ((dir 0))
       (tagbody
         again
         (let ((food-dir (sense food)))
           (set! dir food-dir)
           (go again))))`,
    r => {
      return r.includes('SENSE FOOD r0');
    });

  test('let-forwarding: no forward when binding is set! target',
    `(let ((dir 0))
       (let ((x (sense food)))
         (set! x 5)
         (set! dir x)
         (move dir)))`,
    r => {
      return !r.includes('SENSE FOOD r0');
    });

  test('let-forwarding: no forward when set! is conditional (target in cond)',
    `(let ((dir 3))
       (let ((x (sense food)))
         (when (!= dir 0)
           (set! dir x))
         (move dir)))`,
    r => {
      // set! is inside when — conditional, so no forwarding
      return r.includes('SENSE FOOD r1');
    });

  test('let-forwarding: no forward when set! is conditional (target read before)',
    `(let ((dir 3))
       (let ((x (sense food)))
         (when (!= x 0)
           (move dir)
           (set! dir x))
         (move dir)))`,
    r => {
      // set! is inside when — conditional, so no forwarding
      return r.includes('SENSE FOOD r1');
    });

  test('let-forwarding: no forward when set! is conditional (intervening forms)',
    `(let ((dir 0))
       (let ((x (sense food)))
         (when (!= x 0)
           (move random)
           (set! dir x))
         (move dir)))`,
    r => {
      // set! is inside when — conditional, so no forwarding
      return r.includes('SENSE FOOD r1');
    });

  test('let-forwarding: no forward when set! is deeply nested in conditionals',
    `(let ((dir 0))
       (let ((x (sense food)))
         (when (!= x 0)
           (when (!= x 3)
             (set! dir x)))
         (move dir)))`,
    r => {
      // set! is nested inside two when forms — conditional
      return r.includes('SENSE FOOD r1');
    });

  test('let-forwarding: no forward for trail-dir pattern (conditional set!)',
    `(let ((dir 0))
       (let ((x (sense food)))
         (when (!= x 0)
           (when (!= (probe x) 1)
             (set! dir x)))
         (move dir)))`,
    r => {
      // set! is inside nested when — conditional
      return r.includes('SENSE FOOD r1');
    });

  test('let-forwarding: no forward when target read in earlier body form',
    `(let ((dir 3))
       (let ((x (sense food)))
         (move dir)
         (when (!= x 0)
           (set! dir x))
         (move dir)))`,
    r => {
      // set! is conditional AND dir is read before — no forwarding
      return r.includes('SENSE FOOD r1');
    });

  test('let-forwarding: unconditional set! in begin',
    `(let ((dir 0))
       (let ((x (sense food)))
         (begin
           (move random)
           (set! dir x))
         (move dir)))`,
    r => {
      // set! is inside begin (unconditional) — safe to forward
      return r.includes('SENSE FOOD r0');
    });

  test('let-forwarding: multi-ref unconditional',
    `(let ((dir 0))
       (let ((x (sense food)))
         (mark ch_red x)
         (set! dir x)
         (move dir)))`,
    r => {
      // x has 2 refs but set! is unconditional — safe to forward
      return r.includes('SENSE FOOD r0');
    });

  // --- Dead register clobbering ---
  test('dead-reg clobber: reuses dead binding register in arith',
    `(let ((current 10))
       (let ((strongest 20))
         (set! strongest (- strongest 1))
         (mark ch_red (- strongest current))))`,
    r => {
      // (- strongest current) should reuse strongest's register in-place
      // since strongest is dead after this expression
      return !r.match(/SET r2 r1/) && r.includes('MARK CH_RED r1');
    });

  test('dead-reg clobber: no clobber when binding used later',
    `(let ((current 10))
       (let ((strongest 20))
         (mark ch_red (- strongest current))
         (move strongest)))`,
    r => {
      // strongest is NOT dead after mark — used by move
      // Should use a temp register for the subtraction result
      return r.includes('SET r2 r1');
    });

  test('dead-reg clobber: no clobber when used twice in same form',
    `(let ((current 10))
       (let ((strongest 20))
         (mark strongest (- strongest current))))`,
    r => {
      // strongest appears as both mark channel arg AND in (- strongest current)
      // clobbering would destroy the value needed by the first arg of mark
      return r.includes('SET r2 r1');
    });

  // --- Dead register scavenging via allocReg fallback ---
  // All 8 regs occupied (a-h = r0-r7), then a is dead after mark.
  // The inner (+ c 0) has a symbol first arg so compileArith clobbers c's reg.
  // The outer (+ ... d) has a compound first arg, so compileArith calls
  // allocReg() which must scavenge a's dead register from clobberableRegs.
  test('dead-reg scavenge: allocReg reuses dead reg at register pressure',
    `(let ((a 1) (b 2) (c 3) (d 4) (e 5) (f 6) (g 7) (h 8))
       (mark ch_red a)
       (mark ch_blue (+ (+ c 0) d)))`,
    r => {
      // Should compile without register exhaustion, using a's r0 for the outer +
      return r.includes('MARK CH_BLUE') && r.includes('SET r0 r2');
    });

  // Regression: clobberable register not consumed must still be freed.
  // When a binding is marked clobberable at its last use but nobody
  // actually takes it from clobberableRegs (e.g. it's read as a plain
  // symbol arg, not via compileArith clobbering), it must still be
  // freed at scope exit. This is the minimal repro for the open2.alisp
  // register leak in dec-dx!/inc-dx! macros.
  test('dead-reg: unconsumed clobberable reg freed at scope exit',
    `(let ((packed 0))
       (let ((tmp 0))
         (set! tmp (and packed 255))
         (set! packed (or packed tmp)))
       (let ((tmp2 0))
         (move random)))`,
    r => {
      // tmp's register should be freed after the first inner let exits,
      // even though it was marked clobberable. tmp2 should reuse it.
      return r.includes('MOVE RANDOM');
    });

  // --- Integration: open2.alisp compiles with optimizations enabled ---
  // (The mark-gradient (- strongest current) pattern still uses a temp
  // because strongest has multiple refs within the same when body form;
  // sub-expression liveness would be needed to optimize that.)
  {
    const fs = require('fs');
    test('open2 integration: compiles successfully with optimizations',
      fs.readFileSync('open2.alisp', 'utf8'),
      r => {
        // Verify it compiles and produces expected structure
        return r.includes('.tag 0 exploring') &&
               r.includes('MARK CH_RED') &&
               r.includes('MOVE');
      });
  }

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══`);
}

runTests();
