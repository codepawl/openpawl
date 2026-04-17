/**
 * Product metadata — single source of truth for name and tagline.
 * Anywhere the user sees the tagline (welcome banner, --help header,
 * onboarding intro, CLI help), import from here rather than hardcoding.
 */

export const PRODUCT_NAME = "OpenPawl";

/** Full tagline used in README, long-form help, and the welcome banner. */
export const PRODUCT_TAGLINE_LONG =
  "Terminal AI coding with a team of agents, not just one. Chat-based, keyboard-first, open source.";

/** Short variant for space-constrained slots (package.json, GitHub repo description, header lines). */
export const PRODUCT_TAGLINE_SHORT =
  "Terminal AI coding with a team of agents, not just one.";
