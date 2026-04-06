/**
 * Shared helpers for simulation test files.
 *
 * vi.hoisted() and vi.mock() CANNOT be shared — they must be at the
 * top level of each test file. This file only exports data helpers.
 */

export function makeTeam(count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `bot_${i}`,
    name: `Bot${i}`,
    role_id: "software_engineer",
    traits: {},
    worker_url: null,
  }));
}

export function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "TASK-001",
    assigned_to: "bot_0",
    status: "pending",
    description: "Test task",
    priority: "MEDIUM",
    worker_tier: "light",
    result: null,
    ...overrides,
  };
}
