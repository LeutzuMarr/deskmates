/** Small pictures of pages (page overview, covers, template previews), drawn with the page code. */
import { useEffect, useRef } from 'react'
import type { Item, Page, PageStyle } from '../model'
import { pageDimensions } from '../model'
import { drawPaper } from './paper'
import { InkCache, paintItem } from './paint'
import { templateById } from '../templates/registry'
import { drawTemplate, type TemplateSpec } from '../templates/spec'
import { assetBlob } from '../db'

let shared: InkCache | null = null
const redraws = new Set<() => void>()

/** One cache for all thumbnails; a picture that finishes loading redraws them. */
export function thumbCache(): InkCache {
  shared ??= new InkCache(
    (id) => assetBlob(id),
    () => {
      for (const r of redraws) r()
    }
  )
  return shared
}

export function drawPageThumb(canvas: HTMLCanvasElement, page: Pick<Page, 'paper' | 'color' | 'width' | 'height' | 'template' | 'background'>, items: Item[], width: number, template?: TemplateSpec | null): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const height = Math.round((width * page.height) / page.width)
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const scale = (width * dpr) / page.width
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  const all = { minX: 0, minY: 0, maxX: page.width, maxY: page.height }
  drawPaper(ctx, page, all, scale / dpr / 1.4)
  const spec = template ?? templateById(page.template)
  if (spec) drawTemplate(ctx, spec, page.width, page.color, scale / dpr / 1.4)
  const cache = thumbCache()
  if (page.background) {
    const picture = cache.picture(page.background.assetId)
    if (picture) ctx.drawImage(picture, 0, 0, page.width, page.height)
  }
  for (const item of items) paintItem(ctx, item, cache, page.color)
}

/** A <canvas> showing a page, redrawn when its inputs change. */
export function usePageThumb(page: Parameters<typeof drawPageThumb>[1] | null, items: Item[], width: number, template?: TemplateSpec | null) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const draw = (): void => {
      if (ref.current && page) drawPageThumb(ref.current, page, items, width, template)
    }
    draw()
    redraws.add(draw)
    return () => {
      redraws.delete(draw)
    }
  }, [page, items, width, template])
  return ref
}

/** What a template looks like on a page. */
export function templatePage(spec: TemplateSpec | PageStyle & { landscape?: boolean }): Pick<Page, 'paper' | 'color' | 'width' | 'height'> {
  const [width, height] = pageDimensions({ paper: spec.paper, color: spec.color, size: 'size' in spec && spec.size && spec.size !== 'infinite' ? spec.size : 'a4', landscape: spec.landscape })
  return { paper: spec.paper, color: spec.color, width, height }
}
