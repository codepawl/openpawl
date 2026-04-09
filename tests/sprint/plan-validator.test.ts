import { describe, it, expect } from "vitest";
import { validatePlan, reorderSetupFirst } from "../../src/sprint/plan-validator.js";
import type { SprintTask } from "../../src/sprint/types.js";

function task(desc: string, dependsOn?: number[]): SprintTask {
  return { id: "task-1", description: desc, status: "pending", dependsOn };
}

describe("validatePlan", () => {
  it("warns when first task is not setup", () => {
    const tasks = [task("Create user model"), task("Write tests")];
    const warnings = validatePlan(tasks, "Build an app");
    expect(warnings.some(w => w.type === "missing_setup")).toBe(true);
  });

  it("no warning when first task is setup", () => {
    const tasks = [task("Initialize project and install dependencies"), task("Write tests")];
    const warnings = validatePlan(tasks, "Build an app");
    expect(warnings.some(w => w.type === "missing_setup")).toBe(false);
  });

  it("warns when no test task exists", () => {
    const tasks = [task("Setup project"), task("Create API endpoints")];
    const warnings = validatePlan(tasks, "Build an app");
    expect(warnings.some(w => w.type === "missing_test")).toBe(true);
  });

  it("no warning when test task exists", () => {
    const tasks = [task("Setup project"), task("Write tests for API")];
    const warnings = validatePlan(tasks, "Build an app");
    expect(warnings.some(w => w.type === "missing_test")).toBe(false);
  });

  it("detects backward dependency ordering", () => {
    const tasks: SprintTask[] = [
      { id: "task-1", description: "Task A", status: "pending", dependsOn: [2] },
      { id: "task-2", description: "Task B", status: "pending" },
    ];
    const warnings = validatePlan(tasks, "Build an app");
    const depWarning = warnings.find(w => w.type === "dependency_order");
    expect(depWarning).toBeDefined();
    expect(depWarning!.message).toContain("comes after it");
  });

  it("detects out-of-range dependency", () => {
    const tasks: SprintTask[] = [
      { id: "task-1", description: "Setup", status: "pending", dependsOn: [99] },
    ];
    const warnings = validatePlan(tasks, "Build an app");
    const depWarning = warnings.find(w => w.type === "dependency_order");
    expect(depWarning).toBeDefined();
    expect(depWarning!.message).toContain("non-existent");
  });

  it("no dependency warning for valid ordering", () => {
    const tasks: SprintTask[] = [
      { id: "task-1", description: "Setup project", status: "pending" },
      { id: "task-2", description: "Create DB schema", status: "pending", dependsOn: [1] },
      { id: "task-3", description: "Write tests", status: "pending", dependsOn: [1, 2] },
    ];
    const warnings = validatePlan(tasks, "Build an app");
    expect(warnings.some(w => w.type === "dependency_order")).toBe(false);
  });

  it("detects over-engineering (Stripe not in goal)", () => {
    const tasks = [task("Setup"), task("Add Stripe payment processing"), task("Write tests")];
    const warnings = validatePlan(tasks, "Build a coffee shop website");
    expect(warnings.some(w => w.type === "over_engineering")).toBe(true);
    expect(warnings.find(w => w.type === "over_engineering")!.message).toContain("Stripe");
  });

  it("no over-engineering warning when feature is in goal", () => {
    const tasks = [task("Setup"), task("Add Stripe payment processing"), task("Write tests")];
    const warnings = validatePlan(tasks, "Build an e-commerce site with Stripe payments");
    expect(warnings.some(w => w.type === "over_engineering")).toBe(false);
  });

  it("detects assumed libraries (Prisma not in goal)", () => {
    const tasks = [task("Setup"), task("Create Prisma schema for users"), task("Write tests")];
    const warnings = validatePlan(tasks, "Build a user management app");
    expect(warnings.some(w => w.type === "assumed_library")).toBe(true);
    expect(warnings.find(w => w.type === "assumed_library")!.message).toContain("Prisma");
  });

  it("no library warning when library is in goal", () => {
    const tasks = [task("Setup"), task("Create Prisma schema for users"), task("Write tests")];
    const warnings = validatePlan(tasks, "Build a user app using Prisma");
    expect(warnings.some(w => w.type === "assumed_library")).toBe(false);
  });

  it("returns empty array for empty tasks", () => {
    expect(validatePlan([], "Build something")).toEqual([]);
  });
});

describe("reorderSetupFirst", () => {
  it("moves setup task to front", () => {
    const tasks: SprintTask[] = [
      { id: "task-1", description: "Create user model", status: "pending" },
      { id: "task-2", description: "Initialize project and install dependencies", status: "pending" },
      { id: "task-3", description: "Write tests", status: "pending" },
    ];
    const reordered = reorderSetupFirst(tasks);
    expect(reordered).toBe(true);
    expect(tasks[0]!.description).toContain("Initialize");
    expect(tasks[0]!.id).toBe("task-1");
    expect(tasks[1]!.id).toBe("task-2");
  });

  it("does nothing when setup is already first", () => {
    const tasks: SprintTask[] = [
      { id: "task-1", description: "Setup project structure", status: "pending" },
      { id: "task-2", description: "Create API", status: "pending" },
    ];
    const reordered = reorderSetupFirst(tasks);
    expect(reordered).toBe(false);
    expect(tasks[0]!.description).toContain("Setup");
  });

  it("does nothing for empty tasks", () => {
    const tasks: SprintTask[] = [];
    expect(reorderSetupFirst(tasks)).toBe(false);
  });
});
