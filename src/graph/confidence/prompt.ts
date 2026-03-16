/**
 * Appends confidence scoring instructions to a task prompt.
 */

const CONFIDENCE_INSTRUCTIONS = `

<confidence_instructions>
After completing your task, append a self-assessment block in exactly this format:

<confidence>
score: 0.XX
reasoning: One sentence explaining your confidence level
flags: comma_separated_flags_if_any
</confidence>

Scoring rubric:
- 0.90-1.00: Fully complete, well-tested, no ambiguity
- 0.70-0.89: Mostly complete, minor gaps or assumptions
- 0.50-0.69: Partially complete, notable gaps or uncertainties
- 0.30-0.49: Significant issues, needs rework
- 0.00-0.29: Major problems, largely incomplete

Available flags (use only if applicable):
- missing_context: Key information was unavailable
- ambiguous_requirements: Requirements were unclear
- untested_approach: Used an approach you haven't verified
- partial_completion: Only part of the task was addressed
- external_dependency: Depends on external systems or data
- high_complexity: Task complexity exceeds typical scope
</confidence_instructions>`;

/**
 * Wraps a task prompt with confidence scoring instructions.
 * Does not mutate the original string.
 */
export function withConfidenceScoring(prompt: string): string {
  return prompt + CONFIDENCE_INSTRUCTIONS;
}
