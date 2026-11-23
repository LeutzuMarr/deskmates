import { useEffect, useRef, useState } from 'react'
import { ArrowUp, BookOpen, Check, GraduationCap, Layers, Sparkles, X } from 'lucide-react'
import type { RemoteDevice } from '../../remote/relay'
import { getMeta, setMeta } from '../db'
import type { NotesEngine } from '../editor/engine'
import type { TextData, StickyData } from '../model'
import { addCards } from './cards'
import { askAndWait, jsonList, pcClient } from './client'
import { useLiquid } from '../ui/liquid'

interface QuizQuestion {
  q: string
  options: string[]
  answer: number
}

interface Message {
  id: number
  from: 'me' | 'ai' | 'error' | 'note'
  text: string
  quiz?: QuizQuestion[]
}

type Kind = 'chat' | 'explain' | 'quiz' | 'cards'

/** The page as it looks on screen, small enough to send quickly. */
function pagePicture(engine: NotesEngine): string | null {
  const source = engine.baseCanvasElement
  const scale = Math.min(1, 1200 / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

/** The typed text on the page shown (text boxes and sticky notes), to go with the picture. */
function pageText(engine: NotesEngine): string {
  const page = engine.pages[engine.currentPageIndex()]
  if (!page) return ''
  return engine
    .itemsOn(page.id)
    .filter((i) => i.kind === 'text' || i.kind === 'sticky')
    .map((i) => (i.data as TextData | StickyData).text)
    .join('\n')
    .slice(0, 4000)
}

const ASK: Record<Exclude<Kind, 'chat'>, string> = {
  explain: 'Explică-mi pe înțeles ce este pe pagina asta din notițele mele (în imaginea atașată), ca unui elev. Dacă e o problemă, arată-mi pașii.',
  quiz: 'Fă-mi un test scurt de 5 întrebări cu variante de răspuns din pagina asta de notițe (în imaginea atașată). Răspunde doar cu JSON, fără alt text: [{"q":"întrebarea","options":["varianta 1","varianta 2","varianta 3","varianta 4"],"answer":0}] (answer = indexul variantei corecte).',
  cards: 'Fă 8 flashcarduri din pagina asta de notițe (în imaginea atașată). Răspunde doar cu JSON, fără alt text: [{"q":"întrebarea","a":"răspunsul"}].'
}

function Quiz({ questions }: { questions: QuizQuestion[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({})
  const score = Object.entries(picked).filter(([i, p]) => questions[Number(i)]?.answer === p).length
  const finished = Object.keys(picked).length === questions.length
  return (
    <div className="flex flex-col gap-3">
      {questions.map((q, i) => (
        <div key={i} className="rounded-2xl bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,.06)]">
          <div className="mb-2 text-[14px] font-semibold">
            {i + 1}. {q.q}
          </div>
          <div className="flex flex-col gap-1.5">
            {q.options.map((option, j) => {
              const chosen = picked[i] === j
              const show = picked[i] !== undefined
              const right = j === q.answer
              return (
                <button
                  key={j}
                  type="button"
                  disabled={show}
                  onClick={() => setPicked({ ...picked, [i]: j })}
                  className={`press rounded-xl px-3 py-2 text-left text-[13px] ${show && right ? 'bg-[#23864a]/15 font-semibold text-[#23864a]' : show && chosen ? 'bg-[#c8372d]/12 text-[#c8372d]' : 'bg-black/5 dark:bg-white/10'}`}
                >
                  {option}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {finished && (
        <div className="rounded-2xl bg-clay/15 p-3 text-center text-[14px] font-semibold text-clay-deep">
          {score} / {questions.length} correct
        </div>
      )}
    </div>
  )
}

/** The Deskmates bar in a notebook: ask about the page; answers come from Freebuff on the PC. */
export function AiPanel({
  engine,
  device,
  online,
  notebookTitle,
  autoAsk,
  onAutoAsked,
  onClose,
  onCardsAdded
}: {
  engine: NotesEngine
  device: RemoteDevice | null
  online: boolean
  notebookTitle: string
  /** Asks this as soon as the panel opens (from "Make from this page" in Flashcards). */
  autoAsk?: 'cards' | null
  onAutoAsked?: () => void
  onClose: () => void
  onCardsAdded: (count: number) => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [sendPage, setSendPage] = useState(true)
  const taskKey = `aiTask:${engine.notebookId}`
  // The Freebuff model that answers ("current" = whatever Freebuff has selected), remembered.
  const [model, setModel] = useState('current')
  const [models, setModels] = useState<Array<{ name: string; cost: string | null; note?: string }>>([])
  useEffect(() => {
    void getMeta<string>('aiModel').then((m) => m && setModel(m))
    if (!device || !online) return
    void pcClient(device)
      .call('freebuff.models', {})
      .then((list) => setModels(list.models))
      .catch(() => undefined)
  }, [device, online])
  const taskId = useRef<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | null>(null)
  const counter = useRef(0)
  useLiquid(panel, { reach: 10, press: 0.006, axis: 'x' })

  useEffect(() => {
    void getMeta<string>(taskKey).then((id) => (taskId.current = id))
    return () => abort.current?.abort()
  }, [taskKey])
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  const add = (m: Omit<Message, 'id'>): void => setMessages((all) => [...all, { ...m, id: ++counter.current }])

  const ask = async (kind: Kind, typed?: string): Promise<void> => {
    if (!device || !online || busy) return
    const question = kind === 'chat' ? (typed ?? '').trim() : ASK[kind]
    if (!question) return
    const shown = kind === 'chat' ? question : kind === 'explain' ? 'Explain this page' : kind === 'quiz' ? 'Quiz me on this page' : 'Make flashcards from this page'
    add({ from: 'me', text: shown })
    setText('')
    const withPage = sendPage || kind !== 'chat'
    const picture = withPage ? pagePicture(engine) : null
    const typedText = withPage ? pageText(engine) : ''
    const message = typedText ? `${question}\n\nText scris pe pagină:\n${typedText}` : question
    const controller = new AbortController()
    abort.current = controller
    setBusy('Sending…')
    try {
      const page = engine.currentPageIndex() + 1
      const { taskId: id, text: reply } = await askAndWait(
        pcClient(device),
        { text: message, images: picture ? [{ dataUrl: picture, name: `pagina-${page}.jpg` }] : [], taskId: taskId.current ?? undefined, title: `${notebookTitle}, p. ${page}`, freebuffModel: model },
        setBusy,
        controller.signal
      )
      taskId.current = id
      void setMeta(taskKey, id)
      if (kind === 'quiz') {
        const quiz = jsonList<QuizQuestion>(reply)?.filter((q) => q && typeof q.q === 'string' && Array.isArray(q.options) && typeof q.answer === 'number')
        if (quiz?.length) add({ from: 'ai', text: '', quiz })
        else add({ from: 'ai', text: reply })
      } else if (kind === 'cards') {
        const pairs = jsonList<{ q: string; a: string }>(reply)?.filter((c) => c && typeof c.q === 'string' && typeof c.a === 'string')
        if (pairs?.length) {
          const made = await addCards(engine.notebookId, pairs.map((c) => ({ front: c.q, back: c.a })))
          add({ from: 'note', text: `Added ${made.length} flashcards to this notebook. Open them from the menu: Flashcards.` })
          onCardsAdded(made.length)
        } else add({ from: 'ai', text: reply })
      } else add({ from: 'ai', text: reply })
    } catch (error) {
      add({ from: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
      abort.current = null
    }
  }

  useEffect(() => {
    if (!autoAsk) return
    onAutoAsked?.()
    void ask(autoAsk)
    // Once, when asked to.
  }, [autoAsk])

  const unavailable = !online ? 'Deskmates needs the internet. Your notes keep working without it.' : !device ? 'Pair with your PC first (Notes → Pair with PC).' : null

  return (
    <div ref={panel} className="glass fixed bottom-3 right-3 top-[calc(env(safe-area-inset-top)+64px)] z-30 flex w-[min(400px,calc(100vw-24px))] flex-col rounded-[28px] shadow-2xl" style={{ animation: 'sheet-up .35s cubic-bezier(.2,.9,.3,1.15)' }}>
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <div className="flex items-center gap-2 font-serif text-[20px]">
          <Sparkles size={18} className="text-clay" /> Deskmates
          {device && online && (
            <select
              aria-label="AI model"
              value={model}
              disabled={Boolean(busy)}
              onChange={(e) => {
                setModel(e.target.value)
                void setMeta('aiModel', e.target.value)
              }}
              className="ml-1 max-w-[11rem] truncate rounded-full border border-rule bg-card px-2.5 py-1 font-sans text-[12px] outline-none focus:border-clay"
            >
              <option value="current">Freebuff’s current model</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.cost ? ` · ${m.cost}` : ' · free'}
                </option>
              ))}
              {model !== 'current' && !models.some((m) => m.name === model) && <option value={model}>{model}</option>}
            </select>
          )}
        </div>
        <button type="button" aria-label="Close" className="press rounded-full bg-black/5 p-1.5 dark:bg-white/10" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div ref={list} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-3">
        {messages.length === 0 && (
          <p className="text-[13px] leading-relaxed text-ink-muted">Ask about this page. Answers come from Freebuff on your PC, so it needs to be on with Deskmates open. The chat is also in Deskmates on the PC, under Work → Notes.</p>
        )}
        {messages.map((m) =>
          m.quiz ? (
            <Quiz key={m.id} questions={m.quiz} />
          ) : (
            <div
              key={m.id}
              className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed ${m.from === 'me' ? 'self-end bg-clay text-white' : m.from === 'error' ? 'bg-[#c8372d]/12 text-[#c8372d]' : m.from === 'note' ? 'bg-[#23864a]/12 text-[#23864a]' : 'bg-card shadow-[0_1px_3px_rgba(0,0,0,.06)]'}`}
            >
              {m.from === 'note' && <Check size={14} className="mr-1 inline" />}
              {m.text}
            </div>
          )
        )}
        {busy && (
          <div className="flex items-center gap-2 text-[13px] text-ink-muted">
            <span className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 animate-bounce rounded-full bg-clay" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
            {busy}
            <button type="button" className="press ml-auto text-[12px] font-semibold" onClick={() => abort.current?.abort()}>
              Stop waiting
            </button>
          </div>
        )}
      </div>
      {unavailable ? (
        <p className="m-3 rounded-2xl bg-black/5 p-3 text-[13px] text-ink-muted dark:bg-white/10">{unavailable}</p>
      ) : (
        <div className="flex flex-col gap-2 border-t border-[var(--glass-edge)] p-3">
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['explain', 'Explain this page', <BookOpen key="i" size={13} />],
                ['quiz', 'Quiz me', <GraduationCap key="i" size={13} />],
                ['cards', 'Flashcards', <Layers key="i" size={13} />]
              ] as const
            ).map(([kind, label, icon]) => (
              <button key={kind} type="button" disabled={Boolean(busy)} onClick={() => void ask(kind)} className="press flex items-center gap-1 rounded-full bg-black/5 px-3 py-1.5 text-[12px] font-semibold disabled:opacity-40 dark:bg-white/10">
                {icon} {label}
              </button>
            ))}
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void ask('chat', text)
            }}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void ask('chat', text)
                }
              }}
              rows={1}
              placeholder="Ask Deskmates"
              className="max-h-32 min-h-[40px] flex-1 resize-none rounded-2xl border border-rule bg-card px-3 py-2 text-[15px] outline-none focus:border-clay"
            />
            <button type="submit" aria-label="Send" disabled={!text.trim() || Boolean(busy)} className="press rounded-full bg-clay p-2.5 text-white disabled:opacity-40">
              <ArrowUp size={18} />
            </button>
          </form>
          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            <input type="checkbox" checked={sendPage} onChange={(e) => setSendPage(e.target.checked)} /> Send a picture of the page with my question
          </label>
        </div>
      )}
    </div>
  )
}
