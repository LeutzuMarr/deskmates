/**
 * Freebuff's models as its own /model picker lists them (CLI 0.2.35, November 2026), in its order and
 * groups. The cost is how fast a model uses Freebucks compared with the cheapest; Unlimited models
 * don't use Freebucks at all. Freebuff can add or drop models in an update; Deskmates then still
 * offers "Freebuff's current model", and the picker check in the host reports a missing one.
 */
export type FreebuffGroup = 'standard' | 'powerful' | 'unlimited'

export interface FreebuffModel {
  /** The name exactly as Freebuff's picker shows it; also the model id Deskmates stores. */
  name: string
  group: FreebuffGroup
  /** "1x"…"20x" for Freebucks models, "Paid plan" for ones that need a paid plan, null for Unlimited. */
  cost: string | null
  note?: string
}

/** Keeps whatever model is selected in Freebuff itself. */
export const FREEBUFF_CURRENT_MODEL = 'current'

export const FREEBUFF_GROUP_LABELS: Record<FreebuffGroup, string> = {
  standard: 'Uses Freebucks',
  powerful: 'Powerful · uses more Freebucks',
  unlimited: 'Unlimited · no Freebucks'
}

export const FREEBUFF_MODELS: readonly FreebuffModel[] = [
  { name: 'Muse Spark 1.3', group: 'standard', cost: '3x', note: 'falls back to DeepSeek when busy' },
  { name: 'GLM 5.3 Flash', group: 'standard', cost: '4x', note: 'deep reasoning' },
  { name: 'MiMo v2.6 Flash Slow', group: 'standard', cost: '1x', note: 'slow, cheapest' },
  { name: 'DeepSeek V4.1 Flash Slow', group: 'standard', cost: '2x' },
  { name: 'MiMo v2.6 Flash Fast', group: 'standard', cost: '2x', note: 'balanced' },
  { name: 'GPT-6 Luna', group: 'standard', cost: '4x', note: 'strong all-around' },
  { name: 'DeepSeek V4.1 Flash Fast', group: 'powerful', cost: '5x' },
  { name: 'Claude Haiku 5.5', group: 'powerful', cost: '6x' },
  { name: 'GPT-6.1 Terra', group: 'powerful', cost: '20x', note: '1 session a day' },
  { name: 'GPT-6.1 Sol', group: 'powerful', cost: 'Paid plan', note: '1 session a day' },
  { name: 'Nemotron 3.5 Lightning', group: 'unlimited', cost: null, note: 'fast' },
  { name: 'Glyph Cluster', group: 'unlimited', cost: null, note: 'preview; prompts may be kept for training' },
  { name: 'Solar Pro 4', group: 'unlimited', cost: null, note: 'promotional' }
]

/** The model ids Deskmates offers for Freebuff: the current one first, then the picker's list. */
export const FREEBUFF_MODEL_IDS: readonly string[] = [FREEBUFF_CURRENT_MODEL, ...FREEBUFF_MODELS.map((m) => m.name)]

/** How a Freebuff model reads in a model menu, e.g. "MiMo v2.6 Flash Slow · 1x Freebucks". */
export function freebuffModelLabel(id: string): string {
  if (id === FREEBUFF_CURRENT_MODEL) return "Freebuff's current model"
  const model = FREEBUFF_MODELS.find((m) => m.name === id)
  if (!model) return id
  const cost = model.cost === null ? 'unlimited' : model.cost === 'Paid plan' ? 'paid plan' : `${model.cost} Freebucks`
  return `${model.name} · ${cost}${model.note ? ` · ${model.note}` : ''}`
}

/** What Freebuff shows about the running session, read off its screen. Null fields weren't on screen. */
export interface FreebuffStatus {
  /** The model named in Freebuff's status bar. */
  model: string | null
  /** Minutes left in the current session ("34m left"). */
  sessionMinutesLeft: number | null
  /** Session hours left today and the daily total ("12/12 hours remaining"). */
  hoursLeftToday: number | null
  hoursPerDay: number | null
  /** Context used, as Freebuff prints it ("35K (7%)"). */
  context: string | null
  /** When Deskmates last read this, epoch ms. */
  updatedAt: number
}
