import { useEffect, useState } from 'react'
import { useStore } from '../lib/store'
import { FREEBUFF_CURRENT_MODEL, FREEBUFF_GROUP_LABELS, FREEBUFF_MODELS, type FreebuffStatus } from '../../../shared/freebuff'

/** Often enough that the minutes-left count moves while you watch; the read is a cheap screen parse. */
const POLL_MS = 10_000

/** Freebuff's own session facts for a project answered by Freebuff: model, minutes left in the
 *  session, hours left today, context use. Freebuff doesn't expose the Freebucks balance, so the
 *  model's cost is shown instead. */
export function FreebuffStatusLine({ folder, modelId }: { folder: string; modelId: string | undefined }) {
  const loadFreebuffStatus = useStore((s) => s.loadFreebuffStatus)
  const [status, setStatus] = useState<FreebuffStatus | null>(null)

  useEffect(() => {
    let live = true
    const read = (): void => {
      void loadFreebuffStatus(folder).then((next) => {
        if (live) setStatus(next)
      })
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [folder, loadFreebuffStatus])

  const name = status?.model ?? (modelId && modelId !== FREEBUFF_CURRENT_MODEL ? modelId : null)
  const model = FREEBUFF_MODELS.find((m) => m.name === name)
  const parts: string[] = []
  if (name) parts.push(name)
  if (model) parts.push(model.cost && model.cost !== 'Paid plan' ? `${model.cost} Freebucks` : FREEBUFF_GROUP_LABELS[model.group].split(' · ')[0])
  if (status?.sessionMinutesLeft != null) parts.push(`${status.sessionMinutesLeft} min left in session`)
  if (status?.hoursLeftToday != null) parts.push(`${status.hoursLeftToday}${status.hoursPerDay != null ? `/${status.hoursPerDay}` : ''} h left today`)
  if (status?.context) parts.push(`context ${status.context}`)

  return (
    <div className="flex shrink-0 items-center gap-2 text-[12px] text-ink-muted" title="What Freebuff shows about its session">
      <span className="font-medium text-ink">Freebuff</span>
      <span className="truncate">{status ? parts.join(' · ') : `${parts.length ? `${parts.join(' · ')} · ` : ''}starts with your first prompt`}</span>
    </div>
  )
}
