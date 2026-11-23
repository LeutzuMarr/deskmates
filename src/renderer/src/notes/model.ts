/**
 * What a notebook is made of. Everything on a page is an item in page coordinates (CSS pixels of
 * the page at 100%), so it redraws sharply at any zoom and syncs as small records.
 */

export type Paper = 'blank' | 'ruled' | 'narrow' | 'grid' | 'dots' | 'cornell' | 'graph' | 'isometric'
export type PaperColor = 'white' | 'cream' | 'dark'
export type PageSize = 'a4' | 'letter' | 'square' | 'infinite'

export interface PageStyle {
  paper: Paper
  color: PaperColor
  size: PageSize
  landscape?: boolean
}

export interface Page extends PageStyle {
  id: string
  notebookId: string
  /** Sort key within the notebook. */
  order: number
  width: number
  height: number
  /** A user-given heading, shown in the outline. */
  title?: string
  bookmarked?: boolean
  /** A page made from a PDF page or a picture template: drawn under everything. */
  background?: { assetId: string; page?: number }
  /** A built-in or added template the page was made from. */
  template?: string
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export type PenTool = 'pen' | 'pencil' | 'highlighter' | 'marker' | 'graphite' | 'charcoal' | 'airbrush' | 'watercolor'

/** One point: x, y in page space, pressure 0..1, ms since the stroke began. */
export type InkPoint = [number, number, number, number]

export interface StrokeData {
  tool: PenTool
  color: string
  /** Nominal width in page pixels at full pressure. */
  width: number
  /** 0..1, for markers and watercolour. */
  opacity?: number
  points: InkPoint[]
  /** A shape the stroke was turned into (kept so it stays crisp). */
  shape?: 'line' | 'polyline' | 'ellipse'
  /** Seed for brush grain, so it looks the same every time. */
  seed?: number
}

export interface TextData {
  x: number
  y: number
  width: number
  text: string
  size: number
  color: string
  font: 'sans' | 'serif' | 'mono' | 'hand'
  bold?: boolean
}

export interface ImageData {
  assetId: string
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

export interface StickyData {
  x: number
  y: number
  width: number
  height: number
  rotation: number
  color: string
  text: string
}

export interface TapeData {
  x1: number
  y1: number
  x2: number
  y2: number
  width: number
  color: string
  revealed: boolean
}

export interface FillData {
  /** Outline of the filled area (page space), possibly with holes. */
  rings: Array<Array<[number, number]>>
  color: string
}

export type ItemKind = 'stroke' | 'text' | 'image' | 'sticker' | 'sticky' | 'tape' | 'fill'

export interface ItemDataMap {
  stroke: StrokeData
  text: TextData
  image: ImageData
  sticker: ImageData
  sticky: StickyData
  tape: TapeData
  fill: FillData
}

export interface Item<K extends ItemKind = ItemKind> {
  id: string
  pageId: string
  notebookId: string
  kind: K
  /** Stacking order on the page (later on top). */
  z: number
  data: ItemDataMap[K]
  /** When it was made, relative to an audio recording of the notebook if one was running. */
  audio?: { recordingId: string; at: number }
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export const PAGE_SIZES: Record<Exclude<PageSize, 'infinite'>, [number, number]> = {
  a4: [794, 1123],
  letter: [816, 1056],
  square: [960, 960]
}

/** An "infinite" whiteboard is one big page that the view never runs out of. */
export const INFINITE_SIZE = 20000

export function pageDimensions(style: PageStyle): [number, number] {
  if (style.size === 'infinite') return [INFINITE_SIZE, INFINITE_SIZE]
  const [w, h] = PAGE_SIZES[style.size]
  return style.landscape ? [h, w] : [w, h]
}

export const DEFAULT_PAGE_STYLE: PageStyle = { paper: 'ruled', color: 'white', size: 'a4' }
