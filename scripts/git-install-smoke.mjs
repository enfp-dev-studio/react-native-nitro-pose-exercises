import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const own = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const baseline = JSON.parse(readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
assert.ok(process.argv.slice(2).every(arg => ['--yarn', '--keep-temp'].includes(arg)), 'Usage: node scripts/git-install-smoke.mjs [--yarn] [--keep-temp]');
const useYarn = process.argv.includes('--yarn');
const keep = process.argv.includes('--keep-temp');
const temp = mkdtempSync(path.join(os.tmpdir(), 'nitro-pose-git-install-'));
const source = path.join(temp, 'source');
const app = path.join(temp, 'app');
const saveJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
// Exercise ordinary installs even when the caller used a Corepack-check workaround.
const env = { ...process.env };
delete env.SKIP_YARN_COREPACK_CHECK;
delete env.COREPACK_ROOT;
const run = (command, args, cwd, extra = {}) => execFileSync(command, args, {
  cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...extra,
});

try {
  mkdirSync(source);
  mkdirSync(app);
  const manager = useYarn ? 'yarn@1.22.22' : baseline.packageManager;
  const command = useYarn ? 'yarn' : 'pnpm';
  assert.equal(`${command}@${run(command, ['--version'], temp).trim()}`, manager);
  assert.equal(own.scripts?.prepare, 'bob build', 'Git dependencies must build through the standard prepare lifecycle');

  // Copy the real working source, including new files and excluding deleted ones.
  // Never seed the Git dependency with this checkout's generated JS or installed deps.
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean);
  for (const relative of new Set(files)) {
    if (relative.startsWith('lib/') || relative.split('/').includes('node_modules')) continue;
    const from = path.join(root, relative);
    let stat;
    try { stat = lstatSync(from); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const to = path.join(source, relative);
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { dereference: false, verbatimSymlinks: true });
  }
  assert.equal(existsSync(path.join(source, 'lib')), false, 'Snapshot must contain no built library');
  run('git', ['init', '--quiet', '--initial-branch=codex/git-install-smoke'], source);
  const gitOptions = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Nitro Pose Git Install Test', '-c', 'user.email=git-install-test@example.invalid'];
  run('git', [...gitOptions, 'add', '--all'], source);
  run('git', [...gitOptions, 'commit', '--quiet', '-m', 'Snapshot source for local Git installation test'], source);
  const commit = run('git', ['rev-parse', 'HEAD'], source).trim();
  const repository = `git+${pathToFileURL(source).href}`;
  const dependency = `${repository}#${commit}`;
  saveJson(path.join(app, 'package.json'), {
    name: 'git-install-expo-smoke', private: true, packageManager: manager,
    dependencies: { ...baseline.hostDependencies, ...baseline.runtimeDependencies, [own.name]: dependency },
  });
  saveJson(path.join(app, 'app.json'), {
    expo: { name: 'Git Install Smoke', slug: 'git-install-smoke', plugins: [own.name] },
  });
  if (!useYarn) {
    writeFileSync(path.join(app, 'pnpm-workspace.yaml'),
      `packages:
  - "."
allowBuilds:
  "@shopify/react-native-skia": true
  ${JSON.stringify(`${own.name}@${repository}`)}: true
`);
  }
  process.stdout.write(`Installing a source-only local Git dependency with ${manager}...\n`);
  run(command, ['install', useYarn ? '--non-interactive' : '--no-frozen-lockfile'], app, { stdio: 'inherit' });
  if (useYarn) {
    run('yarn', ['check', '--integrity'], app, { stdio: 'inherit' });
    for (const [name, version] of Object.entries({ ...baseline.hostDependencies, ...baseline.runtimeDependencies })) {
      const installedPeer = JSON.parse(readFileSync(path.join(app, 'node_modules', name, 'package.json'), 'utf8'));
      assert.equal(installedPeer.version, version, `Unexpected installed version of ${name}`);
    }
  } else {
    run('pnpm', ['peers', 'check'], app, { stdio: 'inherit' });
  }

  const installed = path.join(app, 'node_modules', own.name);
  const manifest = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, own.name);
  assert.equal(manifest.version, own.version);
  for (const entry of ['.', './counter', './overlay', './camera']) {
    for (const condition of ['source', 'types', 'default']) {
      const target = manifest.exports?.[entry]?.[condition];
      assert.equal(typeof target, 'string', `Missing ${entry} ${condition} export`);
      assert.ok(existsSync(path.join(installed, target)), `Missing generated/exported file: ${target}`);
    }
  }
  for (const relative of [
    'NitroPoseExercises.podspec', 'android/build.gradle', 'ios/NitroPoseExercises.swift',
    'src/NitroPoseExercises.nitro.ts', 'src/PoseCameraRuntime.nitro.ts', 'nitro.json',
    'nitrogen/generated/shared/c++/HybridNitroPoseExercisesSpec.hpp',
    'nitrogen/generated/shared/c++/HybridPoseCameraRuntimeSpec.hpp',
    'cpp/HybridPoseCameraRuntime.cpp', 'cpp/HybridPoseCameraRuntime.hpp',
    'cpp/PoseCameraQueue.hpp', 'cpp/LICENSE-VisionCamera', 'app.plugin.js',
  ]) assert.ok(existsSync(path.join(installed, relative)), `Missing native/plugin source: ${relative}`);
  assert.equal(existsSync(path.join(installed, 'dependency-patches')), false);
  assert.equal(existsSync(path.join(app, 'patches')), false);
  assert.equal(existsSync(path.join(app, 'node_modules', 'react-native-vision-camera-worklets')), false);
  run(process.execPath, ['--input-type=module', '-e',
    `const { createReferencePushupState } = await import(${JSON.stringify(`${own.name}/counter`)}); if (createReferencePushupState('full').mode !== 'full') throw new Error('Invalid counter export');`,
  ], app);

  const config = JSON.parse(run(process.execPath, [
    path.join(app, 'node_modules', 'expo', 'bin', 'cli'), 'config', '--type', 'introspect', '--json',
  ], app, { timeout: 30000, env: { ...env, EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1' } }));
  assert.equal(config.plugins.filter(entry => (Array.isArray(entry) ? entry[0] : entry) === own.name).length, 1);
  const mods = config._internal?.modResults;
  for (const permission of ['NSCameraUsageDescription', 'NSMotionUsageDescription']) {
    assert.equal(typeof mods?.ios?.infoPlist?.[permission], 'string', `Missing evaluated ${permission}`);
    assert.ok(mods.ios.infoPlist[permission].trim());
  }
  assert.ok(mods?.android?.manifest?.manifest?.['uses-permission']?.some(entry =>
    entry.$?.['android:name'] === 'android.permission.CAMERA' && entry.$?.['tools:node'] !== 'remove'),
  'Missing evaluated Android camera permission');
  const minimum = mods?.android?.gradleProperties?.find(entry =>
    entry.type === 'property' && entry.key === 'android.minSdkVersion')?.value;
  assert.ok(Number(minimum) >= baseline.androidMinSdk, 'Missing evaluated Android minimum SDK');
  process.stdout.write('Git prepare output, native/public exports, pure counter import and Expo plugin introspection passed.\n');
  process.stdout.write('This local git+file check does not verify remote Git HTTPS transport, native builds, camera operation or exercise accuracy.\n');
} finally {
  if (keep) process.stdout.write(`Retained test fixture: ${temp}\n`);
  else rmSync(temp, { recursive: true, force: true });
}
