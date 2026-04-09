/**
 * Single source of truth for the app version.
 * Reads from package.json at import time.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
