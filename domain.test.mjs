import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePrice, VAT_RATE } from '../services/domain/pricing.js';
import { createStore } from '../services/state/store.js';
import { TTError, normalizeError } from '../services/core/errors.js';

test('VAT and total are rounded to minor currency units', () => {
  assert.equal(VAT_RATE, 0.15);
  assert.deepEqual(calculatePrice(100), { subtotal: 100, vat: 15, total: 115, currencyScale: 2 });
  assert.deepEqual(calculatePrice(10.01), { subtotal: 10.01, vat: 1.5, total: 11.51, currencyScale: 2 });
});
test('pricing rejects invalid values', () => {
  assert.throws(() => calculatePrice(-1), RangeError);
  assert.throws(() => calculatePrice(Number.NaN), RangeError);
  assert.throws(() => calculatePrice(10, 1.1), RangeError);
});
test('store publishes immutable state and unsubscribe works', () => {
  const store = createStore({ count: 0 }); let calls = 0;
  const stop = store.subscribe(s => { calls++; assert.equal(Object.isFrozen(s), true); });
  store.setState(s => ({ count: s.count + 1 })); stop(); store.setState({ count: 2 });
  assert.equal(store.getState().count, 2); assert.equal(calls, 1);
});
test('error normalization preserves application errors and wraps unknown errors', () => {
  const known = new TTError('invalid', 'bad'); assert.equal(normalizeError(known), known);
  const wrapped = normalizeError(Object.assign(new Error('offline'), { code: 'network-error' }));
  assert.equal(wrapped.code, 'network-error'); assert.equal(wrapped.retryable, true);
});
