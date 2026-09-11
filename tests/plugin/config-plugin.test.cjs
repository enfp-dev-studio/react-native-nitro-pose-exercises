'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { compileModsAsync, withPlugins } = require('expo/config-plugins');
const withNitroPose = require('../../app.plugin.js');

const libraryRoot = path.resolve(__dirname, '../..');

function fixture(t, extra = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-pose-plugin-'));
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'pose-plugin-fixture', version: '1.0.0' }));
  fs.symlinkSync(path.join(libraryRoot, 'node_modules'), path.join(projectRoot, 'node_modules'), 'dir');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  return {
    config: { name: 'PosePluginFixture', slug: 'pose-plugin-fixture',
      ios: { bundleIdentifier: 'dev.example.poseplugin' },
      android: { package: 'dev.example.poseplugin' }, ...extra,
      _internal: { projectRoot } },
    projectRoot,
  };
}

async function introspect(config, projectRoot) {
  const result = await compileModsAsync(config, { projectRoot, introspect: true, platforms: ['android', 'ios'] });
  return result._internal.modResults;
}

function minSdk(mods) {
  return mods.android.gradleProperties.find(item => item.type === 'property' && item.key === 'android.minSdkVersion')?.value;
}

test('default plugin produces native camera, motion and minimum-SDK output', async t => {
  const { config, projectRoot } = fixture(t);
  const mods = await introspect(withNitroPose(config), projectRoot);
  const camera = mods.android.manifest.manifest['uses-permission'].filter(item => item.$['android:name'] === 'android.permission.CAMERA');
  assert.equal(camera.length, 1);
  assert.notEqual(camera[0].$['tools:node'], 'remove');
  assert.match(mods.ios.infoPlist.NSCameraUsageDescription, /카메라/);
  assert.match(mods.ios.infoPlist.NSMotionUsageDescription, /흔들림/);
  assert.equal(minSdk(mods), '26');
});

test('host permission wording wins over options and other permissions survive', async t => {
  const { config, projectRoot } = fixture(t, {
    ios: { infoPlist: { NSCameraUsageDescription: 'Host camera text', NSMotionUsageDescription: 'Host motion text', CustomValue: 'keep' } },
    android: { permissions: ['CAMERA', 'android.permission.VIBRATE'], blockedPermissions: ['RECORD_AUDIO'] },
  });
  const mods = await introspect(withNitroPose(config, { cameraPermission: 'Option camera', motionPermission: 'Option motion' }), projectRoot);
  assert.equal(mods.ios.infoPlist.NSCameraUsageDescription, 'Host camera text');
  assert.equal(mods.ios.infoPlist.NSMotionUsageDescription, 'Host motion text');
  assert.equal(mods.ios.infoPlist.CustomValue, 'keep');
  const permissions = mods.android.manifest.manifest['uses-permission'].map(item => item.$['android:name']);
  assert.equal(permissions.filter(permission => permission === 'android.permission.CAMERA').length, 1);
  assert.ok(permissions.includes('android.permission.VIBRATE'));
});

test('explicit permission options become native permission wording', async t => {
  const { config, projectRoot } = fixture(t);
  const mods = await introspect(withNitroPose(config, { cameraPermission: 'Measure exercise poses', motionPermission: 'Reject phone movement' }), projectRoot);
  assert.equal(mods.ios.infoPlist.NSCameraUsageDescription, 'Measure exercise poses');
  assert.equal(mods.ios.infoPlist.NSMotionUsageDescription, 'Reject phone movement');
});

test('higher host minimum and other build properties survive either plugin order', async t => {
  for (const ownFirst of [true, false]) {
    const buildOptions = { android: { minSdkVersion: 30, targetSdkVersion: 37, enableMinifyInReleaseBuilds: true }, ios: { useFrameworks: 'static' } };
    const { config, projectRoot } = fixture(t, { plugins: [
      ...(ownFirst ? [[withNitroPose, {}], ['expo-build-properties', buildOptions]] : [['expo-build-properties', buildOptions], [withNitroPose, {}]]),
    ] });
    const mods = await introspect(withPlugins(config, config.plugins), projectRoot);
    assert.equal(minSdk(mods), '30');
    assert.equal(mods.android.gradleProperties.find(item => item.key === 'android.targetSdkVersion')?.value, '37');
    assert.equal(mods.android.gradleProperties.find(item => item.key === 'android.enableMinifyInReleaseBuilds')?.value, 'true');
    assert.equal(mods.ios.podfileProperties?.['ios.useFrameworks'], 'static');
    assert.equal(buildOptions.android.minSdkVersion, 30);
  }
});

test('a lower configured minimum is raised without rewriting host plugin options', async t => {
  const buildOptions = { android: { minSdkVersion: 24 } };
  const { config, projectRoot } = fixture(t, { plugins: [['expo-build-properties', buildOptions], withNitroPose] });
  const mods = await introspect(withPlugins(config, config.plugins), projectRoot);
  assert.equal(minSdk(mods), '26');
  assert.equal(buildOptions.android.minSdkVersion, 24);
});

test('blocked CAMERA and malformed permission/minSDK configuration fail clearly', t => {
  for (const permission of ['CAMERA', 'android.permission.CAMERA']) {
    const { config } = fixture(t, { android: { blockedPermissions: [permission] } });
    assert.throws(() => withNitroPose(config), /CAMERA is explicitly blocked/);
  }
  const { config: emptyCopy } = fixture(t, { ios: { infoPlist: { NSCameraUsageDescription: '' } } });
  assert.throws(() => withNitroPose(emptyCopy), /NSCameraUsageDescription must be a non-empty string/);
  const { config: badMinimum } = fixture(t, { plugins: [['expo-build-properties', { android: { minSdkVersion: '26' } }]] });
  assert.throws(() => withNitroPose(badMinimum), /minSdkVersion must be a positive integer/);
  const { config: duplicate } = fixture(t, { plugins: ['expo-build-properties', 'expo-build-properties'] });
  assert.throws(() => withNitroPose(duplicate), /Duplicate expo-build-properties/);
  const { config: badOption } = fixture(t);
  assert.throws(() => withNitroPose(badOption, { cameraPermission: false }), /cameraPermission must be a non-empty string/);
});

test('repeating the package plugin does not duplicate native CAMERA entries', async t => {
  const { config, projectRoot } = fixture(t);
  const once = withNitroPose(config);
  const twice = withNitroPose(once);
  const mods = await introspect(twice, projectRoot);
  assert.equal(mods.android.manifest.manifest['uses-permission'].filter(item => item.$['android:name'] === 'android.permission.CAMERA').length, 1);
  assert.equal(minSdk(mods), '26');
});

test('prebuild mods preserve a higher existing native minimum and unrelated properties', async t => {
  const { config, projectRoot } = fixture(t);
  fs.mkdirSync(path.join(projectRoot, 'android'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'android/gradle.properties'), 'android.minSdkVersion=31\ncustom.property=kept\n');
  const prepared = withNitroPose(config);
  // Evaluate the official Gradle provider against a real native file. Other mods
  // are covered by introspection above; no Gradle/SDK installation is required.
  prepared.mods = { android: { gradleProperties: prepared.mods.android.gradleProperties } };
  await compileModsAsync(prepared, { projectRoot, platforms: ['android'] });
  const contents = fs.readFileSync(path.join(projectRoot, 'android/gradle.properties'), 'utf8');
  assert.match(contents, /^android\.minSdkVersion=31$/m);
  assert.match(contents, /^custom\.property=kept$/m);
});
