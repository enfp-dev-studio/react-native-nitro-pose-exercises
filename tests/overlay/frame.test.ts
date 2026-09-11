import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSkeletonFrameFresh } from '../../src/overlay/frame.ts';

test('an unchanged packet expires and disabling clears it immediately', () => {
  const packet = { id: 4, processedAt: 1000 };
  assert.equal(isSkeletonFrameFresh(packet, true, 1400), true);
  assert.equal(isSkeletonFrameFresh(packet, true, 1401), false);
  assert.equal(isSkeletonFrameFresh(packet, false, 1001), false);
  assert.deepEqual(packet, { id: 4, processedAt: 1000 });
});

test('future or malformed timestamps and identifiers cannot render', () => {
  for (const packet of [
    { id: 0, processedAt: 1000 }, { id: 0.5, processedAt: 1000 },
    { id: 1, processedAt: 0 }, { id: 1, processedAt: NaN },
    { id: 1, processedAt: Infinity }, { id: 1, processedAt: 1200 },
  ]) assert.equal(isSkeletonFrameFresh(packet, true, 1100), false);
  assert.equal(isSkeletonFrameFresh({ id: 1, processedAt: 1000 }, true, NaN), false);
  assert.equal(isSkeletonFrameFresh({ id: 1, processedAt: 1000 }, true, 1001, -1), false);
});

test('a restarted stream can reuse an id with a fresh timestamp', () => {
  assert.equal(isSkeletonFrameFresh({ id: 1, processedAt: 1000 }, true, 2000), false);
  assert.equal(isSkeletonFrameFresh({ id: 1, processedAt: 2000 }, true, 2001), true);
});
