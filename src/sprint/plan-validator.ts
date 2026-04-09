/**
 * Plan validator — catches common planner mistakes after task parsing.
 * Checks dependency ordering, over-engineering, missing setup/test tasks,
 * and assumed libraries not mentioned in the goal.
 */
import type { SprintTask } from "./types.js";

export interface PlanWarning {
  type: "dependency_order" | "over_engineering" | "missing_setup" | "missing_test" | "assumed_library" | "goal_coverage";
  message: string;
  taskIndex?: number;
}

/** Libraries that should not be assumed unless the goal mentions them. */
const ASSUMED_LIBRARY_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bprisma\b/i, name: "Prisma" },
  { pattern: /\btypeorm\b/i, name: "TypeORM" },
  { pattern: /\bsequelize\b/i, name: "Sequelize" },
  { pattern: /\bmongoose\b/i, name: "Mongoose" },
  { pattern: /\bredux\b/i, name: "Redux" },
  { pattern: /\bgraphql\b/i, name: "GraphQL" },
  { pattern: /\bdrizzle\b/i, name: "Drizzle" },
];

/** Features that indicate over-engineering for goals that don't request them. */
const OVER_ENGINEERING_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bstripe\b/i, name: "Stripe payment processing" },
  { pattern: /\bpaypal\b/i, name: "PayPal integration" },
  { pattern: /\bsendgrid\b/i, name: "SendGrid email" },
  { pattern: /\bemailjs\b/i, name: "EmailJS" },
  { pattern: /\bnodemailer\b/i, name: "Nodemailer" },
  { pattern: /\boauth\b/i, name: "OAuth" },
  { pattern: /\bdocker\b/i, name: "Docker" },
  { pattern: /\bci\s*\/\s*cd\b/i, name: "CI/CD pipeline" },
  { pattern: /\bkubernetes\b/i, name: "Kubernetes" },
  { pattern: /\bterraform\b/i, name: "Terraform" },
  { pattern: /\bsentry\b/i, name: "Sentry error tracking" },
  { pattern: /\bdatadog\b/i, name: "Datadog monitoring" },
];

const SETUP_KEYWORDS = ["init", "setup", "set up", "initialize", "scaffold", "install", "create project", "package.json", "dependencies", "config"];
const TEST_KEYWORDS = ["test", "spec", "verify", "coverage"];

/**
 * Validate a parsed task plan against quality rules.
 * Returns warnings (non-blocking) that can be emitted to the TUI.
 */
export function validatePlan(tasks: SprintTask[], goal: string): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const goalLower = goal.toLowerCase();

  if (tasks.length === 0) return warnings;

  // 1. First task should be project setup
  const firstDesc = tasks[0]!.description.toLowerCase();
  if (!SETUP_KEYWORDS.some(kw => firstDesc.includes(kw))) {
    warnings.push({
      type: "missing_setup",
      message: "First task should be project setup (init, dependencies, config).",
      taskIndex: 0,
    });
  }

  // 2. At least one test task
  if (!tasks.some(t => TEST_KEYWORDS.some(kw => t.description.toLowerCase().includes(kw)))) {
    warnings.push({
      type: "missing_test",
      message: "No testing task found. At least one task should verify the build works.",
    });
  }

  // 3. Dependency ordering — task N's dependsOn must all reference earlier tasks
  for (let i = 0; i < tasks.length; i++) {
    const deps = tasks[i]!.dependsOn;
    if (!deps) continue;
    for (const dep of deps) {
      if (dep < 1 || dep > tasks.length) {
        warnings.push({
          type: "dependency_order",
          message: `Task ${i + 1} references non-existent dependency: task ${dep}.`,
          taskIndex: i,
        });
      } else if (dep >= i + 1) {
        warnings.push({
          type: "dependency_order",
          message: `Task ${i + 1} depends on task ${dep}, which comes after it.`,
          taskIndex: i,
        });
      }
    }
  }

  // 4. Over-engineering detection — flag features not in the goal
  for (let i = 0; i < tasks.length; i++) {
    const desc = tasks[i]!.description;
    for (const { pattern, name } of OVER_ENGINEERING_PATTERNS) {
      if (pattern.test(desc) && !pattern.test(goalLower)) {
        warnings.push({
          type: "over_engineering",
          message: `Task ${i + 1} includes ${name}, not requested in goal.`,
          taskIndex: i,
        });
      }
    }
  }

  // 5. Assumed library detection — flag ORMs/frameworks not in the goal
  for (let i = 0; i < tasks.length; i++) {
    const desc = tasks[i]!.description;
    for (const { pattern, name } of ASSUMED_LIBRARY_PATTERNS) {
      if (pattern.test(desc) && !pattern.test(goalLower)) {
        warnings.push({
          type: "assumed_library",
          message: `Task ${i + 1} uses ${name}, not requested. Prefer built-in approaches.`,
          taskIndex: i,
        });
      }
    }
  }

  // 6. Goal coverage — check if tasks actually address what the user asked for
  const domainKeywords = extractDomainKeywords(goal);
  if (domainKeywords.length > 0) {
    const featureTasks = tasks.filter((t, i) => {
      const d = t.description.toLowerCase();
      // Exclude setup (first) and test (last) tasks from this check
      if (i === 0 && SETUP_KEYWORDS.some(kw => d.includes(kw))) return false;
      if (TEST_KEYWORDS.some(kw => d.includes(kw))) return false;
      return true;
    });
    const goalRelevant = featureTasks.filter(t =>
      domainKeywords.some(kw => t.description.toLowerCase().includes(kw)),
    );
    if (featureTasks.length > 0 && goalRelevant.length === 0) {
      warnings.push({
        type: "goal_coverage",
        message: `No tasks reference the goal's domain (${domainKeywords.slice(0, 5).join(", ")}). Plan may be generic boilerplate.`,
      });
    }
  }

  return warnings;
}

/** Common programming terms to exclude from domain keyword extraction. */
const GENERIC_TERMS = new Set([
  "build", "create", "make", "app", "application", "website", "web", "site",
  "project", "system", "platform", "tool", "service", "api", "server", "client",
  "frontend", "backend", "database", "the", "a", "an", "with", "for", "and", "or",
  "using", "from", "that", "this", "simple", "basic", "full", "stack", "modern",
]);

/** Extract domain-specific keywords from the goal (nouns that aren't common programming terms). */
function extractDomainKeywords(goal: string): string[] {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !GENERIC_TERMS.has(w));
}

/**
 * Auto-fix: move a setup task to position 0 if it exists but isn't first.
 * Mutates the array in place. Re-assigns task IDs after reorder.
 */
export function reorderSetupFirst(tasks: SprintTask[]): boolean {
  if (tasks.length === 0) return false;
  const firstDesc = tasks[0]!.description.toLowerCase();
  if (SETUP_KEYWORDS.some(kw => firstDesc.includes(kw))) return false;

  const setupIdx = tasks.findIndex(t =>
    SETUP_KEYWORDS.some(kw => t.description.toLowerCase().includes(kw)),
  );
  if (setupIdx <= 0) return false;

  const [setupTask] = tasks.splice(setupIdx, 1);
  tasks.unshift(setupTask!);
  tasks.forEach((t, i) => { t.id = `task-${i + 1}`; });
  return true;
}
