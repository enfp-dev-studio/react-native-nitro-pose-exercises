// Adapted from VisionCamera Worklets. Copyright (c) 2025 Marc Rousavy.
// Distributed under the MIT license in LICENSE-VisionCamera.
#include "HybridPoseCameraRuntime.hpp"

#include <NitroModules/Dispatcher.hpp>
#include <VisionCamera/HybridNativeThreadSpec.hpp>
#include <utility>
#ifdef ANDROID
#include <fbjni/fbjni.h>
#endif

namespace margelo::nitro::nitroposeexercises {
namespace {

// Both the Worklets event loop and Nitro callbacks may enqueue from C++ threads.
// Attach only for the Java scheduling call. The native camera thread still owns
// execution of the job, and runOnThread copies its callback before returning.
void enqueue(const std::shared_ptr<camera::HybridNativeThreadSpec>& thread,
             const std::function<void()>& job) {
#ifdef ANDROID
  facebook::jni::ThreadScope::WithClassLoader([&]() { thread->runOnThread(job); });
#else
  thread->runOnThread(job);
#endif
}

class PoseCameraAsyncQueue final : public ::worklets::AsyncQueue {
public:
  explicit PoseCameraAsyncQueue(std::shared_ptr<camera::HybridNativeThreadSpec> thread)
      : _thread(std::move(thread)) {}

  void push(std::function<void()>&& job) override {
    enqueue(_thread, job);
  }

private:
  // Retain the camera executor for the entire runtime queue lifetime.
  std::shared_ptr<camera::HybridNativeThreadSpec> _thread;
};

class PoseCameraDispatcher final : public Dispatcher {
public:
  explicit PoseCameraDispatcher(std::shared_ptr<camera::HybridNativeThreadSpec> thread)
      : _thread(std::move(thread)) {}

  void runSync(std::function<void()>&&) override {
    throw std::runtime_error("PoseCameraRuntime does not support synchronous dispatch");
  }

  void runAsync(std::function<void()>&& job) override {
    enqueue(_thread, job);
  }

private:
  std::shared_ptr<camera::HybridNativeThreadSpec> _thread;
};

} // namespace

HybridPoseCameraRuntime::HybridPoseCameraRuntime() : HybridObject(TAG) {}

std::shared_ptr<::worklets::AsyncQueue>
HybridPoseCameraRuntime::wrapThreadInQueue(const std::shared_ptr<camera::HybridNativeThreadSpec>& thread) {
  return std::make_shared<PoseCameraAsyncQueue>(thread);
}

void HybridPoseCameraRuntime::loadHybridMethods() {
  HybridPoseCameraRuntimeSpec::loadHybridMethods();
  registerHybrids(this, [](Prototype& prototype) {
    prototype.registerRawHybridMethod("installDispatcher", 1, &HybridPoseCameraRuntime::installDispatcher);
  });
}

facebook::jsi::Value HybridPoseCameraRuntime::installDispatcher(facebook::jsi::Runtime& runtime,
                                                               const facebook::jsi::Value&,
                                                               const facebook::jsi::Value* args,
                                                               size_t count) {
  if (count != 1) {
    throw facebook::jsi::JSError(runtime, "installDispatcher expects one camera thread");
  }
  auto thread = JSIConverter<std::shared_ptr<camera::HybridNativeThreadSpec>>::fromJSI(runtime, args[0]);
  Dispatcher::installRuntimeGlobalDispatcher(runtime, std::make_shared<PoseCameraDispatcher>(std::move(thread)));
  return facebook::jsi::Value::undefined();
}

} // namespace margelo::nitro::nitroposeexercises
