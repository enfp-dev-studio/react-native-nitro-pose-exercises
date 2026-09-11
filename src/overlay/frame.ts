import type { SkeletonPoint } from './geometry.ts';

export type SkeletonPreviewFrame = {
  /** A positive result identifier. Use a new processedAt when a session restarts. */
  id: number;
  points: SkeletonPoint[];
  /** A monotonic timestamp in milliseconds, using the UI's performance.now() clock. */
  processedAt: number;
  /** Optional host-owned status copy. The overlay never determines rep counts. */
  message?: string;
};

export const EMPTY_SKELETON_PREVIEW_FRAME: SkeletonPreviewFrame = {
  id: 0, points: [], processedAt: 0,
};

export const DEFAULT_SKELETON_STALE_AFTER_MS = 400;

/** A stopped or delayed stream must disappear even if it sends no final packet. */
export function isSkeletonFrameFresh(
  frame: Pick<SkeletonPreviewFrame, 'id' | 'processedAt'>,
  enabled: boolean,
  now: number,
  staleAfterMs: number = DEFAULT_SKELETON_STALE_AFTER_MS,
): boolean {
  'worklet';
  return enabled
    && Number.isInteger(frame.id) && frame.id > 0
    && Number.isFinite(now) && Number.isFinite(frame.processedAt) && frame.processedAt > 0
    && Number.isFinite(staleAfterMs) && staleAfterMs >= 0
    && now >= frame.processedAt && now - frame.processedAt <= staleAfterMs;
}
