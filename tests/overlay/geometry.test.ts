import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSkeletonGeometry, projectSkeletonPoints, type SkeletonPoint,
} from '../../src/overlay/geometry.ts';

const point = (index: number, strength: 'strong' | 'weak' = 'strong', x = index): SkeletonPoint =>
  ({ index, x, y: index * 2, strength });

test('a missing elbow never becomes a shoulder-to-wrist shortcut', () => {
  const geometry = buildSkeletonGeometry([point(11), point(15)]);
  assert.equal(geometry.strongSegments.length, 0);
  assert.equal(geometry.weakSegments.length, 0);
  assert.equal(geometry.strongJoints.length, 2);
});

test('a weak endpoint dims its segment while duplicate strong joints win', () => {
  const geometry = buildSkeletonGeometry([
    point(11, 'weak', 99), point(11, 'strong', 20), point(11, 'weak', 42),
    point(13), point(15, 'weak'),
  ]);
  assert.equal(geometry.strongJoints.filter(p => p.index === 11).length, 1);
  assert.equal(geometry.strongJoints.find(p => p.index === 11)?.x, 20);
  assert.deepEqual(geometry.strongSegments.map(s => [s.from.index, s.to.index]), [[11, 13]]);
  assert.deepEqual(geometry.weakSegments.map(s => [s.from.index, s.to.index]), [[13, 15]]);
});

test('bad geometry is rejected while legitimate off-screen points remain for canvas clipping', () => {
  const geometry = buildSkeletonGeometry([
    point(0), point(33), point(13.5), point(99), point(23, 'strong', NaN),
    point(11, 'strong', -20), point(13, 'strong', 440),
    { ...point(12), strength: 'invalid' as 'strong' },
  ]);
  assert.deepEqual(geometry.strongJoints.map(p => p.index), [11, 13]);
  assert.equal(geometry.strongSegments[0]?.from.x, -20);
  assert.equal(geometry.strongSegments[0]?.to.x, 440);
});

test('preview projection applies rotation/mirror/crop exactly once and preserves confidence', () => {
  const projected = projectSkeletonPoints([
    { index: 11, x: 0.2, y: 0.4, strength: 'weak' },
    { index: 13, x: 2, y: -1, strength: 'strong' },
  ], { a: 0, b: -200, c: 300, d: 0, tx: -10, ty: 220 });
  assert.deepEqual(projected, [
    { index: 11, x: 110, y: 180, strength: 'weak' },
    { index: 13, x: -310, y: -180, strength: 'strong' },
  ]);
  assert.deepEqual(projectSkeletonPoints([point(11)], {
    a: NaN, b: 0, c: 0, d: 1, tx: 0, ty: 0,
  }), []);
});
