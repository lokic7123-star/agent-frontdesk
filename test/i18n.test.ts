// The English side of the i18n gates that does not depend on the page's own markup: the
// runtime-composed quota labels (server side joins group · window) and the engine texts
// against their dictionary and pattern entries.
import test from 'node:test';
import assert from 'node:assert/strict';

test('English text lookup: exact entries, composed quota labels, passthrough', async () => {
  const { english } = await import('../src/client/js/i18n.js');
  // The composed labels the Antigravity quota panel builds at runtime from group · window.
  assert.equal(english('Gemini 模型 · 每周限额'), 'Gemini models · Weekly limit');
  assert.equal(english('Gemini 模型 · 5 小时限额'), 'Gemini models · 5-hour limit');
  assert.equal(english('Claude 和 GPT 模型 · 5 小时限额'), 'Claude and GPT models · 5-hour limit');
  // A group the dictionary has never heard of passes its own name through unchanged.
  assert.equal(english('Gemini 4 Argon · 每周限额'), 'Gemini 4 Argon · Weekly limit');
  assert.equal(english('未知引擎 · 每周限额'), '未知引擎 · Weekly limit');
  // Known exact entries still win over the patterns.
  assert.equal(english('每周 · Opus'), 'Weekly · Opus');
  assert.equal(english('some engine text'), 'some engine text');
  assert.equal(english(''), '');
});
