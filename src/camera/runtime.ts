import { NitroModules } from 'react-native-nitro-modules';
import type { NativeThread } from 'react-native-vision-camera';
import { createWorkletRuntime, type WorkletRuntime } from 'react-native-worklets';

import type { PoseCameraRuntime } from '../PoseCameraRuntime.nitro.ts';

type CameraRuntimeFactory = PoseCameraRuntime & {
  /** Raw JSI method: installs a dispatcher into the calling JavaScript runtime. */
  installDispatcher(thread: NativeThread): void;
};

let factory: CameraRuntimeFactory | undefined;

/** The queue and Nitro completions both target the camera's serial native thread. */
export function createPoseCameraRuntime(thread: NativeThread): WorkletRuntime {
  factory ??= NitroModules.createHybridObject<CameraRuntimeFactory>('PoseCameraRuntime');
  const nativeFactory = factory;
  const queue = nativeFactory.wrapThreadInQueue(thread);
  return createWorkletRuntime({
    name: `pose-${thread.id}`,
    queue,
    initializer: () => {
      'worklet';
      // Failure must abort runtime creation; async inference needs this dispatcher.
      nativeFactory.installDispatcher(thread);
    },
  });
}
