import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
// Append new migrations; never edit ones that have shipped.
export const MIGRATIONS = [
  `
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    next_number INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number       INTEGER NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'backlog',
    priority     TEXT NOT NULL DEFAULT 'medium',
    type         TEXT NOT NULL DEFAULT 'task',
    assignee     TEXT,
    labels       TEXT NOT NULL DEFAULT '[]',
    parent_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    position     INTEGER NOT NULL DEFAULT 0,
    created_by   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    started_at   TEXT,
    completed_at TEXT,
    UNIQUE (project_id, number)
  );
  CREATE INDEX tasks_board ON tasks (project_id, status, position);
  CREATE INDEX tasks_assignee ON tasks (assignee);
  CREATE INDEX tasks_parent ON tasks (parent_id);

  CREATE TABLE task_dependencies (
    task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on_id)
  );
  CREATE INDEX task_dependencies_rev ON task_dependencies (depends_on_id);

  CREATE TABLE comments (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX comments_task ON comments (task_id);

  CREATE TABLE activity (
    id         INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id    INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    task_key   TEXT,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX activity_project ON activity (project_id, id);
  CREATE INDEX activity_task ON activity (task_id, id);
  `,
  `
  CREATE TABLE milestones (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    due_date    TEXT,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX milestones_name ON milestones (project_id, name COLLATE NOCASE);

  ALTER TABLE tasks ADD COLUMN milestone_id INTEGER REFERENCES milestones(id) ON DELETE SET NULL;
  CREATE INDEX tasks_milestone ON tasks (milestone_id);
  `,
  `
  CREATE TABLE sprints (
    id           INTEGER PRIMARY KEY,
    project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    goal         TEXT NOT NULL DEFAULT '',
    start_date   TEXT,
    end_date     TEXT,
    status       TEXT NOT NULL DEFAULT 'planned',
    position     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE UNIQUE INDEX sprints_name ON sprints (project_id, name COLLATE NOCASE);

  ALTER TABLE tasks ADD COLUMN epic_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN estimate INTEGER;
  CREATE INDEX tasks_epic ON tasks (epic_id);
  CREATE INDEX tasks_sprint ON tasks (sprint_id);
  `,
  `
  ALTER TABLE projects ADD COLUMN agent_brief TEXT NOT NULL DEFAULT '';

  ALTER TABLE tasks ADD COLUMN criteria TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN context TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN handoff TEXT;
  ALTER TABLE tasks ADD COLUMN rework INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE attachments (
    id         INTEGER PRIMARY KEY,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    data       BLOB NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_task ON attachments (task_id);
  `,
  `
  CREATE TABLE decisions (
    id             INTEGER PRIMARY KEY,
    project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    decision       TEXT NOT NULL,
    rationale      TEXT NOT NULL DEFAULT '',
    tags           TEXT NOT NULL DEFAULT '[]',
    source_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    created_by     TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    UNIQUE (project_id, number)
  );

  CREATE TABLE questions (
    id             INTEGER PRIMARY KEY,
    task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    question       TEXT NOT NULL,
    options        TEXT NOT NULL DEFAULT '[]',
    recommendation TEXT,
    blocking       INTEGER NOT NULL DEFAULT 1,
    asked_by       TEXT NOT NULL,
    asked_at       TEXT NOT NULL,
    answer         TEXT,
    answered_by    TEXT,
    answered_at    TEXT,
    decision_id    INTEGER REFERENCES decisions(id) ON DELETE SET NULL
  );
  CREATE INDEX questions_task ON questions (task_id);
  `,
  `
  ALTER TABLE tasks ADD COLUMN prerequisites TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
  `,
  `
  ALTER TABLE tasks ADD COLUMN scope TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE tasks ADD COLUMN context_baseline TEXT NOT NULL DEFAULT '{}';
  `,
  `
  ALTER TABLE tasks ADD COLUMN external_id TEXT;
  CREATE UNIQUE INDEX tasks_external_id ON tasks (project_id, external_id) WHERE external_id IS NOT NULL;
  `,
  `
  ALTER TABLE tasks ADD COLUMN checkpoint TEXT;
  `,
  `
  ALTER TABLE tasks ADD COLUMN no_review INTEGER NOT NULL DEFAULT 0;
  `,
  // Agents now close their own tasks unless the Director asks to review one, so the flag flips.
  `
  ALTER TABLE tasks RENAME COLUMN no_review TO needs_review;
  UPDATE tasks SET needs_review = 0;
  `,
];

export function openDb(file) {
  const inMemory = file === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (!inMemory) db.exec('PRAGMA journal_mode = WAL;');

  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
