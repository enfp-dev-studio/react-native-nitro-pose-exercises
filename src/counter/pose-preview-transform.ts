import { landmarkToFramePoint, type PoseFrameMetadata, type PosePoint } from './pose-coordinates.ts';

export interface PosePreviewTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

/**
 * Build on RN after converting the raw frame's origin, right and bottom basis
 * points through Camera.convertCameraPointToViewPoint. The result includes the
 * pose engine's orientation/mirror correction, so workers only need affine math.
 */
export function createPosePreviewTransform(
  metadata: PoseFrameMetadata,
  viewBasis: readonly [PosePoint, PosePoint, PosePoint],
): PosePreviewTransform | null {
  if (typeof metadata.isMirrored !== 'boolean'
    || viewBasis.length !== 3
    || viewBasis.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;

  const [origin, right, bottom] = viewBasis;
  const project = (point: PosePoint): PosePoint | null => {
    const raw = landmarkToFramePoint(point, metadata);
    if (!raw) return null;
    const u = raw.x / metadata.width, v = raw.y / metadata.height;
    return {
      x: origin.x + u * (right.x - origin.x) + v * (bottom.x - origin.x),
      y: origin.y + u * (right.y - origin.y) + v * (bottom.y - origin.y),
    };
  };

  const zero = project({ x: 0, y: 0 });
  const xAxis = project({ x: 1, y: 0 });
  const yAxis = project({ x: 0, y: 1 });
  if (!zero || !xAxis || !yAxis) return null;

  const transform: PosePreviewTransform = {
    a: xAxis.x - zero.x, b: xAxis.y - zero.y,
    c: yAxis.x - zero.x, d: yAxis.y - zero.y,
    tx: zero.x, ty: zero.y,
  };
  const { a, b, c, d, tx, ty } = transform;
  const determinant = a * d - b * c;
  if (![a, b, c, d, tx, ty, determinant].every(Number.isFinite) || determinant === 0) return null;
  return transform;
}

/** Standalone worklet: no imported helper or native camera object is accessed. */
export function applyPosePreviewTransform(point: PosePoint, transform: PosePreviewTransform): PosePoint | null {
  'worklet';
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !Number.isFinite(transform.a) || !Number.isFinite(transform.b)
    || !Number.isFinite(transform.c) || !Number.isFinite(transform.d)
    || !Number.isFinite(transform.tx) || !Number.isFinite(transform.ty)) return null;
  const x = transform.a * point.x + transform.c * point.y + transform.tx;
  const y = transform.b * point.x + transform.d * point.y + transform.ty;
  // Preserve off-preview points; clipping belongs to the preview/canvas, not this transform.
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
