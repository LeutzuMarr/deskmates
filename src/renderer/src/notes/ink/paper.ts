/**
 * Draws a page's paper: its colour and its lines, grid or dots. Spacing is in real millimetres of
 * an A4 sheet (794 px wide = 210 mm), so ruled paper feels like a school notebook.
 */
import type { Page, PaperColor } from '../model'
import type { Bounds } from './stroke'

export const MM = 794 / 210

export const PAPER_FILL: Record<PaperColor, string> = { white: '#ffffff', cream: '#fbf6e8', dark: '#252524' }
const LINE: Record<PaperColor, string> = { white: 'rgba(70,110,170,.26)', cream: 'rgba(120,96,60,.24)', dark: 'rgba(255,255,255,.14)' }
const STRONG: Record<PaperColor, string> = { white: 'rgba(70,110,170,.42)', cream: 'rgba(120,96,60,.38)', dark: 'rgba(255,255,255,.24)' }
const MARGIN: Record<PaperColor, string> = { white: 'rgba(214,92,92,.45)', cream: 'rgba(200,90,70,.42)', dark: 'rgba(240,120,110,.35)' }

/** The ink colour that reads on this paper when the chosen colour is "auto" black. */
export function inkOn(color: PaperColor, ink: string): string {
  if (color === 'dark' && (ink === '#1c1c1e' || ink === '#000000')) return '#f4f4f2'
  return ink
}

function hLines(ctx: CanvasRenderingContext2D, area: Bounds, step: number, from: number, x0: number, x1: number): void {
  const start = Math.max(from, from + Math.ceil((area.minY - from) / step) * step)
  for (let y = start; y <= area.maxY; y += step) {
    ctx.moveTo(x0, y)
    ctx.lineTo(x1, y)
  }
}

function vLines(ctx: CanvasRenderingContext2D, area: Bounds, step: number, y0: number, y1: number): void {
  for (let x = Math.ceil(area.minX / step) * step; x <= area.maxX; x += step) {
    ctx.moveTo(x, y0)
    ctx.lineTo(x, y1)
  }
}

function dots(ctx: CanvasRenderingContext2D, area: Bounds, step: number, radius: number, offsetRows = false): void {
  const rowStep = offsetRows ? step * Math.sin(Math.PI / 3) : step
  const firstRow = Math.ceil(area.minY / rowStep)
  for (let row = firstRow; row * rowStep <= area.maxY; row++) {
    const y = row * rowStep
    const shift = offsetRows && row % 2 !== 0 ? step / 2 : 0
    for (let x = Math.ceil((area.minX - shift) / step) * step + shift; x <= area.maxX; x += step) {
      ctx.moveTo(x + radius, y)
      ctx.arc(x, y, radius, 0, Math.PI * 2)
    }
  }
}

/**
 * Paints the paper, in page space (the context is already transformed to the page), only where
 * `visible` (page space) shows. `zoom` keeps hairlines about one screen pixel wide.
 */
export function drawPaper(ctx: CanvasRenderingContext2D, page: Pick<Page, 'paper' | 'color' | 'width' | 'height'>, visible: Bounds, zoom: number): void {
  const area: Bounds = {
    minX: Math.max(0, visible.minX),
    minY: Math.max(0, visible.minY),
    maxX: Math.min(page.width, visible.maxX),
    maxY: Math.min(page.height, visible.maxY)
  }
  if (area.minX >= area.maxX || area.minY >= area.maxY) return
  ctx.fillStyle = PAPER_FILL[page.color]
  ctx.fillRect(area.minX, area.minY, area.maxX - area.minX, area.maxY - area.minY)

  const hair = Math.max(0.6, 1 / zoom)
  const top = page.height > 2000 ? 0 : 26 * MM
  ctx.lineWidth = hair
  ctx.strokeStyle = LINE[page.color]
  ctx.fillStyle = STRONG[page.color]
  ctx.beginPath()
  switch (page.paper) {
    case 'ruled':
      hLines(ctx, area, 8 * MM, top, area.minX, area.maxX)
      break
    case 'narrow':
      hLines(ctx, area, 6 * MM, top, area.minX, area.maxX)
      break
    case 'grid':
      hLines(ctx, area, 5 * MM, 0, area.minX, area.maxX)
      vLines(ctx, area, 5 * MM, area.minY, area.maxY)
      break
    case 'graph':
      // Millimetre paper: faint every mm, stronger every 5 and 10.
      if (zoom * MM > 3) {
        ctx.globalAlpha = 0.45
        hLines(ctx, area, MM, 0, area.minX, area.maxX)
        vLines(ctx, area, MM, area.minY, area.maxY)
        ctx.stroke()
        ctx.beginPath()
        ctx.globalAlpha = 1
      }
      hLines(ctx, area, 5 * MM, 0, area.minX, area.maxX)
      vLines(ctx, area, 5 * MM, area.minY, area.maxY)
      ctx.stroke()
      ctx.beginPath()
      ctx.strokeStyle = STRONG[page.color]
      hLines(ctx, area, 10 * MM, 0, area.minX, area.maxX)
      vLines(ctx, area, 10 * MM, area.minY, area.maxY)
      break
    case 'dots':
      ctx.stroke()
      ctx.beginPath()
      dots(ctx, area, 5 * MM, Math.max(0.9, 1.1 / zoom))
      ctx.fill()
      ctx.beginPath()
      break
    case 'isometric':
      ctx.stroke()
      ctx.beginPath()
      dots(ctx, area, 6 * MM, Math.max(0.9, 1.1 / zoom), true)
      ctx.fill()
      ctx.beginPath()
      break
    case 'cornell': {
      const cue = 62 * MM
      const summary = page.height - 50 * MM
      hLines(ctx, { ...area, maxY: Math.min(area.maxY, summary) }, 8 * MM, top, area.minX, area.maxX)
      ctx.stroke()
      ctx.beginPath()
      ctx.strokeStyle = MARGIN[page.color]
      ctx.lineWidth = Math.max(1, 1.4 / zoom)
      ctx.moveTo(cue, top)
      ctx.lineTo(cue, summary)
      ctx.moveTo(0, summary)
      ctx.lineTo(page.width, summary)
      ctx.moveTo(0, top)
      ctx.lineTo(page.width, top)
      break
    }
    case 'blank':
      break
  }
  ctx.stroke()
  if (page.paper === 'ruled' || page.paper === 'narrow') {
    ctx.beginPath()
    ctx.strokeStyle = MARGIN[page.color]
    ctx.lineWidth = Math.max(0.8, 1.2 / zoom)
    ctx.moveTo(24 * MM, Math.max(0, area.minY))
    ctx.lineTo(24 * MM, area.maxY)
    ctx.stroke()
  }
}
