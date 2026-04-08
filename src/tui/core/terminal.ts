/**
 * Terminal abstraction — real (ProcessTerminal) and testing (VirtualTerminal).
 */

/** Terminal interface — the abstraction boundary between TUI and the OS. */
export interface Terminal {
  /** Write data to the terminal output. */
  write(data: string): void;
  /** Current terminal width in columns. */
  get columns(): number;
  /** Current terminal height in rows. */
  get rows(): number;
  /** Register handler for raw input data. */
  onInput(handler: (data: Buffer) => void): void;
  /** Register handler for terminal resize. */
  onResize(handler: () => void): void;
  /** Initialize terminal (raw mode, cursor hide, bracketed paste). */
  start(): void;
  /** Restore terminal to original state. */
  stop(): void;
}

/**
 * Real terminal implementation using process.stdin/stdout.
 * Enables raw mode, handles SIGWINCH for resize.
 */
export class ProcessTerminal implements Terminal {
  private inputHandlers: ((data: Buffer) => void)[] = [];
  private resizeHandlers: (() => void)[] = [];
  private started = false;
  private writeBuffer = "";
  private flushScheduled = false;

  get columns(): number {
    return process.stdout.columns ?? 80;
  }

  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  write(data: string): void {
    // Batch writes for performance
    this.writeBuffer += data;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      process.nextTick(() => {
        this.flushScheduled = false;
        if (this.writeBuffer) {
          process.stdout.write(this.writeBuffer);
          this.writeBuffer = "";
        }
      });
    }
  }

  onInput(handler: (data: Buffer) => void): void {
    this.inputHandlers.push(handler);
  }

  onResize(handler: () => void): void {
    this.resizeHandlers.push(handler);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Drain any stale stdin bytes (e.g., Enter from shell invocation)
    // before attaching input handlers. The 16ms delay lets Node's stream
    // flush buffered data harmlessly.
    setTimeout(() => {
      process.stdin.on("data", (data: Buffer) => {
        for (const handler of this.inputHandlers) handler(data);
      });
    }, 16);

    // Forward resize events
    process.stdout.on("resize", () => {
      for (const handler of this.resizeHandlers) handler();
    });

    // Switch to alternate screen buffer (full-screen TUI, no scrollback pollution)
    process.stdout.write("\x1b[?1049h"); // enter alt screen
    process.stdout.write("\x1b[H");      // cursor to top-left

    // Enable mouse tracking for scroll wheel + click/drag selection
    process.stdout.write("\x1b[?1000h"); // button press/release tracking
    process.stdout.write("\x1b[?1002h"); // button-event tracking (drag)
    process.stdout.write("\x1b[?1006h"); // SGR extended mode (decimal coordinates)

    // Hide cursor and enable bracketed paste
    process.stdout.write("\x1b[?25l"); // hide cursor
    process.stdout.write("\x1b[?2004h"); // bracketed paste on
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    // Flush any remaining writes synchronously
    if (this.writeBuffer) {
      process.stdout.write(this.writeBuffer);
      this.writeBuffer = "";
    }

    // Restore terminal state
    process.stdout.write("\x1b[?1000l"); // disable mouse tracking
    process.stdout.write("\x1b[?1002l");
    process.stdout.write("\x1b[?1003l");
    process.stdout.write("\x1b[?1006l");
    process.stdout.write("\x1b[?25h"); // show cursor
    process.stdout.write("\x1b[?2004l"); // bracketed paste off
    process.stdout.write("\x1b[0m"); // reset styles
    process.stdout.write("\x1b[?1049l"); // leave alt screen (restores previous buffer)

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    process.stdin.removeAllListeners("data");
    process.stdout.removeAllListeners("resize");
  }
}

/**
 * Virtual terminal for testing.
 * Captures all output and provides inspection methods.
 * Simulates input injection for test automation.
 */
export class VirtualTerminal implements Terminal {
  private _columns: number;
  private _rows: number;
  private output: string[] = [];
  private rawOutput = "";
  private inputHandlers: ((data: Buffer) => void)[] = [];
  private resizeHandlers: (() => void)[] = [];

  constructor(columns = 80, rows = 24) {
    this._columns = columns;
    this._rows = rows;
  }

  get columns(): number {
    return this._columns;
  }

  get rows(): number {
    return this._rows;
  }

  write(data: string): void {
    this.rawOutput += data;
    // Simple line tracking: split on newlines
    const lines = data.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) this.output.push(""); // newline creates new line
      const last = this.output.length - 1;
      if (last >= 0) {
        this.output[last] += lines[i]!;
      } else {
        this.output.push(lines[i]!);
      }
    }
  }

  onInput(handler: (data: Buffer) => void): void {
    this.inputHandlers.push(handler);
  }

  onResize(handler: () => void): void {
    this.resizeHandlers.push(handler);
  }

  start(): void {
    // No-op for virtual terminal
  }

  stop(): void {
    // No-op for virtual terminal
  }

  // --- Testing API ---

  /** Get all accumulated output lines. */
  getLines(): string[] {
    return [...this.output];
  }

  /** Get raw accumulated output (includes escape sequences). */
  getRawOutput(): string {
    return this.rawOutput;
  }

  /** Clear all captured output. */
  clearOutput(): void {
    this.output = [];
    this.rawOutput = "";
  }

  /** Inject input data (simulate keystrokes). */
  simulateInput(data: Buffer | string): void {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    for (const handler of this.inputHandlers) handler(buf);
  }

  /** Simulate terminal resize. */
  simulateResize(columns: number, rows: number): void {
    this._columns = columns;
    this._rows = rows;
    for (const handler of this.resizeHandlers) handler();
  }
}
