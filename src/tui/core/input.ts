/**
 * Terminal input parser — converts raw stdin bytes to structured KeyEvent objects.
 * Handles CSI sequences, bracketed paste, and 10ms escape buffering.
 */

export type KeyEvent =
  | { type: "char"; char: string; ctrl: boolean; alt: boolean; shift: boolean }
  | { type: "enter"; shift: boolean }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "tab"; shift: boolean }
  | { type: "escape" }
  | { type: "arrow"; direction: "up" | "down" | "left" | "right"; ctrl: boolean; alt: boolean }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "scroll_up" }
  | { type: "scroll_down" }
  | { type: "mouse_click"; button: "left" | "middle" | "right"; col: number; row: number }
  | { type: "mouse_drag"; col: number; row: number }
  | { type: "mouse_release"; col: number; row: number }
  | { type: "paste"; text: string }
  | { type: "resize"; columns: number; rows: number }
  | { type: "unknown"; raw: Buffer };

/**
 * Parse raw terminal input data into KeyEvent objects.
 * Uses a 10ms buffer timer for escape sequence completion — when ESC arrives alone,
 * we wait 10ms to see if it's the start of a multi-byte sequence or a standalone Escape key.
 */
export class InputParser {
  onEvent: (event: KeyEvent) => void = () => {};

  private buffer: number[] = [];
  private escapeTimer: ReturnType<typeof setTimeout> | null = null;
  private inPaste = false;
  private pasteBuffer = "";

  /** Feed raw stdin data. */
  feed(data: Buffer): void {
    for (let i = 0; i < data.length; i++) {
      this.buffer.push(data[i]!);
    }
    this.process();
  }

  private process(): void {
    // Cancel any pending escape timer
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }

    while (this.buffer.length > 0) {
      // Bracketed paste mode: accumulate until end marker
      if (this.inPaste) {
        // Decode as UTF-8 (not per-byte String.fromCharCode which corrupts multi-byte chars)
        const buf = Buffer.from(this.buffer);
        const str = buf.toString("utf-8");
        const endIdx = str.indexOf("\x1b[201~");
        if (endIdx !== -1) {
          this.pasteBuffer += str.slice(0, endIdx);
          // Normalize line endings: \r\n → \n, standalone \r → \n
          const normalized = this.pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          this.onEvent({ type: "paste", text: normalized });
          this.pasteBuffer = "";
          this.inPaste = false;
          // Remove consumed bytes (re-encode to count actual byte length)
          const consumed = Buffer.byteLength(str.slice(0, endIdx + 6), "utf-8");
          this.buffer.splice(0, consumed);
          continue;
        }
        // End marker not found — accumulate and wait for more data
        this.pasteBuffer += str;
        this.buffer.length = 0;
        return;
      }

      const b0 = this.buffer[0]!;

      // ESC (0x1b) — could be standalone or start of a sequence
      if (b0 === 0x1b) {
        if (this.buffer.length === 1) {
          // Might be start of sequence — wait 10ms for more data
          this.escapeTimer = setTimeout(() => {
            this.escapeTimer = null;
            if (this.buffer.length === 1 && this.buffer[0] === 0x1b) {
              this.buffer.shift();
              this.onEvent({ type: "escape" });
            } else {
              this.process();
            }
          }, 10);
          return;
        }

        const b1 = this.buffer[1]!;

        // CSI sequence: ESC [
        if (b1 === 0x5b) {
          const consumed = this.parseCSI();
          if (consumed > 0) {
            this.buffer.splice(0, consumed);
            continue;
          }
          // Incomplete CSI — wait for more data
          return;
        }

        // Alt+Enter: ESC followed by CR — treat as Shift+Enter
        if (b1 === 0x0d) {
          this.buffer.splice(0, 2);
          this.onEvent({ type: "enter", shift: true });
          continue;
        }

        // Alt+char: ESC followed by a printable character
        if (b1 >= 0x20 && b1 <= 0x7e) {
          this.buffer.splice(0, 2);
          this.onEvent({
            type: "char",
            char: String.fromCharCode(b1),
            ctrl: false,
            alt: true,
            shift: b1 >= 0x41 && b1 <= 0x5a, // uppercase = shift
          });
          continue;
        }

        // Unknown escape sequence — emit as escape
        this.buffer.shift();
        this.onEvent({ type: "escape" });
        continue;
      }

      // Enter (CR)
      if (b0 === 0x0d) {
        this.buffer.shift();
        this.onEvent({ type: "enter", shift: false });
        continue;
      }

      // Backspace (DEL on most terminals)
      if (b0 === 0x7f) {
        this.buffer.shift();
        this.onEvent({ type: "backspace" });
        continue;
      }

      // Tab
      if (b0 === 0x09) {
        this.buffer.shift();
        this.onEvent({ type: "tab", shift: false });
        continue;
      }

      // Ctrl+A through Ctrl+Z (0x01-0x1a)
      if (b0 >= 0x01 && b0 <= 0x1a) {
        this.buffer.shift();
        const char = String.fromCharCode(b0 + 0x60); // 0x01 → 'a', 0x03 → 'c', etc.
        this.onEvent({ type: "char", char, ctrl: true, alt: false, shift: false });
        continue;
      }

      // Regular character (single byte ASCII or multi-byte UTF-8)
      if (b0 >= 0x20 && b0 <= 0x7e) {
        this.buffer.shift();
        this.onEvent({
          type: "char",
          char: String.fromCharCode(b0),
          ctrl: false,
          alt: false,
          shift: b0 >= 0x41 && b0 <= 0x5a, // uppercase
        });
        continue;
      }

      // Multi-byte UTF-8 character
      if (b0 >= 0xc0) {
        const len = b0 < 0xe0 ? 2 : b0 < 0xf0 ? 3 : 4;
        if (this.buffer.length < len) return; // wait for more bytes
        const bytes = this.buffer.splice(0, len);
        const char = Buffer.from(bytes).toString("utf-8");
        this.onEvent({
          type: "char",
          char,
          ctrl: false,
          alt: false,
          shift: false,
        });
        continue;
      }

      // Unknown byte — skip
      this.buffer.shift();
    }
  }

  /**
   * Parse a CSI sequence starting from buffer[0]=ESC, buffer[1]=[
   * Returns number of bytes consumed, or 0 if incomplete.
   */
  private parseCSI(): number {
    // Find the terminating byte (0x40-0x7e)
    let i = 2;
    while (i < this.buffer.length) {
      const b = this.buffer[i]!;
      if (b >= 0x40 && b <= 0x7e) {
        break;
      }
      i++;
    }
    if (i >= this.buffer.length) return 0; // incomplete

    const terminator = this.buffer[i]!;
    const paramStr = String.fromCharCode(...this.buffer.slice(2, i));

    // SGR mouse events: ESC[<button;col;rowM (press) or ESC[<button;col;rowm (release)
    if (paramStr.startsWith("<") && (terminator === 0x4d || terminator === 0x6d)) {
      const parts = paramStr.slice(1).split(";");
      const button = parseInt(parts[0] ?? "", 10);
      const col = parseInt(parts[1] ?? "1", 10);
      const row = parseInt(parts[2] ?? "1", 10);
      const pressed = terminator === 0x4d; // M = press, m = release

      // Scroll: button 64 = up, 65 = down
      if (button === 64) { this.onEvent({ type: "scroll_up" }); return i + 1; }
      if (button === 65) { this.onEvent({ type: "scroll_down" }); return i + 1; }

      // Release
      if (!pressed) { this.onEvent({ type: "mouse_release", col, row }); return i + 1; }

      // Drag (button 32-34 = left/middle/right + motion)
      if (button >= 32 && button <= 34) {
        this.onEvent({ type: "mouse_drag", col, row });
        return i + 1;
      }

      // Click (button 0=left, 1=middle, 2=right)
      const buttonMap: Record<number, "left" | "middle" | "right"> = { 0: "left", 1: "middle", 2: "right" };
      this.onEvent({ type: "mouse_click", button: buttonMap[button] ?? "left", col, row });
      return i + 1;
    }

    // Check for bracketed paste start: ESC[200~
    if (paramStr === "200" && terminator === 0x7e) {
      this.inPaste = true;
      this.pasteBuffer = "";
      return i + 1;
    }

    // Arrow keys: ESC[A, ESC[B, ESC[C, ESC[D
    // With modifiers: ESC[1;modA
    const directions: Record<number, "up" | "down" | "left" | "right"> = {
      0x41: "up", 0x42: "down", 0x43: "right", 0x44: "left",
    };
    if (terminator in directions) {
      const parts = paramStr.split(";");
      const mod = parts.length >= 2 ? parseInt(parts[1]!, 10) - 1 : 0;
      this.onEvent({
        type: "arrow",
        direction: directions[terminator]!,
        ctrl: (mod & 4) !== 0,
        alt: (mod & 2) !== 0,
      });
      return i + 1;
    }

    // Home: ESC[H or ESC[1~
    if (terminator === 0x48 || (paramStr === "1" && terminator === 0x7e)) {
      this.onEvent({ type: "home" });
      return i + 1;
    }

    // End: ESC[F or ESC[4~
    if (terminator === 0x46 || (paramStr === "4" && terminator === 0x7e)) {
      this.onEvent({ type: "end" });
      return i + 1;
    }

    // Delete: ESC[3~
    if (paramStr === "3" && terminator === 0x7e) {
      this.onEvent({ type: "delete" });
      return i + 1;
    }

    // Page Up: ESC[5~
    if (paramStr === "5" && terminator === 0x7e) {
      this.onEvent({ type: "pageup" });
      return i + 1;
    }

    // Page Down: ESC[6~
    if (paramStr === "6" && terminator === 0x7e) {
      this.onEvent({ type: "pagedown" });
      return i + 1;
    }

    // Shift+Tab: ESC[Z
    if (terminator === 0x5a) {
      this.onEvent({ type: "tab", shift: true });
      return i + 1;
    }

    // Kitty keyboard protocol: ESC[key;modifiersu
    // Shift+Enter: ESC[13;2u (key=13=CR, modifier=2=shift)
    if (terminator === 0x75) { // 'u'
      const parts = paramStr.split(";");
      const key = parseInt(parts[0] ?? "", 10);
      const mod = parts.length >= 2 ? parseInt(parts[1]!, 10) - 1 : 0;
      if (key === 13) {
        this.onEvent({ type: "enter", shift: (mod & 1) !== 0 });
        return i + 1;
      }
    }

    // Unknown CSI sequence
    this.onEvent({ type: "unknown", raw: Buffer.from(this.buffer.slice(0, i + 1)) });
    return i + 1;
  }
}
