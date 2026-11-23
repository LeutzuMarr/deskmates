/**
 * Turns the store's packs (src/renderer/src/notes/store/packs.ts) into static files the app
 * downloads: /store/catalog.json (the shelf) and /store/packs/<id>.json (templates and the list of
 * sticker files). Sticker files themselves are in the public folder already.
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { PACKS } from '../src/renderer/src/notes/store/packs'

export function stickerName(file: string): string {
  const base = file.replace(/\.svg$/, '').replace(/^dm-/, '').replace(/-/g, ' ')
  return base.charAt(0).toUpperCase() + base.slice(1)
}

export function buildStore(stickerRoot: string): { catalog: unknown; packs: Record<string, unknown> } {
  const packs: Record<string, unknown> = {}
  const catalog = PACKS.map((pack) => {
    const dir = join(stickerRoot, pack.id)
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.svg')).sort((a, b) => (a.startsWith('dm-') === b.startsWith('dm-') ? a.localeCompare(b) : a.startsWith('dm-') ? -1 : 1)) : []
    const stickers = files.map((f) => ({ id: `${pack.id}:${f.replace(/\.svg$/, '')}`, name: stickerName(f), file: `/store/stickers/${pack.id}/${f}` }))
    const templates = pack.templates.map((t) => ({ ...t, id: `store:${pack.id}:${t.id}`, group: pack.name, accent: pack.accent }))
    packs[pack.id] = { id: pack.id, name: pack.name, subject: pack.subject, accent: pack.accent, version: pack.version, credits: pack.credits, templates, stickers }
    return {
      id: pack.id,
      name: pack.name,
      subject: pack.subject,
      description: pack.description,
      accent: pack.accent,
      cover: `/store/stickers/${pack.id}/${pack.cover}.svg`,
      preview: stickers.slice(0, 8).map((s) => s.file),
      templates: templates.length,
      stickers: stickers.length,
      version: pack.version,
      credits: pack.credits
    }
  })
  return { catalog: { version: 1, packs: catalog }, packs }
}

export function storeFiles(stickerRoot: string): Plugin {
  return {
    name: 'deskmates-store-files',
    apply: 'build',
    generateBundle() {
      const { catalog, packs } = buildStore(stickerRoot)
      this.emitFile({ type: 'asset', fileName: 'store/catalog.json', source: JSON.stringify(catalog) })
      for (const [id, pack] of Object.entries(packs)) this.emitFile({ type: 'asset', fileName: `store/packs/${id}.json`, source: JSON.stringify(pack) })
    }
  }
}
