/**
 * TUI test harness — launches the full TUI app with VirtualTerminal.
 * Provides helpers for simulating user input and asserting on output.
 */
import { VirtualTerminal, stripAnsi } from "../../../src/tui/index.js";
import { launchTUI, type LaunchOptions } from "../../../src/app/index.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class TUIHarness {
  readonly terminal: VirtualTerminal;
  readonly sessionsDir: string;
  private tuiPromise: Promise<void> | null = null;

  constructor(columns = 120, rows = 40) {
    this.terminal = new VirtualTerminal(columns, rows);
    this.sessionsDir = mkdtempSync(path.join(os.tmpdir(), "tc-e2e-"));
  }

  /** Start the TUI app with the virtual terminal. */
  async start(opts?: Partial<LaunchOptions>): Promise<void> {
    this.tuiPromise = launchTUI({
      terminal: this.terminal,
      sessionsDir: this.sessionsDir,
      ...opts,
    });

    // Wait for initial render
    await this.tick();
  }

  /** Simulate typing text character by character. */
  type(text: string): void {
    this.terminal.simulateInput(text);
  }

  /** Simulate pressing Enter (optionally with text typed first). */
  submit(text?: string): void {
    if (text) this.type(text);
    this.terminal.simulateInput("\r");
  }

  /** Send a slash command (types /cmd and presses Enter). */
  command(cmd: string): void {
    this.submit(`/${cmd}`);
  }

  /** Simulate Ctrl+C. */
  interrupt(): void {
    this.terminal.simulateInput(Buffer.from([0x03]));
  }

  /** Get all output with ANSI codes stripped. */
  getVisibleOutput(): string {
    return stripAnsi(this.terminal.getRawOutput());
  }

  /** Get raw output including ANSI codes. */
  getRawOutput(): string {
    return this.terminal.getRawOutput();
  }

  /** Wait for a pattern to appear in output. */
  async waitFor(pattern: string | RegExp, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const output = this.getVisibleOutput();
      if (typeof pattern === "string" ? output.includes(pattern) : pattern.test(output)) {
        return;
      }
      await this.tick(50);
    }
    throw new Error(
      `Timeout (${timeoutMs}ms) waiting for: ${pattern}\nOutput (last 500 chars):\n${this.getVisibleOutput().slice(-500)}`,
    );
  }

  /** Wait for output to stabilize (no new content for 300ms). */
  async waitForIdle(timeoutMs = 15_000): Promise<void> {
    let lastLen = 0;
    let stableCount = 0;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const len = this.terminal.getRawOutput().length;
      if (len === lastLen) {
        stableCount++;
        if (stableCount >= 6) return; // stable for 300ms
      } else {
        stableCount = 0;
        lastLen = len;
      }
      await this.tick(50);
    }
  }

  /** Send /quit and wait for cleanup (with timeout so tests don't hang). */
  async stop(): Promise<void> {
    this.command("quit");
    await this.tick(100);
    // If TUI is still running, force stop with Ctrl+D
    this.terminal.simulateInput(Buffer.from([0x04])); // Ctrl+D

    // Wait for TUI promise to settle, but don't hang if it never does
    if (this.tuiPromise) {
      await Promise.race([
        this.tuiPromise.catch(() => {}),
        this.tick(2000),
      ]);
    }
  }

  /** Advance the event loop. */
  private tick(ms = 0): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
