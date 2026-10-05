import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let s;
before(async () => {
  s = await startServer();
  await s.director('POST', '/api/projects', { key: 'CL', name: 'Capture label' });
});
after(() => s.close());

const project = async () => (await s.call('GET', '/api/projects')).body.find((p) => p.key === 'CL');

test('capture_label defaults to "capture", takes one label, and null resets it', async () => {
  assert.equal((await project()).capture_label, 'capture');
  assert.equal((await s.director('PATCH', '/api/projects/CL', { capture_label: 'playtest' })).status, 200);
  assert.equal((await project()).capture_label, 'playtest');
  const two = await s.director('PATCH', '/api/projects/CL', { capture_label: 'a, b' });
  assert.equal(two.status, 400);
  assert.match(two.body.error, /capture_label must be one label/);
  await s.director('PATCH', '/api/projects/CL', { capture_label: null });
  assert.equal((await project()).capture_label, 'capture');
  assert.equal((await s.call('PATCH', '/api/projects/CL', { capture_label: 'mine' })).status, 403, 'a Director setting');
});
