#!/usr/bin/env node
/**
 * TeamClaw onboarding wizard — delegates to the unified setup wizard.
 */

import { runSetup } from "../commands/setup.js";
import { logger } from "../core/logger.js";

export interface RunOnboardOptions {
    installDaemon?: boolean;
}

export async function runOnboard(_options?: RunOnboardOptions): Promise<void> {
    await runSetup();
}

const isMain = process.argv[1]?.endsWith("onboard.js") ?? false;
if (isMain) {
    runOnboard().catch((err) => {
        logger.error(String(err));
        process.exit(1);
    });
}
