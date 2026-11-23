/**
 * Recording audio while writing. Ink written during a recording remembers when, so playing it back
 * shows the writing appear as the sound plays, and tapping a line jumps to that moment.
 */
import { useEffect, useRef, useState } from 'react'
import { Mic, Pause, Play, Square, Trash2 } from 'lucide-react'
import { Slider } from 'glisse'
import { getAsset, getByIndex, newId, putAsset, save } from '../db'
import type { Item } from '../model'
import type { NotesEngine } from '../editor/engine'
import { Popover, anchorOf } from '../ui/Popover'

export interface Recording {
  id: string
  notebookId: string
  assetId: string
  startedAt: number
  duration: number
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
}

class Recorder {
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private stream: MediaStream | null = null
  recordingId: string | null = null
  notebookId: string | null = null
  startedAt = 0
  private listeners = new Set<() => void>()

  on(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  get recording(): boolean {
    return this.recorder !== null
  }

  async start(notebookId: string): Promise<void> {
    if (this.recorder) return
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 64_000 } : undefined)
    this.chunks = []
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data)
    }
    this.recordingId = newId()
    this.notebookId = notebookId
    this.startedAt = Date.now()
    this.recorder.start(1000)
    this.emit()
  }

  async stop(): Promise<Recording | null> {
    const recorder = this.recorder
    if (!recorder) return null
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
    recorder.stop()
    await stopped
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    const blob = new Blob(this.chunks, { type: recorder.mimeType || 'audio/mp4' })
    const now = Date.now()
    const asset = await putAsset(blob, { name: 'Recording' })
    const recording: Recording = { id: this.recordingId!, notebookId: this.notebookId!, assetId: asset.id, startedAt: this.startedAt, duration: now - this.startedAt, createdAt: now, updatedAt: now, deletedAt: null }
    await save({ recordings: [recording] })
    this.recorder = null
    this.stream = null
    this.recordingId = null
    this.notebookId = null
    this.emit()
    return recording
  }

  /** The time stamp for new ink, if this notebook is being recorded. */
  stamp(notebookId: string): Item['audio'] {
    if (!this.recorder || this.notebookId !== notebookId || !this.recordingId) return undefined
    return { recordingId: this.recordingId, at: Date.now() - this.startedAt }
  }
}

export const recorder = new Recorder()

export async function listRecordings(notebookId: string): Promise<Recording[]> {
  return (await getByIndex<Recording>('recordings', 'notebookId', notebookId)).filter((r) => !r.deletedAt).sort((a, b) => a.startedAt - b.startedAt)
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The microphone button and the recordings list, in a notebook's top bar. */
export function AudioControls({ engine }: { engine: NotesEngine }) {
  const [, force] = useState(0)
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [playing, setPlaying] = useState<{ recording: Recording; time: number; paused: boolean } | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => recorder.on(() => force((n) => n + 1)), [])
  useEffect(() => {
    void listRecordings(engine.notebookId).then(setRecordings)
  }, [engine, open])
  useEffect(() => {
    if (!recorder.recording) return
    const timer = setInterval(() => force((n) => n + 1), 500)
    return () => clearInterval(timer)
  }, [recorder.recording])

  // Tapping a line written during the recording jumps there.
  useEffect(() => {
    engine.onTap = (at) => {
      if (!playing || !audio.current) return false
      const hit = engine.itemAt(at.page.id, at.x, at.y)
      if (!hit?.audio || hit.audio.recordingId !== playing.recording.id) return false
      audio.current.currentTime = Math.max(0, hit.audio.at / 1000 - 1)
      void audio.current.play()
      return true
    }
    return () => {
      engine.onTap = null
    }
  }, [engine, playing])

  useEffect(
    () => () => {
      audio.current?.pause()
      engine.audioFilter = null
    },
    [engine]
  )

  const play = async (recording: Recording): Promise<void> => {
    audio.current?.pause()
    const asset = await getAsset(recording.assetId)
    if (!asset) return
    const el = new Audio(URL.createObjectURL(asset.blob))
    audio.current = el
    el.ontimeupdate = () => {
      const time = el.currentTime * 1000
      engine.audioFilter = { recordingId: recording.id, at: time }
      engine.requestRender()
      setPlaying({ recording, time, paused: el.paused })
    }
    el.onpause = () => setPlaying((p) => (p ? { ...p, paused: true } : p))
    el.onplay = () => setPlaying((p) => (p ? { ...p, paused: false } : { recording, time: 0, paused: false }))
    el.onended = () => {
      engine.audioFilter = null
      engine.requestRender()
      setPlaying(null)
    }
    setPlaying({ recording, time: 0, paused: false })
    await el.play()
  }

  const stopPlaying = (): void => {
    audio.current?.pause()
    audio.current = null
    engine.audioFilter = null
    engine.requestRender()
    setPlaying(null)
  }

  const recording = recorder.recording && recorder.notebookId === engine.notebookId

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={recording ? 'Stop recording' : 'Audio recordings'}
        onClick={() => {
          if (recording) void recorder.stop().then(() => listRecordings(engine.notebookId).then(setRecordings))
          else setOpen(anchorOf(button.current))
        }}
        className={`press flex shrink-0 items-center gap-1.5 rounded-full p-2 ${recording ? 'bg-[#e03131] px-3 text-white' : ''}`}
      >
        {recording ? (
          <>
            <Square size={13} className="fill-current" />
            <span className="text-[13px] font-semibold tabular-nums">{clock(Date.now() - recorder.startedAt)}</span>
          </>
        ) : (
          <Mic size={18} className={playing ? 'text-clay' : ''} />
        )}
      </button>
      <Popover open={Boolean(open)} anchor={open} label="Recordings" onClose={() => setOpen(null)} width={330}>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            className="press flex items-center justify-center gap-2 rounded-full bg-[#e03131] py-2.5 text-[14px] font-semibold text-white"
            onClick={() => {
              stopPlaying()
              void recorder.start(engine.notebookId).then(
                () => setOpen(null),
                () => setOpen(null)
              )
            }}
          >
            <Mic size={16} /> Record while I write
          </button>
          {recordings.length === 0 && <p className="text-[13px] text-ink-muted">Recordings of this notebook appear here. Play one to see the writing appear with the sound; tap a line to jump to it.</p>}
          {recordings.map((r) => {
            const active = playing?.recording.id === r.id
            return (
              <div key={r.id} className="rounded-2xl bg-black/5 p-2.5 dark:bg-white/10">
                <div className="flex items-center gap-2">
                  <button type="button" aria-label={active && !playing.paused ? 'Pause' : 'Play'} className="press rounded-full bg-clay p-2 text-white" onClick={() => (active ? (playing.paused ? void audio.current?.play() : audio.current?.pause()) : void play(r))}>
                    {active && !playing.paused ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <div className="min-w-0 flex-1 text-[13px]">
                    <div className="font-semibold">{new Date(r.startedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                    <div className="text-ink-muted tabular-nums">{active ? `${clock(playing.time)} / ` : ''}{clock(r.duration)}</div>
                  </div>
                  <button
                    type="button"
                    aria-label="Delete recording"
                    className="press rounded-full p-1.5 text-ink-muted"
                    onClick={() => {
                      if (!confirm('Delete this recording? The writing stays.')) return
                      if (active) stopPlaying()
                      const now = Date.now()
                      void save({ recordings: [{ ...r, deletedAt: now, updatedAt: now }] }).then(() => listRecordings(engine.notebookId).then(setRecordings))
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {active && (
                  <div className="mt-2">
                    <Slider aria-label="Position" min={0} max={r.duration / 1000} step={0.5} value={playing.time / 1000} onValueChange={(v) => audio.current && (audio.current.currentTime = v)} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </Popover>
    </>
  )
}
