import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createReferencePushupState,
  extractReferencePushupFeatures,
  referencePushupRobustSpan,
  updateReferencePushupCounter,
  type ReferencePushupObservation,
  type ReferencePushupRawPoint,
  type ReferencePushupResult,
  type ReferencePushupState,
} from '../../src/counter/reference-pushup-counter.ts';

type PoseOptions = { angle?: number; rightAngle?: number; drop?: number; wristsDrop?: number; hipDrop?: number; hips?: boolean; visibility?: number };
function observation(id: number, timeMs: number, options: PoseOptions = {}): ReferencePushupObservation {
  const angle = options.angle ?? 170, drop = options.drop ?? 0;
  const points: (ReferencePushupRawPoint | null)[] = Array.from({ length: 34 }, () => null);
  const set = (index: number, x: number, y: number) => { points[index] = { x, y, visibility: options.visibility ?? 1 }; };
  for (let side = 0; side < 2; side++) {
    const x = 0.4 + side * 0.2, sy = 0.25 + drop, wy = 0.6 + (options.wristsDrop ?? 0);
    const radians = (side === 1 ? options.rightAngle ?? angle : angle) * Math.PI / 180;
    const h = (wy - sy) / 2 / Math.tan(radians / 2);
    set(11 + side, x, sy); set(13 + side, x + (side === 0 ? -h : h), (sy + wy) / 2); set(15 + side, x, wy);
    if (options.hips !== false) set(23 + side, x + (side === 0 ? 0.05 : -0.05), 0.4 + (options.hipDrop ?? drop));
  }
  return { resultId: id, timeMs, cachePoints: points, rawPoints: points };
}
function replay(poses: PoseOptions[], mode: 'full' | 'knee' = 'full', motion = 0, step = 50, initial?: ReferencePushupState) {
  let state = initial ?? createReferencePushupState(mode);
  const results: ReferencePushupResult[] = [];
  for (let i = 0; i < poses.length; i++) {
    const result = updateReferencePushupCounter(state, {
      observation: observation(state.lastResultId + 1, Math.max(1000, state.lastInputTimeMs + step), poses[i]),
      mode, deviceMotion: motion,
    });
    state = result.state; results.push(result);
  }
  return { state, results };
}
function cycle(depth = 0.12): PoseOptions[] {
  return [
    ...Array.from({ length: 5 }, () => ({ angle: 170, drop: 0 })),
    { angle: 145, drop: depth / 4 }, { angle: 120, drop: depth / 2 }, { angle: 90, drop: depth },
    ...Array.from({ length: 8 }, () => ({ angle: 85, drop: depth })),
    { angle: 110, drop: depth * 0.8 }, { angle: 135, drop: depth * 0.5 }, { angle: 160, drop: depth * 0.2 },
    ...Array.from({ length: 5 }, () => ({ angle: 170, drop: 0 })),
  ];
}

test('elbow angles use normalized axes, bilateral minimum and one-arm fallback', () => {
  const pose = observation(1, 1000, { angle: 85, rightAngle: 165 });
  assert.ok(Math.abs(extractReferencePushupFeatures(pose).elbowAngle - 85) < 0.001);
  const cache = pose.cachePoints.slice(); cache[13] = null;
  const feature = extractReferencePushupFeatures({ ...pose, cachePoints: cache });
  assert.ok(Math.abs(feature.elbowAngle - 165) < 0.001);
  assert.equal(feature.armsVisible, true);
});

test('cached points remain usable but .18 raw confidence controls fresh evidence', () => {
  const pose = observation(1, 1000, { visibility: 0.179 });
  const feature = extractReferencePushupFeatures(pose);
  assert.equal(feature.armsVisible, true); assert.equal(feature.armFresh, false); assert.equal(feature.hipFresh, false);
  assert.equal(extractReferencePushupFeatures(observation(2, 1050, { visibility: 0.18 })).armFresh, true);
});

test('robust range uses rounded 10th/90th percentiles from five samples', () => {
  assert.equal(referencePushupRobustSpan([1, 2, 3, 100]), 99);
  assert.equal(referencePushupRobustSpan([1, 2, 3, 4, 5, 6, 7, 8, 9, 100]), 7);
});

test('full and knee recognize a held bottom and return exactly one accepted event', () => {
  for (const mode of ['full', 'knee'] as const) {
    const { state, results } = replay(cycle(), mode);
    assert.equal(state.reps, 1, JSON.stringify(results.filter(r => r.event !== 'none')));
    assert.equal(results.filter(r => r.accepted).length, 1);
    assert.ok(results.some(r => r.phase === 'descent')); assert.ok(results.some(r => r.phase === 'down')); assert.ok(results.some(r => r.phase === 'ascent'));
    assert.equal(state.phase, 'up');
  }
});

test('shallow shoulder travel is rejected even when the elbows complete a cycle', () => {
  const { state, results } = replay(cycle(0.015));
  assert.equal(state.reps, 0);
  assert.ok(results.some(r => r.reasons.includes('too-shallow')));
});

test('sensor peak minus baseline rejects positive movement above .12 only', () => {
  const moving = replay(cycle(), 'full', 0.12001);
  assert.equal(moving.state.reps, 0); assert.ok(moving.results.some(r => r.reasons.includes('phone-moving')));
  assert.equal(replay(cycle(), 'full', 0.12).state.reps, 1);
  assert.equal(replay(cycle(), 'full', -0.2).state.reps, 1);
});

test('pinned hips are rejected in Full while Knee retains its separate rules', () => {
  const poses = cycle().map(p => ({ ...p, hipDrop: 0 }));
  const full = replay(poses, 'full');
  assert.equal(full.state.reps, 0); assert.ok(full.results.some(r => r.reasons.includes('hips-pinned')));
  assert.equal(replay(poses, 'knee').state.reps, 1);
});

test('missing hips need lower-body or hip-visibility evidence', () => {
  const result = replay(cycle().map(p => ({ ...p, hips: false })));
  assert.equal(result.state.reps, 0); assert.ok(result.results.some(r => r.reasons.includes('hips-missing')));
});

test('duplicate results and timestamps are ignored without mutating prior state', () => {
  const original = createReferencePushupState();
  const input = { observation: observation(1, 1000), mode: 'full' as const };
  const first = updateReferencePushupCounter(original, input);
  assert.deepEqual(original, createReferencePushupState());
  assert.equal(updateReferencePushupCounter(first.state, input).event, 'ignored');
  assert.equal(updateReferencePushupCounter(first.state, { ...input, observation: observation(2, 999) }).event, 'ignored');
  assert.equal(first.state.angleHistory.length, 1);
});

test('a gap over 1.5 seconds resets the candidate while preserving saved repetitions', () => {
  const initial = replay(cycle()).state;
  const mid = replay(cycle().slice(0, 12), 'full', 0, 50, initial).state;
  assert.equal(mid.phase, 'down');
  const result = updateReferencePushupCounter(mid, {
    observation: observation(mid.lastResultId + 1, mid.lastInputTimeMs + 1501), mode: 'full',
  });
  assert.equal(result.event, 'reset'); assert.equal(result.reps, 1); assert.equal(result.state.candidate.frames, 0);
});

test('the movement depth signal reaches its bottom value', () => {
  const result = replay(cycle()).results.find(r => r.phase === 'down')!;
  assert.equal(result.progress, 1);
});

test('Full and Knee retain their different .15 and .20 shoulder-depth thresholds', () => {
  assert.equal(replay(cycle(0.035), 'full').state.reps, 1);
  const knee = replay(cycle(0.035), 'knee');
  assert.equal(knee.state.reps, 0); assert.ok(knee.results.some(r => r.reasons.includes('too-shallow')));
});

test('Full geometry can complete a missed bottom that Knee does not accept', () => {
  const missed = cycle().map(p => ({ ...p, angle: Math.max(p.angle!, 105) }));
  assert.equal(replay(missed, 'full').state.reps, 1);
  assert.equal(replay(missed, 'knee').state.reps, 0);
});

test('waiting can enter descent after a 112-degree peak drops by twelve without a straight-arm start', () => {
  const { results } = replay([
    ...Array.from({ length: 5 }, () => ({ angle: 135 })),
    ...Array.from({ length: 5 }, () => ({ angle: 115, drop: 0.04 })),
  ]);
  assert.equal(results.some(r => r.phase === 'up'), false);
  assert.equal(results.some(r => r.phase === 'descent'), true);
});

test('three-result median rejects a single low-angle spike', () => {
  const result = replay([
    ...Array.from({ length: 5 }, () => ({ angle: 170 })), { angle: 80, drop: 0.12 },
    ...Array.from({ length: 5 }, () => ({ angle: 170 })),
  ]);
  assert.equal(result.state.reps, 0);
  assert.equal(result.results.some(r => r.phase === 'down'), false);
});

test('moving the shoulders and wrists together cannot replace elbow bending evidence', () => {
  const result = replay(cycle().map(p => ({ ...p, wristsDrop: p.drop })));
  assert.equal(result.state.reps, 0);
  assert.ok(result.results.some(r => r.reasons.includes('no-bend')));
  assert.ok(result.results.some(r => r.reasons.includes('hands-moved-width')));
});

test('an upright torso is rejected after an otherwise complete arm cycle', () => {
  const result = replay(cycle().map(p => ({ ...p, hipDrop: (p.drop ?? 0) + 0.25 })));
  assert.equal(result.state.reps, 0); assert.ok(result.results.some(r => r.reasons.includes('upright')));
});

test('a candidate lasting over twenty seconds restarts without counting', () => {
  const poses = [
    ...cycle().slice(0, 10),
    ...Array.from({ length: 110 }, () => ({ angle: 85, drop: 0.12 })),
  ];
  const result = replay(poses, 'full', 0, 200);
  assert.equal(result.state.reps, 0);
  assert.ok(result.results.some(r => r.event === 'reset'));
});

test('fast result cadence cannot keep a candidate alive beyond 450 collected frames', () => {
  const initial = replay(cycle().slice(0, 12)).state;
  const result = replay(Array.from({ length: 455 }, () => ({ angle: 85, drop: 0.12 })), 'full', 0, 20, initial);
  assert.equal(result.state.reps, 0); assert.ok(result.results.some(r => r.event === 'reset'));
});

test('changing Full/Knee preserves repetitions and discards the current candidate', () => {
  const initial = replay(cycle()).state;
  const mid = replay(cycle().slice(0, 12), 'full', 0, 50, initial).state;
  const result = replay([{ angle: 170 }], 'knee', 0, 50, mid);
  assert.equal(result.state.reps, 1); assert.equal(result.state.candidate.frames, 0);
  assert.equal(result.results[0].event, 'reset');
});

test('consecutive complete movements within .55 seconds cannot both count', () => {
  const first = replay(cycle(), 'full', 0, 20);
  assert.equal(first.state.reps, 1);
  const second = replay(cycle(), 'full', 0, 20, first.state);
  assert.equal(second.state.reps, 1);
  assert.ok(second.results.some(r => r.reasons.includes('too-fast')));
});

test('successful empty poses advance the result clock without inventing a missing-camera gap', () => {
  let state = replay(cycle().slice(0, 12)).state;
  const empty = Array.from({ length: 34 }, () => null);
  for (let i = 0; i < 40; i++) {
    const result = updateReferencePushupCounter(state, {
      observation: { resultId: state.lastResultId + 1, timeMs: state.lastInputTimeMs + 50, cachePoints: empty, rawPoints: empty },
      mode: 'full',
    });
    assert.notEqual(result.event, 'reset'); assert.equal(result.progress, 0); state = result.state;
  }
  assert.equal(state.phase, 'down'); assert.equal(state.reps, 0);
});
