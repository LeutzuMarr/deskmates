/**
 * Freebuff's models and what each costs to run. Deskmates reads the live list off Freebuff's own
 * /model picker whenever a Freebuff session is idle (see FreebuffHost.listModels) and keeps the last
 * one it read; the list below is only the starting point before the first read.
 */
export interface FreebuffModel {
  /** The name exactly as Freebuff's picker shows it; also the model id Deskmates stores. */
  name: string
  /** "1x"…"20x" for models that use Freebucks, "Paid plan" for ones that need a paid plan, null
   *  for free (Unlimited) models. */
  cost: string | null
  /** The picker's tagline, e.g. "slow · cheapest". */
  note?: string
}

/** The last list read from Freebuff, and when. */
export interface FreebuffModelList {
  models: FreebuffModel[]
  /** Epoch ms of the read; 0 for the built-in starting list. */
  updatedAt: number
}

/** Keeps whatever model is selected in Freebuff itself. */
export const FREEBUFF_CURRENT_MODEL = 'current'

/** The starting list (CLI 0.2.35, November 2026), used until Deskmates has read Freebuff's picker. */
export const FREEBUFF_MODELS: readonly FreebuffModel[] = [
  { name: 'Muse Spark 1.3', cost: '3x', note: 'falls back to DeepSeek when busy' },
  { name: 'GLM 5.3 Flash', cost: '4x', note: 'deep reasoning' },
  { name: 'MiMo v2.6 Flash Slow', cost: '1x', note: 'slow, cheapest' },
  { name: 'DeepSeek V4.1 Flash Slow', cost: '2x' },
  { name: 'MiMo v2.6 Flash Fast', cost: '2x', note: 'balanced' },
  { name: 'GPT-6 Luna', cost: '4x', note: 'strong all-around' },
  { name: 'DeepSeek V4.1 Flash Fast', cost: '5x' },
  { name: 'Claude Haiku 5.5', cost: '6x' },
  { name: 'GPT-6.1 Terra', cost: '20x', note: '1 session a day' },
  { name: 'GPT-6.1 Sol', cost: 'Paid plan', note: '1 session a day' },
  { name: 'Nemotron 3.5 Lightning', cost: null, note: 'fast' },
  { name: 'Glyph Cluster', cost: null, note: 'preview; prompts may be kept for training' },
  { name: 'Solar Pro 4', cost: null, note: 'promotional' }
]

/** Sort weight: free first, then by Freebucks multiplier, paid-plan models last. */
function costRank(cost: string | null): number {
  if (cost === null) return 0
  const multiplier = /^(\d+(?:\.\d+)?)x$/.exec(cost)
  return multiplier ? Number(multiplier[1]) : Number.MAX_SAFE_INTEGER
}

/** Cheapest first: free models, then 1x, 2x…, then paid-plan ones. Ties keep Freebuff's order. */
export function sortFreebuffModels(models: readonly FreebuffModel[]): FreebuffModel[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort((a, b) => costRank(a.model.cost) - costRank(b.model.cost) || a.index - b.index)
    .map(({ model }) => model)
}

let known: FreebuffModel[] = sortFreebuffModels(FREEBUFF_MODELS)

/** Replaces the known list (after a fresh read of Freebuff's picker). Ignores an empty list. */
export function setFreebuffModels(models: readonly FreebuffModel[]): void {
  if (models.length > 0) known = sortFreebuffModels(models)
}

/** The known models, cheapest first. */
export function freebuffModels(): FreebuffModel[] {
  return known
}

/** The model ids Deskmates offers for Freebuff: the current one first, then the known list, cheapest first. */
export function freebuffModelIds(): string[] {
  return [FREEBUFF_CURRENT_MODEL, ...known.map((m) => m.name)]
}

/** What a model costs to run, in words: "free (unlimited)", "5x Freebucks" or "paid plan". */
export function freebuffCostLabel(cost: string | null): string {
  if (cost === null) return 'free (unlimited)'
  if (/^\d/.test(cost)) return `${cost} Freebucks`
  return cost.toLowerCase()
}

/** How a Freebuff model reads in a model menu, e.g. "MiMo v2.6 Flash Slow · 1x Freebucks · slow, cheapest". */
export function freebuffModelLabel(id: string): string {
  if (id === FREEBUFF_CURRENT_MODEL) return "Freebuff's current model"
  const model = known.find((m) => m.name === id)
  if (!model) return id
  return `${model.name} · ${freebuffCostLabel(model.cost)}${model.note ? ` · ${model.note}` : ''}`
}

/**
 * The model cards on a screen of Freebuff's /model picker. Each card is a box whose first row is
 * "› Name · tagline · tags" (the › marks the highlighted one) and whose second row is the cost
 * ("5x"), "Paid plan", or something else (a warning) for free models.
 */
export function parsePickerCards(screen: string): FreebuffModel[] {
  const rows = screen.split('\n').map((line) => line.replace(/^\s*│|│\s*$/g, '').trim())
  const lines = screen.split('\n')
  const cards: FreebuffModel[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[┌╭]/.test(lines[i]!)) continue
    const first = rows[i + 1]
    if (!first || !lines[i + 1]!.includes('│')) continue
    const segments = first.replace(/^›\s*/, '').split(/\s+·\s+/).map((part) => part.trim()).filter(Boolean)
    const name = segments[0]
    if (!name) continue
    const second = lines[i + 2]?.includes('│') && !/^\s*[└╰]/.test(lines[i + 2]!) ? rows[i + 2]!.trim() : ''
    const multiplier = /^(\d+(?:\.\d+)?)\s*x\b/i.exec(second)
    const cost = multiplier ? `${multiplier[1]}x` : /paid/i.test(second) ? 'Paid plan' : null
    const note = segments.slice(1).join(' · ')
    cards.push(note ? { name, cost, note } : { name, cost })
  }
  return cards
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
