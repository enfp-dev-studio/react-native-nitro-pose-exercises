export type SkeletonTheme = {
  /** Six- or eight-digit hexadecimal color. */
  boneColor: string;
  /** Six- or eight-digit hexadecimal color. */
  jointColor: string;
  /** Logical pixels; independent of camera resolution and display pixel density. */
  strokeWidth: number;
  jointRadius: number;
  strongOpacity: number;
  weakOpacity: number;
};

export const DEFAULT_SKELETON_THEME: Readonly<SkeletonTheme> = Object.freeze({
  boneColor: '#66E3E7',
  jointColor: '#FFFFFF',
  strokeWidth: 2.5,
  jointRadius: 3,
  strongOpacity: 0.94,
  weakOpacity: 0.28,
});

/** A fixed palette communicates tracking confidence without encoding exercise depth. */
export function resolveSkeletonTheme(overrides: Partial<SkeletonTheme> = {}): SkeletonTheme {
  const color = (value: string | undefined, fallback: string) =>
    typeof value === 'string' && /^#[\da-f]{6}([\da-f]{2})?$/i.test(value) ? value : fallback;
  const size = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  const opacity = (value: number | undefined, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  const strongOpacity = opacity(overrides.strongOpacity, DEFAULT_SKELETON_THEME.strongOpacity);
  return {
    boneColor: color(overrides.boneColor, DEFAULT_SKELETON_THEME.boneColor),
    jointColor: color(overrides.jointColor, DEFAULT_SKELETON_THEME.jointColor),
    strokeWidth: size(overrides.strokeWidth, DEFAULT_SKELETON_THEME.strokeWidth),
    jointRadius: size(overrides.jointRadius, DEFAULT_SKELETON_THEME.jointRadius),
    strongOpacity,
    weakOpacity: Math.min(strongOpacity, opacity(overrides.weakOpacity, DEFAULT_SKELETON_THEME.weakOpacity)),
  };
}
