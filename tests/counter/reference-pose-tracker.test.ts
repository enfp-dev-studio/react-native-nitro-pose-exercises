import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  advanceReferencePoseTracker, createReferencePoseTrackerState,
  type ReferencePoseRawPoint, type ReferencePoseTrackerState,
} from '../../src/counter/reference-pose-tracker.ts';

const allIndices = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const point = (x: number, visibility = 0.9, y = 0.5): ReferencePoseRawPoint => ({ x, y, visibility });
function landmarks(entries: Record<number, ReferencePoseRawPoint>) {
  const result = new Array<ReferencePoseRawPoint | null>(34).fill(null);
  for (const [index, value] of Object.entries(entries)) result[Number(index)] = value;
  return result;
}
function step(state: ReferencePoseTrackerState, timeMs: number,
  entries: Record<number, ReferencePoseRawPoint>, shoulderWidthBaseline = 0,
  resultId = (state.lastObservation?.resultId ?? 0) + 1) {
  return advanceReferencePoseTracker(state, {
    resultId, timeMs, landmarks: landmarks(entries), shoulderWidthBaseline,
  });
}
function near(actual: number | undefined, expected: number) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('tracking uses the inclusive 0.18 threshold and display uses current raw at 0.5', () => {
  const below = step(createReferencePoseTrackerState(), 0, { 0: point(0.1, 0.179) });
  assert.equal(below.observation.cachePoints[0], null);
  assert.deepEqual(below.observation.strong, []);
  const first = step(createReferencePoseTrackerState(), 0, { 0: point(0.1, 0.18) });
  near(first.observation.cachePoints[0]?.x, 0.1);
  near(first.observation.strong[0]?.x, 0.1);

  const held = step(first.state, 50, { 0: point(0.9, 0.5) });
  near(held.observation.cachePoints[0]?.x, 0.1);
  near(held.observation.strong[0]?.x, 0.9);
  assert.equal(held.state.jumpCounts[0], 1);
  const filteredDisplay = step(first.state, 50, { 0: point(0.9, 0.499) });
  near(filteredDisplay.observation.strong[0]?.x, 0.1);
});

test('two recent large jumps are held with timestamp refresh; the third is filtered', () => {
  let result = step(createReferencePoseTrackerState(), 0, { 0: point(0.1) });
  for (const [time, count] of [[50, 1], [100, 2]]) {
    result = step(result.state, time, { 0: point(0.9) });
    near(result.observation.cachePoints[0]?.x, 0.1);
    assert.equal(result.state.jumpCounts[0], count);
    assert.equal(result.state.cacheEntries[0]?.timeMs, time);
  }
  result = step(result.state, 150, { 0: point(0.9) });
  near(result.observation.cachePoints[0]?.x, 0.82);
  assert.equal(result.state.jumpCounts[0], 0);
});

test('jump distance is strictly greater than 0.2 and jump age is strictly below 120 ms', () => {
  const initial = step(createReferencePoseTrackerState(), 0, { 0: point(0) });
  const exactDistance = step(initial.state, 50, { 0: point(0.2) });
  near(exactDistance.observation.cachePoints[0]?.x, 0.18);
  assert.equal(exactDistance.state.jumpCounts[0], 0);
  const beforeAge = step(initial.state, 119.999, { 0: point(0.9) });
  near(beforeAge.observation.cachePoints[0]?.x, 0);
  assert.equal(beforeAge.state.jumpCounts[0], 1);
  const atAge = step(initial.state, 120, { 0: point(0.9) });
  near(atAge.observation.cachePoints[0]?.x, 0.81);
  assert.equal(atAge.state.jumpCounts[0], 0);
});

test('confidence-dependent alpha switches at 0.3 and clamps to 0.6..0.9', () => {
  for (const [visibility, expected] of [[0.18, 0.03], [0.299, 0.03], [0.3, 0.06], [0.6, 0.06], [0.8, 0.08], [1, 0.09]]) {
    const initial = step(createReferencePoseTrackerState(), 0, { 0: point(0) });
    const next = step(initial.state, 50, { 0: point(0.1, visibility) });
    near(next.observation.cachePoints[0]?.x, expected);
  }
});

test('filtering expires at 300 ms and unobserved cache points expire at 400 ms', () => {
  const initial = step(createReferencePoseTrackerState(), 0, { 0: point(0.1) });
  near(step(initial.state, 299.999, { 0: point(0.2) }).observation.cachePoints[0]?.x, 0.19);
  near(step(initial.state, 300, { 0: point(0.2) }).observation.cachePoints[0]?.x, 0.2);
  near(step(initial.state, 399.999, {}).observation.cachePoints[0]?.x, 0.1);
  const expired = step(initial.state, 400, {});
  assert.equal(expired.observation.cachePoints[0], null);
  assert.deepEqual(expired.observation.strong, []);
  assert.deepEqual(expired.observation.weak, []);
  assert.equal(expired.state.cacheEntries[0]?.timeMs, 0);
});

test('missing and below-threshold observations do not refresh time or reset jump count', () => {
  const initial = step(createReferencePoseTrackerState(), 0, { 0: point(0.1) });
  const held = step(initial.state, 50, { 0: point(0.9) });
  const missingCases: Record<number, ReferencePoseRawPoint>[] = [{}, { 0: point(0.9, 0.17) }];
  for (const entries of missingCases) {
    const absent = step(held.state, 75, entries);
    assert.equal(absent.state.jumpCounts[0], 1);
    assert.equal(absent.state.cacheEntries[0]?.timeMs, 50);
    const next = step(absent.state, 100, { 0: point(0.9) });
    assert.equal(next.state.jumpCounts[0], 2);
    near(next.observation.cachePoints[0]?.x, 0.1);
  }
  const small = step(held.state, 75, { 0: point(0.15) });
  assert.equal(small.state.jumpCounts[0], 0);
});

test('display changes from strong to weak at 150 ms and disappears at 400 ms', () => {
  const first = step(createReferencePoseTrackerState(), 1000, { 0: point(0.1) });
  for (const [time, strongCount, weakCount] of [[1149.999, 1, 0], [1150, 0, 1], [1399.999, 0, 1], [1400, 0, 0]]) {
    const next = step(first.state, time, {});
    assert.equal(next.observation.strong.length, strongCount);
    assert.equal(next.observation.weak.length, weakCount);
  }
});

test('repeated feature reads advance every cached joint only once per result', () => {
  const entries = Object.fromEntries(allIndices.map(index => [index, point(index / 40)]));
  const first = step(createReferencePoseTrackerState(), 0, entries);
  const moved = Object.fromEntries(allIndices.map(index => [index, point(index / 40 + 0.3)]));
  const next = step(first.state, 50, moved);
  for (const index of allIndices) {
    near(next.observation.cachePoints[index]?.x, index / 40);
    assert.equal(next.state.jumpCounts[index], 1, `joint ${index}`);
  }
});

test('an unrequested elbow or leg may be raw-displayed without entering the persistent cache', () => {
  const next = step(createReferencePoseTrackerState(), 0, {
    13: point(0.2), 14: point(0.3, 0.49), 15: point(0.4, 0.49),
    25: point(0.5), 27: point(0.6),
  });
  assert.equal(next.state.cacheEntries[13], null);
  assert.equal(next.state.cacheEntries[25], null);
  assert.equal(next.observation.cachePoints[13], null);
  assert.deepEqual(next.observation.strong.map(p => p.index), [13, 15, 25, 27]);
  assert.equal(next.observation.strong.find(p => p.index === 14), undefined);
});

test('hip feature elbow checks preserve short-circuit cache updates', () => {
  const entries = {
    13: point(0.5, 0.49), 14: point(0.7, 0.49),
    23: point(0.4), 24: point(0.6),
  };
  const closeLeft = step(createReferencePoseTrackerState(), 0, entries);
  assert.ok(closeLeft.state.cacheEntries[13]);
  assert.equal(closeLeft.state.cacheEntries[14], null);
  const distantLeft = step(createReferencePoseTrackerState(), 0, { ...entries, 13: point(0.2, 0.49) });
  assert.ok(distantLeft.state.cacheEntries[14]);
});

test('one available hip still triggers elbow cache checks through the single-side fallback', () => {
  const next = step(createReferencePoseTrackerState(), 0, {
    23: point(0.5), 13: point(0.2, 0.49), 14: point(0.7, 0.49),
  });
  assert.ok(next.state.cacheEntries[13]);
  assert.ok(next.state.cacheEntries[14]);
});

test('a leg cache advances only through available hip, knee, then ankle', () => {
  const initial = step(createReferencePoseTrackerState(), 0, { 23: point(0.5), 27: point(0.6, 0.49) });
  assert.ok(initial.state.cacheEntries[23]);
  assert.equal(initial.state.cacheEntries[27], null);
  const next = step(initial.state, 50, { 25: point(0.55), 27: point(0.6, 0.49) });
  assert.ok(next.state.cacheEntries[27]);
  assert.equal(next.state.cacheEntries[23]?.timeMs, 0);
});

test('neck is a shoulder midpoint and is weak whenever either displayed shoulder is weak', () => {
  const first = step(createReferencePoseTrackerState(), 0, { 11: point(0.2), 12: point(0.8) });
  assert.deepEqual(first.observation.strong.find(p => p.index === 33), { index: 33, x: 0.5, y: 0.5 });
  const partial = step(first.state, 150, { 11: point(0.2) });
  assert.equal(partial.observation.strong.find(p => p.index === 33), undefined);
  assert.deepEqual(partial.observation.weak.find(p => p.index === 33), { index: 33, x: 0.5, y: 0.5 });
  const expired = step(first.state, 400, { 11: point(0.2) });
  assert.equal([...expired.observation.strong, ...expired.observation.weak].find(p => p.index === 33), undefined);
});

test('shoulder collapse preserves both entire previous display maps while still advancing cache', () => {
  const first = step(createReferencePoseTrackerState(), 0, { 11: point(0.2), 12: point(0.8), 15: point(0.1) });
  const weakWrist = step(first.state, 150, { 11: point(0.2), 12: point(0.8) });
  assert.equal(weakWrist.observation.weak[0]?.index, 15);
  const collapse = step(weakWrist.state, 1000, { 11: point(0.45), 12: point(0.55), 16: point(0.9) }, 0.6);
  assert.deepEqual(collapse.observation.strong, weakWrist.observation.strong);
  assert.deepEqual(collapse.observation.weak, weakWrist.observation.weak);
  near(collapse.observation.cachePoints[11]?.x, 0.45);
  assert.equal(collapse.state.cacheEntries[16]?.timeMs, 1000);
  const repeated = step(collapse.state, 3000, { 11: point(0.45), 12: point(0.55) }, 0.6);
  // Display preservation has no separate age cap while shoulder collapse continues.
  assert.deepEqual(repeated.observation.strong, weakWrist.observation.strong);
  assert.deepEqual(repeated.observation.weak, weakWrist.observation.weak);
  const recovered = step(repeated.state, 4000, { 11: point(0.2), 12: point(0.8) }, 0.6);
  assert.deepEqual(recovered.observation.strong.map(p => p.index), [11, 12, 33]);
  assert.deepEqual(recovered.observation.weak, []);
});

test('shoulder preservation is strict and needs a positive baseline and both shoulders', () => {
  const first = step(createReferencePoseTrackerState(), 0, { 11: point(0), 12: point(1) });
  const exact = step(first.state, 1000, { 11: point(0.25), 12: point(0.75) }, 1);
  assert.deepEqual(exact.observation.strong, [
    { index: 11, x: 0.25, y: 0.5 }, { index: 12, x: 0.75, y: 0.5 }, { index: 33, x: 0.5, y: 0.5 },
  ]);
  const noBaseline = step(first.state, 1000, { 11: point(0.45), 12: point(0.55) }, 0);
  assert.deepEqual(noBaseline.observation.strong, [
    { index: 11, x: 0.45, y: 0.5 }, { index: 12, x: 0.55, y: 0.5 }, { index: 33, x: 0.5, y: 0.5 },
  ]);
  const missing = step(first.state, 1000, { 11: point(0.45) }, 1);
  assert.deepEqual(missing.observation.strong, [{ index: 11, x: 0.45, y: 0.5 }]);
});

test('tracking clamps endpoints, preserves existing axes, and applies no strict bounds filter', () => {
  const next = step(createReferencePoseTrackerState(), 0, {
    0: point(-0.2, 0.9, 1.2), 15: point(0.25, 0.9, 0.75),
  });
  assert.deepEqual(next.observation.rawPoints[0], { x: 0, y: 1, visibility: 0.9 });
  assert.deepEqual(next.observation.strong[0], { index: 0, x: 0, y: 1 });
  assert.deepEqual(next.observation.cachePoints[15], { x: 0.25, y: 0.75 });
});

test('transport rejects repeated/out-of-order packets without mutating the prior state', () => {
  const first = step(createReferencePoseTrackerState(), 100, { 0: point(0.1) }, 0, 10);
  const before = JSON.stringify(first.state);
  for (const [time, id] of [[100, 10], [150, 9], [99, 11]]) {
    const repeated = step(first.state, time, { 0: point(0.9) }, 0, id);
    assert.equal(repeated.state, first.state);
    assert.equal(repeated.observation, first.observation);
  }
  step(first.state, 150, { 0: point(0.9) });
  assert.equal(JSON.stringify(first.state), before);
});

test('missing/nonfinite joints are tolerated and state size stays bounded across a long session', () => {
  let result = step(createReferencePoseTrackerState(), 0, { 0: point(NaN), 15: point(0.1, Infinity) });
  assert.equal(result.observation.rawPoints[0], null);
  assert.equal(result.observation.rawPoints[15], null);
  for (let i = 1; i <= 1000; i += 1) result = step(result.state, i * 40, { 0: point((i % 10) / 10) });
  assert.equal(result.state.cacheEntries.length, 34);
  assert.equal(result.state.jumpCounts.length, 34);
  assert.equal(result.state.lastObservation, result.observation);
  assert.equal(result.observation.rawPoints.length, 34);
  assert.equal(result.observation.cachePoints.length, 34);
  assert.equal(result.state.cacheEntries.filter(Boolean).length, 1);
});
