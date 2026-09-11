// Adapted from VisionCamera Worklets. Copyright (c) 2025 Marc Rousavy.
// Distributed under the MIT license in LICENSE-VisionCamera.
#pragma once

#include "HybridPoseCameraRuntimeSpec.hpp"
#include "PoseCameraQueue.hpp"

namespace margelo::nitro::nitroposeexercises {

class HybridPoseCameraRuntime final : public HybridPoseCameraRuntimeSpec {
public:
  HybridPoseCameraRuntime();

  std::shared_ptr<::worklets::AsyncQueue>
  wrapThreadInQueue(const std::shared_ptr<camera::HybridNativeThreadSpec>& thread) override;

  void loadHybridMethods() override;
  facebook::jsi::Value installDispatcher(facebook::jsi::Runtime& runtime,
                                         const facebook::jsi::Value& thisValue,
                                         const facebook::jsi::Value* args,
                                         size_t count);
};

} // namespace margelo::nitro::nitroposeexercises
