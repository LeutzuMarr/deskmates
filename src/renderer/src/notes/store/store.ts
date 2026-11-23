/**
 * The store on the device: the shelf of packs (fetched when online, remembered for offline),
 * installing a pack (its templates and sticker files are saved, so they work offline), and the
 * user's own stickers and templates.
 */
import { getAllRecords, getByIndex, getMeta, newId, putAsset, save, setMeta } from '../db'
import { addTemplates, removeTemplate, allTemplates, type StoredTemplate } from '../templates/registry'
import type { TemplateSpec } from '../templates/spec'

export interface CatalogPack {
  id: string
  name: string
  subject: string
  description: string
  accent: string
  cover: string
  preview: string[]
  templates: number
  stickers: number
  version: number
  credits: string
}

interface PackFile {
  id: string
  name: string
  subject: string
  accent: string
  version: number
  credits: string
  templates: TemplateSpec[]
  stickers: Array<{ id: string; name: string; file: string }>
}

export interface InstalledPack {
  id: string
  name: string
  subject: string
  accent: string
  /** "store" for packs from the store, "mine" for the user's own. */
  source: 'store' | 'mine'
  version: number
  credits?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

export interface Sticker {
  id: string
  packId: string
  name: string
  assetId: string
  /** Natural size, to place it at the right shape. */
  width: number
  height: number
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

export const MY_PACK = 'mine'

export async function fetchCatalog(): Promise<CatalogPack[]> {
  try {
    const response = await fetch('/store/catalog.json', { cache: 'no-cache' })
    if (!response.ok) throw new Error(String(response.status))
    const catalog = (await response.json()) as { packs: CatalogPack[] }
    await setMeta('storeCatalog', catalog.packs)
    return catalog.packs
  } catch {
    // Offline: the shelf as it was last seen.
    return (await getMeta<CatalogPack[]>('storeCatalog')) ?? []
  }
}

export async function listInstalled(): Promise<InstalledPack[]> {
  return (await getAllRecords<InstalledPack>('packs')).filter((p) => !p.deletedAt)
}

export async function listStickers(packId: string): Promise<Sticker[]> {
  return (await getByIndex<Sticker>('stickers', 'packId', packId)).filter((s) => !s.deletedAt)
}

async function imageSize(blob: Blob): Promise<[number, number]> {
  try {
    if (blob.type === 'image/svg+xml') {
      const text = await blob.text()
      const box = /viewBox="[\d.\s-]*?\s([\d.]+)\s([\d.]+)"/.exec(text)
      if (box) return [Number(box[1]), Number(box[2])]
    }
    const bitmap = await createImageBitmap(blob)
    const size: [number, number] = [bitmap.width, bitmap.height]
    bitmap.close()
    return size
  } catch {
    return [1, 1]
  }
}

/** Downloads a pack and keeps it on the device. */
export async function installPack(id: string, progress?: (done: number, total: number) => void): Promise<void> {
  const response = await fetch(`/store/packs/${id}.json`, { cache: 'no-cache' })
  if (!response.ok) throw new Error('The pack couldn’t be downloaded.')
  const pack = (await response.json()) as PackFile
  const now = Date.now()
  const existing = new Map((await listStickers(pack.id)).map((s) => [s.id, s]))
  const stickers: Sticker[] = []
  let done = 0
  const total = pack.stickers.length
  // A few at a time: quick, without opening dozens of requests at once.
  const queue = [...pack.stickers]
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (existing.has(next.id)) {
        done++
        continue
      }
      const file = await fetch(next.file)
      if (!file.ok) throw new Error('A sticker couldn’t be downloaded.')
      const blob = new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' })
      const asset = await putAsset(blob, { name: next.name })
      const [width, height] = await imageSize(blob)
      stickers.push({ id: next.id, packId: pack.id, name: next.name, assetId: asset.id, width, height, createdAt: now, updatedAt: now })
      progress?.(++done, total)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  const record: InstalledPack = { id: pack.id, name: pack.name, subject: pack.subject, accent: pack.accent, source: 'store', version: pack.version, credits: pack.credits, createdAt: now, updatedAt: now, deletedAt: null }
  await save({ packs: [record], stickers })
  await addTemplates(pack.templates.map((t) => ({ ...t, source: `store:${pack.id}`, createdAt: now, updatedAt: now })))
}

export async function uninstallPack(id: string): Promise<void> {
  const now = Date.now()
  const pack = (await listInstalled()).find((p) => p.id === id)
  if (!pack) return
  const stickers = await listStickers(id)
  await save({ packs: [{ ...pack, deletedAt: now, updatedAt: now }], stickers: stickers.map((s) => ({ ...s, deletedAt: now, updatedAt: now })) })
  for (const t of allTemplates()) if ((t as StoredTemplate).source === `store:${id}`) await removeTemplate(t.id)
}

async function ensureMyPack(): Promise<void> {
  if ((await listInstalled()).some((p) => p.id === MY_PACK)) return
  const now = Date.now()
  await save({ packs: [{ id: MY_PACK, name: 'My stickers', subject: 'Mine', accent: '#c96442', source: 'mine', version: 1, createdAt: now, updatedAt: now, deletedAt: null } satisfies InstalledPack] })
}

/** Adds pictures (from Photos, files, or a lasso selection) as the user's own stickers. */
export async function addMyStickers(files: Array<{ blob: Blob; name?: string }>): Promise<Sticker[]> {
  await ensureMyPack()
  const now = Date.now()
  const stickers: Sticker[] = []
  for (const { blob, name } of files) {
    const asset = await putAsset(blob, { name })
    const [width, height] = await imageSize(blob)
    stickers.push({ id: newId(), packId: MY_PACK, name: name ?? 'Sticker', assetId: asset.id, width, height, createdAt: now, updatedAt: now })
  }
  await save({ stickers })
  return stickers
}

export async function removeSticker(sticker: Sticker): Promise<void> {
  const now = Date.now()
  await save({ stickers: [{ ...sticker, deletedAt: now, updatedAt: now }] })
}

/** Makes a template of the user's own from pictures (one per page). */
export async function addMyTemplate(name: string, pages: Blob[], landscape: boolean): Promise<StoredTemplate> {
  const now = Date.now()
  const backgrounds: string[] = []
  for (const blob of pages) backgrounds.push((await putAsset(blob, { name })).id)
  const template: StoredTemplate = { id: `mine:${newId()}`, name: name.trim() || 'My template', group: 'Mine', paper: 'blank', color: 'white', landscape, elements: [], source: 'mine', backgrounds, createdAt: now, updatedAt: now }
  await addTemplates([template])
  return template
}

/** Saves a page's paper and printed template as a template of the user's own. */
export async function savePageStyleAsTemplate(name: string, base: TemplateSpec): Promise<StoredTemplate> {
  const now = Date.now()
  const template: StoredTemplate = { ...base, id: `mine:${newId()}`, name: name.trim() || 'My template', group: 'Mine', source: 'mine', createdAt: now, updatedAt: now }
  await addTemplates([template])
  return template
}
