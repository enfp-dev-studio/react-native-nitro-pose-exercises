import { useEffect, useMemo, useRef } from 'react';
import {
  CommonResolutions, VisionCamera,
  type CameraFrameOutput, type Frame, type FrameDroppedReason, type FrameOutputOptions,
} from 'react-native-vision-camera';
import {
  createSynchronizable, scheduleOnRuntime,
  type Synchronizable, type WorkletRuntime,
} from 'react-native-worklets';

import { createPoseCameraRuntime } from './runtime.ts';

export interface UsePoseFrameOutputProps extends Partial<FrameOutputOptions> {
  /**
   * Runs on the camera's serial worker. Return the Promise for asynchronous work;
   * the frame remains valid and the worker remains alive until it settles.
   * The hook owns and disposes the frame afterward. Never dispose it yourself,
   * or keep using it after the callback's returned Promise settles.
   * At most one callback is in flight; additional frames are discarded.
   * @worklet
   */
  onFrame?: (frame: Frame) => void | Promise<void>;
  onFrameDropped?: (reason: FrameDroppedReason) => void;
}

type RuntimeResources = {
  output: CameraFrameOutput;
  runtime: WorkletRuntime;
  registration: Synchronizable<number>;
  inFlight: Synchronizable<number>;
};

/**
 * Retain the runtime, its dispatcher, and output until callback removal and any
 * admitted Promise finish. Do not dispose a camera-owned output here: effect
 * replay may reuse it, and the Camera session owns its native connection.
 */
async function retainUntilDrained(
  resources: RuntimeResources,
  detached: Synchronizable<boolean>,
): Promise<void> {
  while (!detached.getBlocking() || resources.inFlight.getBlocking() !== 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Camera output backed by this package's JNI-safe queue and Nitro dispatcher.
 * Frame buffers remain native; asynchronous inference never blocks the camera
 * worker while waiting for a result. Requires the host Worklets Babel transform.
 */
export function usePoseFrameOutput({
  targetResolution = CommonResolutions.VGA_4_3,
  pixelFormat = 'yuv',
  dropFramesWhileBusy = true,
  enableCameraMatrixDelivery = false,
  enablePhysicalBufferRotation = false,
  enablePreviewSizedOutputBuffers = false,
  allowDeferredStart = true,
  onFrame,
  onFrameDropped,
}: UsePoseFrameOutputProps): CameraFrameOutput {
  const output = useMemo(() => VisionCamera.createFrameOutput({
    targetResolution, pixelFormat, dropFramesWhileBusy,
    enableCameraMatrixDelivery, enablePhysicalBufferRotation,
    enablePreviewSizedOutputBuffers, allowDeferredStart,
  }), [targetResolution, pixelFormat, dropFramesWhileBusy,
    enableCameraMatrixDelivery, enablePhysicalBufferRotation,
    enablePreviewSizedOutputBuffers, allowDeferredStart]);

  const resources = useMemo<RuntimeResources>(() => ({
    output,
    runtime: createPoseCameraRuntime(output.thread),
    registration: createSynchronizable(0),
    inFlight: createSynchronizable(0),
  }), [output]);

  const droppedCallback = useRef(onFrameDropped);
  droppedCallback.current = onFrameDropped;
  useEffect(() => {
    output.setOnFrameDroppedCallback((reason) => droppedCallback.current?.(reason));
    return () => output.setOnFrameDroppedCallback(undefined);
  }, [output]);

  useEffect(() => {
    const { runtime, registration, inFlight } = resources;
    const revision = registration.getBlocking() + 1;
    registration.setBlocking(revision);
    scheduleOnRuntime(runtime, () => {
      'worklet';
      if (registration.getBlocking() !== revision) return;
      if (!onFrame) {
        output.setOnFrameCallback(undefined);
        return;
      }
      output.setOnFrameCallback((frame) => {
        if (registration.getBlocking() !== revision || inFlight.getBlocking() !== 0) {
          frame.dispose();
          return true;
        }
        inFlight.setBlocking(1);
        let completed = false;
        const complete = () => {
          'worklet';
          if (completed) return;
          completed = true;
          try {
            frame.dispose();
          } catch (cause) {
            console.error('Pose frame release failed:', String(cause));
          } finally {
            inFlight.setBlocking(0);
          }
        };
        const reject = (cause: unknown) => {
          'worklet';
          try { console.error('Pose frame callback failed:', String(cause)); }
          finally { complete(); }
        };
        try {
          const pending = onFrame(frame);
          if (pending && typeof pending.then === 'function') {
            pending.then(complete, reject);
          } else {
            complete();
          }
        } catch (cause) {
          reject(cause);
        }
        return true;
      });
    });

    return () => {
      // Invalidate synchronously before queued removal so no new frame can be
      // admitted through an old callback while an existing result completes.
      const removalRevision = registration.getBlocking() + 1;
      registration.setBlocking(removalRevision);
      const detached = createSynchronizable(false);
      scheduleOnRuntime(runtime, () => {
        'worklet';
        // A newer effect may already have registered a replacement callback.
        if (registration.getBlocking() === removalRevision) {
          output.setOnFrameCallback(undefined);
        }
        detached.setBlocking(true);
      });
      void retainUntilDrained(resources, detached);
    };
  }, [onFrame, output, resources]);

  return output;
}
