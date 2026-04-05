import { describe, it, expect } from "vitest";
import { PriorityQueue } from "../../src/streaming/priority-queue.js";

describe("PriorityQueue", () => {
  it("dequeue returns highest priority first", () => {
    const q = new PriorityQueue<string>();
    q.enqueue("low", 3);
    q.enqueue("high", 1);
    q.enqueue("med", 2);
    expect(q.dequeue()).toBe("high");
    expect(q.dequeue()).toBe("med");
    expect(q.dequeue()).toBe("low");
  });

  it("same priority → FIFO order", () => {
    const q = new PriorityQueue<string>();
    q.enqueue("first", 1);
    q.enqueue("second", 1);
    q.enqueue("third", 1);
    expect(q.dequeue()).toBe("first");
    expect(q.dequeue()).toBe("second");
  });

  it("remove by predicate works", () => {
    const q = new PriorityQueue<string>();
    q.enqueue("a", 1);
    q.enqueue("b", 2);
    q.enqueue("c", 3);
    expect(q.remove((x) => x === "b")).toBe(true);
    expect(q.size()).toBe(2);
  });

  it("size returns correct count", () => {
    const q = new PriorityQueue<number>();
    expect(q.size()).toBe(0);
    q.enqueue(1, 1);
    q.enqueue(2, 2);
    expect(q.size()).toBe(2);
  });

  it("empty queue returns undefined", () => {
    const q = new PriorityQueue<string>();
    expect(q.dequeue()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });
});
