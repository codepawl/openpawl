/**
 * Slash command registry — register, lookup, and autocomplete commands.
 * Uses a Trie for fast prefix-based autocomplete.
 */
import { Trie } from "../autocomplete/trie.js";

export interface CommandContext {
  /** Add a message to the messages component. */
  addMessage: (role: string, content: string) => void;
  /** Clear all messages from the TUI display. */
  clearMessages: () => void;
  /** Request the TUI to re-render. */
  requestRender: () => void;
  /** Access to the TUI stop function. */
  exit: () => void;
  /** Access to the TUI instance (for interactive views). */
  tui?: import("../core/tui.js").TUI;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  args?: string;
  execute: (args: string, ctx: CommandContext) => Promise<void>;
  hidden?: boolean;
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private trie = new Trie();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    this.trie.insert(command.name);
    for (const alias of command.aliases ?? []) {
      this.commands.set(alias, command);
      this.trie.insert(alias);
    }
  }

  unregister(name: string): void {
    const cmd = this.commands.get(name);
    if (cmd) {
      this.commands.delete(cmd.name);
      for (const alias of cmd.aliases ?? []) {
        this.commands.delete(alias);
      }
      this.rebuildTrie();
    }
  }

  private rebuildTrie(): void {
    this.trie = new Trie();
    const seen = new Set<string>();
    for (const [key] of this.commands) {
      if (!seen.has(key)) {
        this.trie.insert(key);
        seen.add(key);
      }
    }
  }

  lookup(input: string): { command: SlashCommand; args: string } | null {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
    const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

    const cmd = this.commands.get(name);
    return cmd ? { command: cmd, args } : null;
  }

  getSuggestions(partial: string): SlashCommand[] {
    const matches = this.trie.search(partial, 50);
    const seen = new Set<string>();
    const results: SlashCommand[] = [];

    for (const name of matches) {
      const cmd = this.commands.get(name);
      if (!cmd || cmd.hidden || seen.has(cmd.name)) continue;
      results.push(cmd);
      seen.add(cmd.name);
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  getAll(): SlashCommand[] {
    const seen = new Set<string>();
    const results: SlashCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (seen.has(cmd.name)) continue;
      if (!cmd.hidden) {
        results.push(cmd);
        seen.add(cmd.name);
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }
}
