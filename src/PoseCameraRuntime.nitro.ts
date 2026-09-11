import type { CustomType, HybridObject } from 'react-native-nitro-modules';
import type { NativeThread } from 'react-native-vision-camera';

/** Opaque native queue accepted by Worklets' createWorkletRuntime. */
export type PoseCameraQueue = CustomType<
  object,
  'std::shared_ptr<::worklets::AsyncQueue>',
  {
    canBePassedByReference: true;
    include: 'PoseCameraQueue.hpp';
  }
>;

/** Internal runtime adapter; camera frames keep their original native thread. */
export interface PoseCameraRuntime extends HybridObject<{
  ios: 'c++';
  android: 'c++';
}> {
  wrapThreadInQueue(thread: NativeThread): PoseCameraQueue;
  // installDispatcher is a raw JSI method because it configures the calling runtime.
}
