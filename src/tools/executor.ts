/**
 * Tool execution engine — validates, permission-checks, runs, and logs tools.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ToolEvent } from "../router/event-types.js";
import { Result, ok, err } from "neverthrow";
import type {
  ToolOutput,
  ToolError,
  ToolExecutionContext,
  PermissionLevel,
} from "./types.js";
import { ToolRegistry } from "./registry.js";
import { PermissionResolver } from "./permissions.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SUMMARY_BYTES = 10_240;
const TRUNCATED_HEAD = 5_120;
const TRUNCATED_TAIL = 1_024;

export class ToolExecutor extends EventEmitter {
  private activeAbortControllers = new Map<string, AbortController>();

  constructor(
    private registry: ToolRegistry,
    private permissionResolver: PermissionResolver,
  ) {
    super();
  }

  async execute(
    toolName: string,
    input: unknown,
    context: ToolExecutionContext,
    resolvedPermission?: PermissionLevel,
  ): Promise<Result<ToolOutput, ToolError>> {
    // 1. Lookup
    const tool = this.registry.get(toolName);
    if (!tool) return err({ type: "not_found", toolName });

    // 2. Validate input
    const parseResult = tool.inputSchema.safeParse(input);
    if (!parseResult.success) {
      const errors = parseResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
      return err({ type: "validation_failed", toolName, errors });
    }
    const validatedInput = parseResult.data;

    // Custom validation
    if (tool.validate) {
      const vResult = tool.validate(validatedInput);
      if (vResult.isErr()) return err(vResult.error);
    }

    // 3. Permission check
    const permission = resolvedPermission ?? tool.defaultPermission;
    const check = this.permissionResolver.checkPermission(
      toolName, context.agentId, permission, tool.riskLevel,
    );

    if ("allowed" in check && !check.allowed) {
      return err({ type: "permission_denied", toolName, level: permission });
    }

    if ("needsConfirmation" in check && check.needsConfirmation) {
      const approval = await this.requestConfirmation(toolName, context.agentId, validatedInput);
      if (approval === "denied") {
        return err({ type: "permission_denied", toolName, level: permission });
      }
      if (approval === "always" || permission === "session") {
        this.permissionResolver.grantSession(toolName);
      }
    }

    // 4. Execute with timeout
    const executionId = randomUUID().slice(0, 8);
    const abortController = new AbortController();
    this.activeAbortControllers.set(executionId, abortController);

    // Forward parent abort signal
    if (context.abortSignal) {
      context.abortSignal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    this.emit(ToolEvent.Start, executionId, toolName, context.agentId);

    try {
      const result = await Promise.race([
        tool.execute(validatedInput, { ...context, abortSignal: abortController.signal }),
        this.createTimeout(toolName, DEFAULT_TIMEOUT_MS, abortController.signal),
      ]);

      this.activeAbortControllers.delete(executionId);

      if (result.isErr()) {
        this.emit(ToolEvent.Error, executionId, toolName, result.error);
        return result;
      }

      // Truncate large output for LLM summary
      const output = result.value;
      if (output.fullOutput && output.fullOutput.length > MAX_SUMMARY_BYTES) {
        output.summary = truncateForSummary(output.summary, output.fullOutput);
      }

      this.emit(ToolEvent.Done, executionId, toolName, output);
      return ok(output);
    } catch (e) {
      this.activeAbortControllers.delete(executionId);
      if (abortController.signal.aborted) {
        const toolErr: ToolError = { type: "aborted", toolName };
        this.emit(ToolEvent.Error, executionId, toolName, toolErr);
        return err(toolErr);
      }
      const toolErr: ToolError = { type: "execution_failed", toolName, cause: String(e) };
      this.emit(ToolEvent.Error, executionId, toolName, toolErr);
      return err(toolErr);
    }
  }

  async executeParallel(
    calls: Array<{ toolName: string; input: unknown }>,
    context: ToolExecutionContext,
  ): Promise<Result<ToolOutput, ToolError>[]> {
    return Promise.all(
      calls.map((call) => this.execute(call.toolName, call.input, context)),
    );
  }

  /**
   * Request user confirmation for a tool execution.
   * Emits tool:confirmation_needed with approve/reject callbacks.
   * If no listener is registered, auto-approves (backwards compat).
   */
  private async requestConfirmation(
    toolName: string,
    agentId: string,
    input: unknown,
  ): Promise<"denied" | "once" | "always"> {
    // If nobody is listening for confirmations, auto-approve
    if (this.listenerCount(ToolEvent.ConfirmationNeeded) === 0) {
      return "once";
    }

    const tool = this.registry.get(toolName);
    return new Promise<"denied" | "once" | "always">((resolve) => {
      this.emit(ToolEvent.ConfirmationNeeded, {
        toolName,
        agentId,
        input,
        riskLevel: tool?.riskLevel ?? "moderate",
        category: tool?.category ?? "custom",
        approve: (always?: boolean) => resolve(always ? "always" : "once"),
        reject: () => resolve("denied"),
      });
    });
  }

  abort(executionId: string): void {
    const controller = this.activeAbortControllers.get(executionId);
    if (controller) {
      controller.abort();
      this.emit(ToolEvent.Aborted, executionId);
    }
  }

  private createTimeout(
    toolName: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Result<ToolOutput, ToolError>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(err({ type: "timeout", toolName, timeoutMs }));
      }, timeoutMs);

      // Don't block process exit
      if (timer.unref) timer.unref();

      signal.addEventListener("abort", () => {
        clearTimeout(timer);
      }, { once: true });
    });
  }
}

function truncateForSummary(summary: string, fullOutput: string): string {
  if (summary.length <= MAX_SUMMARY_BYTES) return summary;
  const head = fullOutput.slice(0, TRUNCATED_HEAD);
  const tail = fullOutput.slice(-TRUNCATED_TAIL);
  return `${head}\n\n[... truncated ${fullOutput.length - TRUNCATED_HEAD - TRUNCATED_TAIL} bytes ...]\n\n${tail}`;
}
