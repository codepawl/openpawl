import pc from "picocolors";
import {
  readGlobalConfigWithDefaults,
  writeGlobalConfig,
  type OpenPawlGlobalConfig,
} from "../core/global-config.js";

const ALLOWED_KEYS = new Set([
  "dashboardPort",
  "debugMode",
  "tokenOptimization",
  "timeouts",
  "timeouts.llm",
  "timeouts.health",
  "dashboard",
  "dashboard.autoOpen",
  "work",
  "work.maxCycles",
  "work.mode",
  "streaming",
  "streaming.enabled",
  "personality",
  "personality.enabled",
  "handoff",
  "handoff.enabled",
]);

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    obj,
  );
}

const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  if (keys.some((k) => BANNED_KEYS.has(k))) return;
  let target = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!target[keys[i]] || typeof target[keys[i]] !== "object") {
      target[keys[i]] = {};
    }
    target = target[keys[i]] as Record<string, unknown>;
  }
  target[keys[keys.length - 1]] = value;
}

function coerce(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== "") return num;
  return value;
}

export function getSettingValue(key: string): unknown {
  const config = readGlobalConfigWithDefaults();
  return getNestedValue(config as unknown as Record<string, unknown>, key);
}

export function setSettingValue(key: string, value: string): void {
  const config = readGlobalConfigWithDefaults();
  const obj = config as unknown as Record<string, unknown>;
  setNestedValue(obj, key, coerce(value));
  writeGlobalConfig(obj as unknown as OpenPawlGlobalConfig);
}

export async function runSettings(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "get" && args[1]) {
    const val = getSettingValue(args[1]);
    if (val === undefined) {
      console.log(pc.yellow(`Unknown key: ${args[1]}`));
      const suggestions = [...ALLOWED_KEYS].filter((k) => k.includes(args[1]));
      if (suggestions.length > 0) console.log(pc.dim(`Did you mean: ${suggestions.join(", ")}?`));
    } else {
      console.log(typeof val === "object" ? JSON.stringify(val, null, 2) : String(val));
    }
    return;
  }

  if (sub === "set" && args[1] && args[2]) {
    if (!ALLOWED_KEYS.has(args[1])) {
      console.log(pc.yellow(`Unknown key: ${args[1]}`));
      return;
    }
    setSettingValue(args[1], args[2]);
    console.log(pc.green(`${args[1]} = ${args[2]}`));
    return;
  }

  if (sub === "reset") {
    const { confirm } = await import("@clack/prompts");
    const yes = await confirm({ message: "Reset all settings to defaults?" });
    if (yes === true) {
      writeGlobalConfig({ version: 1 } as OpenPawlGlobalConfig);
      console.log(pc.green("Settings reset to defaults."));
    }
    return;
  }

  // Default: show all settings
  const config = readGlobalConfigWithDefaults();
  const display: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    if (!key.includes(".")) {
      display[key] = getNestedValue(config as unknown as Record<string, unknown>, key);
    }
  }
  console.log(pc.bold("\nOpenPawl Settings\n"));
  for (const [key, val] of Object.entries(display)) {
    const formatted = typeof val === "object" ? JSON.stringify(val) : String(val);
    console.log(`  ${pc.cyan(key.padEnd(22))} ${formatted}`);
  }
  console.log();
}
