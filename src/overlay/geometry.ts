import type { PosePoint } from '../counter/pose-coordinates.ts';
import {
  applyPosePreviewTransform,
  type PosePreviewTransform,
} from '../counter/pose-preview-transform.ts';

export type SkeletonConfidence = 'strong' | 'weak';

/** Coordinates are in the camera preview's logical pixels, not raw image pixels. */
export type SkeletonPoint = PosePoint & {
  index: number;
  strength: SkeletonConfidence;
};

export type SkeletonSegment = {
  from: SkeletonPoint;
  to: SkeletonPoint;
};

export type SkeletonGeometry = {
  strongSegments: SkeletonSegment[];
  weakSegments: SkeletonSegment[];
  strongJoints: SkeletonPoint[];
  weakJoints: SkeletonPoint[];
};

/** Major body joints only; a single shoulder line keeps the display uncluttered. */
export const SKELETON_CONNECTIONS: readonly (readonly [number, number])[] = [
  [11, 12],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
];

/**
 * Project normalized tracker output with the camera's affine preview transform.
 * Rotation and mirroring belong to that transform and must not be applied again.
 * Off-screen coordinates remain intact so the preview can clip complete segments.
 */
export function projectSkeletonPoints(
  points: readonly SkeletonPoint[],
  transform: PosePreviewTransform,
): SkeletonPoint[] {
  'worklet';
  const projected: SkeletonPoint[] = [];
  for (const point of points) {
    const position = applyPosePreviewTransform(point, transform);
    if (position) projected.push({ ...point, ...position });
  }
  return projected;
}

/** Retain the tracker's confidence groups; do not re-test raw landmark likelihood. */
export function buildSkeletonGeometry(points: readonly SkeletonPoint[]): SkeletonGeometry {
  'worklet';
  const geometry: SkeletonGeometry = {
    strongSegments: [], weakSegments: [], strongJoints: [], weakJoints: [],
  };
  const byIndex: (SkeletonPoint | undefined)[] = new Array(29);
  for (const point of points) {
    if (!Number.isInteger(point.index)
      || !((point.index >= 11 && point.index <= 16)
        || (point.index >= 23 && point.index <= 28))
      || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || (point.strength !== 'strong' && point.strength !== 'weak')) continue;
    const existing = byIndex[point.index];
    if (!existing || (existing.strength === 'weak' && point.strength === 'strong')) {
      byIndex[point.index] = point;
    }
  }
  for (const point of byIndex) {
    if (!point) continue;
    if (point.strength === 'strong') geometry.strongJoints.push(point);
    else geometry.weakJoints.push(point);
  }
  for (const [from, to] of SKELETON_CONNECTIONS) {
    const a = byIndex[from], b = byIndex[to];
    if (!a || !b) continue;
    const segment = { from: a, to: b };
    if (a.strength === 'strong' && b.strength === 'strong') {
      geometry.strongSegments.push(segment);
    } else {
      geometry.weakSegments.push(segment);
    }
  }
  return geometry;
}
