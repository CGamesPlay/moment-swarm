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
    r => r.includes('SET r0 3') && r.includes('ADD r0 4') && r.includes('ADD r0 5'));

  test('global define',
    '(define dx 0) (define dy 0) (main (set! dx (+ dx 1)))',
    r => r.includes('SET r0 0') && r.includes('ADD r0 1'));

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
    r => r.includes('fn_double:') && r.includes('MUL r0 2') && r.includes('SET r0 5'));

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

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══`);
}

runTests();
