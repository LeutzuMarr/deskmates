import { useEffect, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'

/** HSV (h 0–360, s and v 0–1) to #rrggbb. */
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number): number => {
    const k = (n + h / 60) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
}

export function hexToHsv(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  const n = parseInt(m[1]!, 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return [h, max === 0 ? 0 : d / max, max]
}

/** Tracks a finger or pen dragging over an element, as 0–1 fractions. */
function useDrag(onMove: (fx: number, fy: number) => void) {
  const ref = useRef<HTMLDivElement>(null)
  const handler = useRef(onMove)
  handler.current = onMove
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const at = (e: PointerEvent): void => {
      const r = el.getBoundingClientRect()
      handler.current(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)))
    }
    const down = (e: PointerEvent): void => {
      el.setPointerCapture(e.pointerId)
      at(e)
      el.addEventListener('pointermove', at)
      const up = (): void => {
        el.removeEventListener('pointermove', at)
        el.removeEventListener('pointerup', up)
      }
      el.addEventListener('pointerup', up)
    }
    el.addEventListener('pointerdown', down)
    return () => el.removeEventListener('pointerdown', down)
  }, [])
  return ref
}

/** Saturation/brightness square, hue strip, hex field, and saved palettes. */
export function ColorPicker({ value, onChange, palette, onPaletteChange }: { value: string; onChange: (hex: string) => void; palette: string[]; onPaletteChange: (palette: string[]) => void }) {
  const [hsv, setHsv] = useState(() => hexToHsv(value))
  const [hex, setHex] = useState(value)
  useEffect(() => {
    if (value.toLowerCase() !== hsvToHex(...hsv).toLowerCase()) setHsv(hexToHsv(value))
    setHex(value)
    // Only when the colour changes from outside.
  }, [value])
  const set = (next: [number, number, number]): void => {
    setHsv(next)
    const out = hsvToHex(...next)
    setHex(out)
    onChange(out)
  }
  const square = useDrag((fx, fy) => set([hsv[0], fx, 1 - fy]))
  const hue = useDrag((fx) => set([fx * 360, hsv[1], hsv[2]]))
  const [h, s, v] = hsv
  return (
    <div className="flex flex-col gap-3">
      <div ref={square} className="relative h-40 w-full touch-none overflow-hidden rounded-2xl" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hsvToHex(h, 1, 1)})` }}>
        <span className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.3)]" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: hsvToHex(h, s, v) }} />
      </div>
      <div ref={hue} className="relative h-6 w-full touch-none rounded-full" style={{ background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }}>
        <span className="pointer-events-none absolute top-1/2 size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.3)]" style={{ left: `${(h / 360) * 100}%`, background: hsvToHex(h, 1, 1) }} />
      </div>
      <div className="flex items-center gap-2">
        <span className="size-8 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)]" style={{ background: value }} />
        <input
          value={hex}
          aria-label="Hex colour"
          onChange={(e) => {
            setHex(e.target.value)
            const clean = e.target.value.trim().replace(/^#?/, '#')
            if (/^#[0-9a-f]{6}$/i.test(clean)) {
              setHsv(hexToHsv(clean))
              onChange(clean.toLowerCase())
            }
          }}
          className="w-28 rounded-xl border border-rule bg-card px-2.5 py-1.5 font-mono text-[14px] uppercase outline-none focus:border-clay"
        />
        <button type="button" className="press ml-auto flex items-center gap-1 rounded-full bg-black/5 px-2.5 py-1.5 text-[12px] font-semibold dark:bg-white/10" onClick={() => !palette.includes(value) && onPaletteChange([...palette, value].slice(-24))}>
          <Plus size={13} /> Save
        </button>
      </div>
      {palette.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {palette.map((c) => (
            <span key={c} className="group relative">
              <button type="button" aria-label={c} className="swatch" aria-pressed={c === value} style={{ background: c }} onClick={() => onChange(c)} />
              <button type="button" aria-label="Remove from palette" className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-card p-0.5 shadow group-hover:block" onClick={() => onPaletteChange(palette.filter((x) => x !== c))}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
