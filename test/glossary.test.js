import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlossary, lintGlossary } from '../src/glossary.js';
import { startServer, tempRepo } from './helpers.js';

const CONTEXT = `# Game

**Hero**:
A collectible playable character.
_Avoid_: unit (clashes with "unit test" in code), character, champion

**Guarantee**:
A published promise.
_Avoid_: pity (in docs and code), spark (reserved for combat)

**Spark**:
A combat resource.
_Avoid_: mana

**Era**:
A setting. No avoid line.
`;

let s;
let repo;
before(async () => {
  s = await startServer();
  repo = tempRepo();
  repo.commit({ 'CONTEXT.md': CONTEXT }, 'glossary');
  await s.call('POST', '/api/projects', { key: 'GL', repo_path: repo.dir });
});
after(() => {
  repo.remove();
  return s.close();
});

test('CONTEXT.md parsing: terms, avoid lists, notes dropped, quoted exceptions kept, terms never avoided', () => {
  assert.deepEqual(parseGlossary(CONTEXT), [
    { term: 'Hero', avoid: ['unit', 'character', 'champion'], allow: ['unit test'] },
    { term: 'Guarantee', avoid: ['pity'] },
    { term: 'Spark', avoid: ['mana'] },
  ]);
});

test('matching is whole-word and case-insensitive, and skips code', () => {
  const g = parseGlossary(CONTEXT);
  const found = (text) => lintGlossary(g, { description: text }).map((f) => f.word);
  assert.deepEqual(found('Each UNIT gets a turn'), ['unit']);
  assert.deepEqual(found('Community, units, unitary, character_id'), [], 'no partial words');
  assert.deepEqual(found('Add a unit test for the Summon'), [], 'the allowed phrase');
  assert.deepEqual(found('Rename `Unit` to `Hero` in `Unit.cs`'), [], 'inline code');
  assert.deepEqual(found('Pity timer, and a Champion'), ['champion', 'pity']);
});

// Entries shaped like a real game's CONTEXT.md.
const REAL = `**Home Base**:
The base a player builds for others to visit.
_Avoid_: base, camp

**Release Plan**:
The public schedule of what ships when.
_Avoid_: "the release" on its own (ambiguous with the Release Party)

**Release Party**:
The in-game launch event.
_Avoid_: the party
`;

test('using a term is never flagged, even when it contains an avoided word', () => {
  const g = parseGlossary(REAL);
  const found = (text) => lintGlossary(g, { title: text }).map((f) => f.word);
  assert.deepEqual(found('Set up the Home Base screen'), []);
  assert.deepEqual(found('Two home  bases, then the base'), ['base'], 'the plural is not the term; the bare word is flagged');
  assert.deepEqual(found('Build a strong base'), ['base']);
});

test('a quoted phrase followed by a note avoids just the phrase', () => {
  const g = parseGlossary(REAL);
  assert.deepEqual(g.find((e) => e.term === 'Release Plan').avoid, ['the release']);
  const found = (text) => lintGlossary(g, { description: text }).map((f) => f.word);
  assert.deepEqual(found('Explain the release to players'), ['the release']);
  assert.deepEqual(found('Before the Release Party'), [], 'another term that contains the phrase');
});

test('allowed phrases match across any whitespace and hyphens', () => {
  const g = parseGlossary(CONTEXT);
  const found = (text) => lintGlossary(g, { description: text }).map((f) => f.word);
  assert.deepEqual(found('Add a unit  test'), []);
  assert.deepEqual(found('Add a unit\ntest'), []);
  assert.deepEqual(found('Add a unit-test'), []);
  assert.deepEqual(found('Add a unit, then test it'), ['unit']);
});

test('import from the repo or pasted text; warnings on create, update and submit; nothing blocks', async () => {
  const imported = await s.director('POST', '/api/projects/GL/glossary/import', { path: 'CONTEXT.md' });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 3);
  assert.equal(imported.body.glossary[0].term, 'Hero');
  assert.equal((await s.director('POST', '/api/projects/GL/glossary/import', { markdown: 'no entries here' })).status, 400);
  const merged = await s.director('POST', '/api/projects/GL/glossary/import', { markdown: '**Energy**:\nx\n_Avoid_: stamina', mode: 'merge' });
  assert.deepEqual(merged.body.glossary.map((g) => g.term), ['Hero', 'Guarantee', 'Spark', 'Energy']);

  const created = await s.call('POST', '/api/tasks', { project: 'GL', title: 'Unit stamina bar', description: 'Add a unit test.' });
  assert.equal(created.status, 201, 'warnings never block');
  assert.deepEqual(created.body.warnings, [
    'Glossary: say "Hero", not "unit" (title).',
    'Glossary: say "Energy", not "stamina" (title).',
  ]);

  const updated = await s.call('PATCH', `/api/tasks/${created.body.key}`, { title: 'Hero Energy bar', criteria: ['Pity counter shown'] });
  assert.deepEqual(updated.body.warnings, ['Glossary: say "Guarantee", not "pity" (criteria).']);
  const quiet = await s.call('PATCH', `/api/tasks/${created.body.key}`, { priority: 'high' });
  assert.equal(quiet.body.warnings, undefined, 'only text edits are linted');

  const detail = await s.call('GET', `/api/tasks/${created.body.key}`);
  assert.deepEqual(detail.body.glossary_warnings, [{ term: 'Guarantee', word: 'pity', field: 'criteria' }]);

  await s.call('POST', `/api/tasks/${created.body.key}/claim`, {}, 'agent');
  const submitted = await s.call('POST', `/api/tasks/${created.body.key}/submit`, { summary: 'Each champion now shows Energy.' }, 'agent');
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.body.warnings, ['Glossary: say "Hero", not "champion" (handoff summary).']);

  const viaMcp = await s.rpc('create_task', { project: 'GL', title: 'Mana for every character' });
  assert.equal(viaMcp.warnings.length, 2);
  const agentImport = await s.call('POST', '/api/projects/GL/glossary/import', { markdown: '**Hero**:\n_Avoid_: toon' });
  assert.match(agentImport.body.error, /Only the Director can change the glossary/, 'agents never change it (MCP has no import_glossary)');
});
