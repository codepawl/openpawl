/**
 * Combined autocomplete provider — /commands + @files.
 */
import type { AutocompleteProvider, AutocompleteSuggestion, CommandRegistry } from "../tui/index.js";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export function createAutocompleteProvider(
  registry: CommandRegistry,
  cwd: string,
): AutocompleteProvider {
  return {
    getSuggestions(input: string, cursorPos: number): AutocompleteSuggestion[] {
      const text = input.slice(0, cursorPos);

      // / prefix → slash commands
      if (text.startsWith("/")) {
        const partial = text.slice(1).split(" ")[0] ?? "";
        return registry.getSuggestions(partial).map((cmd) => ({
          label: `/${cmd.name}`,
          description: cmd.description,
          insertText: `/${cmd.name} `,
        }));
      }

      // @ anywhere → file completion
      const atMatch = text.match(/@(\S*)$/);
      if (atMatch) {
        const partial = atMatch[1] ?? "";
        return getFileCompletions(partial, cwd);
      }

      return [];
    },
  };
}

function getFileCompletions(partial: string, cwd: string): AutocompleteSuggestion[] {
  const dir = partial.includes("/")
    ? path.resolve(cwd, path.dirname(partial))
    : cwd;
  const prefix = partial.includes("/") ? path.basename(partial) : partial;

  try {
    const entries = readdirSync(dir)
      .filter((name) => !name.startsWith(".") && name !== "node_modules")
      .filter((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, 10);

    return entries.map((name) => {
      const fullPath = path.join(dir, name);
      const isDir = statSync(fullPath).isDirectory();
      const rel = partial.includes("/")
        ? path.dirname(partial) + "/" + name
        : name;
      return {
        label: `@${rel}${isDir ? "/" : ""}`,
        description: isDir ? "directory" : "",
        insertText: `@${rel}${isDir ? "/" : ""} `,
      };
    });
  } catch {
    return [];
  }
}
