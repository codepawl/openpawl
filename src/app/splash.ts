/**
 * Splash screen — styled text displayed on launch.
 */
import type { Terminal } from "../tui/core/terminal.js";
import type { Theme } from "../tui/themes/theme.js";
import { visibleWidth } from "../tui/utils/text-width.js";

// ── Rendering ─────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function centerCol(text: string, termCols: number): number {
  return Math.max(1, Math.floor((termCols - visibleWidth(text)) / 2));
}

/**
 * Render the splash screen — styled text, fits any terminal width.
 */
export async function renderSplash(
  terminal: Terminal,
  theme: Theme,
): Promise<void> {
  const rows = terminal.rows;
  const cols = terminal.columns;

  // Clear screen and hide cursor
  terminal.write("\x1b[2J\x1b[H");
  terminal.write("\x1b[?25l");

  const name = "OpenPawl";
  const tag = "Your AI team, one prompt away.";

  const totalHeight = 4; // name + tag + blank + loading
  const startRow = Math.max(1, Math.floor((rows - totalHeight) / 2));

  const nameCol = centerCol(name, cols);
  terminal.write(`\x1b[${startRow};${nameCol}H`);
  terminal.write(theme.bold(theme.logo(name)));
  await sleep(120);

  const tagCol = centerCol(tag, cols);
  terminal.write(`\x1b[${startRow + 1};${tagCol}H`);
  terminal.write(theme.dim(tag));
  await sleep(120);

  // Loading dots
  const loadText = "Starting";
  const loadCol = Math.max(1, Math.floor((cols - 20) / 2));
  for (let dots = 0; dots < 3; dots++) {
    terminal.write(`\x1b[${startRow + 3};${loadCol}H`);
    terminal.write(theme.dim(loadText + ".".repeat(dots + 1)));
    await sleep(300);
  }
}

/**
 * Wait for splash to dismiss — either keypress or short timeout.
 */
export async function waitForSplashDismiss(
  terminal: Terminal,
  timeoutMs = 500,
): Promise<void> {
  await Promise.race([
    sleep(timeoutMs),
    new Promise<void>((resolve) => {
      terminal.onInput(() => resolve());
    }),
  ]);
}
