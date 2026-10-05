import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, tempRepo } from './helpers.js';

// submit_for_review media entries "repo:<path>" are read from the project's checkout and stored as
// attachments, so an MCP-only agent can attach a screenshot or a log it wrote into the repo.
let s;
let repo;
let outside;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
before(async () => {
  s = await startServer();
  repo = tempRepo();
  const head = repo.commit({ 'README.md': 'x' }, 'base');
  fs.mkdirSync(path.join(repo.dir, 'artifacts'));
  fs.writeFileSync(path.join(repo.dir, 'artifacts', 'check.log'), 'Passed: 42\n');
  fs.writeFileSync(path.join(repo.dir, 'artifacts', 'shot.png'), PNG);
  fs.writeFileSync(path.join(repo.dir, 'artifacts', 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(repo.dir, 'artifacts', 'empty.txt'), '');
  outside = fs.mkdtempSync(path.join(path.dirname(repo.dir), 'kanban-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo.dir, 'artifacts', 'link.txt'));
  await s.director('POST', '/api/projects', { key: 'RM', repo_path: repo.dir });
  await s.director('POST', '/api/projects', { key: 'RN' });
  s.head = head;
});
after(() => {
  repo.remove();
  fs.rmSync(outside, { recursive: true, force: true });
  return s.close();
});

const claimed = async (project = 'RM') => {
  const key = (await s.director('POST', '/api/tasks', { project, title: 't', status: 'todo' })).body.key;
  await s.call('POST', `/api/tasks/${key}/claim`, {}, 'mcp-agent');
  return key;
};

test('repo:<path> media become attachments, and the handoff keeps their URLs in place', async () => {
  const key = await claimed();
  const sub = await s.rpc('submit_for_review', {
    task: key,
    summary: 'done',
    commit: s.head,
    media: ['https://example.com/clip', 'repo:artifacts/shot.png', 'repo:./artifacts/check.log'],
  });
  assert.equal(sub.status, 'review');
  const detail = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.deepEqual(detail.attachments.map((a) => [a.filename, a.mime]), [['shot.png', 'image/png'], ['check.log', 'text/plain']]);
  assert.deepEqual(detail.handoff.media, ['https://example.com/clip', ...detail.attachments.map((a) => a.url)]);
  const log = await fetch(`${s.base}${detail.attachments[1].url}`);
  assert.equal(await log.text(), 'Passed: 42\n');
  const image = await s.rpc('get_attachment', { id: detail.attachments[0].id });
  assert.equal(image.error, undefined);
});

test('paths that escape the repo are a 400 and nothing is saved', async () => {
  const key = await claimed();
  for (const [entry, why] of [
    ['repo:../secret.txt', /no "\.\."/],
    [`repo:${path.join(outside, 'secret.txt')}`, /no leading "\/"/],
    ['repo:artifacts/link.txt', /resolves outside the repo/],
    ['repo:artifacts/missing.png', /no such file/],
    ['repo:artifacts', /not a file/],
  ]) {
    const res = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', media: [entry] }, 'mcp-agent');
    assert.equal(res.status, 400, entry);
    assert.match(res.body.error, why, entry);
  }
  const detail = (await s.call('GET', `/api/tasks/${key}`)).body;
  assert.equal(detail.status, 'in_progress');
  assert.equal(detail.attachments.length, 0);
});

test("the upload endpoint's types and size limit apply", async () => {
  const key = await claimed();
  const html = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', media: ['repo:artifacts/page.html'] }, 'mcp-agent');
  assert.equal(html.status, 415);
  assert.match(html.body.error, /repo:artifacts\/page\.html: Unsupported attachment type/);
  const empty = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', media: ['repo:artifacts/empty.txt'] }, 'mcp-agent');
  assert.equal(empty.status, 400);
  const big = path.join(repo.dir, 'artifacts', 'big.log');
  fs.writeFileSync(big, Buffer.alloc(20 * 1024 * 1024 + 1, 97));
  const tooBig = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', media: ['repo:artifacts/big.log'] }, 'mcp-agent');
  assert.equal(tooBig.status, 413);
  fs.rmSync(big);
  // A failed submit (a commit the repo lacks) stores none of its files either.
  const bad = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', commit: 'deadbeef', media: ['repo:artifacts/check.log'] }, 'mcp-agent');
  assert.equal(bad.status, 409);
  assert.equal((await s.call('GET', `/api/tasks/${key}`)).body.attachments.length, 0);
});

test('projects without repo_path get a 400 explaining that repo: paths need one; other media are unchanged', async () => {
  const key = await claimed('RN');
  const res = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', media: ['repo:artifacts/check.log'] }, 'mcp-agent');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /repo: media needs the project's repo_path, and RN has none\. Upload with POST \/api\/tasks\/RN-\d+\/attachments instead\./);
  const plain = await s.call('POST', `/api/tasks/${key}/submit`, { summary: 'x', media: ['/api/attachments/1', 'shots/local.png'] }, 'mcp-agent');
  assert.deepEqual(plain.body.handoff.media, ['/api/attachments/1', 'shots/local.png']);
});
