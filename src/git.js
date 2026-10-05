// Read-only access to a project's git repository. Only query subcommands are allowed, each
// runs without a shell under a timeout, and git is told not to take optional locks, so
// reading never changes the repo (not even its index).
//
// Queries are asynchronous, so a slow repo never stalls other requests, and each reader
// remembers its answers: make one reader per request and a repeated query runs git once.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const READ_ONLY = new Set(['rev-parse', 'log', 'diff', 'merge-base', 'show']);
// Options that would make a query write a file or run an external program.
const UNSAFE_ARG = /^--(output|ext-diff|textconv|exec|upload-pack|open-files-in-pager)/;
export const GIT_TIMEOUT_MS = 5000;
const SEP = '\u001f';

export class GitError extends Error {}

export class GitReader {
  // The git executable. Tests point it at a wrapper (e.g. one that sleeps).
  static binary = 'git';

  constructor(repoPath, { timeout = GIT_TIMEOUT_MS } = {}) {
    this.path = repoPath;
    this.timeout = timeout;
    this.memo = new Map();
  }

  async run(subcommand, ...args) {
    if (!READ_ONLY.has(subcommand)) throw new GitError(`git ${subcommand} is not allowed (read-only reader)`);
    if (subcommand === 'diff' && !args.includes('--name-only')) throw new GitError('git diff is only allowed with --name-only');
    const bad = args.find((a) => UNSAFE_ARG.test(a));
    if (bad) throw new GitError(`git option ${bad} is not allowed`);
    const key = [subcommand, ...args].join('\0');
    if (!this.memo.has(key)) this.memo.set(key, this.exec(subcommand, args));
    return this.memo.get(key);
  }

  exec(subcommand, args) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        GitReader.binary,
        [
          '-C',
          this.path,
          // The repo may belong to another user (a bind mount in Docker). Trust this one path only, and turn off
          // config that could make a read run a program (fsmonitor hooks, signature checks via gpg.program).
          '-c',
          `safe.directory=${this.path}`,
          '-c',
          'core.fsmonitor=false',
          '-c',
          'log.showSignature=false',
          '--no-optional-locks',
          subcommand,
          ...args,
        ],
        {
          encoding: 'utf8',
          timeout: this.timeout,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
        },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout.trimEnd());
          const why = err.killed || err.signal === 'SIGTERM' ? `timed out after ${this.timeout} ms` : String(stderr || err.message).trim();
          reject(new GitError(`git ${subcommand} failed: ${why}`));
        },
      );
      child.stdin?.end();
    });
  }

  // Like run, but a failure (unknown ref, missing path) is just null.
  async tryRun(subcommand, ...args) {
    try {
      return await this.run(subcommand, ...args);
    } catch (err) {
      if (err.message.includes('not allowed')) throw err;
      return null;
    }
  }

  // Throws a readable error unless the path is the top of a git work tree (or a bare repo).
  async validate() {
    if (!path.isAbsolute(this.path)) throw new GitError('repo_path must be an absolute path');
    if (!fs.existsSync(this.path) || !fs.statSync(this.path).isDirectory()) {
      // In Docker the server only sees the KANBAN_REPOS mount; a path outside it "doesn't exist" from here.
      const root = process.env.KANBAN_REPOS?.trim().replace(/\/+$/, '');
      if (root && this.path !== root && !this.path.startsWith(`${root}/`)) {
        throw new GitError(
          `repo_path ${this.path} isn't visible to the board server (it runs in a container that sees ${root}). ` +
            'Move the repo under it, or point KANBAN_REPOS at a folder that contains it.',
        );
      }
      throw new GitError(`repo_path does not exist: ${this.path}`);
    }
    const top = await this.tryRun('rev-parse', '--show-toplevel');
    if (top === null) throw new GitError(`repo_path is not a git repository: ${this.path}`);
    return top;
  }

  async resolve(ref) {
    if (!ref || String(ref).startsWith('-')) return null;
    return (await this.tryRun('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)) || null;
  }

  async hasBranch(name) {
    if (!name || String(name).startsWith('-')) return false;
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`, `refs/remotes/${name}`]) {
      if ((await this.tryRun('rev-parse', '--verify', '--quiet', ref)) !== null) return true;
    }
    return false;
  }

  // The branch work merges into: the given one if it exists, else main, master, then HEAD.
  async baseRef(preferred) {
    for (const ref of [preferred, 'main', 'master', 'origin/main', 'origin/master'].filter(Boolean)) {
      if (await this.resolve(ref)) return ref;
    }
    return 'HEAD';
  }

  mergeBase(a, b) {
    return this.tryRun('merge-base', a, b);
  }

  async changedFiles(from, to) {
    const out = await this.tryRun('diff', '--name-only', '--no-renames', `${from}..${to}`);
    return out === null ? null : out.split('\n').filter(Boolean);
  }

  async head(rev = 'HEAD') {
    const out = await this.tryRun('log', '-1', `--format=%H${SEP}%s${SEP}%aI`, rev);
    if (!out) return null;
    const [sha, subject, date] = out.split(SEP);
    return { sha, subject, date };
  }

  // The last commit (on rev) that touched path, or null when git doesn't know the path.
  async lastCommit(file, rev = 'HEAD') {
    return (await this.tryRun('log', '-1', '--format=%H', rev, '--', file)) || null;
  }

  // Commits on rev that touched path after `since` (a SHA), newest first.
  async commitsSince(since, file, rev = 'HEAD') {
    const out = await this.tryRun('log', `--format=%H${SEP}%s${SEP}%aI`, `${since}..${rev}`, '--', file);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [sha, subject, date] = line.split(SEP);
      return { sha, subject, date };
    });
  }

  // Commits on rev that touched path after an ISO date, newest first.
  async commitsAfter(date, file, rev = 'HEAD') {
    const out = await this.tryRun('log', `--since=${date}`, `--format=%H${SEP}%s${SEP}%aI`, rev, '--', file);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [sha, subject, d] = line.split(SEP);
      return { sha, subject, date: d };
    });
  }

  // Whether a file or folder exists at rev.
  async exists(rev, file) {
    const p = String(file).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p || p.startsWith('-')) return false;
    return (await this.tryRun('rev-parse', '--verify', '--quiet', `${rev}:${p}`)) !== null;
  }

  showFile(rev, file) {
    if (String(file).startsWith('-')) return null;
    return this.tryRun('show', `${rev}:${file.replace(/^\.\//, '')}`);
  }
}
