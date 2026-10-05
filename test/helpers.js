// Shared harness for feature test files: an in-memory server plus HTTP and MCP callers.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

// opts go to createApp (e.g. {directorKey}).
export async function startServer(opts = {}) {
  const app = createApp({ dbPath: ':memory:', ...opts });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  // agent: the X-Agent name. role: "director" sends X-Role like the board UI does; directorKey sends X-Director-Key.
  async function call(method, urlPath, body, agent = 'tester', { role, directorKey } = {}) {
    const headers = { 'content-type': 'application/json', 'x-agent': agent };
    if (role) headers['x-role'] = role;
    if (directorKey) headers['x-director-key'] = directorKey;
    const res = await fetch(base + urlPath, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text && json ? JSON.parse(text) : text || null };
  }
  const director = (method, urlPath, body) => call(method, urlPath, body, 'human', { role: 'director', directorKey: opts.directorKey });

  // Calls an MCP tool; returns the parsed JSON result, or {error} for tool errors.
  async function rpc(name, args, agent = 'mcp-agent') {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': agent },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const { result } = await res.json();
    const text = result.content[0].text;
    return result.isError ? { error: text } : JSON.parse(text);
  }

  async function mcp(method, params = {}) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent': 'mcp-agent' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()).result;
  }

  return { app, base, call, director, rpc, mcp, close: () => app.close() };
}

// A throwaway git repo. commit({path: content}, message) writes files and commits them, returning the SHA.
export function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-repo-'));
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (files, message = 'change') => {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      if (content === null) {
        fs.rmSync(full);
        continue;
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
