/** The Deskmates bar and flashcards in notebooks. */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles } from 'lucide-react'
import { notebookExtras, type NotebookContext } from './editor/NotebookView'
import type { NotesEngine } from './editor/engine'
import { AiPanel } from './ai/AiPanel'
import { Flashcards } from './ai/Flashcards'

type Open = { panel: boolean; cards: boolean; autoAsk: 'cards' | null }

/** One place per notebook view for what's open, shared by the button and the menu. */
const views = new WeakMap<NotesEngine, { state: Open; listeners: Set<(s: Open) => void> }>()

function viewOf(engine: NotesEngine) {
  let v = views.get(engine)
  if (!v) {
    v = { state: { panel: false, cards: false, autoAsk: null }, listeners: new Set() }
    views.set(engine, v)
  }
  return v
}

function setView(engine: NotesEngine, next: Partial<Open>): void {
  const v = viewOf(engine)
  v.state = { ...v.state, ...next }
  for (const l of v.listeners) l(v.state)
}

function useView(engine: NotesEngine): Open {
  const [state, setState] = useState(viewOf(engine).state)
  useEffect(() => {
    const v = viewOf(engine)
    v.listeners.add(setState)
    return () => {
      v.listeners.delete(setState)
    }
  }, [engine])
  return state
}

function DeskmatesButton({ engine, context }: { engine: NotesEngine; context: NotebookContext }) {
  const view = useView(engine)
  return (
    <>
      <button
        type="button"
        aria-label="Ask Deskmates"
        aria-pressed={view.panel}
        onClick={() => setView(engine, { panel: !view.panel })}
        className={`press flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[13px] font-semibold ${view.panel ? 'bg-clay text-white' : context.online && context.device ? 'text-clay-deep' : 'text-ink-faint'}`}
      >
        <Sparkles size={17} />
        <span className="hidden lg:inline">Deskmates</span>
      </button>
      {view.panel &&
        createPortal(
          <AiPanel
            engine={engine}
            device={context.device}
            online={context.online}
            notebookTitle={context.notebook.title}
            autoAsk={view.autoAsk}
            onAutoAsked={() => setView(engine, { autoAsk: null })}
            onClose={() => setView(engine, { panel: false })}
            onCardsAdded={(n) => context.notice(`${n} flashcards added. Study them from the menu: Flashcards.`)}
          />,
          document.body
        )}
      {view.cards &&
        createPortal(
          <Flashcards
            notebookId={engine.notebookId}
            onClose={() => setView(engine, { cards: false })}
            onMakeWithAi={context.online && context.device ? () => setView(engine, { cards: false, panel: true, autoAsk: 'cards' }) : null}
          />,
          document.body
        )}
    </>
  )
}

notebookExtras.topRight = [...(notebookExtras.topRight ?? []), (engine, context) => <DeskmatesButton engine={engine} context={context} />]

notebookExtras.menu = [...(notebookExtras.menu ?? []), (engine) => [{ label: 'Flashcards', onSelect: () => setView(engine, { cards: true }) }]]
