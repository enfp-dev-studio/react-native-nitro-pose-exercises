import assert from 'node:assert/strict';
import test from 'node:test';

// Importing the public pure entry under Node must not load React Native/Nitro.
import {
  advanceReferencePoseTracker,
  applyPosePreviewTransform,
  createPosePreviewTransform,
  createReferencePoseTrackerState,
  createReferencePushupState,
  extractReferencePushupFeatures,
  landmarkToFramePoint,
  referencePushupRobustSpan,
  updateReferencePushupCounter,
} from '../../src/counter/index.ts';

test('the pure entry processes a completed empty inference without a native runtime', () => {
  const counter = createReferencePushupState('knee', 7);
  const tracked = advanceReferencePoseTracker(createReferencePoseTrackerState(), {
    resultId: 1,
    timeMs: 1000,
    landmarks: [],
    shoulderWidthBaseline: counter.shoulderWidthBaseline,
  });
  const result = updateReferencePushupCounter(counter, {
    observation: tracked.observation,
    mode: counter.mode,
    deviceMotion: 0,
  });

  assert.equal(result.reps, 7);
  assert.equal(result.accepted, false);
  assert.equal(result.state.lastResultId, 1);
  assert.equal(result.state.mode, 'knee');
  assert.equal(extractReferencePushupFeatures(tracked.observation).armsVisible, false);

  for (const exported of [
    landmarkToFramePoint,
    createPosePreviewTransform,
    applyPosePreviewTransform,
    referencePushupRobustSpan,
  ]) assert.equal(typeof exported, 'function');
});
