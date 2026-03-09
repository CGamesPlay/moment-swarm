// ═══════════════════════════════════════════════════════════════
// Metadata Tests — tag/alias collection
// ═══════════════════════════════════════════════════════════════

import { runSuite, test, assert, assertEq, collectMeta } from './test-helpers';

runSuite('Metadata', () => {
  test('alias directive produces AliasDef and is removed from forms', () => {
    const meta = collectMeta('(alias counter r5) (move random)');
    assertEq(meta.aliases.length, 1);
    assertEq(meta.aliases[0].name, 'counter');
    assertEq(meta.aliases[0].reg, 'r5');
    // alias should be removed; only (move random) remains
    assertEq(meta.forms.length, 1);
    assert(meta.forms[0].type === 'list');
  });

  test('set-tag produces TagDef with correct ID', () => {
    const meta = collectMeta('(set-tag homing) (move random)');
    assertEq(meta.tags.length, 1);
    assertEq(meta.tags[0].name, 'homing');
    assertEq(meta.tags[0].id, 0);
  });

  test('multiple aliases and tags', () => {
    const meta = collectMeta(`
      (alias dx r5)
      (alias dy r6)
      (set-tag exploring)
      (set-tag homing)
      (move random)
    `);
    assertEq(meta.aliases.length, 2);
    assertEq(meta.aliases[0].name, 'dx');
    assertEq(meta.aliases[1].name, 'dy');
    assertEq(meta.tags.length, 2);
    assertEq(meta.tags[0].name, 'exploring');
    assertEq(meta.tags[0].id, 0);
    assertEq(meta.tags[1].name, 'homing');
    assertEq(meta.tags[1].id, 1);
  });

  test('no directives: passthrough', () => {
    const meta = collectMeta('(move random) (pickup)');
    assertEq(meta.aliases.length, 0);
    assertEq(meta.tags.length, 0);
    assertEq(meta.forms.length, 2);
  });

  test('tag ID assignment order: first occurrence wins', () => {
    const meta = collectMeta(`
      (if (= 0 0) (set-tag alpha) (set-tag beta))
      (set-tag gamma)
    `);
    assertEq(meta.tags.length, 3);
    assertEq(meta.tags[0].name, 'alpha');
    assertEq(meta.tags[0].id, 0);
    assertEq(meta.tags[1].name, 'beta');
    assertEq(meta.tags[1].id, 1);
    assertEq(meta.tags[2].name, 'gamma');
    assertEq(meta.tags[2].id, 2);
  });

  test('duplicate set-tag: only one TagDef', () => {
    const meta = collectMeta('(set-tag foo) (set-tag foo)');
    assertEq(meta.tags.length, 1);
    assertEq(meta.tags[0].name, 'foo');
  });
});
