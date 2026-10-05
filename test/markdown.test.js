import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdown, inline, esc } from '../public/markdown.js';

const md = (src) => markdown(src);

test('_underscore_ renders in italics, like *asterisk*', () => {
  // The line every AS task description opens with.
  assert.equal(md('_Size: 1 session · Your time: 30 min_'), '<p><em>Size: 1 session · Your time: 30 min</em></p>');
  assert.equal(md('Read this _now_, please.'), '<p>Read this <em>now</em>, please.</p>');
  assert.equal(md('(_quietly_)'), '<p>(<em>quietly</em>)</p>');
  assert.equal(md('_a_'), '<p><em>a</em></p>');
  assert.equal(md('*star* and _under_'), '<p><em>star</em> and <em>under</em></p>');
  assert.equal(md('- _item_'), '<ul><li><em>item</em></li></ul>');
  // An identifier inside an italic span stays whole.
  assert.equal(md('_see claim_next_task first_'), '<p><em>see claim_next_task first</em></p>');
});

test('snake_case, identifiers, paths and code are unchanged', () => {
  for (const src of [
    'snake_case',
    'call claim_next_task with the key',
    'the __init__ method',
    'see src/_private_/file_name.py',
    'a_b_c and d_e',
    '_leading and trailing_x',
    'MAX_ATTACHMENT_BYTES',
  ]) {
    assert.equal(md(src), `<p>${esc(src)}</p>`, src);
  }
  assert.equal(md('`_not italic_` here'), '<p><code>_not italic_</code> here</p>');
  assert.equal(inline('`claim_next_task`'), '<code>claim_next_task</code>');
  assert.equal(md('```\n_raw_\n```'), '<pre><code>_raw_</code></pre>');
  // Links and task keys still work around underscores.
  assert.match(md('https://example.com/a_b_c'), /<a href="https:\/\/example.com\/a_b_c"/);
  assert.match(md('_see AS-1_'), /<em>see <a class="task-link" href="#\/AS-1">AS-1<\/a><\/em>/);
});
