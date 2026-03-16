/**
 * Replay engine — loads and plays back recorded sessions.
 * Emits identical WebSocket events to live runs so the dashboard renders the same.
 * Supports speed control, node seeking, and patch mode.
 */

import type { RecordingEvent, BroadcastEvent, ReplayOptions, ReplayPatch } from "./types.js";
import { readRecordingEvents, readBroadcastEvents } from "./storage.js";
import { getSession } from "./session-index.js";
import { logger } from "../core/logger.js";

export interface ReplayEmitter {
  emit(event: Record<string, unknown>): void;
}

export interface ReplayProgress {
  currentIndex: number;
  totalEvents: number;
  currentNode: string;
  elapsedMs: number;
  isComplete: boolean;
}

export class ReplayEngine {
  private events: BroadcastEvent[] = [];
  private recordingEvents: RecordingEvent[] = [];
  private options: ReplayOptions;
  private emitter: ReplayEmitter;
  private aborted = false;
  private paused = false;
  private currentIndex = 0;
  private startTime = 0;

  constructor(options: ReplayOptions, emitter: ReplayEmitter) {
    this.options = options;
    this.emitter = emitter;
  }

  /** Load session data and prepare for playback. */
  async load(): Promise<{ ok: boolean; error?: string }> {
    const session = getSession(this.options.sessionId);
    if (!session) {
      return { ok: false, error: `Session not found: ${this.options.sessionId}` };
    }

    this.events = await readBroadcastEvents(this.options.sessionId);
    this.recordingEvents = await readRecordingEvents(this.options.sessionId);

    if (this.events.length === 0 && this.recordingEvents.length === 0) {
      return { ok: false, error: "No recorded events found for this session" };
    }

    // Filter by run index if specified
    if (this.options.runIndex != null) {
      this.recordingEvents = this.recordingEvents.filter(
        (e) => e.runIndex === this.options.runIndex,
      );
    }

    // Seek to fromNode if specified
    if (this.options.fromNode) {
      const seekIdx = this.events.findIndex((e) => {
        const evt = e.event;
        return (
          (evt.type === "node_event" && evt.node === this.options.fromNode) ||
          (evt.type === "telemetry" &&
            (evt.payload as Record<string, unknown>)?.event === "NODE_ACTIVE" &&
            (evt.payload as Record<string, unknown>)?.node === this.options.fromNode)
        );
      });

      if (seekIdx >= 0) {
        this.currentIndex = seekIdx;
      }
    }

    return { ok: true };
  }

  /** Play back all events. */
  async play(): Promise<void> {
    this.startTime = Date.now();
    const speed = this.options.speed;
    const isInstant = speed === 0;

    // Emit replay start marker
    this.emitter.emit({
      type: "replay_start",
      sessionId: this.options.sessionId,
      totalEvents: this.events.length,
      speed,
    });

    let prevTimestamp = this.events[this.currentIndex]?.timestamp ?? 0;

    for (let i = this.currentIndex; i < this.events.length; i++) {
      if (this.aborted) break;

      // Pause loop
      while (this.paused && !this.aborted) {
        await sleep(100);
      }
      if (this.aborted) break;

      const event = this.events[i];
      this.currentIndex = i;

      // Check if this event should be patched
      const patchedEvent = this.applyPatch(event);

      // Timing delay (unless instant)
      if (!isInstant && i > 0 && speed > 0) {
        const gap = event.timestamp - prevTimestamp;
        if (gap > 0) {
          const delay = Math.min(gap / speed, 5000); // cap at 5s per gap
          await sleep(delay);
        }
      }

      // Emit the event (patched or original)
      this.emitter.emit(patchedEvent.event);

      // Emit progress
      this.emitter.emit({
        type: "replay_progress",
        currentIndex: i,
        totalEvents: this.events.length,
        currentNode: (patchedEvent.event.node as string) ?? null,
        elapsedMs: Date.now() - this.startTime,
      });

      prevTimestamp = event.timestamp;
    }

    // Emit replay complete marker
    this.emitter.emit({
      type: "replay_complete",
      sessionId: this.options.sessionId,
      totalEvents: this.events.length,
      elapsedMs: Date.now() - this.startTime,
    });
  }

  /** Stop replay. */
  abort(): void {
    this.aborted = true;
  }

  /** Pause replay. */
  pause(): void {
    this.paused = true;
  }

  /** Resume replay. */
  resume(): void {
    this.paused = false;
  }

  /** Get current progress. */
  getProgress(): ReplayProgress {
    return {
      currentIndex: this.currentIndex,
      totalEvents: this.events.length,
      currentNode: "",
      elapsedMs: Date.now() - this.startTime,
      isComplete: this.currentIndex >= this.events.length - 1,
    };
  }

  /** Get recording events for external use (e.g., diff). */
  getRecordingEvents(): RecordingEvent[] {
    return this.recordingEvents;
  }

  /** Apply patch to an event if matching. */
  private applyPatch(event: BroadcastEvent): BroadcastEvent {
    if (!this.options.patch?.length) return event;

    const evt = event.event;
    if (evt.type !== "node_event") return event;

    const nodeId = evt.node as string;
    const patch = this.options.patch.find((p) => p.nodeId === nodeId);
    if (!patch) return event;

    // Apply output override if specified
    if (patch.outputOverride != null) {
      const data = { ...(evt.data as Record<string, unknown>) };
      data.output = patch.outputOverride;
      data.patched = true;
      return {
        ...event,
        event: { ...evt, data, patched: true },
      };
    }

    return event;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create and run a replay in CLI-only mode (no dashboard).
 * Prints events to terminal.
 */
export async function replayToTerminal(options: ReplayOptions): Promise<boolean> {
  const emitter: ReplayEmitter = {
    emit(event: Record<string, unknown>) {
      const type = event.type as string;
      if (type === "node_event") {
        const node = event.node as string;
        const data = event.data as Record<string, unknown>;
        const message = (data?.message as string) ?? "";
        const patched = event.patched ? " [PATCHED]" : "";
        logger.plain(`  ${node}: ${message}${patched}`);
      } else if (type === "replay_start") {
        logger.plain(`Replaying session ${event.sessionId} (${event.totalEvents} events, speed: ${event.speed}x)`);
      } else if (type === "replay_complete") {
        logger.plain(`Replay complete (${event.elapsedMs}ms)`);
      }
    },
  };

  const engine = new ReplayEngine(options, emitter);
  const result = await engine.load();
  if (!result.ok) {
    logger.error(result.error ?? "Failed to load session");
    return false;
  }

  await engine.play();
  return true;
}
