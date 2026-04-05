/**
 * Memory monitoring and management. Target: < 150MB RSS for normal session.
 */

import { EventEmitter } from "node:events";

export interface MemoryUsage {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

export class MemoryManager extends EventEmitter {
  private warningThresholdMB: number;
  private criticalThresholdMB: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private warningCallbacks: Array<(usage: MemoryUsage) => void> = [];

  constructor(warningMB = 120, criticalMB = 200) {
    super();
    this.warningThresholdMB = warningMB;
    this.criticalThresholdMB = criticalMB;
  }

  getUsage(): MemoryUsage {
    const mem = process.memoryUsage();
    return {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
      arrayBuffers: Math.round(mem.arrayBuffers / 1024 / 1024),
    };
  }

  startMonitoring(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      const usage = this.getUsage();
      if (usage.rss >= this.criticalThresholdMB) {
        this.emit("memory:critical", usage);
        for (const cb of this.warningCallbacks) cb(usage);
      } else if (usage.rss >= this.warningThresholdMB) {
        this.emit("memory:warning", usage);
        for (const cb of this.warningCallbacks) cb(usage);
      }
    }, 30_000);
    if (this.interval.unref) this.interval.unref();
  }

  stopMonitoring(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  onWarning(callback: (usage: MemoryUsage) => void): void {
    this.warningCallbacks.push(callback);
  }
}
