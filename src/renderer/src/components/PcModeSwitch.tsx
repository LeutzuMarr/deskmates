import { useState } from 'react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import type { PcMode } from '../../../shared/protocol'

const MODE_ORDER: readonly PcMode[] = ['own', 'shared']

const MODE_LABEL: Record<PcMode, string> = { own: 'Own PC', shared: 'Shared PC' }

const MODE_EXPLANATION: Record<PcMode, string> = {
  own: "Each bot gets its own PC, logins and files, so bots can run at the same time.",
  shared:
    "Every bot uses one PC and takes turns, sharing its logins and files. Switching back restores each bot's own PC — nothing is deleted either way."
}

/** The global own-PC/shared-PC switch (`pcs.mode.*`). `pcs.mode.set` doesn't emit a bus event, so this
 *  writes the confirmed result straight into the store itself rather than waiting on one. */
export function PcModeSwitch() {
  const pcMode = useStore((s) => s.pcMode)
  const showToast = useStore((s) => s.showToast)
  const [busy, setBusy] = useState(false)

  const setMode = async (mode: PcMode): Promise<void> => {
    if (busy || mode === pcMode) return
    setBusy(true)
    try {
      const confirmed = await core.call('pcs.mode.set', { mode })
      useStore.setState({ pcMode: confirmed })
    } catch (error) {
      showToast(`Couldn't change the PC mode: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const current = pcMode ?? 'own'

  return (
    <div>
      <div className="segmented" role="radiogroup" aria-label="Bot PC mode">
        {MODE_ORDER.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={current === mode}
            className="segmented-item"
            disabled={busy || pcMode === null}
            onClick={() => void setMode(mode)}
          >
            {MODE_LABEL[mode]}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-ink-faint">{MODE_EXPLANATION[current]}</p>
    </div>
  )
}
