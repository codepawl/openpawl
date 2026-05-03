/**
 * App mode system — the only mode system in OpenPawl.
 * Controls dispatch strategy: solo (single agent) or crew (multi-agent, not yet implemented).
 * Shift+Tab cycles: solo → crew → solo.
 */

import { ICONS } from "../constants/icons.js";
import { defaultTheme } from "../themes/default.js";
import type { StyleFn } from "../themes/theme.js";

export type AppMode = "solo" | "crew";

export interface AppModeInfo {
  mode: AppMode;
  displayName: string;
  shortName: string;
  icon: string;
  color: StyleFn;
}

const APP_MODE_DEFS: AppModeInfo[] = [
  { mode: "solo", displayName: "Solo", shortName: "solo", icon: ICONS.modeSolo, color: defaultTheme.dim },
  { mode: "crew", displayName: "Crew", shortName: "crew", icon: ICONS.modeCrew, color: defaultTheme.accent },
];

const CYCLE_ORDER: AppMode[] = ["solo", "crew"];

export class AppModeSystem {
  private currentMode: AppMode = "solo";

  getMode(): AppMode {
    return this.currentMode;
  }

  setMode(mode: AppMode): void {
    this.currentMode = mode;
  }

  getModeInfo(): AppModeInfo {
    return APP_MODE_DEFS.find((m) => m.mode === this.currentMode) ?? APP_MODE_DEFS[0]!;
  }

  /** Cycles solo → crew → solo. */
  cycleNext(): AppMode {
    const idx = CYCLE_ORDER.indexOf(this.currentMode);
    this.currentMode = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length]!;
    return this.currentMode;
  }

  getAllModes(): AppModeInfo[] {
    return [...APP_MODE_DEFS];
  }
}
