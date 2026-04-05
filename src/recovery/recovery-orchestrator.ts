/**
 * Central recovery coordinator. All errors route through here.
 */

import { EventEmitter } from "node:events";
import { ErrorPresenter } from "./error-presenter.js";
import { RetryEngine, CircuitBreaker } from "./retry-engine.js";
import type { RecoverableError, ErrorContext } from "./types.js";

export class RecoveryOrchestrator extends EventEmitter {
  private presenter = new ErrorPresenter();
  private retryEngine = new RetryEngine();
  private circuitBreaker = new CircuitBreaker();

  async handleError(error: unknown, context: ErrorContext): Promise<RecoverableError> {
    const recoverable = this.presenter.present(error, context);

    this.emit("error:occurred", recoverable);

    // Check circuit breaker for provider errors
    if (context.provider && (recoverable.category === "network" || recoverable.category === "rate_limit")) {
      if (!this.circuitBreaker.canExecute(context.provider)) {
        recoverable.userMessage = `${context.provider} circuit open (too many failures). Using fallback.`;
        recoverable.strategy = { type: "fallback", fallbackAction: "Switch to next provider" };
      } else {
        this.circuitBreaker.recordFailure(context.provider);
      }
    }

    if (recoverable.recoverable) {
      this.emit("error:recovered", recoverable);
    } else {
      this.emit("error:fatal", recoverable);
    }

    return recoverable;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  getRetryEngine(): RetryEngine {
    return this.retryEngine;
  }

  getPresenter(): ErrorPresenter {
    return this.presenter;
  }
}
