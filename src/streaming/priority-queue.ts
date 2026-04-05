/**
 * Priority queue — lower number = higher priority.
 */

export class PriorityQueue<T> {
  private items: Array<{ item: T; priority: number }> = [];

  enqueue(item: T, priority: number): void {
    const entry = { item, priority };
    let inserted = false;
    for (let i = 0; i < this.items.length; i++) {
      if (priority < this.items[i]!.priority) {
        this.items.splice(i, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.items.push(entry);
  }

  dequeue(): T | undefined {
    return this.items.shift()?.item;
  }

  peek(): T | undefined {
    return this.items[0]?.item;
  }

  size(): number {
    return this.items.length;
  }

  remove(predicate: (item: T) => boolean): boolean {
    const idx = this.items.findIndex((e) => predicate(e.item));
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.items = [];
  }
}
