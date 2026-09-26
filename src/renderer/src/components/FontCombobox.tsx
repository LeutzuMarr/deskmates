import { useEffect, useMemo, useState } from 'react'
import { ChevronsUpDown, Search } from 'lucide-react'
import { WEB_FONTS } from '../../../shared/design-bridge'
import type { WebFont } from '../../../shared/design-bridge'
import { useDismissableMenu } from '../lib/useMenu'
import { concentricVars } from '../lib/design'

let systemFontsPromise: Promise<string[]> | null = null
function loadSystemFontsOnce(): Promise<string[]> {
  if (!systemFontsPromise) systemFontsPromise = window.deskmates.design.systemFonts().catch(() => [])
  return systemFontsPromise
}

interface FontComboboxProps {
  /** The selected element's current font family (bare name, e.g. "Inter"). */
  value: string
  onPickWebFont: (font: WebFont) => void
  onPickSystemFont: (name: string) => void
}

export function FontCombobox({ value, onPickWebFont, onPickSystemFont }: FontComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const menuRef = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false))

  useEffect(() => {
    if (open) void loadSystemFontsOnce().then(setSystemFonts)
  }, [open])

  const q = query.trim().toLowerCase()
  const webMatches = useMemo(() => WEB_FONTS.filter((f) => f.family.toLowerCase().includes(q)), [q])
  const systemMatches = useMemo(() => systemFonts.filter((f) => f.toLowerCase().includes(q)), [systemFonts, q])
  const noMatches = webMatches.length === 0 && systemMatches.length === 0

  const pickWeb = (font: WebFont): void => {
    onPickWebFont(font)
    setOpen(false)
    setQuery('')
  }
  const pickSystem = (name: string): void => {
    onPickSystemFont(name)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative">
      <button
        type="button"
        className="r-concentric flex w-full items-center justify-between gap-2 border border-rule bg-transparent px-3 py-2 text-left text-[13px] text-ink"
        style={concentricVars(16)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Font: ${value || 'not set'}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="min-w-0 flex-1 truncate">{value || 'Choose a font'}</span>
        <ChevronsUpDown size={13} aria-hidden="true" className="shrink-0 text-ink-muted" />
      </button>
      {open && (
        <div
          ref={menuRef}
          role="listbox"
          aria-label="Font"
          className="menu scroll-area"
          style={{ top: '100%', left: 0, right: 0, marginTop: 4, maxHeight: 280, overflowY: 'auto' }}
        >
          <div className="flex items-center gap-2 px-2 py-1">
            <Search size={13} aria-hidden="true" className="shrink-0 text-ink-muted" />
            <label className="sr-only" htmlFor="font-search">
              Search fonts
            </label>
            <input
              id="font-search"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search fonts"
              className="w-full min-w-0 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
            />
          </div>
          {webMatches.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wide text-ink-faint">Web fonts</div>
              {webMatches.map((font) => (
                <button key={font.family} type="button" role="option" className="menu-item" onClick={() => pickWeb(font)}>
                  {font.family}
                </button>
              ))}
            </>
          )}
          {systemMatches.length > 0 && (
            <>
              <div className="px-2 pb-1 pt-2 text-[11px] uppercase tracking-wide text-ink-faint">On this PC</div>
              {systemMatches.map((name) => (
                <button key={name} type="button" role="option" className="menu-item" onClick={() => pickSystem(name)}>
                  {name}
                </button>
              ))}
            </>
          )}
          {noMatches && <div className="px-3 py-2 text-[13px] text-ink-faint">No fonts match &ldquo;{query}&rdquo;.</div>}
        </div>
      )}
    </div>
  )
}
