/**
 * Session class — wraps SessionState with controlled mutation methods.
 * All state changes go through this class; never mutate state directly.
 */

import { Result, ok, err } from "neverthrow";
import type {
  SessionState,
  SessionStatus,
  SessionMessage,
  ToolExecution,
  ToolConfirmation,
  FileModification,
  SessionError,
} from "./session-state.js";
import { shortId } from "./session-state.js";

export class Session {
  private state: SessionState;
  private dirty = false;

  constructor(state: SessionState) {
    this.state = state;
  }

  // ========================= READ ==========================================

  get id(): string {
    return this.state.id;
  }

  get status(): SessionStatus {
    return this.state.status;
  }

  get messages(): readonly SessionMessage[] {
    return this.state.messages;
  }

  get messageCount(): number {
    return this.state.messageCount;
  }

  get isActive(): boolean {
    return this.state.status === "active" || this.state.status === "idle";
  }

  get cost(): { input: number; output: number; usd: number } {
    return {
      input: this.state.totalInputTokens,
      output: this.state.totalOutputTokens,
      usd: this.state.totalCostUSD,
    };
  }

  getState(): Readonly<SessionState> {
    return this.state;
  }

  toJSON(): SessionState {
    return structuredClone(this.state);
  }

  isDirty(): boolean {
    return this.dirty;
  }

  // ========================= WRITE =========================================

  addMessage(
    msg: Omit<SessionMessage, "id" | "timestamp">,
  ): SessionMessage {
    const message: SessionMessage = {
      ...msg,
      id: shortId(8),
      timestamp: new Date().toISOString(),
    };
    this.state.messages.push(message);
    this.state.messageCount++;
    this.touch();
    return message;
  }

  addToolExecution(
    exec: Omit<ToolExecution, "id" | "timestamp">,
  ): ToolExecution {
    const execution: ToolExecution = {
      ...exec,
      id: shortId(8),
      timestamp: new Date().toISOString(),
    };
    this.state.toolExecutions.push(execution);
    this.touch();
    return execution;
  }

  requestToolConfirmation(
    conf: Omit<ToolConfirmation, "executionId">,
  ): ToolConfirmation {
    const execution = this.state.toolExecutions.at(-1);
    const executionId = execution?.id ?? shortId(8);
    const confirmation: ToolConfirmation = { ...conf, executionId };
    this.state.pendingConfirmations.push(confirmation);
    this.touch();
    return confirmation;
  }

  resolveToolConfirmation(
    executionId: string,
    approved: boolean,
  ): Result<void, SessionError> {
    const idx = this.state.pendingConfirmations.findIndex(
      (c) => c.executionId === executionId,
    );
    if (idx === -1) {
      return err({ type: "confirmation_not_found", executionId });
    }
    this.state.pendingConfirmations.splice(idx, 1);

    const exec = this.state.toolExecutions.find((e) => e.id === executionId);
    if (exec) {
      exec.status = approved ? "approved" : "rejected";
    }
    this.touch();
    return ok(undefined);
  }

  trackFile(filePath: string): void {
    if (!this.state.trackedFiles.includes(filePath)) {
      this.state.trackedFiles.push(filePath);
      this.touch();
    }
  }

  recordFileModification(
    mod: Omit<FileModification, "timestamp">,
  ): void {
    this.state.modifiedFiles.push({
      ...mod,
      timestamp: new Date().toISOString(),
    });
    this.touch();
  }

  setActiveAgents(agentIds: string[]): void {
    this.state.activeAgents = agentIds;
    this.touch();
  }

  updateAgentState(agentId: string, agentState: unknown): void {
    this.state.agentStates[agentId] = agentState;
    this.touch();
  }

  addTokenUsage(
    provider: string,
    input: number,
    output: number,
    costUSD: number,
  ): void {
    this.state.totalInputTokens += input;
    this.state.totalOutputTokens += output;
    this.state.totalCostUSD += costUSD;

    const existing = this.state.providerBreakdown[provider];
    if (existing) {
      existing.tokens += input + output;
      existing.cost += costUSD;
    } else {
      this.state.providerBreakdown[provider] = {
        tokens: input + output,
        cost: costUSD,
      };
    }
    this.touch();
  }

  setTitle(title: string): void {
    this.state.title = title;
    this.touch();
  }

  setStatus(status: SessionStatus): void {
    this.state.status = status;
    this.touch();
  }

  // ========================= CONTEXT BUILDING ==============================

  /**
   * Build messages to send to LLM, respecting compression.
   * Returns: [compressed summary as system msg] + [messages after checkpoint]
   * If no compression, returns all messages.
   */
  buildContextMessages(maxTokens?: number): SessionMessage[] {
    const { compressedSummary, compressionCheckpoint, messages } = this.state;

    if (!compressedSummary || compressionCheckpoint === 0) {
      return this.maybeTruncate([...messages], maxTokens);
    }

    const summaryMsg: SessionMessage = {
      id: "compressed-summary",
      role: "system",
      content: `[Previous conversation summary]\n${compressedSummary}`,
      timestamp: new Date().toISOString(),
    };

    const tail = messages.slice(compressionCheckpoint);
    return this.maybeTruncate([summaryMsg, ...tail], maxTokens);
  }

  private maybeTruncate(
    msgs: SessionMessage[],
    maxTokens?: number,
  ): SessionMessage[] {
    if (!maxTokens) return msgs;

    // Approximate: walk backwards, accumulate token counts, stop when over budget
    let budget = maxTokens;
    const result: SessionMessage[] = [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const tokenCount = msgs[i]!.tokenCount ?? Math.ceil(msgs[i]!.content.length / 4);
      if (budget - tokenCount < 0 && result.length > 0) break;
      budget -= tokenCount;
      result.unshift(msgs[i]!);
    }
    return result;
  }

  // ========================= COMPRESSION ===================================

  applyCompression(summary: string, upToIndex: number): void {
    this.state.compressedSummary = summary;
    this.state.compressionCheckpoint = upToIndex;
    this.touch();
  }

  // ========================= CHECKPOINT ====================================

  markCheckpoint(): void {
    this.state.checkpointVersion++;
    this.state.lastCheckpointAt = new Date().toISOString();
    this.touch();
  }

  markClean(): void {
    this.dirty = false;
  }

  // ========================= INTERNAL ======================================

  private touch(): void {
    this.dirty = true;
    this.state.updatedAt = new Date().toISOString();
  }
}
