import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const own = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const filename = `${own.name.replace('@', '').replace('/', '-')}-${own.version}.tgz`;
const temp = mkdtempSync(path.join(os.tmpdir(), 'nitro-pose-packed-'));
const artifact = path.join(temp, filename);
assert.equal(process.argv.length, 2, 'Usage: node scripts/pack-smoke.mjs');

try {
  execFileSync('pnpm', ['pack', '--pack-destination', temp], { cwd: root, stdio: 'inherit' });
  execFileSync('tar', ['-xzf', artifact, '-C', temp]);
  const packed = path.join(temp, 'package');
  const packedManifest = JSON.parse(readFileSync(path.join(packed, 'package.json'), 'utf8'));
  assert.equal(packedManifest.name, own.name);
  assert.equal(packedManifest.version, own.version);
  for (const relative of [
    'LICENSE', 'NitroPoseExercises.podspec', 'android/build.gradle',
    'src/NitroPoseExercises.nitro.ts', 'ios/NitroPoseExercises.swift',
    'android/src/main/java/com/margelo/nitro/nitroposeexercises/NitroPoseExercises.kt',
    'nitrogen/generated/shared/c++/HybridNitroPoseExercisesSpec.hpp',
    'cpp/HybridPoseCameraRuntime.cpp', 'cpp/HybridPoseCameraRuntime.hpp',
    'cpp/PoseCameraQueue.hpp', 'cpp/LICENSE-VisionCamera',
    'src/PoseCameraRuntime.nitro.ts',
    'nitrogen/generated/shared/c++/HybridPoseCameraRuntimeSpec.hpp',
    'nitrogen/generated/shared/c++/HybridPoseCameraRuntimeSpec.cpp',
    'lib/module/counter/index.js', 'lib/typescript/src/counter/index.d.ts',
    'lib/module/overlay/index.js', 'lib/typescript/src/overlay/index.d.ts',
    'lib/module/camera/index.js', 'lib/typescript/src/camera/index.d.ts',
    'compatibility.json', 'README.md', 'app.plugin.js',
  ]) assert.ok(existsSync(path.join(packed, relative)), `Missing packed file: ${relative}`);
  for (const entry of ['./camera', './counter', './overlay', './app.plugin.js']) {
    assert.ok(packedManifest.exports[entry], `Missing public export: ${entry}`);
  }
  const app = path.join(temp, 'app');

  // The counter entry remains importable without a React Native runtime.
  mkdirSync(path.join(app, 'node_modules', '@enfp-dev-studio'), { recursive: true });
  symlinkSync(packed, path.join(app, 'node_modules', own.name));
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { createReferencePushupState } from '${own.name}/counter'; if (createReferencePushupState('full').mode !== 'full') throw new Error('Invalid counter export');`,
  ], { cwd: app });
  process.stdout.write('Packed native files, public exports and isolated pure counter import passed.\n');
  process.stdout.write('This check does not build a native binary or verify camera runtime or repetition accuracy.\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
