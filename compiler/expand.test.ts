// ═══════════════════════════════════════════════════════════════
// Expand Tests — macro expansion + const evaluation
// ═══════════════════════════════════════════════════════════════

import * as path from 'path';
import { runSuite, test, assert, assertEq, assertThrows, expandSource, tryEvalConst, parseSource } from './test-helpers';
import type { ASTNode } from './parse';

const FIXTURES = path.resolve(__dirname, 'test-fixtures');
// A fake sourceFile in the fixtures directory, for resolving relative include paths
const FIXTURE_SOURCE = path.join(FIXTURES, 'test.alisp');

function astHead(node: ASTNode): string {
  if (node.type === 'list' && node.value.length > 0 && node.value[0].type === 'symbol') {
    return node.value[0].value;
  }
  return '';
}

function findAll(node: ASTNode, pred: (n: ASTNode) => boolean): ASTNode[] {
  const result: ASTNode[] = [];
  if (pred(node)) result.push(node);
  if (node.type === 'list') {
    for (const child of node.value) {
      result.push(...findAll(child, pred));
    }
  }
  return result;
}

runSuite('Expand', () => {
  // ── Macro expansion ──

  test('simple macro no params', () => {
    const { forms } = expandSource(`
      (defmacro wander () (move (+ (random 4) 1)))
      (wander)
    `);
    assertEq(forms.length, 1);
    // Expanded form should be (move (+ (random 4) 1))
    assertEq(astHead(forms[0]), 'move');
  });

  test('macro with one param', () => {
    const { forms } = expandSource(`
      (defmacro step (dir) (move dir))
      (step n)
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'move');
    // The parameter 'dir' should be substituted with 'n'
    assert(forms[0].type === 'list');
    if (forms[0].type === 'list') {
      const arg = forms[0].value[1];
      assert(arg.type === 'symbol');
      if (arg.type === 'symbol') assertEq(arg.value, 'n');  // directions resolved later in SSA lowering, not expand
    }
  });

  test('macro with multiple params', () => {
    const { forms } = expandSource(`
      (defmacro mark-trail (ch amt) (mark ch amt))
      (mark-trail ch_red 100)
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'mark');
  });

  test('macro with expression param', () => {
    const { forms } = expandSource(`
      (defmacro step (dir) (move dir))
      (step (+ (random 4) 1))
    `);
    assertEq(forms.length, 1);
    assert(forms[0].type === 'list');
    if (forms[0].type === 'list') {
      // The second element should be a list (+ (random 4) 1)
      assert(forms[0].value[1].type === 'list');
    }
  });

  test('macro with multi-statement body', () => {
    const { forms } = expandSource(`
      (defmacro forage ()
        (let ((dir (sense food)))
          (when (!= dir 0) (move dir) (pickup))))
      (forage)
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'let');
  });

  test('macro called multiple times', () => {
    const { forms } = expandSource(`
      (defmacro wander () (move random))
      (wander) (wander) (wander)
    `);
    assertEq(forms.length, 3);
    for (const f of forms) assertEq(astHead(f), 'move');
  });

  test('nested macro calls', () => {
    const { forms } = expandSource(`
      (defmacro step (dir) (move dir))
      (defmacro wander () (step (+ (random 4) 1)))
      (wander)
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'move');
  });

  test('macro: const from definition site visible', () => {
    const { forms } = expandSource(`
      (const MY_VAL 42)
      (defmacro use-val () (move MY_VAL))
      (use-val)
    `);
    assertEq(forms.length, 1);
    assert(forms[0].type === 'list');
    if (forms[0].type === 'list') {
      const arg = forms[0].value[1];
      assert(arg.type === 'number');
      if (arg.type === 'number') assertEq(arg.value, 42);
    }
  });

  test('macro: code fragment param', () => {
    const { forms } = expandSource(`
      (defmacro do-then (action after)
        (action) after)
      (tagbody
        top
        (do-then (move n) (go top)))
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'tagbody');
  });

  test('macro: set! on substituted variable', () => {
    const { forms } = expandSource(`
      (defmacro zero-out (v) (set! v 0))
      (let ((x 5)) (zero-out x) (move x))
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'let');
    // Inside the let body, there should be a (set! x 0)
    if (forms[0].type === 'list') {
      const setForm = forms[0].value[2]; // first body form after bindings
      assert(setForm.type === 'list');
      if (setForm.type === 'list') {
        assertEq(setForm.value[0].type, 'symbol');
        if (setForm.value[0].type === 'symbol') assertEq(setForm.value[0].value, 'set!');
      }
    }
  });

  test('macro: wrong arg count error', () => {
    assertThrows(
      () => expandSource('(defmacro foo (a b) (move a)) (foo n)'),
      'expects 2 args'
    );
  });

  test('defmacro and const removed from forms', () => {
    const { forms } = expandSource(`
      (const X 5)
      (defmacro m () (move random))
      (move n)
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'move');
  });

  // ── Const evaluation ──

  test('tryEvalConst: arithmetic', () => {
    const consts = new Map<string, string>();
    const ast = parseSource('(+ 3 4)');
    assertEq(tryEvalConst(ast.body[0], consts), 7);
  });

  test('tryEvalConst: const referencing const', () => {
    const consts = new Map<string, string>([['A', '5']]);
    const ast = parseSource('(* A 2)');
    assertEq(tryEvalConst(ast.body[0], consts), 10);
  });

  test('tryEvalConst: bitwise lshift', () => {
    const consts = new Map<string, string>();
    const ast = parseSource('(lshift 1 8)');
    assertEq(tryEvalConst(ast.body[0], consts), 256);
  });

  test('tryEvalConst: variadic addition', () => {
    const consts = new Map<string, string>();
    const ast = parseSource('(+ 1 2 3)');
    assertEq(tryEvalConst(ast.body[0], consts), 6);
  });

  test('tryEvalConst: unary negation', () => {
    const consts = new Map<string, string>();
    const ast = parseSource('(- 5)');
    assertEq(tryEvalConst(ast.body[0], consts), -5);
  });

  test('tryEvalConst: nested expressions', () => {
    const consts = new Map<string, string>();
    const ast = parseSource('(+ (* 2 3) 1)');
    assertEq(tryEvalConst(ast.body[0], consts), 7);
  });

  test('tryEvalConst: error on non-const operand', () => {
    const consts = new Map<string, string>();
    const ast = parseSource('(+ 1 y)');
    assertEq(tryEvalConst(ast.body[0], consts), null);
  });

  test('const expr: subtraction', () => {
    const { constValues } = expandSource('(const C (- 10 3))');
    assertEq(constValues.get('C'), '7');
  });

  test('const expr: integer division truncates', () => {
    const { constValues } = expandSource('(const D (/ 10 3))');
    assertEq(constValues.get('D'), '3');
  });

  test('const expr: error on non-const value', () => {
    assertThrows(
      () => expandSource('(const X (+ 1 y))'),
      'not a compile-time constant'
    );
  });

  // ── Include ──

  test('include resolves macros from .inc.alisp file', () => {
    const { forms } = expandSource(
      '(include "macros.inc.alisp")\n(wander)',
      { sourceFile: FIXTURE_SOURCE }
    );
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'move');
  });

  test('include resolves consts from .inc.alisp file', () => {
    const { constValues } = expandSource(
      '(include "macros.inc.alisp")\n(move WANDER_SPEED)',
      { sourceFile: FIXTURE_SOURCE }
    );
    assertEq(constValues.get('WANDER_SPEED'), '3');
  });

  test('include rejects code forms with clear error', () => {
    assertThrows(
      () => expandSource(
        '(include "bad-code.inc.alisp")',
        { sourceFile: FIXTURE_SOURCE }
      ),
      'disallowed form "move"'
    );
  });

  test('include cycle detection errors', () => {
    assertThrows(
      () => expandSource(
        '(include "cycle-a.inc.alisp")',
        { sourceFile: FIXTURE_SOURCE }
      ),
      'Circular include'
    );
  });

  test('include missing file errors', () => {
    assertThrows(
      () => expandSource(
        '(include "nonexistent.inc.alisp")',
        { sourceFile: FIXTURE_SOURCE }
      ),
      'Cannot read include file'
    );
  });

  test('include without sourceFile errors', () => {
    assertThrows(
      () => expandSource('(include "macros.inc.alisp")'),
      'sourceFile'
    );
  });

  test('transitive includes work', () => {
    const { constValues } = expandSource(
      '(include "transitive.inc.alisp")\n(move DERIVED_VAL)',
      { sourceFile: FIXTURE_SOURCE }
    );
    assertEq(constValues.get('BASE_VAL'), '100');
    assertEq(constValues.get('DERIVED_VAL'), '150');
  });

  test('include macro referencing caller-defined const errors', () => {
    assertThrows(
      () => expandSource(
        '(include "nonhygienic.inc.alisp")\n(const CALLER_CONST 3)\n(use-caller-const)',
        { sourceFile: FIXTURE_SOURCE }
      ),
      'references const "CALLER_CONST"'
    );
  });

  test('main-program macro referencing caller const is allowed', () => {
    const { forms } = expandSource(`
      (const X 5)
      (defmacro use-x () (move X))
      (use-x)
    `);
    assertEq(forms.length, 1);
    assertEq(astHead(forms[0]), 'move');
  });

  // ── Go-label hygiene tests ──

  test('macro with (go label) referencing caller tagbody label errors', () => {
    assertThrows(
      () => expandSource(`
        (defmacro jump-out () (go outer-label))
        (tagbody
          outer-label
          (jump-out))
      `),
      'uses (go outer-label)'
    );
  });

  test('include macro with (go label) referencing caller tagbody label errors', () => {
    assertThrows(
      () => expandSource(
        `(include "go-nonhygienic.inc.alisp")
         (tagbody top (jump-to-top))`,
        { sourceFile: FIXTURE_SOURCE }
      ),
      'uses (go top)'
    );
  });

  test('macro with (go label) to own tagbody label is allowed', () => {
    const { forms } = expandSource(`
      (defmacro loop-forever ()
        (tagbody
          top
          (move n)
          (go top)))
      (loop-forever)
    `);
    assertEq(forms.length, 1);
  });

  test('macro with then-do parameter: caller passes (go label) as compound expression', () => {
    const { forms } = expandSource(`
      (defmacro do-thing (then-do)
        (move n)
        (then-do))
      (tagbody
        done
        (do-thing (go done)))
    `);
    assertEq(forms.length, 1);
  });
});
