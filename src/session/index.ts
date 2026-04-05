/**
 * Session module — interactive chat session management.
 */

// Types
export type {
  SessionState,
  SessionStatus,
  SessionMessage,
  ToolExecution,
  ToolExecutionStatus,
  ToolConfirmation,
  FileModification,
  SessionError,
  SessionListItem,
} from "./session-state.js";

// State factory
export { createEmptySession, shortId } from "./session-state.js";

// Session class
export { Session } from "./session.js";

// Serialization
export { serialize, deserialize } from "./session-serializer.js";

// Store
export { SessionStore, truncateToolOutput } from "./session-store.js";

// Recovery
export { SessionRecovery } from "./session-recovery.js";

// Manager
export {
  SessionManager,
  createSessionManager,
} from "./session-manager.js";
export type {
  SessionManagerConfig,
  SessionManagerEvents,
} from "./session-manager.js";
