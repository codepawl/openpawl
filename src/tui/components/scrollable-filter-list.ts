/**
 * Reusable scrollable, filterable list renderer.
 *
 * Works with InteractiveView — the view owns navigation state
 * (selectedIndex, scrollOffset, filterText, maxVisible) and passes
 * it in at render time. This class handles filtering, viewport
 * slicing, scroll indicators, and the filter bar.
 */
import { defaultTheme } from "../themes/default.js";

/** Configuration for a ScrollableFilterList instance. */
export interface ScrollableFilterListConfig<T> {
  /** Render a single item. Return one line or an array of lines. */
  renderItem: (item: T, index: number, selected: boolean) => string | string[];
  /** Filter predicate — return true if item matches query. */
  filterFn?: (item: T, query: string) => boolean;
  /** Message shown when the filtered list is empty. */
  emptyMessage?: string;
  /** Placeholder text for the filter bar. */
  filterPlaceholder?: string;
  /** Show filter bar. Defaults to true when item count >= filterThreshold. */
  showFilter?: boolean;
  /** Minimum item count before the filter bar appears. Default 5. */
  filterThreshold?: number;
}

/** Scroll/selection state passed in from InteractiveView. */
export interface ListRenderState {
  filterText: string;
  selectedIndex: number;
  scrollOffset: number;
  maxVisible: number;
}

export class ScrollableFilterList<T> {
  private allItems: T[] = [];
  private cachedFiltered: T[] | null = null;
  private cachedFilterText = "";

  constructor(private config: ScrollableFilterListConfig<T>) {}

  /** Replace the item list. Invalidates the filter cache. */
  setItems(items: T[]): void {
    this.allItems = items;
    this.cachedFiltered = null;
  }

  /** Get filtered items for the given query. Result is cached. */
  getFilteredItems(filterText: string): T[] {
    if (this.cachedFiltered && this.cachedFilterText === filterText) {
      return this.cachedFiltered;
    }
    const { filterFn } = this.config;
    if (!filterText || !filterFn) {
      this.cachedFiltered = this.allItems;
    } else {
      this.cachedFiltered = this.allItems.filter((item) => filterFn(item, filterText));
    }
    this.cachedFilterText = filterText;
    return this.cachedFiltered;
  }

  /** Filtered item count — use from getItemCount(). */
  getFilteredCount(filterText: string): number {
    return this.getFilteredItems(filterText).length;
  }

  /** Render the full list content including filter bar and scroll indicators. */
  renderLines(state: ListRenderState): string[] {
    const t = defaultTheme;
    const { filterText, selectedIndex, scrollOffset, maxVisible } = state;
    const {
      renderItem,
      emptyMessage = "No items",
      filterPlaceholder = "Type to search...",
      filterThreshold = 5,
    } = this.config;

    const filtered = this.getFilteredItems(filterText);
    const lines: string[] = [];

    // Filter bar
    const showFilter = this.config.showFilter ?? (this.allItems.length >= filterThreshold);
    if (showFilter) {
      if (filterText) {
        lines.push(`    ${t.dim("Filter:")} ${filterText}${t.primary("\u25cc")}`);
      } else {
        lines.push(`    ${t.dim(filterPlaceholder)}`);
      }
      lines.push("");
    }

    // Empty state
    if (filtered.length === 0) {
      if (filterText) {
        lines.push(`    ${t.dim(`No matches for "${filterText}"`)}`);
      } else {
        lines.push(`    ${t.dim(emptyMessage)}`);
      }
      lines.push("");
      return lines;
    }

    // Viewport calculation
    const count = filtered.length;
    let start: number;
    let end: number;
    let aboveCount: number;
    let belowCount: number;

    if (count <= maxVisible) {
      start = 0;
      end = count;
      aboveCount = 0;
      belowCount = 0;
    } else {
      start = scrollOffset;
      end = Math.min(count, start + maxVisible);
      aboveCount = start;
      belowCount = count - end;
    }

    // Scroll indicator: above
    if (aboveCount > 0) {
      lines.push(t.dim(`    \u25b2 ${aboveCount} more`));
    }

    // Render visible items
    for (let vi = 0; vi < end - start; vi++) {
      const globalIdx = start + vi;
      const item = filtered[globalIdx]!;
      const isSelected = globalIdx === selectedIndex;
      const result = renderItem(item, globalIdx, isSelected);
      if (Array.isArray(result)) {
        lines.push(...result);
      } else {
        lines.push(result);
      }
    }

    // Scroll indicator: below
    if (belowCount > 0) {
      lines.push(t.dim(`    \u25bc ${belowCount} more`));
    }

    return lines;
  }
}
