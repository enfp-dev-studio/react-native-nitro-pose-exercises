import { useCallback, useEffect, useId, useMemo, useRef } from 'react';
import { Platform, StyleSheet } from 'react-native';
import type { Landmark, NitroPoseExercises } from '@enfp-dev-studio/react-native-nitro-pose-exercises';
import { usePoseFrameOutput } from '@enfp-dev-studio/react-native-nitro-pose-exercises/camera';
import {
  advanceReferencePoseTracker, applyPosePreviewTransform,
  createPosePreviewTransform, createReferencePoseTrackerState,
  updateReferencePushupCounter,
  type PoseFrameMetadata, type PosePoint, type PosePreviewTransform,
  type ReferencePoseTrackerState, type ReferencePushupPhase, type ReferencePushupState,
} from '@enfp-dev-studio/react-native-nitro-pose-exercises/counter';
import {
  EMPTY_SKELETON_PREVIEW_FRAME, PoseSkeleton, type SkeletonPoint,
} from '@enfp-dev-studio/react-native-nitro-pose-exercises/overlay';
import { useSharedValue } from 'react-native-reanimated';
import {
  Camera, CommonResolutions,
  type CameraDevice, type CameraRef, type Frame,
} from 'react-native-vision-camera';
import { createSynchronizable, scheduleOnRN, type Synchronizable } from 'react-native-worklets';

export type CounterStatus = {
  phase: ReferencePushupPhase; armsVisible: boolean; angle: number; reasons: string[];
};
export const EMPTY_COUNTER_STATUS: CounterStatus = {
  phase: 'waitingForUp', armsVisible: false, angle: 180, reasons: [],
};
type RuntimePoseState = {
  sessionId: string; counter: ReferencePushupState; tracker: ReferencePoseTrackerState; statusAt: number;
  iosDisplayLandmarks: Landmark[] | null;
};
function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function reportInferenceFailure(message: string) {
  console.warn('Pose inference failed; waiting for next frame:', message);
}

type PreviewGeometry = {
  key: string; revision: number; metadata: PoseFrameMetadata;
  cameraBasis: [PosePoint, PosePoint, PosePoint];
};

type PreviewTransform = PosePreviewTransform & { key: string; width: number; height: number };

export function PoseCamera({ device, engine, frameBusy, enabled, active, onError, counter, counterStatus, onCount, onStatus }: {
  device: CameraDevice; engine: NitroPoseExercises; frameBusy: Synchronizable<boolean>;
  enabled: Synchronizable<boolean>; active: boolean; onError: (message: string) => void;
  counter: Synchronizable<ReferencePushupState>;
  counterStatus: Synchronizable<CounterStatus>; onCount: (count: number) => void; onStatus: (message: string) => void;
}) {
  const isIOS = Platform.OS === 'ios';
  const isFrontCamera = device.position === 'front';
  const runtimeSessionId = useId();
  const camera = useRef<CameraRef>(null);
  const previewFrame = useSharedValue(EMPTY_SKELETON_PREVIEW_FRAME);
  const viewport = useMemo(() => createSynchronizable({ width: 0, height: 0, revision: 0 }), []);
  const transform = useMemo(() => createSynchronizable<PreviewTransform | null>(null), []);
  const geometry = useMemo(() => createSynchronizable<PreviewGeometry | null>(null), []);
  const geometryVersion = useMemo(() => createSynchronizable(0), []);
  const frameError = useMemo(() => createSynchronizable(''), []);

  useEffect(() => {
    if (!active) return;
    try { engine.startReferenceMotion(); }
    catch (cause) { onError(`Motion sensor: ${messageOf(cause)}`); }
    return () => engine.stopReferenceMotion();
  }, [active, engine, onError]);

  const invalidatePreview = useCallback(() => {
    const previous = viewport.getBlocking();
    viewport.setBlocking({ ...previous, revision: previous.revision + 1 });
    transform.setBlocking(null);
    geometry.setBlocking(null);
    geometryVersion.setBlocking(0);
    previewFrame.set(EMPTY_SKELETON_PREVIEW_FRAME);
  }, [geometry, geometryVersion, previewFrame, transform, viewport]);

  useEffect(() => {
    invalidatePreview();
    if (!active) return;
    let animation = 0;
    let consumedGeometryVersion = 0;
    // RN only calibrates a changed camera/layout transform and handles failures.
    // Fresh pose coordinates never pass through this requestAnimationFrame loop.
    const update = () => {
      animation = requestAnimationFrame(update);
      const failure = frameError.getBlocking();
      if (failure) {
        frameError.setBlocking('');
        onError(failure);
        return;
      }
      if (isIOS) return;
      const version = geometryVersion.getBlocking();
      if (!version || version === consumedGeometryVersion || !camera.current) return;
      const request = geometry.getBlocking();
      const size = viewport.getBlocking();
      if (!request || request.revision !== size.revision || size.width <= 0 || size.height <= 0) return;
      try {
        const basis = request.cameraBasis.map(point =>
          camera.current!.convertCameraPointToViewPoint(point)) as [PosePoint, PosePoint, PosePoint];
        const next = createPosePreviewTransform(request.metadata, basis);
        if (!next || viewport.getBlocking().revision !== request.revision
          || geometryVersion.getBlocking() !== version) return;
        transform.setBlocking({ ...next, key: request.key, width: size.width, height: size.height });
        consumedGeometryVersion = version;
      } catch {
        // The native preview transform can be unavailable during startup/layout.
        // Retry calibration on the next RN frame; no pose coordinate work is queued.
      }
    };
    animation = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(animation);
      invalidatePreview();
    };
  }, [active, frameError, geometry, geometryVersion, invalidatePreview, isIOS, onError, transform, viewport]);

  const onFrame = useCallback((frame: Frame) => {
    'worklet';
    if (frameBusy.getBlocking()) return;
    frameBusy.setBlocking(true);
    let admissionReleased = false;
    const releaseAdmission = () => {
      'worklet';
      if (admissionReleased) return;
      admissionReleased = true;
      // usePoseFrameOutput owns the Frame until this callback/Promise finishes.
      frameBusy.setBlocking(false);
    };
    const failFrame = (cause: unknown) => {
      'worklet';
      enabled.setBlocking(false);
      frameError.setBlocking(String(cause));
    };
    try {
      if (!enabled.getBlocking()) { releaseAdmission(); return; }
      const revision = viewport.getBlocking().revision;
      const beforeVersion = engine.resultVersion;
      if (!Number.isFinite(beforeVersion)) {
        throw new Error('Rebuild the app with the maintained native pose module.');
      }
      const publish = () => {
        'worklet';
        try {
          const processedAt = performance.now();
          const id = engine.resultVersion;
          // A skipped call or inference failure must never refresh cached coordinates.
          // An unchanged pose from a NEW inference is still a fresh result.
          // Stop blocks new admissions, but finish() drains this already-started
          // result into the final count. Visibility only gates the preview below.
          if (id === beforeVersion) return;
          const landmarks = engine.landmarks;
          // These histories belong to this one Camera Worker. Serializing them
          // across runtimes every frame costs more than the actual pose math.
          const runtime = globalThis as typeof globalThis & { __maintainedPoseValidation?: RuntimePoseState };
          let local = runtime.__maintainedPoseValidation;
          if (!local || local.sessionId !== runtimeSessionId) {
            local = { sessionId: runtimeSessionId, counter: counter.getBlocking(),
              tracker: createReferencePoseTrackerState(), statusAt: 0, iosDisplayLandmarks: null };
            runtime.__maintainedPoseValidation = local;
          }
          const previousCounter = local.counter;
          const tracked = advanceReferencePoseTracker(local.tracker, {
            resultId: id, timeMs: processedAt, landmarks,
            shoulderWidthBaseline: previousCounter.shoulderWidthBaseline,
          });
          local.tracker = tracked.state;
          const result = updateReferencePushupCounter(previousCounter, {
            observation: tracked.observation, mode: previousCounter.mode,
            deviceMotion: engine.motionPeak - engine.motionBaseline,
          });
          local.counter = result.state;
          // Publish the accepted total before releasing busy, so finish() can
          // read it even if its RN callback has not run yet.
          if (result.accepted) counter.setBlocking(result.state);
          if (processedAt - local.statusAt >= 100 || result.event === 'accepted' || result.event === 'rejected') {
            counterStatus.setBlocking({ phase: result.phase,
              armsVisible: result.features?.armsVisible ?? false, angle: result.state.filteredAngle,
              reasons: result.reasons });
            local.statusAt = processedAt;
          }
          if (result.accepted) scheduleOnRN(onCount, result.reps);

          if (!enabled.getBlocking() || viewport.getBlocking().revision !== revision) return;
          if (isIOS) {
            const previous = local.iosDisplayLandmarks;
            const smoothed = landmarks.length === 0 ? null : landmarks.map((landmark, index) => {
              const point = previous?.[index];
              if (!point) return landmark;
              const alpha = Math.max(0.2, Math.min(0.7, landmark.visibility));
              return {
                x: point.x + (landmark.x - point.x) * alpha,
                y: point.y + (landmark.y - point.y) * alpha,
                z: 0,
                visibility: landmark.visibility,
              };
            });
            local.iosDisplayLandmarks = smoothed;
            const size = viewport.getBlocking();
            const points: SkeletonPoint[] = [];
            if (smoothed && size.width !== 0 && frame.width !== 0) {
              for (let index = 11; index < smoothed.length; index++) {
                const landmark = smoothed[index];
                if (!landmark) continue;
                const threshold = index >= 27 && index <= 32 ? 0.5 : 0.1;
                if (landmark.visibility < threshold) continue;
                const x = isFrontCamera ? (1 - landmark.x) * size.width : landmark.x * size.width;
                const y = landmark.y * size.height;
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                points.push({ index, x, y, strength: 'strong' });
              }
            }
            if (!enabled.getBlocking() || viewport.getBlocking().revision !== revision) return;
            previewFrame.set({ id, points, message: points.length ? '' : 'Looking for body landmarks…',
              processedAt });
            return;
          }
          const metadata: PoseFrameMetadata = {
            width: frame.width, height: frame.height, orientation: frame.orientation,
            isMirrored: frame.isMirrored, platform: isIOS ? 'ios' : 'android',
          };
          // Frame-to-sensor geometry stays associated with this exact inference.
          // Include the basis in the cache key, so sensor crop/zoom changes cannot
          // reuse a stale transform even when width and orientation stay unchanged.
          const cameraBasis: [PosePoint, PosePoint, PosePoint] = [
            frame.convertFramePointToCameraPoint({ x: 0, y: 0 }),
            frame.convertFramePointToCameraPoint({ x: frame.width, y: 0 }),
            frame.convertFramePointToCameraPoint({ x: 0, y: frame.height }),
          ];
          const key = [metadata.platform, metadata.width, metadata.height, metadata.orientation,
            metadata.isMirrored, revision, cameraBasis[0].x, cameraBasis[0].y,
            cameraBasis[1].x, cameraBasis[1].y, cameraBasis[2].x, cameraBasis[2].y].join(':');
          const cached = transform.getBlocking();
          if (!cached || cached.key !== key) {
            if (geometry.getBlocking()?.key !== key) {
              geometry.setBlocking({ key, revision, metadata, cameraBasis });
              geometryVersion.setBlocking(id);
            }
            previewFrame.set({ id, points: [], message: 'Preparing preview transform…',
              processedAt });
            return;
          }

          const points: SkeletonPoint[] = [];
          for (const raw of tracked.observation.strong) {
            const point = applyPosePreviewTransform(raw, cached);
            if (point) points.push({ index: raw.index, ...point, strength: 'strong' });
          }
          for (const raw of tracked.observation.weak) {
            const point = applyPosePreviewTransform(raw, cached);
            if (point) points.push({ index: raw.index, ...point, strength: 'weak' });
          }
          if (!enabled.getBlocking() || viewport.getBlocking().revision !== revision) return;
          // Reanimated's shareable setter schedules directly on its host UI runtime.
          // No RN callback, RN rAF polling, or per-pose React state update in this path.
          previewFrame.set({ id, points, message: points.length ? '' : 'Looking for body landmarks…',
            processedAt });
        } catch (cause) {
          failFrame(cause);
        } finally { releaseAdmission(); }
      };
      if (isIOS) {
        engine.processFrameIOS(frame);
        publish();
      } else {
        // Keep ImageProxy alive until ML Kit completes. The analyzer can return
        // immediately while CameraX drops older frames with KEEP_ONLY_LATEST.
        return engine.processFrameAndroidAsync(frame).then(publish, (cause: unknown) => {
          'worklet';
          try { scheduleOnRN(reportInferenceFailure, String(cause)); }
          finally { releaseAdmission(); }
        });
      }
    } catch (cause) {
      try { failFrame(cause); }
      finally { releaseAdmission(); }
    }
  }, [counter, counterStatus, enabled, engine, frameBusy, frameError, geometry, geometryVersion,
    isFrontCamera, isIOS, onCount, previewFrame, runtimeSessionId, transform, viewport]);

  const output = usePoseFrameOutput({
    pixelFormat: 'yuv',
    targetResolution: isIOS ? CommonResolutions.HD_16_9 : CommonResolutions.VGA_4_3,
    onFrame,
  });
  const outputs = useMemo(() => [output], [output]);
  const onLayout = useCallback<NonNullable<React.ComponentProps<typeof Camera>['onLayout']>>(event => {
    const { width, height } = event.nativeEvent.layout;
    const previous = viewport.getBlocking();
    if (previous.width === width && previous.height === height) return;
    viewport.setBlocking({ width, height, revision: previous.revision + 1 });
    transform.setBlocking(null);
    previewFrame.set(EMPTY_SKELETON_PREVIEW_FRAME);
  }, [previewFrame, transform, viewport]);
  const onCameraError = useCallback<NonNullable<React.ComponentProps<typeof Camera>['onError']>>(
    cause => onError(cause.message), [onError]);
  return <>
    <Camera ref={camera} style={StyleSheet.absoluteFill} device={device} isActive={active}
      {...(!isIOS && { implementationMode: 'compatible' as const, resizeMode: 'cover' as const,
        orientationSource: 'interface' as const })}
      onLayout={onLayout} onPreviewStopped={invalidatePreview} onPreviewStarted={invalidatePreview}
      outputs={outputs} onError={onCameraError} />
    {active && <PoseSkeleton frame={previewFrame} enabled={enabled} onBadge={onStatus} />}
  </>;
}
