import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Kanban, ApiError, MAX_ATTACHMENT_BYTES } from './service.js';
import { EventHub } from './events.js';
import { registerApi } from './api.js';
import { handleMcp } from './mcp.js';
import { buildOpenApi } from './openapi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const GUIDE_PATH = path.join(ROOT, 'docs', 'agent-guide.md');
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/guide', '/api/openapi.json']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};
// Friendly URLs for static pages.
const PAGES = { '/': 'index.html', '/capture': 'capture.html' };

class Router {
  constructor() {
    this.routes = [];
    for (const method of ['get', 'post', 'patch', 'delete']) {
      this[method] = (pattern, handler, options) => this.add(method.toUpperCase(), pattern, handler, options);
    }
  }

  // options.raw: pass the request body through as a Buffer (ctx.raw) instead of parsing JSON.
  add(method, pattern, handler, { raw = false } = {}) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler, raw });
  }

  match(method, pathname) {
    const allowed = [];
    for (const route of this.routes) {
      const m = route.re.exec(pathname);
      if (!m) continue;
      if (route.method !== method) {
        allowed.push(route.method);
        continue;
      }
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: route.handler, params, raw: route.raw };
    }
    return { allowed };
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, err) {
  if (res.headersSent) return res.end();
  if (err instanceof ApiError) return sendJson(res, err.status, { error: err.message, ...err.extra });
  console.error(err);
  sendJson(res, 500, { error: 'Internal server error' });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostname = (host) => String(host ?? '').replace(/:\d+$/, '').toLowerCase();

// Web pages on other sites must not drive the board from a visitor's browser: the API sends no CORS
// headers, a request whose Origin isn't this host is refused, and without an API key only loopback
// Host names are served, so a DNS-rebinding page (Host: evil.example) can't reach an open board.
// Agents and MCP clients send no Origin and are unaffected.
function checkCaller(req, apiKey) {
  const hosts = [req.headers.host, req.headers['x-forwarded-host']].filter(Boolean);
  const { origin } = req.headers;
  if (origin !== undefined) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* "null" or garbage: refused below */
    }
    if (!host || !hosts.includes(host)) throw new ApiError(403, `Cross-origin requests are refused (Origin ${origin})`);
  }
  if (!apiKey && !LOOPBACK.has(hostname(req.headers.host))) {
    throw new ApiError(
      403,
      `This board has no API key, so it only answers on localhost. Set API_KEY (KANBAN_API_KEY with Docker) to reach it as ${hostname(req.headers.host) || 'this host'}.`,
    );
  }
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = (await readBody(req, MAX_BODY_BYTES)).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON');
  }
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  return `${proto}://${req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost'}`;
}

function resolveActor(req, body, url) {
  const raw = req.headers['x-agent'] ?? body?.actor ?? url.searchParams.get('actor') ?? 'anonymous';
  return String(raw).trim().slice(0, 64) || 'anonymous';
}

const sameSecret = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// Only the human may tick Director-owned items, answer questions and tick prerequisites.
// With a Director key configured, the role takes that key (X-Director-Key, sent by the board UI);
// without one the board runs open and "X-Role: director" is enough. Agents (and every MCP call)
// act as "agent".
function resolveRole(req, directorKey) {
  if (directorKey) {
    const sent = req.headers['x-director-key'];
    return typeof sent === 'string' && sent && sameSecret(sent, directorKey) ? 'director' : 'agent';
  }
  return String(req.headers['x-role'] ?? '').trim().toLowerCase() === 'director' ? 'director' : 'agent';
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'Method not allowed');
  const rel = PAGES[pathname] ?? decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new ApiError(404, 'Not found');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

export function createApp({ dbPath = ':memory:', apiKey = '', directorKey = '' } = {}) {
  const db = openDb(dbPath);
  const hub = new EventHub();
  const kanban = new Kanban(db, { onChange: (event) => hub.publish(event) });
  const guideTemplate = fs.readFileSync(GUIDE_PATH, 'utf8');
  const guide = (base) => guideTemplate.replaceAll('{{BASE_URL}}', base);
  const router = new Router();
  registerApi(router, kanban, { guide, openapi: buildOpenApi, directorLocked: Boolean(directorKey) });

  const authorized = (req, url) => {
    if (!apiKey) return true;
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    return [bearer, req.headers['x-api-key'], url.searchParams.get('api_key')].includes(apiKey);
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const isApi = pathname.startsWith('/api/') || pathname === '/mcp';

    if (isApi) checkCaller(req, apiKey);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (pathname === '/llms.txt') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(guide(baseUrl(req)));
    }
    if (!isApi) return serveStatic(req, res, pathname);

    if (!PUBLIC_API_PATHS.has(pathname) && !authorized(req, url)) {
      throw new ApiError(401, 'Missing or invalid API key (send "Authorization: Bearer <key>")');
    }

    if (pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        return res.end();
      }
      const body = await readJson(req);
      const [status, payload] = await handleMcp(body, kanban, resolveActor(req, null, url));
      if (payload === null) {
        res.writeHead(status);
        return res.end();
      }
      return sendJson(res, status, payload);
    }

    if (pathname === '/api/events') return hub.subscribe(req, res, url.searchParams.get('project'));

    const match = router.match(req.method, pathname);
    if (!match.handler) {
      if (match.allowed.length) throw new ApiError(405, `Method not allowed. Use: ${match.allowed.join(', ')}`);
      throw new ApiError(404, `No route for ${req.method} ${pathname}. See ${baseUrl(req)}/api/guide`);
    }
    const raw = match.raw ? await readBody(req, MAX_ATTACHMENT_BYTES) : undefined;
    const body = !match.raw && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {};
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'Request body must be a JSON object');
    }
    const ctx = {
      params: match.params,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
      raw,
      actor: resolveActor(req, body, url),
      role: resolveRole(req, directorKey),
      baseUrl: baseUrl(req),
      status: 200,
      type: null,
      responseHeaders: {},
    };
    const result = await match.handler(ctx);
    if (ctx.type) {
      res.writeHead(ctx.status, { 'content-type': ctx.type, ...ctx.responseHeaders });
      return res.end(result);
    }
    return sendJson(res, ctx.status, result);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });

  return {
    server,
    kanban,
    close: () =>
      new Promise((resolve) => {
        hub.closeAll();
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
