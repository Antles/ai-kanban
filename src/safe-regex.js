// Runs user-supplied regular expressions (project reference patterns) in a worker thread under a
// time budget. A pattern that backtracks catastrophically ("((a+))+$") costs its caller at most the
// budget and never blocks the event loop: the worker is killed and replaced, and the caller learns
// which pattern timed out.
import { Worker } from 'node:worker_threads';

export const REGEX_BUDGET_MS = 250;
// Text longer than this is cut before matching; task text past it is not scanned for IDs.
export const MAX_HAYSTACK = 100_000;

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ patterns, haystack }) => {
  const out = [];
  for (let i = 0; i < patterns.length; i++) {
    parentPort.postMessage({ running: i });
    try {
      out.push([...new Set([...haystack.matchAll(new RegExp(patterns[i], 'g'))].map((m) => m[0]))]);
    } catch {
      out.push([]);
    }
  }
  parentPort.postMessage({ matches: out });
});
`;

let current = null; // {worker, ready}
// Jobs run one at a time, so a timeout only ever kills the job that caused it.
let queue = Promise.resolve();

function spawn() {
  const worker = new Worker(WORKER_SOURCE, { eval: true });
  worker.unref();
  const ready = new Promise((resolve) => worker.once('online', resolve));
  return { worker, ready };
}

async function run(patterns, haystack, budget) {
  current ??= spawn();
  const { worker, ready } = current;
  // Booting a worker takes tens of milliseconds; that isn't part of the pattern's budget.
  await ready;
  return new Promise((resolve) => {
    let running = 0;
    const finish = (result, { kill = false } = {}) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      if (kill) {
        if (current?.worker === worker) current = null;
        worker.terminate();
      }
      resolve(result);
    };
    const onMessage = (msg) => {
      if (msg.running !== undefined) running = msg.running;
      else finish({ matches: msg.matches });
    };
    const onError = () => finish({ timed_out: running }, { kill: true });
    const timer = setTimeout(() => finish({ timed_out: running }, { kill: true }), budget);
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage({ patterns, haystack });
  });
}

// Resolves to the distinct matches of each pattern in haystack: {matches: [[ids], ...]}, or
// {timed_out: index} when pattern `index` ran past the budget.
export function matchAllSafe(patterns, haystack, { budget = REGEX_BUDGET_MS } = {}) {
  if (!patterns.length) return Promise.resolve({ matches: [] });
  const job = queue.then(() => run(patterns, String(haystack).slice(0, MAX_HAYSTACK), budget));
  queue = job.catch(() => {});
  return job;
}
