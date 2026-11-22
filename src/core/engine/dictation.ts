/**
 * Voice dictation for the message box. Two ways, best first:
 * - "record": the app records the microphone and a model with a key here writes it down (Gemini
 *   hears audio directly; OpenAI has a transcription model). Any language, punctuation included.
 * - "system": Windows' own speech recognition (System.Speech, offline, the languages installed in
 *   Windows), run in a hidden PowerShell that prints each phrase as it is recognised.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createGoogle } from '@ai-sdk/google'
import { generateText } from 'ai'
import type { KeyStore } from '../models/keys'

export type DictationMode = 'record' | 'system' | 'none'

const MAX_AUDIO_BYTES = 20 * 1024 * 1024

export function dictationMode(keys: Pick<KeyStore, 'get'>, platform = process.platform): DictationMode {
  if (keys.get('google') || keys.get('openai')) return 'record'
  return platform === 'win32' ? 'system' : 'none'
}

const TRANSCRIBE_PROMPT =
  "Write down exactly what is said in this recording, in the language it is spoken in, with normal punctuation and capital letters. Reply with the words only: no quotes, no notes, no translation. If nothing is said, reply with nothing."

/** The words in a recording, from Gemini or OpenAI (whichever has a key; Gemini first). */
export async function transcribeAudio(keys: Pick<KeyStore, 'get'>, audioBase64: string, mediaType: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const bytes = Buffer.from(audioBase64, 'base64')
  if (bytes.length === 0) return ''
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error('That recording is too long to write down; keep dictation under a few minutes.')
  const type = mediaType.split(';')[0] || 'audio/webm'
  const google = keys.get('google')
  if (google) {
    const { text } = await generateText({
      model: createGoogle({ apiKey: google, fetch: fetchImpl })('gemini-2.5-flash'),
      messages: [{ role: 'user', content: [{ type: 'text', text: TRANSCRIBE_PROMPT }, { type: 'file', data: bytes, mediaType: type }] }],
      maxOutputTokens: 4000,
      abortSignal: AbortSignal.timeout(90_000)
    })
    return text.trim()
  }
  const openai = keys.get('openai')
  if (openai) {
    const form = new FormData()
    form.append('model', 'gpt-4o-mini-transcribe')
    form.append('file', new Blob([bytes], { type }), `dictation.${type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm'}`)
    const response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openai}` },
      body: form,
      signal: AbortSignal.timeout(90_000)
    })
    if (!response.ok) throw new Error(`OpenAI couldn't write the recording down (HTTP ${response.status}).`)
    const body = (await response.json()) as { text?: string }
    return (body.text ?? '').trim()
  }
  throw new Error('Dictation needs a Google Gemini or OpenAI key in Settings, or Windows speech recognition.')
}

/** The PowerShell that listens: one recognised phrase per line on stdout, "!" lines for errors. */
const LISTENER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Speech
  $culture = [System.Globalization.CultureInfo]::CurrentUICulture
  $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1
  if (-not $info) { $info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | Select-Object -First 1 }
  if (-not $info) { [Console]::Out.WriteLine('!No speech recognition language is installed in Windows (Settings > Time & language > Speech).'); exit 1 }
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $engine.SetInputToDefaultAudioDevice()
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  [Console]::Out.WriteLine('~' + $info.Culture.Name)
  [Console]::Out.Flush()
  while ($true) {
    $result = $engine.Recognize([TimeSpan]::FromSeconds(30))
    if ($result -and $result.Text) { [Console]::Out.WriteLine($result.Text); [Console]::Out.Flush() }
  }
} catch {
  [Console]::Out.WriteLine('!' + $_.Exception.Message)
  exit 1
}
`

/** Windows speech recognition, listening until stopped. */
export class SystemDictation {
  private child: ChildProcess | null = null

  get listening(): boolean {
    return this.child !== null
  }

  start(handlers: { onText(text: string): void; onError(message: string): void; onReady?(language: string): void; onEnd?(): void }): void {
    this.stop()
    const encoded = Buffer.from(LISTENER, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '').trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        if (line.startsWith('!')) handlers.onError(line.slice(1))
        else if (line.startsWith('~')) handlers.onReady?.(line.slice(1))
        else handlers.onText(line)
      }
    })
    child.on('error', (error) => handlers.onError(`Windows speech recognition didn't start: ${error.message}`))
    child.on('exit', () => {
      if (this.child === child) this.child = null
      handlers.onEnd?.()
    })
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (child && child.exitCode === null) child.kill()
  }
}
