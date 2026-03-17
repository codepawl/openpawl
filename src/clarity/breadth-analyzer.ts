/**
 * Breadth analyzer — detects goals that span too many unrelated domains.
 */

export const DOMAIN_KEYWORDS: Record<string, string[]> = {
  auth: ["auth", "login", "oauth", "jwt", "session", "token"],
  database: ["database", "db", "sql", "query", "schema", "migration"],
  api: ["api", "endpoint", "rest", "graphql", "route", "request"],
  frontend: ["ui", "component", "css", "react", "page", "layout"],
  performance: ["performance", "latency", "cache", "speed", "optimize"],
  security: ["security", "vulnerability", "encrypt", "sanitize", "xss"],
  testing: ["test", "spec", "coverage", "unit", "integration", "e2e"],
  deployment: ["deploy", "ci", "cd", "docker", "k8s", "infra"],
};

export interface BreadthResult {
  isTooWide: boolean;
  domains: string[];
  domainMatches: Record<string, string[]>;
}

export function detectBreadth(goal: string): BreadthResult {
  const lower = goal.toLowerCase();
  const domainMatches: Record<string, string[]> = {};

  for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
    const matches: string[] = [];
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, "i");
      if (regex.test(lower)) {
        matches.push(keyword);
      }
    }
    if (matches.length > 0) {
      domainMatches[domain] = matches;
    }
  }

  const domains = Object.keys(domainMatches);

  return {
    isTooWide: domains.length >= 3,
    domains,
    domainMatches,
  };
}

export function suggestSplits(goal: string, domains: string[]): string[] {
  const lower = goal.toLowerCase();
  const suggestions: string[] = [];

  for (const domain of domains) {
    const keywords = DOMAIN_KEYWORDS[domain];
    if (!keywords) continue;
    const matched = keywords.filter((k) => new RegExp(`\\b${k}\\b`, "i").test(lower));
    if (matched.length > 0) {
      suggestions.push(`Focus on ${domain}: ${matched.join(", ")} aspects of the goal`);
    }
  }

  return suggestions.slice(0, 4);
}
