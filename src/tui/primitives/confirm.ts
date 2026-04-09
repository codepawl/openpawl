/**
 * Confirmation prompt renderer.
 */
import { ctp } from "../themes/default.js";

export interface ConfirmOptions {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  dangerLevel?: "normal" | "warning" | "danger";
}

export function renderConfirmPrompt(options: ConfirmOptions): string {
  const { message, confirmLabel = "Yes", cancelLabel = "No" } = options;

  const color = options.dangerLevel === "danger" ? ctp.red
    : options.dangerLevel === "warning" ? ctp.yellow
    : ctp.text;

  const confirm = ctp.green(`[${confirmLabel[0]?.toUpperCase()}]`) + ctp.green(confirmLabel.slice(1));
  const cancel = ctp.red(`[${cancelLabel[0]?.toUpperCase()}]`) + ctp.red(cancelLabel.slice(1));

  return `${color(message)} ${confirm} ${cancel}`;
}
