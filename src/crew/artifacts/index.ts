/**
 * Public surface for the typed artifact store.
 *
 * Crew runtime imports `ArtifactStore` (full read/write) and hands an
 * `ArtifactStoreReader` view to subagent code so agents cannot bypass the
 * write-lock by holding a writer reference.
 */

export {
  ARTIFACT_KINDS,
  ArtifactKindSchema,
  ArtifactSchema,
  PlanArtifactSchema,
  PhaseSummaryArtifactSchema,
  MeetingNotesArtifactSchema,
  ReflectionArtifactSchema,
  ReviewArtifactSchema,
  TestReportArtifactSchema,
  PostMortemArtifactSchema,
  PhaseCompactionArtifactSchema,
  PlanArtifactPayloadSchema,
  PhaseSummaryArtifactPayloadSchema,
  MeetingNotesArtifactPayloadSchema,
  ReflectionArtifactPayloadSchema,
  ReviewArtifactPayloadSchema,
  TestReportArtifactPayloadSchema,
  PostMortemArtifactPayloadSchema,
  PhaseCompactionArtifactPayloadSchema,
  ReviewSeveritySchema,
  ReviewVerdictSchema,
} from "./types.js";

export type {
  Artifact,
  ArtifactId,
  ArtifactKind,
  ArtifactByKind,
  PlanArtifact,
  PhaseSummaryArtifact,
  MeetingNotesArtifact,
  ReflectionArtifact,
  ReviewArtifact,
  TestReportArtifact,
  PostMortemArtifact,
  PhaseCompactionArtifact,
  PlanArtifactPayload,
  PhaseSummaryArtifactPayload,
  MeetingNotesArtifactPayload,
  ReflectionArtifactPayload,
  ReviewArtifactPayload,
  TestReportArtifactPayload,
  PostMortemArtifactPayload,
  PhaseCompactionArtifactPayload,
} from "./types.js";

export {
  ARTIFACT_LOCK_PREFIX,
  ArtifactStore,
  artifactJsonlPath,
} from "./store.js";

export type {
  ArtifactStoreOptions,
  ArtifactStoreReader,
  ArtifactListFilter,
  ArtifactWriteResult,
  ArtifactWriteOk,
  ArtifactWriteRejected,
  ArtifactWriteRejectReason,
} from "./store.js";
