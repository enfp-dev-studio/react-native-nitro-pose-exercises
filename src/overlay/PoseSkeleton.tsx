import { Canvas, Path, Skia, type SkPathBuilder } from '@shopify/react-native-skia';
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN, type Synchronizable } from 'react-native-worklets';

import {
  DEFAULT_SKELETON_STALE_AFTER_MS,
  isSkeletonFrameFresh,
  type SkeletonPreviewFrame,
} from './frame.ts';
import { buildSkeletonGeometry, type SkeletonPoint, type SkeletonSegment } from './geometry.ts';
import { resolveSkeletonTheme, type SkeletonTheme } from './theme.ts';

// Supplied by the native UI runtime; use the same monotonic clock as frame packets.
declare const performance: { now(): number };

export type PoseSkeletonProps = {
  frame: SharedValue<SkeletonPreviewFrame>;
  /** Share the same enabled gate used by the camera worker. */
  enabled: Synchronizable<boolean>;
  theme?: Partial<SkeletonTheme>;
  staleAfterMs?: number;
  waitingMessage?: string;
  /** Status is delivered on RN at most four times per second, only when changed. */
  onBadge?: (message: string) => void;
};

function appendSegments(builder: SkPathBuilder, segments: readonly SkeletonSegment[]) {
  'worklet';
  for (const { from, to } of segments) builder.moveTo(from.x, from.y).lineTo(to.x, to.y);
}

function appendJoints(builder: SkPathBuilder, points: readonly SkeletonPoint[], radius: number) {
  'worklet';
  for (const point of points) builder.addCircle(point.x, point.y, radius);
}

/** Draws projected tracker points above a camera preview; it owns no camera or session. */
export const PoseSkeleton = memo(function PoseSkeleton({
  frame,
  enabled,
  theme,
  staleAfterMs = DEFAULT_SKELETON_STALE_AFTER_MS,
  waitingMessage = 'Waiting for body tracking',
  onBadge,
}: PoseSkeletonProps) {
  const palette = useMemo(() => resolveSkeletonTheme(theme), [theme]);
  const emptyPath = useMemo(() => Skia.Path.Make(), []);
  const strongLines = useSharedValue(emptyPath);
  const weakLines = useSharedValue(emptyPath);
  const strongJoints = useSharedValue(emptyPath);
  const weakJoints = useSharedValue(emptyPath);
  const drawn = useSharedValue({ id: 0, processedAt: 0, radius: 0 });
  const badge = useSharedValue({ sentText: '', sentAt: -Infinity });
  const mounted = useRef(false);
  const badgeCallback = useRef(onBadge);
  useEffect(() => { badgeCallback.current = onBadge; }, [onBadge]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const publishBadge = useCallback((message: string) => {
    if (mounted.current) badgeCallback.current?.(message);
  }, []);

  // Read shared inputs only after mount on the UI thread. Checking freshness on
  // every display frame also handles a disabled camera or an inference stall.
  useFrameCallback(() => {
    'worklet';
    const now = performance.now();
    const current = frame.get();
    const fresh = isSkeletonFrameFresh(current, enabled.getBlocking(), now, staleAfterMs);
    const previous = drawn.get();
    const text = fresh && current.points.length > 0
      ? current.message || 'Body tracking active'
      : waitingMessage;
    const previousBadge = badge.get();
    if (text !== previousBadge.sentText && now - previousBadge.sentAt >= 250) {
      badge.set({ sentText: text, sentAt: now });
      scheduleOnRN(publishBadge, text);
    }
    if (!fresh || current.points.length === 0) {
      if (previous.id !== 0) {
        strongLines.set(emptyPath); weakLines.set(emptyPath);
        strongJoints.set(emptyPath); weakJoints.set(emptyPath);
        drawn.set({ id: 0, processedAt: 0, radius: 0 });
      }
      return;
    }
    if (current.id === previous.id && current.processedAt === previous.processedAt
      && palette.jointRadius === previous.radius) return;
    const geometry = buildSkeletonGeometry(current.points);
    const builder = Skia.PathBuilder.Make();
    appendSegments(builder, geometry.strongSegments); strongLines.set(builder.detach());
    appendSegments(builder, geometry.weakSegments); weakLines.set(builder.detach());
    appendJoints(builder, geometry.strongJoints, palette.jointRadius); strongJoints.set(builder.detach());
    appendJoints(builder, geometry.weakJoints, palette.jointRadius); weakJoints.set(builder.detach());
    drawn.set({ id: current.id, processedAt: current.processedAt, radius: palette.jointRadius });
  });

  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Path path={weakLines} style="stroke" strokeWidth={palette.strokeWidth}
        strokeCap="round" color={palette.boneColor} opacity={palette.weakOpacity} />
      <Path path={strongLines} style="stroke" strokeWidth={palette.strokeWidth}
        strokeCap="round" color={palette.boneColor} opacity={palette.strongOpacity} />
      <Path path={weakJoints} color={palette.jointColor} opacity={palette.weakOpacity} />
      <Path path={strongJoints} color={palette.jointColor} opacity={palette.strongOpacity} />
    </Canvas>
  );
});
