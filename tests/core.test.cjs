const test = require('node:test');
const assert = require('node:assert/strict');
const { compileRules, findSegments, contrastText, validateSettings, migrateSettings } = require('../linuxdo-keyword-highlighter.user.js');

const rule = (id, text, extra = {}) => ({ id, name: '', keywords: [text], color: '#18f0ff', enabled: true, scopes: ['list', 'topic', 'body'], ...extra });
const settings = rules => ({ version: 2, rules, ui: { mode: 'right', position: { x: 0.94, y: 0.72 } } });
const segments = (text, rules, scope = 'body') => findSegments(text, compileRules(rules, scope));

test('shorter keywords cover only the overlapping part of longer keywords', () => {
  assert.deepEqual(segments('OpenAI API', [rule('phrase', 'OpenAI API'), rule('name', 'OpenAI'), rule('ai', 'AI')]), [
    { start: 0, end: 4, ruleId: 'name' },
    { start: 4, end: 6, ruleId: 'ai' },
    { start: 6, end: 10, ruleId: 'phrase' },
  ]);
});

test('same-length overlaps use the earlier rule and retain uncovered tails', () => {
  assert.deepEqual(segments('abcde', [rule('first', 'abc'), rule('second', 'cde')]), [
    { start: 0, end: 3, ruleId: 'first' }, { start: 3, end: 5, ruleId: 'second' },
  ]);
});

test('all occurrences, including self-overlap, remain highlighted', () => {
  assert.deepEqual(segments('banana ana', [rule('ana', 'ana')]), [
    { start: 1, end: 6, ruleId: 'ana' }, { start: 7, end: 10, ruleId: 'ana' },
  ]);
});

test('literal metacharacters, case differences, and significant spaces are preserved', () => {
  const literal = 'C++ [AI].* (v2) $5 \\path';
  assert.deepEqual(segments(literal, [rule('literal', literal)]), [{ start: 0, end: literal.length, ruleId: 'literal' }]);
  assert.deepEqual(segments('claude CLAUDE ClaudeCode', [rule('claude', 'Claude')]), [
    { start: 0, end: 6, ruleId: 'claude' }, { start: 7, end: 13, ruleId: 'claude' }, { start: 14, end: 20, ruleId: 'claude' },
  ]);
  assert.deepEqual(segments('x = y', [rule('spaces', ' = ')]), [{ start: 1, end: 4, ruleId: 'spaces' }]);
});

test('unicode case matching does not shift original DOM offsets', () => {
  assert.deepEqual(segments('İ A 🧠AI', [rule('a', 'A'), rule('brain', '🧠'), rule('ai', 'AI')]), [
    { start: 2, end: 3, ruleId: 'a' }, { start: 4, end: 6, ruleId: 'brain' },
    { start: 6, end: 7, ruleId: 'a' }, { start: 7, end: 8, ruleId: 'ai' },
  ]);
});

test('scope, pause, empty drafts, and same text with independent scope are respected', () => {
  const rules = [rule('list-ai', 'AI', { scopes: ['list'] }), rule('body-ai', 'AI', { scopes: ['body'] }),
    rule('paused', 'A', { enabled: false }), rule('empty', '')];
  assert.deepEqual(segments('AI', rules, 'list'), [{ start: 0, end: 2, ruleId: 'list-ai' }]);
  assert.deepEqual(segments('AI', rules, 'body'), [{ start: 0, end: 2, ruleId: 'body-ai' }]);
  assert.deepEqual(segments('AI', rules, 'topic'), []);
});

test('every short binary text and keyword combination agrees with an independent coverage oracle', () => {
  const dictionary = ['a', 'b', 'ab', 'ba'];
  const texts = [''];
  for (let length = 1; length <= 5; length++) {
    for (let value = 0; value < 2 ** length; value++) texts.push(value.toString(2).padStart(length, '0').replaceAll('0', 'a').replaceAll('1', 'b'));
  }
  for (const text of texts) {
    for (let subset = 0; subset < 2 ** dictionary.length; subset++) {
      const rules = dictionary.filter((_, index) => subset & (1 << index)).map((word, index) => rule(`r-${index}`, word));
      const actual = Array(text.length).fill(null);
      for (const segment of segments(text, rules)) {
        for (let index = segment.start; index < segment.end; index++) {
          assert.equal(actual[index], null, 'output ranges must not overlap');
          actual[index] = segment.ruleId;
        }
      }
      const expected = Array.from({ length: text.length }, (_, position) => {
        const covering = rules.filter(item => {
          for (let start = 0; start <= position; start++) {
            const word = item.keywords[0];
            if (start + word.length > position && text.slice(start, start + word.length) === word) return true;
          }
          return false;
        });
        covering.sort((a, b) => a.keywords[0].length - b.keywords[0].length);
        return covering[0]?.id || null;
      });
      assert.deepEqual(actual, expected, JSON.stringify({ text, rules }));
    }
  }
});

test('matching leaves source rules immutable and can be repeated', () => {
  const rules = [Object.freeze(rule('ai', 'AI'))];
  const compiled = compileRules(rules, 'body');
  const first = findSegments('AI ai', compiled);
  assert.deepEqual(findSegments('AI ai', compiled), first);
  assert.equal(compiled[0].pattern.lastIndex, 0);
  assert.deepEqual(rules[0].keywords, ['AI']);
});

test('invalid stored values fail explicitly rather than becoming default settings', () => {
  const valid = settings([rule('ai', 'AI')]);
  assert.equal(validateSettings(valid), valid);
  assert.throws(() => validateSettings(null), /设置格式错误/);
  assert.throws(() => validateSettings({ version: 2, rules: 'broken' }), /rules/);
});

test('stored settings reject CSS injection, duplicate ids, invalid scopes and non-finite positions', () => {
  for (const invalid of [
    { ...settings([]), version: 99 },
    settings([rule('bad);body{', 'AI')]),
    settings([rule('ai', 'AI', { color: '#ffff00;display:none' })]),
    settings([rule('ai', 'AI'), rule('ai', 'API')]),
    settings([rule('ai', 'AI', { scopes: ['navigation'] })]),
    settings([rule('ai', 'AI', { keywords: ['AI', 3] })]),
    settings([rule('ai', 'AI', { name: null })]),
    { ...settings([]), ui: { mode: 'floating', position: { x: NaN, y: 0.5 } } },
  ]) assert.throws(() => validateSettings(invalid), /设置格式错误/);
});

test('black or white text always has readable contrast on custom background colors', () => {
  assert.equal(contrastText('#edff00'), '#000000');
  assert.equal(contrastText('#001122'), '#ffffff');
  for (let value = 0; value <= 255; value++) {
    const hex = `#${value.toString(16).padStart(2, '0').repeat(3)}`;
    const channel = value / 255;
    const luminance = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    const contrast = contrastText(hex) === '#000000' ? (luminance + 0.05) / 0.05 : 1.05 / (luminance + 0.05);
    assert.ok(contrast >= 4.5, hex);
  }
});

test('one group applies the same id, enabled state and scopes to all of its keywords', () => {
  const group = rule('claude', '', { name: 'Claude', keywords: ['Claude Opus', 'Anthropic'], scopes: ['body'] });
  assert.deepEqual(segments('claude opus / Anthropic', [group]), [
    { start: 0, end: 11, ruleId: 'claude' }, { start: 14, end: 23, ruleId: 'claude' },
  ]);
  assert.deepEqual(segments('Claude Opus', [group], 'list'), []);
  assert.deepEqual(segments('Anthropic', [{ ...group, enabled: false }]), []);
});

test('overlapping keywords within a group retain separate active intervals', () => {
  const group = rule('group', '', { keywords: ['abcde', 'bc'] });
  assert.deepEqual(segments('abcde', [group, rule('other', 'cde')]), [
    { start: 0, end: 3, ruleId: 'group' }, { start: 3, end: 5, ruleId: 'other' },
  ]);
  assert.deepEqual(segments('aba', [rule('same', '', { keywords: ['aba', 'a', 'a', ''] })]), [
    { start: 0, end: 3, ruleId: 'same' },
  ]);
});

test('v1 migration preserves every keyword, color, scope, id and entry position without mutating input', () => {
  const legacy = {
    version: 1,
    rules: [{ id: 'old', text: 'Claude Opus\nC++', color: '#ff5cc9', enabled: false, scopes: ['topic'] }],
    ui: { mode: 'floating', position: { x: 0.32, y: 0.65 } },
  };
  const before = structuredClone(legacy);
  const next = migrateSettings(legacy);
  assert.deepEqual(next, { ...legacy, version: 2, rules: [rule('old', 'Claude Opus\nC++', { color: '#ff5cc9', enabled: false, scopes: ['topic'] })] });
  assert.deepEqual(legacy, before);
  assert.equal(migrateSettings(next), next);
});

test('migration does not conceal invalid legacy data', () => {
  assert.throws(() => migrateSettings({ version: 1, rules: 'broken' }), /rules/);
  const old = { version: 1, rules: [{ id: 'bad', text: 4, color: '#edff00', enabled: true, scopes: ['body'] }], ui: settings([]).ui };
  assert.throws(() => migrateSettings(old), /keywords/);
  assert.throws(() => migrateSettings(null), /version/);
});
