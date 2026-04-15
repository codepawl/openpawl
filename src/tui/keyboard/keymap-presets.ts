/**
 * Built-in keymap presets: windows/linux, mac, vim.
 * Each preset maps every ActionId to one or more key combos.
 *
 * Key notation: "ctrl+c", "shift+enter", "alt+left", "f1", "pageup"
 * Modifiers sorted: ctrl, alt, shift — then key.
 */
import type { ActionId } from "./actions.js";

export type KeyCombo = string;
export type KeymapPreset = Record<ActionId, KeyCombo | KeyCombo[]>;

export const WINDOWS_KEYMAP: KeymapPreset = {
  "editor.cursor.left": "left",
  "editor.cursor.right": "right",
  "editor.cursor.wordLeft": "ctrl+left",
  "editor.cursor.wordRight": "ctrl+right",
  "editor.cursor.home": "home",
  "editor.cursor.end": "end",

  "editor.delete.charLeft": "backspace",
  "editor.delete.charRight": "delete",
  "editor.delete.wordLeft": "ctrl+backspace",
  "editor.delete.wordRight": "ctrl+delete",
  "editor.delete.toStart": "ctrl+u",
  "editor.delete.toEnd": "ctrl+k",
  "editor.delete.line": "ctrl+shift+k",

  "editor.select.all": "ctrl+a",
  "editor.clipboard.copy": "ctrl+c",
  "editor.clipboard.paste": "ctrl+v",

  "editor.history.prev": "alt+up",
  "editor.history.next": "alt+down",

  "editor.submit": "enter",
  "editor.clear": "ctrl+u",

  "messages.scroll.up": "shift+up",
  "messages.scroll.down": "shift+down",
  "messages.scroll.pageUp": "pageup",
  "messages.scroll.pageDown": "pagedown",
  "messages.scroll.top": "ctrl+home",
  "messages.scroll.bottom": "ctrl+end",
  "messages.scroll.prevPrompt": "ctrl+up",
  "messages.scroll.nextPrompt": "ctrl+down",
  "messages.collapse.toggle": "ctrl+e",
  "messages.toolCalls.toggleAll": "ctrl+t",

  "app.help": "f1",
  "app.quit": "ctrl+d",
  "app.abort": "ctrl+c",
  "app.settings": "ctrl+,",
  "app.cancel": "escape",

  // nav.up/down use placeholder keys — resolveContextual remaps
  // editor.history.prev/next → nav.up/down when an interactive view is active.
  "nav.up": "f24",
  "nav.down": "f25",
  "nav.select": "enter",
  "nav.back": "escape",

  // Mode cycling is handled by the app layer (editor onKey override), not the TUI keybinding system.
  // Use unregistered keys to satisfy the type while avoiding conflicts.
  "mode.cycle": "f19",
  "palette.show": "f20",
  "help.keybindings": "f21",
  "model.picker": "f22",
  "thinking.toggle": "f23",
};

export const MAC_KEYMAP: KeymapPreset = {
  ...WINDOWS_KEYMAP,
  "editor.cursor.wordLeft": "alt+left",
  "editor.cursor.wordRight": "alt+right",
  "editor.delete.wordLeft": "alt+backspace",
  "editor.delete.wordRight": "alt+delete",
  "editor.cursor.home": ["home", "ctrl+a"],
  "editor.cursor.end": ["end", "ctrl+e"],
  "editor.delete.toStart": "ctrl+u",
  "editor.delete.toEnd": "ctrl+k",
};

export const VIM_KEYMAP: KeymapPreset = {
  ...WINDOWS_KEYMAP,
  "nav.up": "k",
  "nav.down": "j",
  "nav.select": ["enter", "l"],
  "nav.back": ["escape", "h", "q"],
  "editor.delete.wordLeft": "ctrl+w",
  "messages.scroll.pageUp": "ctrl+b",
  "messages.scroll.pageDown": "ctrl+f",
  "messages.scroll.top": "g",
  "messages.scroll.bottom": "shift+g",
};

export const LINUX_KEYMAP: KeymapPreset = {
  ...WINDOWS_KEYMAP,
  "editor.cursor.home": ["home", "ctrl+a"],
  "editor.cursor.end": ["end", "ctrl+e"],
  "editor.delete.toEnd": "ctrl+k",
  "editor.delete.toStart": "ctrl+u",
  "editor.cursor.wordLeft": ["ctrl+left", "alt+b"],
  "editor.cursor.wordRight": ["ctrl+right", "alt+f"],
  "editor.delete.wordLeft": ["ctrl+backspace", "ctrl+w"],
};

export const PRESETS = {
  windows: WINDOWS_KEYMAP,
  mac: MAC_KEYMAP,
  vim: VIM_KEYMAP,
  linux: LINUX_KEYMAP,
} as const;

export type PresetName = keyof typeof PRESETS;
