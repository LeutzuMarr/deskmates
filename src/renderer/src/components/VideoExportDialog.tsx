import { useEffect, useId, useRef, useState } from 'react'
import type { VideoExportOptions } from '../../../shared/desktop-api'
import { useStore } from '../lib/store'
import { concentricVars } from '../lib/design'

interface VideoExportDialogProps {
  open: boolean
  onClose: () => void
  projectId: string
  /** The design-relative page to record. */
  file: string
  format: VideoExportOptions['format']
}

const FORMAT_LABELS: Record<VideoExportOptions['format'], string> = {
  mp4: 'MP4 video',
  webm: 'WebM video',
  gif: 'GIF animation'
}

/** A whole number from a text field, or undefined when it's left empty ("from the page"). */
const optionalNumber = (text: string): number | undefined => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : NaN
}

/**
 * Records the page shown in the preview to a video. Empty fields use what the page declares (the
 * motion-stage engine sets its size, frame rate and length), or the length of its CSS animations.
 */
export function VideoExportDialog({ open, onClose, projectId, file, format: initialFormat }: VideoExportDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const showToast = useStore((s) => s.showToast)
  const [format, setFormat] = useState<VideoExportOptions['format']>(initialFormat)
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [fps, setFps] = useState('')
  const [duration, setDuration] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ids = { format: useId(), width: useId(), height: useId(), fps: useId(), duration: useId(), title: useId() }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      setFormat(initialFormat)
      setError(null)
      setProgress(null)
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open, initialFormat])

  useEffect(() => window.deskmates.design.onVideoProgress((fraction) => setProgress(fraction)), [])

  const recording = progress !== null

  const record = async (): Promise<void> => {
    const options: VideoExportOptions = {
      format,
      width: optionalNumber(width),
      height: optionalNumber(height),
      fps: optionalNumber(fps),
      duration: optionalNumber(duration)
    }
    if (Object.values(options).some((value) => typeof value === 'number' && Number.isNaN(value))) {
      setError('Sizes, frame rate and length must be numbers, or left empty.')
      return
    }
    setError(null)
    setProgress(0)
    try {
      const path = await window.deskmates.design.exportVideo(projectId, file, options)
      if (path) {
        const name = path.split(/[\\/]/).pop() ?? path
        showToast(`Saved ${name}`, { label: 'Open', onClick: () => void window.deskmates.openPath(path) })
        onClose()
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(caught)
      if (!/stopped/i.test(message)) setError(message)
    } finally {
      setProgress(null)
    }
  }

  const close = (): void => {
    if (recording) void window.deskmates.design.cancelVideo()
    onClose()
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, placeholder: string) => (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        disabled={recording}
        onChange={(event) => set(event.target.value)}
      />
    </div>
  )

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={ids.title}
      className="w-[460px] rounded-3xl border border-rule bg-card p-6 text-ink"
      onClose={close}
      onClick={(event) => {
        if (event.target === dialogRef.current && !recording) close()
      }}
    >
      <h2 id={ids.title} className="font-serif text-[24px] leading-tight">
        Export video
      </h2>
      <p className="mt-2 text-[13px] text-ink-muted">
        Records <span className="text-ink">{file}</span> frame by frame. Leave a field empty to use what the page
        declares, or the length of its animations.
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <div className="field">
          <label className="field-label" htmlFor={ids.format}>
            Format
          </label>
          <select
            id={ids.format}
            className="select"
            value={format}
            disabled={recording}
            onChange={(event) => setFormat(event.target.value as VideoExportOptions['format'])}
          >
            {(Object.keys(FORMAT_LABELS) as Array<VideoExportOptions['format']>).map((key) => (
              <option key={key} value={key}>
                {FORMAT_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {field(ids.width, 'Width (px)', width, setWidth, 'From the page')}
          {field(ids.height, 'Height (px)', height, setHeight, 'From the page')}
          {field(ids.fps, 'Frame rate', fps, setFps, 'From the page, or 30')}
          {field(ids.duration, 'Length (seconds)', duration, setDuration, 'From the page')}
        </div>
        {recording && (
          <div role="status" aria-live="polite">
            <div className="h-1.5 overflow-hidden rounded-full bg-rule">
              <div className="h-full bg-clay transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
            <div className="mt-1.5 text-[12px] text-ink-muted">
              {progress === 0 ? 'Preparing the page…' : `Recording… ${Math.round((progress ?? 0) * 100)}%`}
            </div>
          </div>
        )}
        {error && (
          <div className="error-bar" role="alert">
            {error}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className="btn btn-outline r-concentric" style={concentricVars(24)} onClick={close}>
            {recording ? 'Stop' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-ivory r-concentric"
            style={concentricVars(24)}
            disabled={recording}
            onClick={() => void record()}
          >
            Record
          </button>
        </div>
      </div>
    </dialog>
  )
}
