import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardEdge, quietCard } from '../public/card-state.js';

const card = (fields = {}) => ({ status: 'todo', blocked_by: [], pending_prerequisites: [], rework: false, waiting_on_director: false, ...fields });

test('the edge shows the first state that needs a human', () => {
  assert.equal(cardEdge(card()), null);
  assert.equal(cardEdge(card({ stale_claim: { idle: '2 days' } })), 'stale');
  assert.equal(cardEdge(card({ stale_claim: {}, rework: true })), 'rework');
  assert.equal(cardEdge(card({ stale_claim: {}, rework: true, pending_prerequisites: ['Install Unity'] })), 'setup');
  assert.equal(cardEdge(card({ stale_claim: {}, rework: true, pending_prerequisites: ['x'], waiting_on_director: true })), 'waiting');
});

test('cards blocked only by dependencies are quiet; claimable and attention cards are not', () => {
  assert.equal(quietCard(card({ blocked_by: ['AS-1'] })), true);
  assert.equal(quietCard(card()), false, 'claimable');
  assert.equal(quietCard(card({ blocked_by: ['AS-1'], pending_prerequisites: ['Set up a device'] })), false, 'needs the Director');
  assert.equal(quietCard(card({ blocked_by: ['AS-1'], waiting_on_director: true })), false);
});
