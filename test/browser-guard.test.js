import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers.js';

// A web page in the Director's browser must not be able to drive the board: no CORS, no foreign
// Origins, and no foreign Host names (DNS rebinding) unless an API key guards the board.
let open;
let keyed;
before(async () => {
  open = await startServer();
  keyed = await startServer({ apiKey: 'k' });
});
after(() => Promise.all([open.close(), keyed.close()]));

// node:http, since fetch won't send a custom Host.
function raw(server, method, path, headers = {}, body) {
  const { port } = new URL(server.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('the API sends no CORS headers, and a cross-origin preflight is refused', async () => {
  const res = await raw(open, 'GET', '/api/projects');
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  const preflight = await raw(open, 'OPTIONS', '/api/projects', { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
});

test('a request from another Origin is refused before it does anything; the board itself and agents get through', async () => {
  const { port } = new URL(open.base);
  const evil = await raw(open, 'POST', '/api/projects', { origin: 'https://evil.example' }, { key: 'EV', name: 'Evil' });
  assert.equal(evil.status, 403);
  assert.match(evil.body.error, /Cross-origin requests are refused/);
  assert.equal((await raw(open, 'POST', '/mcp', { origin: 'null' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 403, 'sandboxed pages too');
  assert.ok(!(await open.call('GET', '/api/projects')).body.some((p) => p.key === 'EV'));

  const board = await raw(open, 'POST', '/api/projects', { origin: `http://127.0.0.1:${port}` }, { key: 'OK', name: 'Same origin' });
  assert.equal(board.status, 201);
  assert.equal((await raw(open, 'GET', '/api/projects')).status, 200, 'no Origin: an agent or MCP client');
});

test('without an API key only loopback Host names are served (DNS rebinding); with one, any host', async () => {
  for (const host of ['localhost:8080', '127.0.0.1', '[::1]:8080']) {
    assert.equal((await raw(open, 'GET', '/api/projects', { host })).status, 200, host);
  }
  const rebound = await raw(open, 'GET', '/api/projects', { host: 'evil.example' });
  assert.equal(rebound.status, 403);
  assert.match(rebound.body.error, /no API key, so it only answers on localhost.*evil\.example/);
  assert.equal((await raw(open, 'GET', '/api/projects', { host: '192.168.1.20:8080' })).status, 403);

  assert.equal((await raw(keyed, 'GET', '/api/projects', { host: '192.168.1.20:8080', authorization: 'Bearer k' })).status, 200);
  assert.equal((await raw(keyed, 'GET', '/api/projects', { host: '192.168.1.20:8080' })).status, 401, 'the key is still required');
});

test('behind a proxy, an Origin matching X-Forwarded-Host is the board itself', async () => {
  const res = await raw(keyed, 'GET', '/api/projects', {
    host: '127.0.0.1:8080',
    'x-forwarded-host': 'kanban.example.com',
    origin: 'https://kanban.example.com',
    authorization: 'Bearer k',
  });
  assert.equal(res.status, 200);
});
