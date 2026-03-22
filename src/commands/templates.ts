/**
 * CLI commands for the template marketplace.
 *
 * Usage:
 *   teamclaw templates browse                   List all from marketplace
 *   teamclaw templates browse --tag <tag>        Filter by tag
 *   teamclaw templates browse --sort <field>     Sort by downloads/stars/name
 *   teamclaw templates search <query>            Fuzzy search name+description+tags
 *   teamclaw templates install <id>              Fetch + install locally
 *   teamclaw templates install <id> --use        Install + use for next work
 *   teamclaw templates remove <id>               Uninstall
 *   teamclaw templates list                      Show installed templates
 *   teamclaw templates show <id>                 Full detail view + README
 *   teamclaw templates validate <path>           Validate local template.json
 *   teamclaw templates publish <path>            Publish to marketplace
 *   teamclaw templates init                      Scaffold a new template.json
 *   teamclaw templates update                    Update all installed templates
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { logger } from "../core/logger.js";
import { MarketplaceClient } from "../templates/marketplace-client.js";
import { LocalTemplateStore } from "../templates/local-store.js";
import { validateTemplate } from "../templates/validator.js";
import { TemplatePublisher } from "../templates/publisher.js";
import { getAllSeedTemplates, getSeedTemplate, isSeedTemplate } from "../templates/seeds/index.js";
import type { TeamClawTemplate, TemplateIndexEntry } from "../templates/types.js";

export async function runTemplatesCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub === "browse") {
    await runBrowse(args.slice(1));
  } else if (sub === "search") {
    await runSearch(args.slice(1));
  } else if (sub === "install") {
    await runInstall(args.slice(1));
  } else if (sub === "remove" || sub === "uninstall") {
    await runRemove(args.slice(1));
  } else if (sub === "list" || sub === "ls") {
    await runList();
  } else if (sub === "show") {
    await runShow(args.slice(1));
  } else if (sub === "validate") {
    await runValidate(args.slice(1));
  } else if (sub === "publish") {
    await runPublish(args.slice(1));
  } else if (sub === "init") {
    await runInit();
  } else if (sub === "update") {
    await runUpdate();
  } else {
    logger.error(`Unknown subcommand: templates ${sub}`);
    printHelp();
    process.exit(1);
  }
}

function printHelp(): void {
  const lines = [
    "",
    pc.bold("teamclaw templates") + " — Template marketplace",
    "",
    "  " + pc.green("browse") + "                    List all templates from marketplace",
    "  " + pc.green("browse --tag <tag>") + "        Filter by tag",
    "  " + pc.green("browse --sort <field>") + "     Sort by downloads, stars, or name",
    "  " + pc.green("search <query>") + "            Search templates by name, description, or tags",
    "  " + pc.green("install <id>") + "              Install a template",
    "  " + pc.green("install <id> --use") + "        Install and use for next work session",
    "  " + pc.green("remove <id>") + "               Uninstall a template",
    "  " + pc.green("list") + "                      Show installed templates",
    "  " + pc.green("show <id>") + "                 Show template details + README",
    "  " + pc.green("validate <path>") + "           Validate a local template.json",
    "  " + pc.green("publish <path>") + "            Publish template to marketplace via GitHub PR",
    "  " + pc.green("init") + "                      Scaffold a new template",
    "  " + pc.green("update") + "                    Update all installed templates",
    "",
    "Examples:",
    pc.dim("  teamclaw templates browse --tag content"),
    pc.dim("  teamclaw templates install content-creator"),
    pc.dim("  teamclaw templates search youtube"),
    pc.dim("  teamclaw templates init"),
    "",
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

function renderTemplateEntry(entry: TemplateIndexEntry, installed: boolean): string {
  const id = pc.bold(entry.id.padEnd(24));
  const name = entry.name;
  const stars = `★ ${String(entry.stars).padEnd(5)}`;
  const downloads = `↓ ${String(entry.downloads).padEnd(5)}`;
  const tags = entry.tags.length > 0 ? pc.dim(`tags: ${entry.tags.join(", ")}`) : "";
  const cost = entry.estimatedCostPerRun && entry.estimatedCostPerRun > 0 ? pc.dim(`~$${entry.estimatedCostPerRun.toFixed(2)}/run`) : "";
  const author = pc.dim(`by ${entry.author}`);
  const badge = installed ? pc.green(" [installed]") : "";

  return [
    `  ${id}${name}${badge}`,
    `  ${stars} ${downloads}          ${entry.description}`,
    `  ${tags}  ${cost}  ${author}`,
  ].join("\n");
}

async function runBrowse(args: string[]): Promise<void> {
  let tag: string | undefined;
  let sortBy: "downloads" | "stars" | "name" | "createdAt" = "downloads";
  const noInteractive = args.includes("--no-interactive");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tag" && args[i + 1]) {
      tag = args[i + 1];
      i++;
    } else if (args[i] === "--sort" && args[i + 1]) {
      const val = args[i + 1];
      if (val === "downloads" || val === "stars" || val === "name" || val === "createdAt") {
        sortBy = val;
      }
      i++;
    }
  }

  const client = new MarketplaceClient();
  const store = new LocalTemplateStore();

  let index;
  try {
    index = await client.fetchIndex();
  } catch (err) {
    logger.error(`Failed to fetch marketplace: ${err instanceof Error ? err.message : String(err)}`);
    logger.plain(pc.dim("Showing seed templates (built-in)..."));
    // Fall back to seeds
    const seeds = getAllSeedTemplates();
    if (seeds.length === 0) {
      logger.plain("No templates available.");
      return;
    }
    for (const seed of seeds) {
      const installed = await store.isInstalled(seed.id);
      logger.plain(renderTemplateEntry(seedToIndexEntry(seed), installed));
      logger.plain("");
    }
    return;
  }

  let templates = index.templates;

  if (tag) {
    templates = client.filterByTag(index, tag);
    if (templates.length === 0) {
      logger.plain(`No templates found with tag "${tag}".`);
      return;
    }
  }

  templates = client.sortTemplates(templates, sortBy);

  // Header
  const updatedAgo = getTimeAgo(index.updatedAt);
  logger.plain("");
  logger.plain(pc.bold("━".repeat(52)));
  logger.plain(pc.bold("  TeamClaw Templates Marketplace"));
  logger.plain(`  ${templates.length} templates  |  Last updated: ${updatedAgo}`);
  logger.plain(pc.bold("━".repeat(52)));
  logger.plain("");

  for (const entry of templates) {
    const installed = await store.isInstalled(entry.id);
    logger.plain(renderTemplateEntry(entry, installed));
    logger.plain("");
  }

  if (!noInteractive && process.stdout.isTTY) {
    logger.plain(pc.dim("[i: install  /: search  q: quit]"));
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function runSearch(args: string[]): Promise<void> {
  const query = args.join(" ").trim();
  if (!query) {
    logger.error("Usage: teamclaw templates search <query>");
    process.exit(1);
  }

  const client = new MarketplaceClient();
  const store = new LocalTemplateStore();

  let results;
  try {
    const index = await client.fetchIndex();
    results = client.searchIndex(index, query);
  } catch {
    // Fall back to searching seeds
    const seeds = getAllSeedTemplates();
    const q = query.toLowerCase();
    results = seeds
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q)),
      )
      .map(seedToIndexEntry);
  }

  if (results.length === 0) {
    logger.plain(`No templates matching "${query}".`);
    return;
  }

  logger.plain(`\n  Found ${results.length} template(s) matching "${query}":\n`);

  for (const entry of results) {
    const installed = await store.isInstalled(entry.id);
    logger.plain(renderTemplateEntry(entry, installed));
    logger.plain("");
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async function runInstall(args: string[]): Promise<void> {
  const id = args[0];
  const useFlag = args.includes("--use");

  if (!id) {
    logger.error("Usage: teamclaw templates install <id> [--use]");
    process.exit(1);
  }

  const store = new LocalTemplateStore();

  // Check if already installed
  if (await store.isInstalled(id)) {
    logger.warn(`Template "${id}" is already installed. Use \`teamclaw templates update\` to update.`);
    return;
  }

  logger.info(`Fetching ${id}...`);

  // Try seed first
  let template = getSeedTemplate(id);

  if (!template) {
    // Fetch from marketplace
    const client = new MarketplaceClient();
    try {
      const index = await client.fetchIndex();
      const entry = index.templates.find((t) => t.id === id);
      if (!entry) {
        logger.error(`Template "${id}" not found in marketplace.`);
        process.exit(1);
      }
      template = await client.fetchTemplate(entry.path);
    } catch (err) {
      logger.error(`Failed to fetch template: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  if (!template) {
    logger.error("Failed to fetch template: received null");
    process.exit(1);
  }

  logger.success(
    `Downloaded (${template.agents.length} agents${template.estimatedCostPerRun ? `, ~$${template.estimatedCostPerRun.toFixed(2)}/run` : ""})`,
  );
  logger.plain("");
  logger.plain(`  Template: ${pc.bold(template.name)}`);
  logger.plain(`  Author:   ${template.author}`);
  logger.plain(`  Agents:   ${template.agents.map((a) => a.role).join(", ")}`);
  logger.plain("");

  await store.install(template);
  logger.success(`Installed to ~/.teamclaw/templates/installed/${id}/`);
  logger.plain("");
  logger.plain("To use this template:");
  logger.plain(pc.cyan(`  teamclaw work --template ${id}`));
  logger.plain(pc.cyan("  teamclaw setup") + "  (select during setup wizard)");

  if (useFlag) {
    // Write template to workspace config
    try {
      const { setConfigValue } = await import("../core/configManager.js");
      setConfigValue("template", id);
      logger.success(`Set active template to "${id}"`);
    } catch {
      logger.warn("Could not set template in config. Use --template flag with teamclaw work.");
    }
  }
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

async function runRemove(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    logger.error("Usage: teamclaw templates remove <id>");
    process.exit(1);
  }

  const store = new LocalTemplateStore();
  const removed = await store.uninstall(id);

  if (removed) {
    logger.success(`Removed template: ${id}`);
  } else {
    logger.error(`Template not found: ${id}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

async function runList(): Promise<void> {
  const store = new LocalTemplateStore();
  const installed = await store.list();

  if (installed.length === 0) {
    logger.plain("No templates installed.");
    logger.plain(pc.dim("Browse available templates: teamclaw templates browse"));
    return;
  }

  logger.plain("");
  logger.plain(pc.bold(`  Installed Templates (${installed.length})`));
  logger.plain("  " + "─".repeat(50));

  for (const t of installed) {
    const date = new Date(t.installedAt).toLocaleDateString();
    const seed = isSeedTemplate(t.id) ? pc.dim(" [built-in]") : "";
    logger.plain(`  ${pc.bold(t.id.padEnd(24))} v${t.installedVersion}  ${pc.dim(date)}${seed}`);
    logger.plain(`  ${pc.dim(t.description)}`);
    logger.plain("");
  }
}

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

async function runShow(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    logger.error("Usage: teamclaw templates show <id>");
    process.exit(1);
  }

  const store = new LocalTemplateStore();
  let template: TeamClawTemplate | null = await store.get(id);
  let installed = true;

  if (!template) {
    template = getSeedTemplate(id);
    installed = false;
  }

  if (!template) {
    // Try marketplace
    const client = new MarketplaceClient();
    try {
      const index = await client.fetchIndex();
      const entry = index.templates.find((t) => t.id === id);
      if (entry) {
        template = await client.fetchTemplate(entry.path);
      }
    } catch {
      // ignore
    }
  }

  if (!template) {
    logger.error(`Template not found: ${id}`);
    process.exit(1);
  }

  logger.plain("");
  logger.plain(pc.bold(`  ${template.name}`) + pc.dim(` v${template.version}`));
  logger.plain("  " + "─".repeat(50));
  logger.plain(`  ID:          ${template.id}`);
  logger.plain(`  Author:      ${template.author}`);
  logger.plain(`  Description: ${template.description}`);
  logger.plain(`  Tags:        ${template.tags.join(", ")}`);
  logger.plain(`  Agents:      ${template.agents.length}`);
  if (template.estimatedCostPerRun) {
    logger.plain(`  Est. cost:   ~$${template.estimatedCostPerRun.toFixed(2)}/run`);
  }
  if (template.defaultGoalTemplate) {
    logger.plain(`  Goal hint:   ${template.defaultGoalTemplate}`);
  }
  logger.plain(`  Status:      ${installed ? pc.green("installed") : pc.dim("not installed")}`);
  logger.plain("");

  // Agents detail
  logger.plain(pc.bold("  Agents:"));
  for (const agent of template.agents) {
    const model = agent.model ? pc.dim(` (${agent.model})`) : "";
    const required = agent.compositionRules?.required ? pc.green(" [required]") : "";
    logger.plain(`    • ${agent.role}${model}${required}`);
    if (agent.taskTypes?.length) {
      logger.plain(`      Tasks: ${agent.taskTypes.join(", ")}`);
    }
  }
  logger.plain("");

  // Try to fetch README
  if (!installed) {
    const client = new MarketplaceClient();
    const readme = await client.fetchReadme(id);
    if (readme) {
      logger.plain(pc.bold("  README:"));
      logger.plain(readme.split("\n").map((l) => `  ${l}`).join("\n"));
      logger.plain("");
    }
  }
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

async function runValidate(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    logger.error("Usage: teamclaw templates validate <path>");
    process.exit(1);
  }

  const absPath = path.resolve(filePath);
  let templateFile = absPath;

  // If path is directory, look for template.json inside
  if (existsSync(absPath) && !absPath.endsWith(".json")) {
    const candidate = path.join(absPath, "template.json");
    if (existsSync(candidate)) {
      templateFile = candidate;
    }
  }

  if (!existsSync(templateFile)) {
    logger.error(`File not found: ${templateFile}`);
    process.exit(1);
  }

  try {
    const raw = readFileSync(templateFile, "utf-8");
    const data = JSON.parse(raw);
    const result = validateTemplate(data);

    if (result.valid) {
      logger.success(`${pc.bold(result.data!.id)} — valid`);
      logger.plain(`  Name:    ${result.data!.name}`);
      logger.plain(`  Version: ${result.data!.version}`);
      logger.plain(`  Agents:  ${result.data!.agents.length}`);
    } else {
      logger.error("Template validation failed:");
      for (const err of result.errors) {
        logger.error(`  ${err}`);
      }
      process.exit(1);
    }
  } catch (err) {
    logger.error(`Failed to parse template: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

async function runPublish(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) {
    logger.error("Usage: teamclaw templates publish <path>");
    process.exit(1);
  }

  let absPath = path.resolve(filePath);
  if (existsSync(absPath) && !absPath.endsWith(".json")) {
    const candidate = path.join(absPath, "template.json");
    if (existsSync(candidate)) absPath = candidate;
  }

  const publisher = new TemplatePublisher();
  const result = await publisher.publish(absPath);

  if (!result.success) {
    logger.error(result.error ?? "Publish failed");
    process.exit(1);
  }

  if (result.method === "gh-cli") {
    logger.success(`PR created: ${result.url}`);
  } else {
    logger.success("Browser opened for PR creation.");
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function runInit(): Promise<void> {
  const { text, confirm, isCancel, cancel } = await import("@clack/prompts");

  const idInput = await text({
    message: "Template ID (kebab-case):",
    placeholder: "my-research-team",
    validate: (v) => {
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(v)) return "Must be kebab-case";
    },
  });
  if (isCancel(idInput)) { cancel("Cancelled."); process.exit(0); }
  const id = String(idInput);

  const nameInput = await text({
    message: "Display name:",
    placeholder: "My Research Team",
  });
  if (isCancel(nameInput)) { cancel("Cancelled."); process.exit(0); }
  const name = String(nameInput);

  const descInput = await text({
    message: "Description (max 200 chars):",
    placeholder: "Research and synthesize market intelligence",
    validate: (v) => {
      if (v.length > 200) return "Max 200 characters";
    },
  });
  if (isCancel(descInput)) { cancel("Cancelled."); process.exit(0); }
  const description = String(descInput);

  const tagsInput = await text({
    message: "Tags (comma separated, max 5):",
    placeholder: "research, market",
  });
  if (isCancel(tagsInput)) { cancel("Cancelled."); process.exit(0); }
  const tags = String(tagsInput)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5);

  // Collect agents
  const agents: TeamClawTemplate["agents"] = [];
  let addMore = true;

  while (addMore) {
    const roleInput = await text({
      message: "Agent role:",
      placeholder: "researcher",
    });
    if (isCancel(roleInput)) { cancel("Cancelled."); process.exit(0); }
    const role = String(roleInput);

    const modelOverride = await confirm({
      message: "Model override?",
      initialValue: false,
    });

    let model: string | undefined;
    if (!isCancel(modelOverride) && modelOverride) {
      const modelInput = await text({
        message: "Model:",
        placeholder: "anthropic/claude-haiku-4-5",
      });
      if (!isCancel(modelInput)) model = String(modelInput);
    }

    agents.push({ role, ...(model ? { model } : {}) });

    const moreInput = await confirm({
      message: "Add another agent?",
      initialValue: true,
    });
    if (isCancel(moreInput) || !moreInput) addMore = false;
  }

  const template: TeamClawTemplate = {
    id,
    name,
    version: "0.0.1",
    author: "",
    description,
    tags,
    agents,
  };

  // Try to get author from git config
  try {
    const { execSync } = await import("node:child_process");
    const gitUser = execSync("git config user.name", { encoding: "utf-8" }).trim();
    if (gitUser) template.author = gitUser;
  } catch {
    template.author = "unknown";
  }

  const outDir = path.resolve(id);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  writeFileSync(
    path.join(outDir, "template.json"),
    JSON.stringify(template, null, 2) + "\n",
    "utf-8",
  );

  const readme = [
    `# ${name}`,
    "",
    description,
    "",
    "## Agents",
    "",
    ...agents.map((a) => `- **${a.role}**${a.model ? ` (${a.model})` : ""}`),
    "",
    "## Usage",
    "",
    "```bash",
    `teamclaw templates install ${id}`,
    `teamclaw work --template ${id}`,
    "```",
    "",
  ].join("\n");

  writeFileSync(path.join(outDir, "README.md"), readme, "utf-8");

  logger.success(`Created ./${id}/template.json`);
  logger.success(`Created ./${id}/README.md`);
  logger.plain("");
  logger.plain("Next steps:");
  logger.plain(pc.cyan(`  teamclaw templates validate ./${id}/`));
  logger.plain(pc.cyan(`  teamclaw templates publish ./${id}/`));
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

async function runUpdate(): Promise<void> {
  const store = new LocalTemplateStore();
  const installed = await store.list();

  if (installed.length === 0) {
    logger.plain("No templates installed.");
    return;
  }

  const client = new MarketplaceClient();
  let index;
  try {
    index = await client.fetchIndex();
  } catch {
    logger.error("Cannot reach marketplace. Try again later.");
    process.exit(1);
  }

  let updated = 0;

  for (const local of installed) {
    const remote = index.templates.find((t) => t.id === local.id);
    if (!remote) continue;

    if (remote.version !== local.installedVersion) {
      logger.info(`Updating ${local.id}: v${local.installedVersion} → v${remote.version}`);
      try {
        const template = await client.fetchTemplate(remote.path);
        if (template) await store.install(template);
        updated++;
      } catch (err) {
        logger.warn(`Failed to update ${local.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (updated === 0) {
    logger.success("All templates are up to date.");
  } else {
    logger.success(`Updated ${updated} template(s).`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedToIndexEntry(seed: TeamClawTemplate): TemplateIndexEntry {
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    author: seed.author,
    version: seed.version,
    tags: seed.tags,
    estimatedCostPerRun: seed.estimatedCostPerRun ?? 0,
    stars: 0,
    downloads: 0,
    createdAt: "2026-03-18",
    path: `templates/${seed.id}/template.json`,
  };
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return dateStr;
}
