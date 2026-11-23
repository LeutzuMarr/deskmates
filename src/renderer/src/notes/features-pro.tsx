/**
 * The advanced (Fresco-style) drawing mode: textured brushes, the eyedropper, the paint bucket,
 * the full colour picker and the lasso's distort. Shown when "Show drawing tools" is on.
 */
import { Brush, Droplets, Highlighter as MarkerIcon, PaintBucket, PenTool, Pipette, SprayCan } from 'lucide-react'
import { EXTRA_TOOLS, notebookExtras } from './editor/NotebookView'
import type { NotesEngine, ToolHandler } from './editor/engine'
import { makeItem } from './editor/content'
import { fillAreaAt } from './editor/fill'
import { ColorPicker } from './ui/ColorPicker'

EXTRA_TOOLS.push(
  { value: 'marker', label: 'Marker', icon: <MarkerIcon size={19} />, advanced: true },
  { value: 'graphite', label: 'Graphite', icon: <PenTool size={19} />, advanced: true },
  { value: 'charcoal', label: 'Charcoal', icon: <Brush size={19} />, advanced: true },
  { value: 'airbrush', label: 'Airbrush', icon: <SprayCan size={19} />, advanced: true },
  { value: 'watercolor', label: 'Watercolour', icon: <Droplets size={19} />, advanced: true },
  { value: 'eyedropper', label: 'Eyedropper', icon: <Pipette size={19} />, advanced: true },
  { value: 'fill', label: 'Fill', icon: <PaintBucket size={19} />, advanced: true }
)

/** Tap anything to take its colour for the pen you used last; then that pen is back in hand. */
function eyedropper(engine: NotesEngine): ToolHandler {
  return {
    down(at) {
      const color = engine.colorAt(at.screen)
      if (!color) return false
      const tools = engine.tools
      const ink = tools.lastInk
      navigator.vibrate?.(8)
      engine.requestTools?.({ ...tools, tool: ink, pens: { ...tools.pens, [ink]: { ...tools.pens[ink], color } }, recentColors: [color, ...tools.recentColors.filter((c) => c !== color)].slice(0, 6) })
      return false
    },
    move() {},
    up() {},
    cancel() {}
  }
}

/** Tap inside an area closed off by ink to fill it, under the lines. */
function bucket(engine: NotesEngine): ToolHandler {
  return {
    down(at) {
      const items = engine.itemsOn(at.page.id)
      const ring = fillAreaAt(at.page, items, engine.cache, at.x, at.y)
      if (!ring) {
        engine.say?.('Close the shape with ink first, then tap inside it.')
        return false
      }
      const color = engine.tools.pens[engine.tools.lastInk].color
      const fill = makeItem(engine, at.page.id, 'fill', { rings: [ring], color })
      // Under everything already on the page, so the outline stays crisp on top.
      fill.z = Math.min(engine.nextZ(), ...items.map((i) => i.z)) - 1
      engine.addItems([fill])
      return false
    },
    move() {},
    up() {},
    cancel() {}
  }
}

notebookExtras.setup = [
  ...(notebookExtras.setup ?? []),
  (engine) => {
    engine.handlers.eyedropper = eyedropper(engine)
    engine.handlers.fill = bucket(engine)
    return () => undefined
  }
]

const previousOptions = notebookExtras.toolOptions
notebookExtras.toolOptions = (tool, tools, update, engine) => {
  if (tool === 'fill') {
    const ink = tools.lastInk
    return (
      <div className="flex flex-col gap-3">
        <ColorPicker value={tools.pens[ink].color} onChange={(color) => update({ ...tools, pens: { ...tools.pens, [ink]: { ...tools.pens[ink], color } } })} palette={tools.palette} onPaletteChange={(palette) => update({ ...tools, palette })} />
        <p className="text-[12px] text-ink-muted">Tap inside a shape closed with ink. The colour goes under the lines.</p>
      </div>
    )
  }
  if (tool === 'eyedropper') return <p className="text-[13px] text-ink-muted">Tap any colour on the page; your last pen takes it.</p>
  return previousOptions?.(tool, tools, update, engine) ?? null
}
