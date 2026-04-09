/**
 * ConfirmBox — reusable bordered confirmation prompt.
 * Wraps content + action buttons in a renderPanel box.
 * Used by tool permission prompts, session delete, etc.
 */
import { renderPanel } from "./panel.js";
import { visibleWidth } from "../utils/text-width.js";
import { ctp } from "../themes/default.js";

export interface ConfirmBoxOptions {
  /** Styled title string — rendered in the top border. */
  title: string;
  /** Body content lines (args, description, etc.). */
  contentLines: string[];
  /** Pre-styled button string, e.g. "[Y]es  [N]o  [!]Always". */
  buttons: string;
  /** Border color function. Default: ctp.surface1 (dim). */
  borderColor?: (s: string) => string;
  /** Title color function. Default: identity (title is pre-styled). */
  titleColor?: (s: string) => string;
  /** Max box width. Default: 80. */
  maxWidth?: number;
}

/**
 * Render a confirmation prompt inside a bordered panel.
 * Returns a single string (newline-joined) suitable for message content.
 */
export function renderConfirmBox(options: ConfirmBoxOptions): string {
  const {
    title,
    contentLines,
    buttons,
    borderColor = ctp.surface1,
    titleColor = (s: string) => s,
    maxWidth = 80,
  } = options;

  // Center buttons within the content area
  // Measure the widest content line to determine box width context
  const allLines = [...contentLines];
  const buttonsW = visibleWidth(buttons);
  let widest = buttonsW;
  for (const line of allLines) {
    const w = visibleWidth(line);
    if (w > widest) widest = w;
  }

  // Pad buttons to center them
  const padAmount = Math.max(0, Math.floor((widest - buttonsW) / 2));
  const centeredButtons = " ".repeat(padAmount) + buttons;

  // Build final content: body + blank line + buttons
  const body = [...allLines, "", centeredButtons];

  const lines = renderPanel(
    {
      title,
      border: "rounded",
      borderColor,
      titleColor,
      width: "auto",
      maxWidth,
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
    },
    body,
  );

  return lines.join("\n");
}
