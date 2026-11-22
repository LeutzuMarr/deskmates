/**
 * How hard the agents think, from the Fable 5.2 prompt's own effort table (low, medium, high,
 * extra, max). The user picks it next to the model in the message box; every agent's instructions
 * carry it as the prompt's <reasoning_effort> value, and models with their own reasoning setting
 * (OpenAI's reasoning models, Gemini's thinking models) get that set to match.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'extra', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** The prompt's default (`<reasoning_effort>10</reasoning_effort>`). */
export const DEFAULT_EFFORT: EffortLevel = 'medium'

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extra: 'Extra',
  max: 'Max'
}

/** One line on what each level means, for the picker. */
export const EFFORT_HINTS: Record<EffortLevel, string> = {
  low: 'Quick answers, little checking',
  medium: 'The usual balance',
  high: 'Thinks longer and checks more',
  extra: 'Careful, thorough work',
  max: 'As thorough as it can be'
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}
