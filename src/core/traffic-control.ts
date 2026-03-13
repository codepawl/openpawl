/**
 * Traffic Control - Rate limiting, concurrency control, and safety circuit breaker.
 * 
 * Features:
 * - Semaphore: Limits concurrent LLM API calls
 * - Cooldown: Throttles consecutive calls from same bot
 * - Circuit Breaker: Caps total requests per session with user prompt
 */

import { logger, isDebugMode } from "./logger.js";

export interface TrafficControlConfig {
    maxConcurrent: number;
    cooldownMs: number;
    maxRequestsPerSession: number;
}

const DEFAULT_CONFIG: TrafficControlConfig = {
    maxConcurrent: 2,
    cooldownMs: 3000,
    maxRequestsPerSession: 50,
};

class Semaphore {
    private permits: number;
    private waitQueue: Array<() => void> = [];

    constructor(permits: number) {
        this.permits = permits;
    }

    async acquire(): Promise<void> {
        if (this.permits > 0) {
            this.permits--;
            return;
        }

        return new Promise<void>((resolve) => {
            this.waitQueue.push(() => {
                this.permits--;
                resolve();
            });
        });
    }

    release(): void {
        this.permits++;
        const next = this.waitQueue.shift();
        if (next) {
            this.permits--;
            setImmediate(next);
        }
    }

    get waitingCount(): number {
        return this.waitQueue.length;
    }

    get availablePermits(): number {
        return this.permits;
    }
}

class CooldownManager {
    private cooldowns: Map<string, number> = new Map();
    private readonly cooldownMs: number;

    constructor(cooldownMs: number) {
        this.cooldownMs = cooldownMs;
    }

    async wait(botId: string): Promise<void> {
        const lastCall = this.cooldowns.get(botId);
        if (lastCall) {
            const elapsed = Date.now() - lastCall;
            if (elapsed < this.cooldownMs) {
                const waitTime = this.cooldownMs - elapsed;
                if (isDebugMode()) {
                    logger.debug(`⏳ Bot ${botId} cooling down (${Math.ceil(waitTime / 1000)}s)`);
                }
                await new Promise((resolve) => setTimeout(resolve, waitTime));
            }
        }
        this.cooldowns.set(botId, Date.now());
    }

    reset(botId: string): void {
        this.cooldowns.delete(botId);
    }

    clear(): void {
        this.cooldowns.clear();
    }
}

export class TrafficController {
    private semaphore: Semaphore;
    private cooldown: CooldownManager;
    private requestCount = 0;
    private paused = false;
    private pauseCallback: (() => Promise<boolean>) | null = null;
    private readonly maxRequests: number;

    constructor(config: Partial<TrafficControlConfig> = {}) {
        const cfg = { ...DEFAULT_CONFIG, ...config };
        this.semaphore = new Semaphore(cfg.maxConcurrent);
        this.cooldown = new CooldownManager(cfg.cooldownMs);
        this.maxRequests = cfg.maxRequestsPerSession;
    }

    setPauseCallback(callback: () => Promise<boolean>): void {
        this.pauseCallback = callback;
    }

    async acquire(botId: string): Promise<boolean> {
        if (this.requestCount >= this.maxRequests && !this.paused) {
            if (isDebugMode()) {
                logger.debug(`⚠️ Safety limit reached: ${this.requestCount}/${this.maxRequests}`);
            }
            this.paused = true;
            
            if (this.pauseCallback) {
                const shouldContinue = await this.pauseCallback();
                if (!shouldContinue) {
                    return false;
                }
                this.paused = false;
                this.requestCount = 0;
            }
        }

        if (this.paused) {
            return false;
        }

        await this.cooldown.wait(botId);

        if (isDebugMode() && this.semaphore.waitingCount > 0) {
            logger.debug(`⏳ Queue: ${this.semaphore.waitingCount} bots waiting for concurrency slot`);
        }

        await this.semaphore.acquire();
        this.requestCount++;

        if (isDebugMode()) {
            logger.debug(`📡 API Request #${this.requestCount}/${this.maxRequests} (bot: ${botId})`);
        }

        return true;
    }

    release(_botId: string): void {
        this.semaphore.release();
    }

    getStats() {
        return {
            totalRequests: this.requestCount,
            maxRequests: this.maxRequests,
            waitingInQueue: this.semaphore.waitingCount,
            availableSlots: this.semaphore.availablePermits,
            isPaused: this.paused,
        };
    }

    reset(): void {
        this.requestCount = 0;
        this.paused = false;
        this.cooldown.clear();
    }
}

let globalController: TrafficController | null = null;

export function getTrafficController(config?: Partial<TrafficControlConfig>): TrafficController {
    if (!globalController) {
        globalController = new TrafficController(config);
    }
    return globalController;
}

export function resetTrafficController(): void {
    globalController = null;
}
