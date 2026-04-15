/**
 * Collab dispatch — builds multi-agent chains for single prompts.
 * Uses keyword matching only (no LLM calls) to detect chain-worthy prompts.
 */

export interface CollabChain {
  steps: CollabStep[];
  maxRounds: number;
}

export interface CollabStep {
  agentId: string;
  role: string;
  instruction: string;
}

// ── Chain patterns ──────────────────────────────────────────────────────────

const CODE_PATTERN = /\b(implement|build|create|write|develop|scaffold|generate)\b/i;
const ARCH_PATTERN = /\b(should I|which approach|design|compare|architect|evaluate|trade-?off)\b/i;
const DEBUG_PATTERN = /\b(fix|bug|error|crash|broken|failing|doesn't work|does not work)\b/i;

const MIN_CODE_WORDS = 50;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Determine if a prompt warrants a collab chain.
 * Returns null for prompts that should use solo dispatch.
 */
export function buildCollabChain(prompt: string, opts?: { force?: boolean }): CollabChain | null {
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  const force = opts?.force ?? false;

  // Short prompts never get chains (unless forced)
  if (wordCount < 5 && !force) return null;

  // Code prompts need sufficient complexity (> 50 words), or force bypasses the gate
  if (CODE_PATTERN.test(prompt) && (wordCount > MIN_CODE_WORDS || force)) {
    return {
      maxRounds: 3,
      steps: [
        { agentId: "coder", role: "implement", instruction: "Implement the requested code." },
        { agentId: "reviewer", role: "review", instruction: "Review the implementation for correctness, edge cases, and code quality." },
        { agentId: "coder", role: "revision", instruction: "Apply the reviewer's feedback and produce the final implementation." },
      ],
    };
  }

  // Architecture / design questions
  if (ARCH_PATTERN.test(prompt)) {
    return {
      maxRounds: 2,
      steps: [
        { agentId: "planner", role: "plan", instruction: "Analyze the design question and propose an approach." },
        { agentId: "reviewer", role: "review", instruction: "Evaluate the proposed approach and identify trade-offs or gaps." },
      ],
    };
  }

  // Debug / fix prompts
  if (DEBUG_PATTERN.test(prompt)) {
    return {
      maxRounds: 2,
      steps: [
        { agentId: "debugger", role: "debug", instruction: "Investigate the issue and identify the root cause." },
        { agentId: "coder", role: "fix", instruction: "Implement the fix based on the debugger's analysis." },
      ],
    };
  }

  // When explicitly requested, default to coder → reviewer → coder chain
  if (force) {
    return {
      maxRounds: 3,
      steps: [
        { agentId: "coder", role: "implement", instruction: "Implement the requested code." },
        { agentId: "reviewer", role: "review", instruction: "Review the implementation for correctness, edge cases, and code quality." },
        { agentId: "coder", role: "revision", instruction: "Apply the reviewer's feedback and produce the final implementation." },
      ],
    };
  }

  return null;
}
