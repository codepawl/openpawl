/**
 * Cursor pulse — soft brightness oscillation for the prompt cursor.
 * Cycles between bright and slightly dim at ~12fps. Not the aggressive
 * ANSI blink — a smooth custom pulse.
 */

const STEP = 0.15;
const MIN_BRIGHTNESS = 0.4;
const MAX_BRIGHTNESS = 1.0;
const INTERVAL_MS = 80;

export class CursorPulse {
  private interval: ReturnType<typeof setInterval> | null = null;
  private phase = MAX_BRIGHTNESS;
  private direction: 1 | -1 = -1;
  private paused = false;

  /** Start pulsing. Calls renderCallback with brightness (0.4–1.0) on each frame. */
  start(renderCallback: (brightness: number) => void): void {
    this.stop();
    this.phase = MAX_BRIGHTNESS;
    this.direction = -1;
    this.paused = false;

    this.interval = setInterval(() => {
      if (this.paused) return;
      this.phase += this.direction * STEP;
      if (this.phase >= MAX_BRIGHTNESS) { this.phase = MAX_BRIGHTNESS; this.direction = -1; }
      if (this.phase <= MIN_BRIGHTNESS) { this.phase = MIN_BRIGHTNESS; this.direction = 1; }
      renderCallback(this.phase);
    }, INTERVAL_MS);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Pause during streaming (screen updates rapidly). */
  pause(): void { this.paused = true; }
  /** Resume after streaming completes. */
  resume(): void { this.paused = false; }

  isRunning(): boolean { return this.interval !== null && !this.paused; }
  getBrightness(): number { return this.phase; }
}

/**
 * Interpolate between two hex colors.
 * t=0 → colorA, t=1 → colorB.
 */
export function interpolateColor(colorA: string, colorB: string, t: number): string {
  const a = hexToRgb(colorA);
  const b = hexToRgb(colorB);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${bl.toString(16).padStart(2, "0")}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
