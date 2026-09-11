import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PoseFrameMetadata, PosePoint } from '../../src/counter/pose-coordinates.ts';
import {
  applyPosePreviewTransform, createPosePreviewTransform,
  type PosePreviewTransform,
} from '../../src/counter/pose-preview-transform.ts';

const frame: PoseFrameMetadata = {
  width: 1280, height: 720, orientation: 'up', isMirrored: false, platform: 'android',
};
// Cropped, non-uniform, skewed view basis: the same raw-buffer joint (1/4,1/8)
// must land at (170,120), regardless of which orientation the engine consumed.
const viewBasis: [PosePoint, PosePoint, PosePoint] = [
  { x: 30, y: -40 }, { x: 670, y: 120 }, { x: -130, y: 920 },
];

function assertPoint(actual: PosePoint | null, expected: PosePoint) {
  assert.ok(actual);
  assert.ok(Math.abs(actual.x - expected.x) < 1e-8, `x: ${actual.x} != ${expected.x}`);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-8, `y: ${actual.y} != ${expected.y}`);
}

test('Android affine cache maps all orientations without applying frame mirroring twice', () => {
  const landmarks = [
    ['up', { x: 0.25, y: 0.125 }],
    ['left', { x: 0.875, y: 0.25 }],
    ['down', { x: 0.75, y: 0.875 }],
    ['right', { x: 0.125, y: 0.75 }],
  ] as const;
  for (const [orientation, point] of landmarks) {
    for (const isMirrored of [false, true]) {
      const transform = createPosePreviewTransform({ ...frame, orientation, isMirrored }, viewBasis);
      assert.ok(transform);
      assertPoint(applyPosePreviewTransform(point, transform), { x: 170, y: 120 });
    }
  }
});

test('iOS affine cache includes all eight EXIF rotation and mirror corrections', () => {
  const landmarks = [
    ['up', { x: 0.25, y: 0.125 }, { x: 0.75, y: 0.125 }],
    ['left', { x: 0.125, y: 0.75 }, { x: 0.125, y: 0.25 }],
    ['down', { x: 0.75, y: 0.875 }, { x: 0.25, y: 0.875 }],
    ['right', { x: 0.875, y: 0.25 }, { x: 0.875, y: 0.75 }],
  ] as const;
  for (const [orientation, plain, mirrored] of landmarks) {
    for (const isMirrored of [false, true]) {
      const transform = createPosePreviewTransform({ ...frame, platform: 'ios', orientation, isMirrored }, viewBasis);
      assert.ok(transform);
      assertPoint(applyPosePreviewTransform(isMirrored ? mirrored : plain, transform), { x: 170, y: 120 });
    }
  }
});

test('preview mirroring and cover cropping remain in the supplied native view basis', () => {
  const transform = createPosePreviewTransform(frame, [
    { x: 500, y: -80 }, { x: -140, y: -80 }, { x: 500, y: 880 },
  ]);
  assert.ok(transform);
  assertPoint(applyPosePreviewTransform({ x: 0.25, y: 0.125 }, transform), { x: 340, y: 40 });
  assertPoint(applyPosePreviewTransform({ x: -0.25, y: 1.25 }, transform), { x: 660, y: 1120 });
});

test('buffer resolution changes do not change normalized landmark placement in the same view', () => {
  for (const [width, height] of [[640, 360], [1280, 720], [1920, 1080], [640, 480]]) {
    const transform = createPosePreviewTransform({ ...frame, width, height, orientation: 'left' }, viewBasis);
    assert.ok(transform);
    assertPoint(applyPosePreviewTransform({ x: 0.875, y: 0.25 }, transform), { x: 170, y: 120 });
  }
});

test('invalid frame metadata cannot produce a preview transform', () => {
  for (const value of [0, -1, NaN, Infinity, -Infinity]) {
    assert.equal(createPosePreviewTransform({ ...frame, width: value }, viewBasis), null);
    assert.equal(createPosePreviewTransform({ ...frame, height: value }, viewBasis), null);
  }
  for (const invalid of [
    { ...frame, orientation: 'unknown' }, { ...frame, platform: 'web' }, { ...frame, isMirrored: 'false' },
  ]) assert.equal(createPosePreviewTransform(invalid as PoseFrameMetadata, viewBasis), null);
});

test('invalid and degenerate native view transforms are rejected while reversed axes are accepted', () => {
  assert.equal(createPosePreviewTransform(frame, [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 },
  ]), null);
  assert.equal(createPosePreviewTransform(frame, [
    { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 },
  ]), null);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(createPosePreviewTransform(frame, [{ x: value, y: 0 }, viewBasis[1], viewBasis[2]]), null);
    assert.equal(createPosePreviewTransform(frame, [viewBasis[0], { x: 0, y: value }, viewBasis[2]]), null);
  }
  assert.ok(createPosePreviewTransform(frame, [{ x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }]));
});

test('worker affine application rejects invalid points, corrupt coefficients and overflow', () => {
  const transform = createPosePreviewTransform(frame, viewBasis);
  assert.ok(transform);
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(applyPosePreviewTransform({ x: value, y: 0.5 }, transform), null);
    assert.equal(applyPosePreviewTransform({ x: 0.5, y: value }, transform), null);
    for (const coefficient of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) {
      assert.equal(applyPosePreviewTransform({ x: 0.5, y: 0.5 }, {
        ...transform, [coefficient]: value,
      } as PosePreviewTransform), null);
    }
  }
  assert.equal(applyPosePreviewTransform({ x: Number.MAX_VALUE, y: 0 }, transform), null);
});
