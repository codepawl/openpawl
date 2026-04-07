/**
 * Interactive config validation and prompting — extracted from config.ts.
 * Checks that providers are configured and a valid roster exists.
 * If not, redirects to the setup wizard.
 */

import {
    note,
} from "@clack/prompts";
import pc from "picocolors";
import type { TeamConfig } from "./team-config.js";
import { clearTeamConfigCache, loadTeamConfig } from "./team-config.js";
import {
    readOpenpawlConfig,
    writeOpenpawlConfig,
} from "./jsonConfigManager.js";
import { setConfigAgentModels } from "./model-config.js";
import { getGlobalProviderManager } from "../providers/provider-factory.js";

function hasValidRoster(cfg: TeamConfig | null): boolean {
    const roster = cfg?.roster;
    if (!roster || roster.length === 0) return false;
    return roster.some(
        (r) =>
            r &&
            typeof r.role === "string" &&
            r.role.trim().length > 0 &&
            Number.isFinite(r.count) &&
            (r.count as number) >= 1,
    );
}

export async function validateOrPromptConfig(
    opts: { forceDiscover?: boolean } = {},
): Promise<void> {
    const teamCfg = await loadTeamConfig();
    const rosterOk = hasValidRoster(teamCfg);

    if (teamCfg?.agent_models && Object.keys(teamCfg.agent_models).length > 0) {
        setConfigAgentModels(teamCfg.agent_models);
    }

    // Check if we have at least one LLM provider configured
    const pm = await getGlobalProviderManager();
    const hasProviders = pm.getProviders().length > 0;

    if (hasProviders && rosterOk && !opts.forceDiscover) {
        return;
    }

    // No providers or force-discover: redirect to setup wizard
    if (!hasProviders || opts.forceDiscover) {
        const tc = readOpenpawlConfig();
        const configEmpty = Object.keys(tc.data).length === 0;

        if (configEmpty && !rosterOk) {
            note(
                "Welcome! Let's do a quick 10-second setup before we start working.",
                "OpenPawl setup",
            );
        } else {
            note(
                "No LLM providers configured. Let's set one up.",
                "OpenPawl setup",
            );
        }

        const { runSetup } = await import("../onboard/setup-flow.js");
        await runSetup();
        clearTeamConfigCache();

        // After setup, if roster is now ok, we're done
        const freshTeamCfg = await loadTeamConfig();
        if (hasValidRoster(freshTeamCfg)) return;
    }

    // Handle missing roster
    if (!rosterOk) {
        const tc = readOpenpawlConfig();
        note(
            [
                "Your project config is missing a team roster.",
                "We'll create a minimal default roster so you can start working,",
                "and you can refine it later via `openpawl onboard` or `openpawl config`.",
            ].join("\n"),
            "Missing roster",
        );

        const data = { ...tc.data };
        if (!Array.isArray((data as Record<string, unknown>).roster)) {
            (data as Record<string, unknown>).roster = [
                {
                    role: "Engineer",
                    count: 3,
                    description: "Builds product features and infrastructure.",
                },
                {
                    role: "Designer",
                    count: 1,
                    description: "Designs UX/UI and product visuals.",
                },
            ];
        }

        writeOpenpawlConfig(tc.path, data);
        clearTeamConfigCache();
        const title = pc.green("Roster initialized");
        note(
            [
                "Created a default roster:",
                "- Engineer x3",
                "- Designer x1",
                "",
                "You can customize this later in `openpawl.config.json` or via the onboarding wizard.",
            ].join("\n"),
            title,
        );
    }
}
