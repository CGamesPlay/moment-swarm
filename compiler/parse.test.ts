// ═══════════════════════════════════════════════════════════════
// Parse Tests — tokenizer + parser
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, assertThrows, tokenize, parse, parseSource } from './test-helpers';

runSuite('Parse', () => {
  // ── Tokenizer ──

  test('tokenize: numbers', () => {
    const tokens = tokenize('42 -3 0');
    assertEq(tokens.length, 3);
    assertEq(tokens[0].value, 42);
    assertEq(tokens[1].value, -3);
    assertEq(tokens[2].value, 0);
  });

  test('tokenize: hex literals', () => {
    const tokens = tokenize('0xFF 0x10');
    assertEq(tokens[0].value, 255);
    assertEq(tokens[1].value, 16);
  });

  test('tokenize: symbols', () => {
    const tokens = tokenize('foo bar-baz set!');
    assertEq(tokens.length, 3);
    assertEq(tokens[0].value, 'foo');
    assertEq(tokens[1].value, 'bar-baz');
    assertEq(tokens[2].value, 'set!');
  });

  test('tokenize: strings', () => {
    const tokens = tokenize('"hello world"');
    assertEq(tokens.length, 1);
    assertEq(tokens[0].type, 'string');
    assertEq(tokens[0].value, 'hello world');
  });

  test('tokenize: nested parens', () => {
    const tokens = tokenize('(+ (- 1 2) 3)');
    assertEq(tokens.length, 9);
    assertEq(tokens[0].value, '(');
    assertEq(tokens[8].value, ')');
  });

  test('tokenize: comments are skipped', () => {
    const tokens = tokenize('; this is a comment\n(move n)');
    assertEq(tokens.length, 4); // ( move n )
    assertEq(tokens[1].value, 'move');
  });

  test('tokenize: line/col tracking', () => {
    const tokens = tokenize('a\nb');
    assertEq(tokens[0].line, 1);
    assertEq(tokens[0].col, 1);
    assertEq(tokens[1].line, 2);
    assertEq(tokens[1].col, 1);
  });

  // ── Parser ──

  test('parse: atom types', () => {
    const program = parseSource('42 foo "str"');
    assertEq(program.body.length, 3);
    assertEq(program.body[0].type, 'number');
    assertEq(program.body[1].type, 'symbol');
    assertEq(program.body[2].type, 'string');
  });

  test('parse: list nesting', () => {
    const program = parseSource('(+ 1 (- 2 3))');
    assertEq(program.body.length, 1);
    const outer = program.body[0];
    assert(outer.type === 'list');
    if (outer.type === 'list') {
      assertEq(outer.value.length, 3);
      assert(outer.value[2].type === 'list');
    }
  });

  test('parse: Program structure', () => {
    const program = parseSource('(move n) (move s)');
    assertEq(program.type, 'program');
    assertEq(program.body.length, 2);
  });

  test('parse: empty input', () => {
    const program = parseSource('');
    assertEq(program.body.length, 0);
  });

  test('parse: unclosed paren error', () => {
    assertThrows(() => parseSource('(+ 1 2'), 'Missing closing paren');
  });

  test('parse: unexpected close paren error', () => {
    assertThrows(() => parseSource(')'), 'Unexpected )');
  });
});
