import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Slider, SegmentedControl } from 'glisse'
import { BRUSHES, HIGHLIGHTS, PALETTE, WIDTHS, isBrushTool, type Favorite, type InkTool, type ToolState } from './tools'
import { ColorPicker } from '../ui/ColorPicker'

const TOOL_NAMES: Record<InkTool, string> = {
  pen: 'Pen',
  pencil: 'Pencil',
  highlighter: 'Highlighter',
  marker: 'Marker',
  graphite: 'Graphite',
  charcoal: 'Charcoal',
  airbrush: 'Airbrush',
  watercolor: 'Watercolour'
}

export function toolName(tool: InkTool): string {
  return TOOL_NAMES[tool]
}

/** A small preview dot for a width. */
function WidthDot({ width, max }: { width: number; max: number }) {
  const size = 6 + (width / max) * 16
  return <span className="block rounded-full bg-current" style={{ width: size, height: size }} />
}

/** Colour, width and favourites for the ink tool in use. */
export function PenOptions({ tools, update }: { tools: ToolState; update: (next: ToolState) => void }) {
  const tool = tools.tool as InkTool
  const pen = tools.pens[tool]
  const [picker, setPicker] = useState(false)
  const palette = tool === 'highlighter' ? HIGHLIGHTS : PALETTE
  const widths = WIDTHS[tool]

  const setPen = (changes: Partial<typeof pen>): void => {
    const recent = changes.color && !palette.includes(changes.color) ? [changes.color, ...tools.recentColors.filter((c) => c !== changes.color)].slice(0, 6) : tools.recentColors
    update({ ...tools, recentColors: recent, pens: { ...tools.pens, [tool]: { ...pen, ...changes } } })
  }

  const isFavorite = (f: Favorite): boolean => f.tool === tool && f.color === pen.color && f.width === pen.width

  return (
    <div className="flex flex-col gap-4">
      {isBrushTool(tool) && (
        <SegmentedControl
          aria-label="Brush"
          items={BRUSHES.map((b) => ({ value: b, label: <span className="text-[12px]">{toolName(b)}</span> }))}
          value={tool}
          onValueChange={(b) => update({ ...tools, tool: b as InkTool, lastInk: b as InkTool, brush: b as InkTool })}
        />
      )}
      <div className="flex flex-wrap gap-2.5" role="group" aria-label="Colour">
        {[...palette, ...tools.recentColors].map((c, i) => (
          <button key={`${c}-${i}`} type="button" className="swatch" aria-label={c} aria-pressed={pen.color === c} style={{ background: c }} onClick={() => setPen({ color: c })} />
        ))}
        <button type="button" className="swatch flex items-center justify-center bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]" aria-label="Pick any colour" aria-pressed={picker} onClick={() => setPicker(!picker)}>
          <span className="size-3 rounded-full bg-white" />
        </button>
      </div>
      {picker && <ColorPicker value={pen.color} onChange={(color) => setPen({ color })} palette={tools.palette} onPaletteChange={(palette) => update({ ...tools, palette })} />}

      <div className="flex items-center gap-3">
        <span className="w-14 text-[13px] text-ink-muted">Size</span>
        <div className="flex-1">
          <SegmentedControl
            aria-label="Size"
            items={widths.map((w, i) => ({ value: String(i), label: <WidthDot width={w} max={widths[2]} /> }))}
            value={String(widths.indexOf(pen.width as never))}
            onValueChange={(v) => setPen({ width: widths[Number(v)]! })}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="w-14 text-[13px] text-ink-muted">Fine</span>
        <div className="flex-1">
          <Slider aria-label="Exact size" min={widths[0] * 0.4} max={widths[2] * 2} step={0.1} value={pen.width} onValueChange={(v) => setPen({ width: Math.round(v * 10) / 10 })} />
        </div>
      </div>
      {(tool === 'highlighter' || tool === 'marker' || tool === 'watercolor' || tool === 'airbrush' || tool === 'pencil') && (
        <div className="flex items-center gap-3">
          <span className="w-14 text-[13px] text-ink-muted">Opacity</span>
          <div className="flex-1">
            <Slider aria-label="Opacity" min={0.1} max={1} step={0.05} value={pen.opacity ?? 1} onValueChange={(v) => setPen({ opacity: v })} />
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] text-ink-muted">Favourites</span>
          {!tools.favorites.some(isFavorite) && (
            <button
              type="button"
              className="press flex items-center gap-1 rounded-full px-2 py-1 text-[13px] font-medium text-clay-deep"
              onClick={() => update({ ...tools, favorites: [...tools.favorites, { tool, ...pen }].slice(-10) })}
            >
              <Plus size={14} /> Save this {toolName(tool).toLowerCase()}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {tools.favorites.map((f, i) => (
            <span key={i} className="flex items-center gap-1 rounded-full bg-black/5 py-1 pl-2 pr-1 text-[12px] dark:bg-white/10">
              <span className="size-3.5 rounded-full" style={{ background: f.color }} />
              {toolName(f.tool)} {f.width}
              <button type="button" aria-label="Remove favourite" className="press rounded-full p-0.5 text-ink-muted" onClick={() => update({ ...tools, favorites: tools.favorites.filter((_, j) => j !== i) })}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
