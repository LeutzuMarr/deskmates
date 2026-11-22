import { useEffect, useState } from 'react'
import { Square, Volume2 } from 'lucide-react'
import { speakableText } from '../lib/speakable'

/** Reads a reply out loud with the computer's own voice, as Claude's "Read aloud" does. */
export function ReadAloudButton({ text }: { text: () => string }) {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => () => {
    if (speaking) window.speechSynthesis?.cancel()
  }, [speaking])
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  const toggle = (): void => {
    const synth = window.speechSynthesis
    if (speaking) {
      synth.cancel()
      setSpeaking(false)
      return
    }
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(speakableText(text()))
    utterance.lang = document.documentElement.lang || navigator.language
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    synth.speak(utterance)
    setSpeaking(true)
  }
  return (
    <button type="button" className="copy-btn" aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'} title={speaking ? 'Stop' : 'Read aloud'} onClick={toggle}>
      {speaking ? <Square size={12} aria-hidden="true" /> : <Volume2 size={13} aria-hidden="true" />}
      {speaking ? 'Stop' : 'Read aloud'}
    </button>
  )
}
