/**
 * Render a selectable list with cursor, scrolling, groups, and descriptions.
 */
import { truncate } from "../utils/truncate.js";
import { defaultTheme, ctp } from "../themes/default.js";

export interface SelectableItem {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  group?: string;
  meta?: string;
}

export interface SelectableListOptions {
  items: SelectableItem[];
  selectedIndex: number;
  maxVisible?: number;
  scrollOffset?: number;
  cursor?: string;
  highlightColor?: (s: string) => string;
  dimColor?: (s: string) => string;
  showDescription?: boolean;
  width?: number;
  scrollIndicators?: boolean;
  indent?: number;
}

export function renderSelectableList(options: SelectableListOptions): string[] {
  const {
    items,
    selectedIndex,
    maxVisible = items.length,
    scrollOffset = 0,
    cursor = defaultTheme.symbols.selected,
    highlightColor = ctp.mauve,
    dimColor = ctp.overlay1,
    showDescription = false,
    width = 60,
    scrollIndicators = true,
    indent = 4,
  } = options;

  const lines: string[] = [];
  const indentStr = " ".repeat(indent);
  const start = scrollOffset;
  const end = Math.min(items.length, start + maxVisible);

  // Scroll indicator: above
  const aboveCount = start;
  const belowCount = items.length - end;
  if (scrollIndicators && aboveCount > 0) {
    lines.push(indentStr + defaultTheme.dim(`\u25b2 ${aboveCount} more`));
  }

  // Render visible items
  let lastGroup = "";
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    const isSelected = i === selectedIndex;

    // Group header
    if (item.group && item.group !== lastGroup) {
      if (lastGroup) lines.push("");
      lines.push(indentStr + defaultTheme.dim(defaultTheme.bold(item.group)));
      lastGroup = item.group;
    }

    // Cursor
    const cursorStr = isSelected ? highlightColor(cursor + " ") : "  ";

    // Label
    const labelColor = item.disabled ? defaultTheme.dim : isSelected ? ctp.text : dimColor;
    const labelStr = labelColor(item.label);

    // Meta (right-aligned info like "2h ago", "12 msgs")
    const metaStr = item.meta ? "  " + defaultTheme.dim(item.meta) : "";

    // Disabled suffix
    const disabledStr = item.disabled ? defaultTheme.dim(" (unavailable)") : "";

    const line = indentStr + cursorStr + labelStr + disabledStr + metaStr;
    lines.push(width ? truncate(line, width) : line);

    // Description on next line
    if (showDescription && item.description && isSelected) {
      lines.push(indentStr + "  " + defaultTheme.dim(truncate(item.description, width - indent - 4)));
    }
  }

  // Scroll indicator: below
  if (scrollIndicators && belowCount > 0) {
    lines.push(indentStr + defaultTheme.dim(`\u25bc ${belowCount} more`));
  }

  return lines;
}
