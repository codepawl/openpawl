/**
 * CLI command: openpawl update
 * Self-update mechanism that detects install method and updates accordingly.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { logger } from "../core/logger.js";
import { isCancel, confirm } from "@clack/prompts";

const GITHUB_REPO = "nxank4/openpawl";
const GITHUB_API_RELEASES = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const GITHUB_RAW_PKG = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/package.json`;

type InstallMethod = "npm" | "source" | "local-dev" | "binary" | "unknown";

function getCurrentVersion(): string {
    const require = createRequire(import.meta.url);
    const { version } = require("../../package.json") as { version: string };
    return version;
}

async function fetchLatestVersion(): Promise<{ version: string; tag: string; downloadUrl?: string } | null> {
    // Try GitHub releases API first
    try {
        const res = await fetch(GITHUB_API_RELEASES, {
            headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "openpawl-cli" },
            signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
            const data = (await res.json()) as { tag_name: string; assets?: Array<{ name: string; browser_download_url: string }> };
            const tag = data.tag_name;
            const version = tag.replace(/^v/, "");
            const asset = data.assets?.find((a) => a.name.includes(process.platform) || a.name.endsWith(".tar.gz"));
            return { version, tag, downloadUrl: asset?.browser_download_url };
        }
    } catch {
        // Fall through to fallback
    }

    // Fallback: fetch package.json from main branch
    try {
        const res = await fetch(GITHUB_RAW_PKG, {
            headers: { "User-Agent": "openpawl-cli" },
            signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
            const data = (await res.json()) as { version: string };
            return { version: data.version, tag: `v${data.version}` };
        }
    } catch {
        // Both methods failed
    }

    return null;
}

function detectInstallMethod(): InstallMethod {
    // Check local dev: cwd is a git repo with package.json name "openpawl-app"
    const cwdPkg = path.join(process.cwd(), "package.json");
    if (existsSync(cwdPkg)) {
        try {
            const require = createRequire(import.meta.url);
            const pkg = require(cwdPkg) as { name?: string };
            if (pkg.name === "openpawl-app" && existsSync(path.join(process.cwd(), ".git"))) {
                return "local-dev";
            }
        } catch {
            // Not valid package.json
        }
    }

    // Check source install: ~/.openpawl/source/ exists
    const sourceDir = path.join(os.homedir(), ".openpawl", "source");
    if (existsSync(sourceDir) && existsSync(path.join(sourceDir, "package.json"))) {
        return "source";
    }

    // Check npm global: resolve `openpawl` binary and see if it's inside node_modules
    try {
        const binPath = execSync("which openpawl 2>/dev/null || where openpawl 2>nul", { encoding: "utf-8" }).trim();
        if (binPath && binPath.includes("node_modules")) {
            return "npm";
        }
    } catch {
        // which/where failed
    }

    // If we got here and can detect a binary path, assume binary install
    try {
        const binPath = execSync("which openpawl 2>/dev/null || where openpawl 2>nul", { encoding: "utf-8" }).trim();
        if (binPath) {
            return "binary";
        }
    } catch {
        // No binary found
    }

    return "unknown";
}

function compareVersions(current: string, latest: string): number {
    const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
    const a = parse(current);
    const b = parse(latest);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (b[i] ?? 0) - (a[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function execShell(cmd: string, cwd?: string): void {
    logger.plain(`  $ ${cmd}`);
    execSync(cmd, { stdio: "inherit", cwd });
}

async function updateNpm(): Promise<void> {
    logger.plain("Updating via npm...");
    execShell("npm install -g @openpawl/cli@latest");
}

async function updateSource(tag: string): Promise<void> {
    const sourceDir = path.join(os.homedir(), ".openpawl", "source");
    logger.plain(`Updating source install at ${sourceDir}...`);
    execShell("git fetch --tags", sourceDir);
    execShell(`git checkout ${tag}`, sourceDir);
    execShell("bun install", sourceDir);
    execShell("bun run build", sourceDir);
}

async function updateLocalDev(): Promise<void> {
    logger.plain("Updating local dev checkout...");
    execShell("git pull --rebase");
    execShell("bun install");
    execShell("bun run build");
}

async function updateBinary(downloadUrl: string | undefined, tag: string): Promise<void> {
    if (!downloadUrl) {
        logger.error("No binary download URL found in the latest release.");
        logger.plain(`Please download manually from: https://github.com/${GITHUB_REPO}/releases/tag/${tag}`);
        process.exit(1);
    }
    logger.plain("Downloading latest binary...");
    // Use the install script approach for binary updates
    const installScript = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/install.sh`;
    execShell(`curl -fsSL ${installScript} | bash`);
}

export async function runUpdateCommand(args: string[]): Promise<void> {
    if (args.includes("--help") || args.includes("-h")) {
        logger.plain("Usage: openpawl update [options]");
        logger.plain("");
        logger.plain("Self-update OpenPawl to the latest version.");
        logger.plain("");
        logger.plain("Options:");
        logger.plain("  --check   Check for updates without installing");
        logger.plain("  --force   Update even if already on the latest version");
        logger.plain("  --help    Show this help message");
        return;
    }

    const checkOnly = args.includes("--check");
    const force = args.includes("--force");

    const current = getCurrentVersion();
    logger.plain(`Current version: v${current}`);

    logger.plain("Checking for updates...");
    const latest = await fetchLatestVersion();

    if (!latest) {
        logger.error("Failed to check for updates. Check your internet connection.");
        process.exit(1);
    }

    logger.plain(`Latest version:  v${latest.version}`);

    const cmp = compareVersions(current, latest.version);
    if (cmp <= 0 && !force) {
        logger.success("Already up to date!");
        return;
    }

    if (cmp > 0) {
        logger.plain(`Update available: v${current} → v${latest.version}`);
    }

    if (checkOnly) {
        return;
    }

    const method = detectInstallMethod();
    logger.plain(`Install method:  ${method}`);

    if (method === "unknown") {
        logger.error("Could not detect how OpenPawl was installed.");
        logger.plain(`Download the latest version manually from: https://github.com/${GITHUB_REPO}/releases`);
        process.exit(1);
    }

    // Confirm before updating if TTY is available
    const canPrompt = Boolean(process.stdout.isTTY && process.stderr.isTTY);
    if (canPrompt && !force) {
        const confirmed = await confirm({
            message: `Update OpenPawl v${current} → v${latest.version} via ${method}?`,
        });
        if (isCancel(confirmed) || !confirmed) {
            logger.plain("Update cancelled.");
            return;
        }
    }

    try {
        switch (method) {
            case "npm":
                await updateNpm();
                break;
            case "source":
                await updateSource(latest.tag);
                break;
            case "local-dev":
                await updateLocalDev();
                break;
            case "binary":
                await updateBinary(latest.downloadUrl, latest.tag);
                break;
        }
    } catch (err) {
        logger.error(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    // Verify the update
    try {
        const newVersion = execSync("openpawl --version 2>/dev/null", { encoding: "utf-8" }).trim();
        logger.success(`Updated to v${newVersion}`);
    } catch {
        logger.success("Update completed. Restart your terminal to use the new version.");
    }
}
