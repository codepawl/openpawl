/**
 * Copy manager — programmatic clipboard access.
 * Primary: OSC 52 (works over SSH, tmux). Fallback: platform commands.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import type { Terminal } from "../core/terminal.js";
import type { LineTracker } from "./line-tracker.js";

export type ClipboardMethod = "osc52" | "pbcopy" | "xclip" | "xsel" | "wl-copy" | "clip" | "none";

let cachedMethod: ClipboardMethod | null = null;

export class CopyManager {
  private terminal: Terminal | null = null;

  setTerminal(terminal: Terminal): void {
    this.terminal = terminal;
  }

  /** Copy text to system clipboard. Returns true on success. */
  async copyToClipboard(text: string): Promise<boolean> {
    const method = await detectClipboardMethod();

    // Send OSC 52 as best-effort (works in terminals that support it, silently ignored otherwise)
    try {
      const b64 = Buffer.from(text, "utf-8").toString("base64");
      const seq = `\x1b]52;c;${b64}\x07`;
      if (this.terminal) {
        this.terminal.write(seq);
      } else {
        process.stdout.write(seq);
      }
    } catch {
      // OSC 52 failed — continue to platform fallback
    }

    // Also try platform clipboard command (pbcopy/xclip/xsel/wl-copy/clip.exe)
    // This ensures copy works even when OSC 52 is disabled or unsupported
    if (method !== "osc52") {
      return this.copyViaPlatform(text, method);
    }

    return true;
  }

  /** Copy a message, reconstructing original text without visual line breaks. */
  async copyMessage(originalText: string): Promise<boolean> {
    return this.copyToClipboard(originalText);
  }

  /** Copy a code block (strips ``` markers). */
  async copyCodeBlock(code: string): Promise<boolean> {
    // Strip leading/trailing ``` lines
    const lines = code.split("\n");
    const start = lines[0]?.trimStart().startsWith("```") ? 1 : 0;
    const end = lines[lines.length - 1]?.trimStart() === "```" ? lines.length - 1 : lines.length;
    const cleaned = lines.slice(start, end).join("\n");
    return this.copyToClipboard(cleaned);
  }

  /** Copy a visual line range using LineTracker to reconstruct original text. */
  async copyVisualRange(
    startLine: number,
    endLine: number,
    lineTracker: LineTracker,
  ): Promise<boolean> {
    const text = lineTracker.reconstructOriginal(startLine, endLine);
    return this.copyToClipboard(text);
  }

  private copyViaPlatform(text: string, method: ClipboardMethod): boolean {
    try {
      switch (method) {
        case "pbcopy":
          execFileSync("pbcopy", [], { input: text, timeout: 3000 });
          return true;
        case "xclip":
          execFileSync("xclip", ["-selection", "clipboard"], { input: text, timeout: 3000 });
          return true;
        case "xsel":
          execFileSync("xsel", ["--clipboard", "--input"], { input: text, timeout: 3000 });
          return true;
        case "wl-copy":
          execFileSync("wl-copy", [], { input: text, timeout: 3000 });
          return true;
        case "clip":
          execFileSync("clip.exe", [], { input: text, timeout: 3000 });
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }
}

async function detectClipboardMethod(): Promise<ClipboardMethod> {
  if (cachedMethod) return cachedMethod;

  if (process.platform === "darwin") {
    cachedMethod = "pbcopy";
  } else if (process.platform === "win32") {
    cachedMethod = "clip";
  } else if (process.env.WAYLAND_DISPLAY) {
    cachedMethod = commandExists("wl-copy") ? "wl-copy" : "osc52";
  } else if (commandExists("xclip")) {
    cachedMethod = "xclip";
  } else if (commandExists("xsel")) {
    cachedMethod = "xsel";
  } else if (isWSL() && commandExists("clip.exe")) {
    cachedMethod = "clip";
  } else {
    cachedMethod = "osc52";
  }

  return cachedMethod;
}

function isWSL(): boolean {
  try {
    return os.release().toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/** Reset cached method (for testing). */
export function resetClipboardCache(): void {
  cachedMethod = null;
}
