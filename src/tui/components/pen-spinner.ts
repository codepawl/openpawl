/**
 * Shimmer animation — decorative trail characters rotate in place.
 * The full trail is always visible at constant width; each frame is a
 * circular left-shift of the pattern. Loops through rotating trail patterns.
 */

const TRAILS = [
  [..."\u00b7\u02da\u2727"],  // ·˚✧
  [..."\u22b9\u00b7\u2726"],  // ⊹·✦
  [..."\u02da\u2082\u27e1"],  // ˚₊⟡
];

function buildFrames(trail: string[]): string[] {
  const frames: string[] = [];
  for (let i = 0; i < trail.length; i++) {
    frames.push([...trail.slice(i), ...trail.slice(0, i)].join(""));
  }
  return frames;
}

// Pre-build all frame sets
const ALL_FRAMES = TRAILS.map(buildFrames);

export function createPenAnimation(): () => string {
  let trailIndex = 0;
  let frameIndex = 0;

  return () => {
    const frames = ALL_FRAMES[trailIndex % ALL_FRAMES.length]!;
    const frame = frames[frameIndex % frames.length]!;
    frameIndex++;

    // Switch trail pattern after completing a full cycle
    if (frameIndex >= frames.length) {
      frameIndex = 0;
      trailIndex++;
    }

    return frame;
  };
}

/** Total frame count for one full cycle (all trail patterns). */
export const PEN_FRAME_COUNT = ALL_FRAMES.reduce((sum, f) => sum + f.length, 0);
