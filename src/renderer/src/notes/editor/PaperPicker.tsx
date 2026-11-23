import { useEffect, useRef, useState } from 'react'
import { SegmentedControl } from 'glisse'
import { drawPaper } from '../ink/paper'
import { pageDimensions, type Paper, type PaperColor, type PageSize, type PageStyle } from '../model'

export const PAPERS: Array<{ value: Paper; label: string }> = [
  { value: 'blank', label: 'Blank' },
  { value: 'ruled', label: 'Ruled' },
  { value: 'narrow', label: 'Narrow ruled' },
  { value: 'grid', label: 'Squared' },
  { value: 'dots', label: 'Dotted' },
  { value: 'cornell', label: 'Cornell' },
  { value: 'graph', label: 'Graph (mm)' },
  { value: 'isometric', label: 'Isometric' }
]

/** A small drawing of a paper, made with the same code that draws the page. */
export function PaperPreview({ style, width = 72 }: { style: PageStyle; width?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [w, h] = style.size === 'infinite' ? [794, 794] : pageDimensions(style)
  const height = Math.round((width * h) / w)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = width * dpr
    canvas.height = height * dpr
    const ctx = canvas.getContext('2d')!
    const scale = (width * dpr) / w
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    drawPaper(ctx, { paper: style.paper, color: style.color, width: w, height: h }, { minX: 0, minY: 0, maxX: w, maxY: h }, scale / dpr / 1.6)
  }, [style.paper, style.color, w, h, width, height])
  return <canvas ref={ref} style={{ width, height }} className="rounded-md shadow-[0_0_0_1px_rgba(0,0,0,.08),0_2px_6px_rgba(0,0,0,.08)]" />
}

export function PaperPicker({ value, onApply }: { value: PageStyle; onApply: (style: PageStyle, scope: 'page' | 'notebook' | 'new-page') => void }) {
  const [style, setStyle] = useState<PageStyle>({ paper: value.paper, color: value.color, size: value.size === 'infinite' ? 'a4' : value.size, landscape: value.landscape })
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 gap-2.5">
        {PAPERS.map((p) => (
          <button
            key={p.value}
            type="button"
            aria-pressed={style.paper === p.value}
            onClick={() => setStyle({ ...style, paper: p.value })}
            className={`press flex flex-col items-center gap-1 rounded-xl p-1.5 text-[11px] ${style.paper === p.value ? 'bg-clay/15 font-semibold text-clay-deep' : ''}`}
          >
            <PaperPreview style={{ ...style, paper: p.value }} width={58} />
            {p.label}
          </button>
        ))}
      </div>
      <SegmentedControl
        aria-label="Paper colour"
        items={[
          { value: 'white', label: 'White' },
          { value: 'cream', label: 'Cream' },
          { value: 'dark', label: 'Dark' }
        ]}
        value={style.color}
        onValueChange={(v) => setStyle({ ...style, color: v as PaperColor })}
      />
      <SegmentedControl
        aria-label="Size"
        items={[
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'Letter' },
          { value: 'square', label: 'Square' }
        ]}
        value={style.size}
        onValueChange={(v) => setStyle({ ...style, size: v as PageSize })}
      />
      <SegmentedControl
        aria-label="Orientation"
        items={[
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' }
        ]}
        value={style.landscape ? 'landscape' : 'portrait'}
        onValueChange={(v) => setStyle({ ...style, landscape: v === 'landscape' })}
      />
      <div className="grid grid-cols-3 gap-2 text-[13px] font-semibold">
        <button type="button" className="press rounded-full bg-black/5 px-2 py-2.5 dark:bg-white/10" onClick={() => onApply(style, 'page')}>
          This page
        </button>
        <button type="button" className="press rounded-full bg-black/5 px-2 py-2.5 dark:bg-white/10" onClick={() => onApply(style, 'notebook')}>
          New pages
        </button>
        <button type="button" className="press rounded-full bg-clay px-2 py-2.5 text-white" onClick={() => onApply(style, 'new-page')}>
          Add page
        </button>
      </div>
    </div>
  )
}
