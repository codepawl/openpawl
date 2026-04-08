/**
 * PDF renderer for audit trails using pdfkit.
 * Falls back to markdown if pdfkit is not installed.
 */

import type { AuditTrail } from "../types.js";
import type { RenderOptions } from "./types.js";
import { DEFAULT_RENDER_OPTIONS } from "./types.js";

interface PDFDoc {
  fontSize(size: number): PDFDoc;
  font(name: string): PDFDoc;
  text(text: string, options?: Record<string, unknown>): PDFDoc;
  moveDown(lines?: number): PDFDoc;
  addPage(): PDFDoc;
  end(): void;
  pipe(stream: NodeJS.WritableStream): PDFDoc;
  on(event: string, fn: (...args: never[]) => void): PDFDoc;
  y: number;
  page: { height: number; margins: { bottom: number } };
}

/** Render audit trail to PDF buffer. Requires pdfkit. */
export async function renderAuditPDF(
  audit: AuditTrail,
  opts: Partial<RenderOptions> = {},
): Promise<Buffer> {
  const options = { ...DEFAULT_RENDER_OPTIONS, ...opts };

  // Dynamic import — pdfkit is optional
  let PDFDocument: new (opts: Record<string, unknown>) => PDFDoc;
  try {
    const pdfkitModule = "pdfkit";
    const mod = await import(/* webpackIgnore: true */ pdfkitModule) as { default: new (opts: Record<string, unknown>) => PDFDoc };
    PDFDocument = mod.default;
  } catch {
    throw new Error("pdfkit is required for PDF export. Install it with: bun add pdfkit");
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      info: {
        Title: `OpenPawl Audit Trail — ${audit.sessionId}`,
        Author: "OpenPawl",
        Subject: audit.goal,
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.fontSize(20).font("Helvetica-Bold").text("OpenPawl Audit Trail");
    doc.moveDown(0.5);
    doc.fontSize(10).font("Helvetica");
    doc.text(`Session: ${audit.sessionId}`);
    doc.text(`Goal: ${audit.goal}`);
    doc.text(`Date: ${new Date(audit.startedAt).toISOString().replace("T", " ").slice(0, 19)} UTC`);
    doc.text(`Duration: ${formatDuration(audit.durationMs)}`);
    doc.text(`Total Tokens: ${audit.summary.totalTokensInput.toLocaleString()} in / ${audit.summary.totalTokensOutput.toLocaleString()} out`);
    doc.text(`Team: ${audit.teamComposition.join(", ")}`);
    doc.moveDown();

    // Summary
    doc.fontSize(14).font("Helvetica-Bold").text("Sprint Summary");
    doc.moveDown(0.3);
    doc.fontSize(10).font("Helvetica");
    doc.text(`Tasks completed: ${audit.summary.tasksCompleted}`);
    doc.text(`Tasks failed: ${audit.summary.tasksFailed}`);
    doc.text(`Auto-approved: ${audit.summary.autoApproved}`);
    doc.text(`User-approved: ${audit.summary.userApproved}`);
    doc.text(`Average confidence: ${audit.summary.averageConfidence.toFixed(2)}`);
    doc.moveDown();

    // Decision Log
    if (options.sections.decisionLog && audit.decisionLog.length > 0) {
      checkPageBreak(doc);
      doc.fontSize(14).font("Helvetica-Bold").text("Decision Log");
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica");

      for (const entry of audit.decisionLog) {
        checkPageBreak(doc);
        const time = new Date(entry.timestamp).toTimeString().slice(0, 8);
        doc.font("Helvetica-Bold").text(`${time} — ${entry.nodeId}`);
        doc.font("Helvetica").text(entry.decision);
        if (entry.data.confidence != null) {
          doc.text(`Confidence: ${(entry.data.confidence as number).toFixed(2)}`);
        }
        doc.moveDown(0.3);
      }
      doc.moveDown(0.5);
    }

    // Approval History
    if (options.sections.approvalHistory && audit.approvalHistory.length > 0) {
      checkPageBreak(doc);
      doc.fontSize(14).font("Helvetica-Bold").text("Approval History");
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica");

      // Simple table
      doc.font("Helvetica-Bold").text("Task        Action          By        Confidence");
      doc.font("Helvetica");
      for (const entry of audit.approvalHistory) {
        const conf = entry.confidence != null ? entry.confidence.toFixed(2) : "—";
        doc.text(`${pad(entry.taskId, 12)}${pad(entry.action, 16)}${pad(entry.by, 10)}${conf}`);
      }
      doc.moveDown();
    }

    // Cost Breakdown
    if (options.sections.costBreakdown && audit.costBreakdown.length > 0) {
      checkPageBreak(doc);
      doc.fontSize(14).font("Helvetica-Bold").text("Cost Breakdown");
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica");

      doc.font("Helvetica-Bold").text("Agent               Tasks   Tokens");
      doc.font("Helvetica");
      for (const entry of audit.costBreakdown) {
        const tokens = entry.tokensInput + entry.tokensOutput;
        doc.text(`${pad(entry.agent, 20)}${pad(String(entry.tasks), 8)}${tokens.toLocaleString()}`);
      }
      doc.moveDown();
    }

    // Agent Performance
    if (options.sections.agentPerformance && audit.agentPerformance.length > 0) {
      checkPageBreak(doc);
      doc.fontSize(14).font("Helvetica-Bold").text("Agent Performance");
      doc.moveDown(0.3);
      doc.fontSize(9).font("Helvetica");

      doc.font("Helvetica-Bold").text("Agent               Tasks   Avg Conf   vs Profile");
      doc.font("Helvetica");
      for (const entry of audit.agentPerformance) {
        const vs = entry.vsProfile != null ? `${entry.vsProfile >= 0 ? "+" : ""}${entry.vsProfile.toFixed(2)}` : "—";
        doc.text(`${pad(entry.agent, 20)}${pad(String(entry.tasks), 8)}${pad(entry.avgConfidence.toFixed(2), 11)}${vs}`);
      }
      doc.moveDown();
    }

    // Footer
    doc.fontSize(8).font("Helvetica")
      .text(`Generated by OpenPawl | Session: ${audit.sessionId}`, { align: "center" });

    doc.end();
  });
}

function checkPageBreak(doc: PDFDoc): void {
  if (doc.y > doc.page.height - doc.page.margins.bottom - 100) {
    doc.addPage();
  }
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(1, w - s.length));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  if (min > 0) return `${min}m ${s.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}
