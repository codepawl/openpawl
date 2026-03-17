/**
 * Background worker for async think jobs.
 * Called via hidden CLI subcommand: teamclaw think-worker <jobId>
 */

import { AsyncThinkJobStore } from "./job-store.js";

export async function runAsyncThinkWorker(jobId: string): Promise<void> {
  const store = new AsyncThinkJobStore();
  const job = store.get(jobId);
  if (!job || job.status !== "running") {
    process.exit(1);
  }

  // Handle graceful shutdown
  const onSignal = () => {
    const current = store.get(jobId);
    if (current && current.status === "running") {
      current.status = "cancelled";
      current.completedAt = Date.now();
      store.save(current);
    }
    process.exit(0);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    const { createThinkSession, saveToJournal, recordToHistory } =
      await import("./session.js");

    const session = await createThinkSession(job.question);

    // Auto-save to journal if enabled and recommendation is conclusive
    let finalSession = session;
    if (
      job.autoSave &&
      session.recommendation &&
      session.recommendation.choice !== "Inconclusive"
    ) {
      finalSession = await saveToJournal(session);
    }

    await recordToHistory(finalSession);

    // Update job with result
    job.status = "completed";
    job.completedAt = Date.now();
    job.result = finalSession;
    store.save(job);

    // Send notification
    try {
      const { notifyCompletion } = await import("./notifier.js");
      await notifyCompletion(job);
    } catch {
      // Notification is best-effort
    }
  } catch (err) {
    job.status = "failed";
    job.error = String(err);
    job.completedAt = Date.now();
    store.save(job);
    process.exit(1);
  }
}
