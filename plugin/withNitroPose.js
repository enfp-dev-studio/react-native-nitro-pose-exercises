'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');
const { name, version } = require('../package.json');

const CAMERA_PERMISSION = 'android.permission.CAMERA';
const MIN_ANDROID_SDK = 26;
const DEFAULT_CAMERA_COPY = '카메라로 운동 자세와 운동 횟수를 확인합니다.';
const DEFAULT_MOTION_COPY = '휴대폰의 흔들림을 확인해 운동 횟수의 오인식을 줄입니다.';

function fail(message) {
  throw new Error(`[${name}] ${message}`);
}

function permissionCopy(value, label) {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
    fail(`${label} must be a non-empty string.`);
  }
  return value;
}

function readOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('Plugin options must be an object with optional cameraPermission and motionPermission strings.');
  }
  for (const key of Object.keys(options)) {
    if (key !== 'cameraPermission' && key !== 'motionPermission') fail(`Unknown plugin option: ${key}.`);
  }
  return {
    cameraPermission: permissionCopy(options.cameraPermission, 'cameraPermission'),
    motionPermission: permissionCopy(options.motionPermission, 'motionPermission'),
  };
}

function isCameraPermission(permission) {
  return permission === 'CAMERA' || permission === CAMERA_PERMISSION;
}

function configuredMinSdk(config) {
  const entries = (config.plugins || []).filter(entry =>
    (Array.isArray(entry) ? entry[0] : entry) === 'expo-build-properties');
  if (entries.length > 1) fail('Duplicate expo-build-properties plugins must be consolidated.');
  const entry = entries[0];
  const options = Array.isArray(entry) ? entry[1] : undefined;
  const minimum = options?.android?.minSdkVersion;
  if (minimum !== undefined && (!Number.isInteger(minimum) || minimum <= 0)) {
    fail('expo-build-properties android.minSdkVersion must be a positive integer.');
  }
  return Math.max(MIN_ANDROID_SDK, minimum ?? 0);
}

function nativeMinSdk(properties) {
  const entries = properties.filter(item => item.type === 'property' && item.key === 'android.minSdkVersion');
  if (entries.length > 1) fail('Duplicate android.minSdkVersion entries in gradle.properties must be consolidated.');
  if (entries.length === 0) return 0;
  const value = entries[0].value;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    fail('android.minSdkVersion in gradle.properties must be a positive integer.');
  }
  return Number(value);
}

/**
 * @param {import('expo/config-plugins').ExpoConfig} config
 * @param {{ cameraPermission?: string, motionPermission?: string }} [options]
 */
function withNitroPose(config, options = {}) {
  // Resolve Expo from the receiving app, including pnpm's isolated dependency tree.
  // Loading this plugin never imports the React Native/Nitro runtime entry point.
  const projectRoot = config._internal?.projectRoot || process.cwd();
  const appRequire = createRequire(path.join(projectRoot, 'package.json'));
  const {
    AndroidConfig, createRunOncePlugin, withInfoPlist, withAndroidManifest, withBaseMod,
  } = appRequire('expo/config-plugins');
  const { withBuildProperties } = appRequire('expo-build-properties');

  return createRunOncePlugin((input, rawOptions) => {
    const props = readOptions(rawOptions);
    const minimum = configuredMinSdk(input);
    const blocked = input.android?.blockedPermissions || [];
    if (blocked.some(isCameraPermission)) {
      fail('CAMERA is explicitly blocked in android.blockedPermissions. Remove that conflict before enabling camera-based counting.');
    }
    const hostCameraCopy = permissionCopy(input.ios?.infoPlist?.NSCameraUsageDescription, 'ios.infoPlist.NSCameraUsageDescription');
    const hostMotionCopy = permissionCopy(input.ios?.infoPlist?.NSMotionUsageDescription, 'ios.infoPlist.NSMotionUsageDescription');

    input = withInfoPlist(input, mod => {
      mod.modResults.NSCameraUsageDescription = hostCameraCopy ?? props.cameraPermission
        ?? permissionCopy(mod.modResults.NSCameraUsageDescription, 'Info.plist NSCameraUsageDescription')
        ?? DEFAULT_CAMERA_COPY;
      mod.modResults.NSMotionUsageDescription = hostMotionCopy ?? props.motionPermission
        ?? permissionCopy(mod.modResults.NSMotionUsageDescription, 'Info.plist NSMotionUsageDescription')
        ?? DEFAULT_MOTION_COPY;
      return mod;
    });

    const permissions = input.android?.permissions || [];
    input = AndroidConfig.Permissions.withPermissions(input,
      permissions.some(isCameraPermission) ? [] : [CAMERA_PERMISSION]);
    input = withAndroidManifest(input, mod => {
      const removed = (mod.modResults.manifest['uses-permission'] || []).some(permission =>
        permission.$?.['android:name'] === CAMERA_PERMISSION && permission.$?.['tools:node'] === 'remove');
      if (removed) fail('AndroidManifest.xml explicitly removes CAMERA permission. Resolve that conflict before prebuild.');
      return mod;
    });

    // Let the official plugin write supported build properties. Existing host
    // plugin entries and unrelated Android/iOS properties remain untouched.
    input = withBuildProperties(input, { android: { minSdkVersion: minimum } });
    // Inspect parsed properties before and after the nested mods so an existing
    // higher value survives. Explicit host plugin minima are included above,
    // making their declaration order independent of this package's SDK floor.
    input = withBaseMod(input, {
      platform: 'android',
      mod: 'gradleProperties',
      async action({ modRequest: { nextMod, ...modRequest }, ...mod }) {
        const previousMinimum = nativeMinSdk(mod.modResults);
        const result = await nextMod({ ...mod, modRequest });
        const effectiveMinimum = Math.max(minimum, previousMinimum, nativeMinSdk(result.modResults));
        AndroidConfig.BuildProperties.updateAndroidBuildProperty(
          result.modResults, 'android.minSdkVersion', String(effectiveMinimum));
        return result;
      },
    });
    return input;
  }, name, version)(config, options);
}

module.exports = withNitroPose;
