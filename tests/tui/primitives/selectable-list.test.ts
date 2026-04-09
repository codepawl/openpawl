import { describe, test, expect } from "bun:test";
import { renderSelectableList } from "../../../src/tui/primitives/selectable-list.js";

function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("renderSelectableList", () => {
  const items = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ];

  test("renders all items", () => {
    const lines = renderSelectableList({ items, selectedIndex: 0 });
    const text = lines.map(strip).join("\n");
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).toContain("Gamma");
  });

  test("selected item has cursor", () => {
    const lines = renderSelectableList({ items, selectedIndex: 1 });
    const betaLine = lines.find((l) => strip(l).includes("Beta"))!;
    // Should have the cursor character (❯)
    expect(strip(betaLine)).toContain("\u276f");
  });

  test("scroll indicators when items exceed maxVisible", () => {
    const lines = renderSelectableList({
      items,
      selectedIndex: 1,
      maxVisible: 2,
      scrollOffset: 1,
    });
    const text = lines.map(strip).join("\n");
    expect(text).toContain("1 more");
  });

  test("disabled items show unavailable", () => {
    const disabledItems = [{ id: "x", label: "Locked", disabled: true }];
    const lines = renderSelectableList({ items: disabledItems, selectedIndex: 0 });
    const text = lines.map(strip).join("\n");
    expect(text).toContain("unavailable");
  });

  test("groups render headers", () => {
    const grouped = [
      { id: "a", label: "A1", group: "Group A" },
      { id: "b", label: "B1", group: "Group B" },
    ];
    const lines = renderSelectableList({ items: grouped, selectedIndex: 0 });
    const text = lines.map(strip).join("\n");
    expect(text).toContain("Group A");
    expect(text).toContain("Group B");
  });

  test("meta shown after label", () => {
    const withMeta = [{ id: "a", label: "Session", meta: "2h ago" }];
    const lines = renderSelectableList({ items: withMeta, selectedIndex: 0 });
    const text = lines.map(strip).join("\n");
    expect(text).toContain("2h ago");
  });
});
