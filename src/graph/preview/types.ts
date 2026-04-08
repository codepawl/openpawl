/**
 * Preview types — cost estimation, preview state, and response shapes.
 */

export interface CostEstimate {
  estimatedUSD: number;
  estimatedTokens?: number;
  parallelWaves: number;
  rfcRequired: boolean;
  estimatedMinutes: number;
}

export interface PreviewTask {
  task_id: string;
  description: string;
  assigned_to: string;
  complexity: string;
  dependencies: string[];
}

export type PreviewAction = "approve" | "edit" | "abort";

export interface PreviewResponse {
  action: PreviewAction;
  editedTasks?: PreviewTask[];
}

export interface PreviewState {
  tasks: PreviewTask[];
  estimate: CostEstimate;
  status: "pending" | "approved" | "edited" | "aborted";
  editedTasks?: PreviewTask[];
}

export type PreviewProvider = (preview: PreviewState) => Promise<PreviewResponse>;
