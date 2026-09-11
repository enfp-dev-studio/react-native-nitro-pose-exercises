import assert from 'node:assert/strict';
import { test } from 'node:test';

import { landmarkToFramePoint, type PoseFrameMetadata } from '../../src/counter/pose-coordinates.ts';

const frame: PoseFrameMetadata = {
  width: 1280, height: 720, orientation: 'up', isMirrored: false, platform: 'android',
};

// A raw-buffer joint at (320, 90), or normalized (1/4, 1/8), has these
// upright ML Kit coordinates. VisionCamera maps rotationDegrees 90 to "left".
const androidLandmarks = [
  ['up', { x: 0.25, y: 0.125 }],
  ['left', { x: 0.875, y: 0.25 }],
  ['down', { x: 0.75, y: 0.875 }],
  ['right', { x: 0.125, y: 0.75 }],
] as const;

// The iOS engine uses same-named CGImagePropertyOrientation values and already
// flips Vision's bottom-left Y. EXIF right is clockwise; left is counterclockwise.
// https://developer.apple.com/documentation/imageio/cgimagepropertyorientation
const iosLandmarks = [
  ['up', { x: 0.25, y: 0.125 }, { x: 0.75, y: 0.125 }],
  ['left', { x: 0.125, y: 0.75 }, { x: 0.125, y: 0.25 }],
  ['down', { x: 0.75, y: 0.875 }, { x: 0.25, y: 0.875 }],
  ['right', { x: 0.875, y: 0.25 }, { x: 0.875, y: 0.75 }],
] as const;

test('Android ML Kit landmarks recover the raw pixel in every orientation without an extra mirror', () => {
  for (const [orientation, point] of androidLandmarks) {
    for (const isMirrored of [false, true]) {
      assert.deepEqual(landmarkToFramePoint(point, { ...frame, orientation, isMirrored }),
        { x: 320, y: 90 }, `${orientation}, mirrored=${isMirrored}`);
    }
  }
});

test('iOS Vision landmarks undo all eight EXIF orientations including mirrored quarter turns', () => {
  for (const [orientation, plain, mirrored] of iosLandmarks) {
    assert.deepEqual(landmarkToFramePoint(plain, { ...frame, platform: 'ios', orientation }),
      { x: 320, y: 90 }, orientation);
    assert.deepEqual(landmarkToFramePoint(mirrored, { ...frame, platform: 'ios', orientation, isMirrored: true }),
      { x: 320, y: 90 }, `${orientation}Mirrored`);
  }
});

test('quarter-turn landmarks use original buffer dimensions rather than swapped portrait dimensions', () => {
  assert.deepEqual(landmarkToFramePoint({ x: 0.875, y: 0.25 }, {
    ...frame, width: 1920, height: 1080, orientation: 'left',
  }), { x: 480, y: 135 });
  assert.deepEqual(landmarkToFramePoint({ x: 0.125, y: 0.75 }, {
    ...frame, width: 640, height: 480, platform: 'ios', orientation: 'left',
  }), { x: 160, y: 60 });
});

test('valid off-frame coordinates stay outside the buffer for native cropping', () => {
  const smallFrame = { ...frame, width: 640, height: 480 };
  assert.deepEqual(landmarkToFramePoint({ x: -0.25, y: 1.25 }, smallFrame), { x: -160, y: 600 });
  assert.deepEqual(landmarkToFramePoint({ x: -0.25, y: 1.25 }, { ...smallFrame, orientation: 'left' }),
    { x: 800, y: 600 });
  assert.deepEqual(landmarkToFramePoint({ x: -0.25, y: 1.25 }, {
    ...smallFrame, platform: 'ios', orientation: 'right', isMirrored: true,
  }), { x: -160, y: 600 });
});

test('invalid coordinates, dimensions, and unsupported metadata cannot reach native conversion', () => {
  const point = { x: 0.25, y: 0.125 };
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(landmarkToFramePoint({ ...point, x: value }, frame), null);
    assert.equal(landmarkToFramePoint({ ...point, y: value }, frame), null);
  }
  for (const value of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(landmarkToFramePoint(point, { ...frame, width: value }), null);
    assert.equal(landmarkToFramePoint(point, { ...frame, height: value }), null);
  }
  assert.equal(landmarkToFramePoint(point, { ...frame, orientation: 'invalid' } as unknown as PoseFrameMetadata), null);
  assert.equal(landmarkToFramePoint(point, { ...frame, platform: 'web' } as unknown as PoseFrameMetadata), null);
  assert.equal(landmarkToFramePoint({ x: Number.MAX_VALUE, y: 0 }, frame), null);
});
