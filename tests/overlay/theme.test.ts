import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SKELETON_THEME, resolveSkeletonTheme } from '../../src/overlay/theme.ts';

test('invalid dimensions and colors cannot reach the native renderer', () => {
  const theme = resolveSkeletonTheme({
    strokeWidth: -2, jointRadius: Infinity, boneColor: 'not a color', jointColor: '',
  });
  assert.deepEqual(theme, DEFAULT_SKELETON_THEME);
});

test('custom palettes preserve confidence ordering and clamp opacity', () => {
  const theme = resolveSkeletonTheme({
    boneColor: '#48abcD', jointColor: '#F8FAFCcc',
    strongOpacity: 0.5, weakOpacity: 1.5, strokeWidth: 1.5, jointRadius: 2,
  });
  assert.equal(theme.boneColor, '#48abcD');
  assert.equal(theme.jointColor, '#F8FAFCcc');
  assert.equal(theme.strongOpacity, 0.5);
  assert.equal(theme.weakOpacity, 0.5);
  assert.equal(theme.strokeWidth, 1.5);
  assert.equal(theme.jointRadius, 2);
  assert.equal(resolveSkeletonTheme({ strongOpacity: -1, weakOpacity: 2 }).weakOpacity, 0);
});
