import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../services/state/store.js';
import { optimisticUpdate } from '../services/core/optimistic.js';

test('optimistic update commits after server confirmation', async () => {
  let value = 'old';
  const result = await optimisticUpdate({
    apply: () => { const previous = value; value = 'pending'; return previous; },
    request: async () => ({ value: 'confirmed' }),
    commit: result => { value = result.value; }
  });
  assert.equal(result.value, 'confirmed');
  assert.equal(value, 'confirmed');
});

test('optimistic update rolls back when server rejects', async () => {
  let value = 'available';
  await assert.rejects(() => optimisticUpdate({
    apply: () => { const previous = value; value = 'held-pending'; return previous; },
    request: async () => { throw new Error('conflict'); },
    rollback: previous => { value = previous; }
  }), /conflict/);
  assert.equal(value, 'available');
});

test('store publishes immutable snapshots to subscribers', () => {
  const store = createStore({ count: 0 });
  let observed;
  const unsubscribe = store.subscribe(state => { observed = state; });
  store.setState({ count: 1 });
  assert.equal(observed.count, 1);
  assert.equal(Object.isFrozen(observed), true);
  unsubscribe();
});

import { TTCache } from '../services/core/cache.js';
test('public cache respects TTL and supports deletion', async () => {
  const key = `test:${Date.now()}`;
  await TTCache.set(key, { items: [1, 2] }, 5000);
  assert.deepEqual(await TTCache.get(key), { items: [1, 2] });
  await TTCache.delete(key);
  assert.equal(await TTCache.get(key), null);
});
