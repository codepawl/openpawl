import type { LeftToDoItem } from "./types.js";

export function generateResumeCommands(
  leftToDo: LeftToDoItem[],
  decisionCount: number,
): string[] {
  const commands: string[] = [];

  // One command per leftToDo item, max 3
  for (const item of leftToDo.slice(0, 3)) {
    if (item.command) {
      commands.push(item.command);
    } else {
      commands.push(`openpawl run --headless --mode solo --goal "${item.description}"`);
    }
  }

  // Suggest journal review if many decisions
  if (decisionCount > 3) {
    commands.push("openpawl journal list");
  }

  // Suggest think mode for escalated items
  const hasEscalated = leftToDo.some((i) => i.type === "escalated");
  if (hasEscalated) {
    const escalated = leftToDo.find((i) => i.type === "escalated");
    if (escalated) {
      commands.push(`openpawl think "${escalated.description}"`);
    }
  }

  return commands;
}
