/**
 * Auto-generate session titles from first user message.
 */

import type { Session } from "./session.js";
import { generateSessionName } from "./session-name.js";

const UNTITLED = "Untitled session";

export class AutoTitler {
  async generateTitle(firstMessage: string): Promise<string> {
    return generateSessionName(firstMessage);
  }

  async titleSession(session: Session, firstMessage: string): Promise<void> {
    const title = session.getState().title;
    if (title !== UNTITLED && title !== "New session") return;
    const newTitle = await this.generateTitle(firstMessage);
    session.setTitle(newTitle);
  }
}
