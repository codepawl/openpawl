/**
 * TUI application layout — composes StatusBar + Messages + Editor.
 */
import {
  TUI,
  StatusBarComponent,
  MessagesComponent,
  EditorComponent,
  DividerComponent,
  type Terminal,
} from "../tui/index.js";

export interface AppLayout {
  tui: TUI;
  statusBar: StatusBarComponent;
  messages: MessagesComponent;
  editor: EditorComponent;
}

export function createLayout(terminal?: Terminal): AppLayout {
  const tui = new TUI(terminal);

  const statusBar = new StatusBarComponent("status");
  const messages = new MessagesComponent("messages");
  const divider = new DividerComponent("divider");
  const editor = new EditorComponent("editor", "Type a message, /command, @file, or !shell...");

  tui.addChild(statusBar);
  tui.addChild(messages);
  tui.addChild(divider);
  tui.addChild(editor);
  tui.setFocus(editor);

  return { tui, statusBar, messages, editor };
}
