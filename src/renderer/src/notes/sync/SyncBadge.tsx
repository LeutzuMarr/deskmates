import { useEffect, useState } from 'react'
import { Cloud, CloudOff, RefreshCw, TriangleAlert } from 'lucide-react'
import { syncer, type SyncState } from './sync'

function ago(at: number | null): string {
  if (!at) return 'not yet'
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : new Date(at).toLocaleDateString()
}

/** Where sync stands, as a small pill; tapping it syncs now. */
export function SyncBadge() {
  const [state, setState] = useState<SyncState>(syncer.state)
  useEffect(() => syncer.onState(setState), [])
  if (state.status === 'off') return null
  const [icon, label, tone] =
    state.status === 'syncing'
      ? [<RefreshCw key="i" size={14} className="animate-spin" />, 'Syncing', '']
      : state.status === 'synced'
        ? [<Cloud key="i" size={14} />, `Synced ${ago(state.at)}`, '']
        : state.status === 'offline'
          ? [<CloudOff key="i" size={14} />, `Synced ${ago(state.at)}`, 'text-ink-muted']
          : [<TriangleAlert key="i" size={14} />, 'Sync paused', 'text-[#c8372d]']
  return (
    <button
      type="button"
      onClick={() => syncer.now()}
      title={state.status === 'error' ? state.message : 'Sync now'}
      className={`press glass flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] ${tone}`}
    >
      {icon} <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
