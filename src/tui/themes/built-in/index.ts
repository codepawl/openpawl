/**
 * Register all built-in themes.
 */
import type { ThemeDefinition } from "../theme-types.js";
import { catppuccinMocha } from "./catppuccin-mocha.js";
import { catppuccinLatte } from "./catppuccin-latte.js";
import { catppuccinFrappe } from "./catppuccin-frappe.js";
import { catppuccinMacchiato } from "./catppuccin-macchiato.js";
import { gruvboxDark } from "./gruvbox-dark.js";
import { gruvboxLight } from "./gruvbox-light.js";
import { tokyoNight } from "./tokyo-night.js";
import { tokyoNightStorm } from "./tokyo-night-storm.js";
import { nord } from "./nord.js";
import { rosePine } from "./rose-pine.js";
import { highContrast } from "./high-contrast.js";

export function getBuiltInThemes(): ThemeDefinition[] {
  return [
    catppuccinMocha,
    catppuccinLatte,
    catppuccinFrappe,
    catppuccinMacchiato,
    gruvboxDark,
    gruvboxLight,
    tokyoNight,
    tokyoNightStorm,
    nord,
    rosePine,
    highContrast,
  ];
}
