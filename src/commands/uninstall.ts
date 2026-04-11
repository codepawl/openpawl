/**
 * openpawl uninstall — remove OpenPawl config, data, and guide package removal.
 */
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { ICONS } from "../tui/constants/icons.js";
import { createInterface } from "node:readline";
import pc from "picocolors";

const OPENPAWL_DIR = join(homedir(), ".openpawl");

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

export async function runUninstall(args: string[]): Promise<void> {
  const force = args.includes("--force") || args.includes("-f");

  console.log("");
  console.log(pc.bold(pc.red("Uninstall OpenPawl")));
  console.log("");

  // Show what will be removed
  const dirExists = existsSync(OPENPAWL_DIR);
  if (dirExists) {
    console.log(`  ${pc.dim("Data directory:")} ${OPENPAWL_DIR}`);
  } else {
    console.log(`  ${pc.dim("Data directory:")} ${pc.dim("(not found)")}`);
  }

  // Find binary location
  let binaryPath: string | null = null;
  try {
    binaryPath = execSync("which openpawl 2>/dev/null || where openpawl 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch { /* not found */ }

  if (binaryPath) {
    console.log(`  ${pc.dim("Binary:")}         ${binaryPath}`);
  }

  console.log("");

  if (!dirExists && !binaryPath) {
    console.log(pc.dim("Nothing to remove. OpenPawl is not installed."));
    return;
  }

  // Confirm
  if (!force) {
    console.log(pc.yellow("This will permanently delete all OpenPawl data including:"));
    console.log(pc.yellow("  - Configuration and credentials"));
    console.log(pc.yellow("  - Session history and memory"));
    console.log(pc.yellow("  - Cached models and logs"));
    console.log("");

    const ok = await confirm(`${pc.bold("Continue?")} (y/N) `);
    if (!ok) {
      console.log(pc.dim("Cancelled."));
      return;
    }
    console.log("");
  }

  // Remove ~/.openpawl/
  if (dirExists) {
    await rm(OPENPAWL_DIR, { recursive: true, force: true });
    console.log(`  ${pc.green(ICONS.success)} Removed ${OPENPAWL_DIR}`);
  }

  // Guide package removal
  console.log("");
  console.log(pc.bold("To complete removal, run:"));
  console.log("");
  console.log(`  ${pc.cyan("npm uninstall -g openpawl")}`);
  console.log("");
  console.log(pc.dim("Or if installed with bun:"));
  console.log(`  ${pc.cyan("bun remove -g openpawl")}`);
  console.log("");
}
