import { useEffect, useState } from 'react'
import { Globe, Microscope, SlidersHorizontal } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import { useDismissableMenu } from '../lib/useMenu'

/**
 * The message box's tools menu, as Claude's: Web search on or off (for every agent), and Research,
 * which makes the next messages a thorough multi-source research with sources until it's turned off.
 */
export function ToolsMenu() {
  const savedWebSearch = useStore((s) => s.settings?.webSearch !== false)
  // Flips at once; the saved setting catches up (and wins if saving failed).
  const [pending, setPending] = useState<boolean | null>(null)
  const webSearch = pending ?? savedWebSearch
  useEffect(() => setPending(null), [savedWebSearch])
  const research = useStore((s) => s.researchNext)
  const setResearch = useStore((s) => s.setResearchNext)
  const showToast = useStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  const [below, setBelow] = useState(false)
  const menuRef = useDismissableMenu<HTMLDivElement>(open, () => setOpen(false))

  const toggleWeb = async (): Promise<void> => {
    const next = !webSearch
    setPending(next)
    try {
      await core.call('settings.update', { webSearch: next })
    } catch (error) {
      setPending(null)
      showToast(`Couldn't change web search: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="relative flex shrink-0 items-center gap-1" ref={menuRef}>
      <button
        type="button"
        className="copy-btn h-8 w-8 justify-center p-0"
        aria-label="Tools"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Tools: web search and research"
        onClick={(event) => {
          setBelow(event.currentTarget.getBoundingClientRect().top < 300)
          setOpen((v) => !v)
        }}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
      </button>
      {research && (
        <button type="button" className="tool-chip" title="Research is on: click to turn it off" onClick={() => setResearch(false)}>
          <Microscope size={12} aria-hidden="true" />
          Research
        </button>
      )}
      {!webSearch && (
        <button type="button" className="tool-chip is-off" title="Web search is off: click to turn it on" onClick={() => void toggleWeb()}>
          <Globe size={12} aria-hidden="true" />
          No web
        </button>
      )}
      {open && (
        <div className={`menu ${below ? 'top-full mt-2' : 'bottom-full mb-2'} left-0 z-50 w-[280px]`} role="dialog" aria-label="Tools">
          <label className="menu-item cursor-pointer">
            <Globe size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink">Web search</span>
              <span className="block text-[12px] text-ink-faint">Agents may search and read the web</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={webSearch} onChange={() => void toggleWeb()} />
          </label>
          <label className="menu-item cursor-pointer">
            <Microscope size={14} aria-hidden="true" className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink">Research</span>
              <span className="block text-[12px] text-ink-faint">Thorough, many sources, cited (slower)</span>
            </span>
            <input type="checkbox" role="switch" className="switch" checked={research} onChange={() => setResearch(!research)} />
          </label>
        </div>
      )}
    </div>
  )
}
