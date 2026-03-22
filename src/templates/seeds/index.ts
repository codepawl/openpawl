/**
 * Built-in seed templates bundled with TeamClaw.
 * These work offline — no network needed.
 */

import type { TeamClawTemplate } from "../types.js";

export const SEED_TEMPLATE_IDS = [
  "content-creator",
  "indie-hacker",
  "research-intelligence",
  "business-ops",
  "full-stack-sprint",
] as const;

const SEED_TEMPLATES: TeamClawTemplate[] = [
  {
    id: "content-creator",
    name: "Content Creator Team",
    version: "0.0.1",
    author: "nxank4",
    description: "Research, script, SEO, and review pipeline for content creators",
    tags: ["content", "youtube", "social-media", "writing"],
    estimatedCostPerRun: 0.07,
    defaultGoalTemplate: "Create {contentType} about {topic}",
    agents: [
      {
        role: "researcher",
        taskTypes: ["research", "analysis"],
        compositionRules: { required: true, includeKeywords: ["research", "topic"] },
      },
      {
        role: "scriptwriter",
        taskTypes: ["writing", "scripting"],
        compositionRules: { required: true, includeKeywords: ["write", "script", "content"] },
      },
      {
        role: "seo-analyst",
        taskTypes: ["seo", "optimization"],
        compositionRules: { includeKeywords: ["seo", "keyword", "optimize"] },
      },
      {
        role: "qa-reviewer",
        taskTypes: ["review", "quality"],
        compositionRules: { required: true },
      },
    ],
  },
  {
    id: "indie-hacker",
    name: "Indie Hacker Team",
    version: "0.0.1",
    author: "nxank4",
    description: "Architect, engineer, QA, and RFC pipeline for solo builders",
    tags: ["coding", "saas", "startup"],
    estimatedCostPerRun: 0.12,
    defaultGoalTemplate: "Build {feature} for {project}",
    agents: [
      {
        role: "architect",
        taskTypes: ["design", "architecture"],
        compositionRules: { required: true, includeKeywords: ["design", "architect", "plan"] },
      },
      {
        role: "engineer",
        taskTypes: ["implementation", "coding"],
        compositionRules: { required: true, includeKeywords: ["build", "implement", "code"] },
      },
      {
        role: "qa-engineer",
        taskTypes: ["testing", "quality"],
        compositionRules: { required: true },
      },
      {
        role: "rfc-author",
        taskTypes: ["documentation", "rfc"],
        compositionRules: { includeKeywords: ["rfc", "proposal", "document"] },
      },
    ],
  },
  {
    id: "research-intelligence",
    name: "Research Intelligence Team",
    version: "0.0.1",
    author: "nxank4",
    description: "Deep research, synthesis, and report generation for market intelligence",
    tags: ["research", "analysis", "intelligence"],
    estimatedCostPerRun: 0.09,
    defaultGoalTemplate: "Research {topic} and produce {deliverable}",
    agents: [
      {
        role: "primary-researcher",
        taskTypes: ["research", "data-gathering"],
        compositionRules: { required: true, includeKeywords: ["research", "investigate", "analyze"] },
      },
      {
        role: "fact-checker",
        taskTypes: ["verification", "validation"],
        compositionRules: { includeKeywords: ["verify", "check", "validate"] },
      },
      {
        role: "synthesizer",
        taskTypes: ["synthesis", "summarization"],
        compositionRules: { required: true, includeKeywords: ["summarize", "synthesize", "report"] },
      },
    ],
  },
  {
    id: "business-ops",
    name: "Business Operations Team",
    version: "0.0.1",
    author: "nxank4",
    description: "Process automation, documentation, and workflow optimization",
    tags: ["business", "operations", "automation"],
    estimatedCostPerRun: 0.08,
    defaultGoalTemplate: "Optimize {process} for {department}",
    agents: [
      {
        role: "process-analyst",
        taskTypes: ["analysis", "process-mapping"],
        compositionRules: { required: true, includeKeywords: ["process", "workflow", "optimize"] },
      },
      {
        role: "automation-engineer",
        taskTypes: ["automation", "scripting"],
        compositionRules: { includeKeywords: ["automate", "script", "integrate"] },
      },
      {
        role: "documentation-writer",
        taskTypes: ["documentation", "sop"],
        compositionRules: { required: true, includeKeywords: ["document", "sop", "guide"] },
      },
    ],
  },
  {
    id: "full-stack-sprint",
    name: "Full-Stack Sprint Team",
    version: "0.0.1",
    author: "nxank4",
    description: "Frontend, backend, and DevOps for rapid full-stack feature sprints",
    tags: ["fullstack", "sprint", "devops"],
    estimatedCostPerRun: 0.15,
    defaultGoalTemplate: "Ship {feature} end-to-end",
    agents: [
      {
        role: "frontend-engineer",
        taskTypes: ["frontend", "ui", "ux"],
        compositionRules: { includeKeywords: ["frontend", "ui", "component", "react"] },
      },
      {
        role: "backend-engineer",
        taskTypes: ["backend", "api", "database"],
        compositionRules: { required: true, includeKeywords: ["api", "backend", "database", "server"] },
      },
      {
        role: "devops-engineer",
        taskTypes: ["deployment", "ci-cd", "infrastructure"],
        compositionRules: { includeKeywords: ["deploy", "ci", "docker", "infra"] },
      },
      {
        role: "tech-lead",
        taskTypes: ["review", "coordination"],
        compositionRules: { required: true },
      },
    ],
  },
];

export function getAllSeedTemplates(): TeamClawTemplate[] {
  return [...SEED_TEMPLATES];
}

export function getSeedTemplate(id: string): TeamClawTemplate | null {
  return SEED_TEMPLATES.find((t) => t.id === id) ?? null;
}

export function isSeedTemplate(id: string): boolean {
  return SEED_TEMPLATES.some((t) => t.id === id);
}
