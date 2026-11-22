import { useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'

type Phase = 'idle' | 'listening' | 'writing'

/** The recording as base64, without the data: prefix. */
async function blobBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Dictation, as Claude's microphone button: click to talk, click again to stop, and the words land
 * in the message box. With a Gemini or OpenAI key the recording is written down by that model (any
 * language); otherwise Windows' own speech recognition listens and types each phrase as it hears it.
 */
export function DictationButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const showToast = useStore((s) => s.showToast)
  const [phase, setPhase] = useState<Phase>('idle')
  const mode = useRef<'record' | 'system' | 'none' | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  // Windows speech recognition sends each phrase as an event while it listens.
  useEffect(
    () =>
      core.onEvent((event) => {
        if (event.type === 'dictation.text' && mode.current === 'system') onTextRef.current(event.text)
        if (event.type === 'dictation.state' && mode.current === 'system') {
          if (event.error) showToast(`Dictation stopped: ${event.error}`)
          if (!event.listening) setPhase('idle')
        }
      }),
    [showToast]
  )

  // Stop listening when the message box goes away.
  useEffect(
    () => () => {
      recorder.current?.state === 'recording' && recorder.current.stop()
      if (mode.current === 'system') void core.call('dictation.stop', {}).catch(() => undefined)
    },
    []
  )

  const start = async (): Promise<void> => {
    try {
      mode.current = await core.call('dictation.mode', {})
    } catch {
      mode.current = 'none'
    }
    if (mode.current === 'none') {
      showToast('Dictation needs a Google Gemini or OpenAI key in Settings (or Windows speech recognition).')
      return
    }
    if (mode.current === 'system') {
      await core.call('dictation.start', {})
      setPhase('listening')
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      showToast("Deskmates can't use the microphone. Check that one is connected and allowed in Windows privacy settings.")
      return
    }
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks: Blob[] = []
    rec.ondataavailable = (event) => event.data.size && chunks.push(event.data)
    rec.onstop = () => {
      stream.getTracks().forEach((track) => track.stop())
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
      if (blob.size < 800) {
        setPhase('idle')
        return
      }
      setPhase('writing')
      void blobBase64(blob)
        .then((audioBase64) => core.call('dictation.transcribe', { audioBase64, mediaType: blob.type }))
        .then((words) => {
          if (words.trim()) onTextRef.current(words.trim())
          else showToast("Didn't catch any words. Try again a little closer to the microphone.")
        })
        .catch((error: unknown) => showToast(`Couldn't write the recording down: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => setPhase('idle'))
    }
    recorder.current = rec
    rec.start()
    setPhase('listening')
  }

  const stop = (): void => {
    if (mode.current === 'system') {
      void core.call('dictation.stop', {}).catch(() => undefined)
      setPhase('idle')
    } else if (recorder.current?.state === 'recording') recorder.current.stop()
  }

  const label = phase === 'listening' ? 'Stop dictation' : phase === 'writing' ? 'Writing down what you said' : 'Dictate'
  return (
    <button
      type="button"
      className={`copy-btn h-8 w-8 justify-center p-0 ${phase === 'listening' ? 'dictating' : ''}`}
      aria-label={label}
      aria-pressed={phase === 'listening'}
      title={phase === 'idle' ? 'Dictate (speak instead of typing)' : label}
      disabled={disabled || phase === 'writing'}
      onClick={() => (phase === 'listening' ? stop() : void start())}
    >
      {phase === 'listening' ? <Square size={13} aria-hidden="true" /> : phase === 'writing' ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
    </button>
  )
}
