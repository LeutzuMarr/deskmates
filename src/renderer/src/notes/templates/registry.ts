/**
 * Every template the device knows: the built-in ones, those installed from the store, and the
 * user's own. Kept in memory so pages can draw their template synchronously.
 */
import { getAllRecords, save } from '../db'
import { BUILTIN_TEMPLATES } from './builtin'
import type { TemplateSpec } from './spec'

/** A template as stored: the spec, where it came from, and (for picture/PDF templates) its pages. */
export interface StoredTemplate extends TemplateSpec {
  /** "store:<pack>" or "mine". */
  source: string
  /** A template made from a picture or PDF: each page's background asset. */
  backgrounds?: string[]
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

const known = new Map<string, TemplateSpec | StoredTemplate>(BUILTIN_TEMPLATES.map((t) => [t.id, t]))
const listeners = new Set<() => void>()

export function templateById(id: string | undefined): TemplateSpec | StoredTemplate | null {
  return id ? (known.get(id) ?? null) : null
}

export function allTemplates(): Array<TemplateSpec | StoredTemplate> {
  return [...known.values()]
}

export function onTemplatesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function changed(): void {
  for (const l of listeners) l()
}

/** Loads installed and own templates from the device. */
export async function loadTemplates(): Promise<void> {
  const stored = await getAllRecords<StoredTemplate>('templates')
  for (const t of stored) {
    if (t.deletedAt) known.delete(t.id)
    else known.set(t.id, t)
  }
  changed()
}

export async function addTemplates(templates: StoredTemplate[]): Promise<void> {
  await save({ templates })
  for (const t of templates) known.set(t.id, t)
  changed()
}

export async function removeTemplate(id: string): Promise<void> {
  const t = known.get(id) as StoredTemplate | undefined
  if (!t || !('source' in t)) return
  const now = Date.now()
  await save({ templates: [{ ...t, deletedAt: now, updatedAt: now }] })
  known.delete(id)
  changed()
}
