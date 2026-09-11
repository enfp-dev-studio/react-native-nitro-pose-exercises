export interface PosePoint {
  x: number;
  y: number;
}

export interface PoseFrameMetadata {
  width: number;
  height: number;
  orientation: 'up' | 'down' | 'left' | 'right';
  isMirrored: boolean;
  platform: 'ios' | 'android';
}

/** Undo the pose engine's image transform before using VisionCamera's sensor conversion. */
export function landmarkToFramePoint(point: PosePoint, frame: PoseFrameMetadata): PosePoint | null {
  'worklet';
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
    || !Number.isFinite(frame.width) || !Number.isFinite(frame.height)
    || frame.width <= 0 || frame.height <= 0
    || (frame.platform !== 'ios' && frame.platform !== 'android')) return null;

  let x = point.x;
  let y = point.y;
  const isIOS = frame.platform === 'ios';
  // Android uses ML Kit rotationDegrees (90 maps to VisionCamera's "left").
  // iOS passes the same-named CGImagePropertyOrientation, whose quarter turns differ.
  // Both engines already return a top-left origin; do not flip Y again.
  switch (frame.orientation) {
    case 'up': break;
    case 'down': x = 1 - point.x; y = 1 - point.y; break;
    case 'left':
      x = isIOS ? 1 - point.y : point.y;
      y = isIOS ? point.x : 1 - point.x;
      break;
    case 'right':
      x = isIOS ? point.y : 1 - point.y;
      y = isIOS ? 1 - point.x : point.x;
      break;
    default: return null;
  }
  // Vision applies the mirrored EXIF orientation; ML Kit ignores frame.isMirrored.
  // Undo that mirror in raw buffer coordinates, after undoing the rotation.
  if (isIOS && frame.isMirrored) x = 1 - x;

  // Keep off-frame points intact so the native preview transform can crop them.
  x *= frame.width;
  y *= frame.height;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
