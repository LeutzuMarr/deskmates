/**
 * Templates: a paper plus a few printed elements (headings, boxes, tables, ruled areas), described
 * as data so built-in templates, store packs and the user's own all work the same way. Positions
 * are in millimetres on an A4 sheet; on other sizes they scale to the page.
 */
import type { Paper, PaperColor, PageSize } from '../model'
import { MM } from '../ink/paper'

export type TemplateColor = 'line' | 'strong' | 'accent' | 'tint' | 'ink' | 'muted'

export type TemplateElement =
  | { t: 'text'; x: number; y: number; text: string; size?: number; weight?: 400 | 600 | 700; c?: TemplateColor; align?: 'left' | 'center' | 'right'; serif?: boolean }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; w?: number; c?: TemplateColor; dash?: boolean }
  | { t: 'rect'; x: number; y: number; w: number; h: number; r?: number; fill?: TemplateColor; stroke?: TemplateColor; sw?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; fill?: TemplateColor; stroke?: TemplateColor; sw?: number; dash?: boolean }
  | { t: 'lines'; x: number; y: number; w: number; h: number; step: number; c?: TemplateColor }
  | { t: 'grid'; x: number; y: number; w: number; h: number; step: number; c?: TemplateColor }
  | { t: 'dots'; x: number; y: number; w: number; h: number; step: number }
  | { t: 'check'; x: number; y: number; size?: number }
  | { t: 'axes'; x: number; y: number; w: number; h: number }

export interface TemplateSpec {
  id: string
  name: string
  /** Where it's listed: study, planning, work, or a school subject. */
  group: string
  paper: Paper
  color: PaperColor
  size?: PageSize
  landscape?: boolean
  /** The accent colour for headings and tints. */
  accent?: string
  elements: TemplateElement[]
}

const PALETTE: Record<PaperColor, Record<Exclude<TemplateColor, 'accent' | 'tint'>, string>> = {
  white: { line: 'rgba(70,110,170,.30)', strong: 'rgba(70,90,130,.55)', ink: '#2b2a28', muted: '#8a877f' },
  cream: { line: 'rgba(120,96,60,.28)', strong: 'rgba(110,86,50,.55)', ink: '#3a3127', muted: '#94866f' },
  dark: { line: 'rgba(255,255,255,.16)', strong: 'rgba(255,255,255,.35)', ink: '#f2f0ea', muted: '#a9a69d' }
}

function canvasColor(c: TemplateColor | undefined, paper: PaperColor, accent: string): string {
  if (c === 'accent') return accent
  if (c === 'tint') return hexAlpha(accent, paper === 'dark' ? 0.22 : 0.12)
  return PALETTE[paper][c ?? 'line']
}

export function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/**
 * Draws a template's elements onto a page (context in page space). `width` is the page width in
 * page pixels; millimetres are scaled so 210 mm spans it.
 */
export function drawTemplate(ctx: CanvasRenderingContext2D, spec: TemplateSpec, pageWidth: number, paper: PaperColor, zoom: number): void {
  // Millimetres of A4, shrunk if the page is narrower than the template.
  const k = Math.min(MM, pageWidth / (spec.landscape ? 297 : 210))
  const accent = spec.accent ?? '#c96442'
  const hair = Math.max(0.6, 1 / zoom)
  ctx.save()
  for (const el of spec.elements) {
    switch (el.t) {
      case 'text': {
        const size = (el.size ?? 5) * k
        ctx.font = `${el.weight ?? 600} ${size}px ${el.serif ? "'Newsreader Variable', Georgia, serif" : "'Instrument Sans Variable', system-ui, sans-serif"}`
        ctx.fillStyle = canvasColor(el.c ?? 'ink', paper, accent)
        ctx.textAlign = el.align ?? 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(el.text, el.x * k, el.y * k)
        break
      }
      case 'line':
        ctx.beginPath()
        ctx.setLineDash(el.dash ? [3 * k, 2 * k] : [])
        ctx.lineWidth = Math.max(hair, (el.w ?? 0.3) * k)
        ctx.strokeStyle = canvasColor(el.c, paper, accent)
        ctx.moveTo(el.x1 * k, el.y1 * k)
        ctx.lineTo(el.x2 * k, el.y2 * k)
        ctx.stroke()
        ctx.setLineDash([])
        break
      case 'rect':
        ctx.beginPath()
        ctx.roundRect(el.x * k, el.y * k, el.w * k, el.h * k, (el.r ?? 0) * k)
        if (el.fill) {
          ctx.fillStyle = canvasColor(el.fill, paper, accent)
          ctx.fill()
        }
        if (el.stroke) {
          ctx.lineWidth = Math.max(hair, (el.sw ?? 0.35) * k)
          ctx.strokeStyle = canvasColor(el.stroke, paper, accent)
          ctx.stroke()
        }
        break
      case 'circle':
        ctx.beginPath()
        ctx.setLineDash(el.dash ? [3 * k, 2 * k] : [])
        ctx.arc(el.cx * k, el.cy * k, el.r * k, 0, Math.PI * 2)
        if (el.fill) {
          ctx.fillStyle = canvasColor(el.fill, paper, accent)
          ctx.fill()
        }
        if (el.stroke) {
          ctx.lineWidth = Math.max(hair, (el.sw ?? 0.35) * k)
          ctx.strokeStyle = canvasColor(el.stroke, paper, accent)
          ctx.stroke()
        }
        ctx.setLineDash([])
        break
      case 'lines':
        ctx.beginPath()
        ctx.lineWidth = hair
        ctx.strokeStyle = canvasColor(el.c, paper, accent)
        for (let y = el.y + el.step; y <= el.y + el.h + 0.01; y += el.step) {
          ctx.moveTo(el.x * k, y * k)
          ctx.lineTo((el.x + el.w) * k, y * k)
        }
        ctx.stroke()
        break
      case 'grid':
        ctx.beginPath()
        ctx.lineWidth = hair
        ctx.strokeStyle = canvasColor(el.c, paper, accent)
        for (let y = el.y; y <= el.y + el.h + 0.01; y += el.step) {
          ctx.moveTo(el.x * k, y * k)
          ctx.lineTo((el.x + el.w) * k, y * k)
        }
        for (let x = el.x; x <= el.x + el.w + 0.01; x += el.step) {
          ctx.moveTo(x * k, el.y * k)
          ctx.lineTo(x * k, (el.y + el.h) * k)
        }
        ctx.stroke()
        break
      case 'dots':
        ctx.beginPath()
        ctx.fillStyle = canvasColor('strong', paper, accent)
        for (let y = el.y; y <= el.y + el.h; y += el.step)
          for (let x = el.x; x <= el.x + el.w; x += el.step) {
            ctx.moveTo(x * k + 0.35 * k, y * k)
            ctx.arc(x * k, y * k, 0.3 * k, 0, Math.PI * 2)
          }
        ctx.fill()
        break
      case 'check': {
        const s = (el.size ?? 4) * k
        ctx.beginPath()
        ctx.lineWidth = Math.max(hair, 0.35 * k)
        ctx.strokeStyle = canvasColor('strong', paper, accent)
        ctx.roundRect(el.x * k, el.y * k, s, s, 0.8 * k)
        ctx.stroke()
        break
      }
      case 'axes': {
        const x0 = el.x * k
        const y0 = el.y * k
        const w = el.w * k
        const h = el.h * k
        ctx.beginPath()
        ctx.lineWidth = Math.max(hair, 0.45 * k)
        ctx.strokeStyle = canvasColor('strong', paper, accent)
        ctx.moveTo(x0, y0 + h / 2)
        ctx.lineTo(x0 + w, y0 + h / 2)
        ctx.moveTo(x0 + w / 2, y0 + h)
        ctx.lineTo(x0 + w / 2, y0)
        // Arrow heads.
        ctx.moveTo(x0 + w - 2.5 * k, y0 + h / 2 - 1.5 * k)
        ctx.lineTo(x0 + w, y0 + h / 2)
        ctx.lineTo(x0 + w - 2.5 * k, y0 + h / 2 + 1.5 * k)
        ctx.moveTo(x0 + w / 2 - 1.5 * k, y0 + 2.5 * k)
        ctx.lineTo(x0 + w / 2, y0)
        ctx.lineTo(x0 + w / 2 + 1.5 * k, y0 + 2.5 * k)
        ctx.stroke()
        ctx.font = `600 ${3.5 * k}px 'Instrument Sans Variable', system-ui, sans-serif`
        ctx.fillStyle = canvasColor('muted', paper, accent)
        ctx.fillText('x', x0 + w - 3 * k, y0 + h / 2 + 5 * k)
        ctx.fillText('y', x0 + w / 2 + 2 * k, y0 + 4 * k)
        ctx.fillText('O', x0 + w / 2 - 4 * k, y0 + h / 2 + 4.5 * k)
        break
      }
    }
  }
  ctx.restore()
}

/** All searchable words in a template (its printed headings). */
export function templateText(spec: TemplateSpec): string {
  return spec.elements
    .filter((e): e is Extract<TemplateElement, { t: 'text' }> => e.t === 'text')
    .map((e) => e.text)
    .join(' ')
}
