// Adapted from VisionCamera Worklets. Copyright (c) 2025 Marc Rousavy.
// Distributed under the MIT license in LICENSE-VisionCamera.
#pragma once

#include <NitroModules/JSIConverter.hpp>
#if __has_include(<worklets/RunLoop/AsyncQueue.h>)
#include <worklets/RunLoop/AsyncQueue.h>
#elif __has_include(<RNWorklets/worklets/RunLoop/AsyncQueue.h>)
#include <RNWorklets/worklets/RunLoop/AsyncQueue.h>
#else
#error "react-native-worklets native headers are required for PoseCameraRuntime"
#endif

// Nitro's JSIConverter for jsi::NativeState handles shared_ptr<AsyncQueue>.
