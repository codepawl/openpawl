/**
 * All bindable TUI actions. Namespaced: area.category.action.
 */
export const ACTIONS = {
  // Editor cursor
  "editor.cursor.left": "Move cursor left",
  "editor.cursor.right": "Move cursor right",
  "editor.cursor.wordLeft": "Move cursor one word left",
  "editor.cursor.wordRight": "Move cursor one word right",
  "editor.cursor.home": "Move cursor to start of line",
  "editor.cursor.end": "Move cursor to end of line",

  // Editor delete
  "editor.delete.charLeft": "Delete character before cursor",
  "editor.delete.charRight": "Delete character after cursor",
  "editor.delete.wordLeft": "Delete word before cursor",
  "editor.delete.wordRight": "Delete word after cursor",
  "editor.delete.toStart": "Delete to start of line",
  "editor.delete.toEnd": "Delete to end of line",
  "editor.delete.line": "Delete entire line",

  // Editor select
  "editor.select.all": "Select all text",

  // Clipboard
  "editor.clipboard.copy": "Copy selection",
  "editor.clipboard.paste": "Paste from clipboard",

  // History
  "editor.history.prev": "Previous command from history",
  "editor.history.next": "Next command from history",

  // Submit / editing
  "editor.submit": "Submit input",
  "editor.clear": "Clear input",

  // Messages scroll
  "messages.scroll.up": "Scroll messages up",
  "messages.scroll.down": "Scroll messages down",
  "messages.scroll.pageUp": "Scroll messages page up",
  "messages.scroll.pageDown": "Scroll messages page down",
  "messages.scroll.top": "Scroll to oldest message",
  "messages.scroll.bottom": "Scroll to newest message",
  "messages.scroll.prevPrompt": "Jump to previous user prompt",
  "messages.scroll.nextPrompt": "Jump to next user prompt",
  "messages.collapse.toggle": "Expand/collapse focused message",
  "messages.toolCalls.toggleAll": "Expand/collapse all tool calls",

  // App
  "app.help": "Show help",
  "app.quit": "Quit OpenPawl",
  "app.abort": "Abort / cancel / Ctrl+C",
  "app.settings": "Open settings",
  "app.cancel": "Close current view",

  // Navigation (interactive views)
  "nav.up": "Navigate up",
  "nav.down": "Navigate down",
  "nav.select": "Select current item",
  "nav.back": "Go back / close view",

  // Mode switching
  "mode.cycle": "Cycle mode (solo/crew)",

  // Palette & overlays
  "palette.show": "Open command palette",
  "help.keybindings": "Show keybinding help",

  // Model
  "model.picker": "Open model picker",

  // Thinking
  "thinking.toggle": "Toggle extended thinking",
} as const;

export type ActionId = keyof typeof ACTIONS;
