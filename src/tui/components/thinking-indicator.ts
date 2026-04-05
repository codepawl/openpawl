/**
 * Thinking indicator — animated spinner shown while waiting for LLM response.
 * Starts immediately on prompt submit, stops when first token arrives.
 */
import { ctp } from "../themes/default.js";

const FRAMES = ["◐", "◓", "◑", "◒"];
const FRAME_INTERVAL = 120;

export class ThinkingIndicator {
  private interval: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;
  private visible = false;
  private agentName: string | null = null;
  private agentColorFn: ((s: string) => string) | null = null;

  /** Callback to update the displayed text (called on each frame). */
  onUpdate?: (text: string) => void;

  start(agentName?: string, agentColorFn?: (s: string) => string): void {
    this.stop();
    this.visible = true;
    this.agentName = agentName ?? null;
    this.agentColorFn = agentColorFn ?? null;
    this.frameIndex = 0;
    this.emitFrame();
    this.interval = setInterval(() => this.emitFrame(), FRAME_INTERVAL);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Get current frame text (for rendering in components). */
  getCurrentText(): string {
    if (!this.visible) return "";
    const frame = FRAMES[this.frameIndex % FRAMES.length]!;
    const spinner = ctp.teal(frame);

    if (this.agentName && this.agentColorFn) {
      return `${spinner} ${this.agentColorFn(`[${this.agentName}]`)} ${ctp.teal("is thinking...")}`;
    }
    return `${spinner} ${ctp.teal("Thinking...")}`;
  }

  private emitFrame(): void {
    this.frameIndex++;
    this.onUpdate?.(this.getCurrentText());
  }
}
