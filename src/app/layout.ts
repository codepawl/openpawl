/**
 * TUI application layout — composes Messages + Divider + Editor + StatusBar.
 *
 * Uses split-region rendering:
 *   messages area  (scrollable, fills remaining rows)
 *   ──────────────  divider      ─┐
 *   │ editor │      input box     │ fixed at bottom
 *   status bar      segments     ─┘
 */
import {
  TUI,
  StatusBarComponent,
  MessagesComponent,
  EditorComponent,
  DividerComponent,
  type Terminal,
} from "../tui/index.js";
import { defaultTheme } from "../tui/themes/default.js";

export interface AppLayout {
  tui: TUI;
  statusBar: StatusBarComponent;
  messages: MessagesComponent;
  editor: EditorComponent;
}

export function createLayout(terminal?: Terminal): AppLayout {
  const tui = new TUI(terminal);

  const messages = new MessagesComponent("messages");
  const divider = new DividerComponent("divider");
  const editor = new EditorComponent("editor", "Type a prompt, /command, @file, or !shell...");
  const statusBar = new StatusBarComponent("status", defaultTheme.statusBarBg);

  // Scrollable region (fills remaining space above fixed bottom)
  tui.setScrollableContent(messages);

  // Fixed at bottom (order: divider, editor, status bar)
  tui.addFixedBottom(divider);
  tui.addFixedBottom(editor);
  tui.addFixedBottom(statusBar);

  tui.setFocus(editor);

  return { tui, statusBar, messages, editor };
}
