import { useEffect, useState } from 'react'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import { SegmentedControl } from 'glisse'
import { Sheet } from '../ui/Sheet'
import { addCards, deleteCard, gradeCard, listCards, studyOrder, type Card } from './cards'

/** A notebook's flashcards: study them (tap to turn over), or add and remove them. */
export function Flashcards({ notebookId, onClose, onMakeWithAi }: { notebookId: string; onClose: () => void; onMakeWithAi: (() => void) | null }) {
  const [cards, setCards] = useState<Card[] | null>(null)
  const [view, setView] = useState<'study' | 'cards'>('study')
  const [queue, setQueue] = useState<Card[]>([])
  const [flipped, setFlipped] = useState(false)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [done, setDone] = useState(0)

  const reload = (): void =>
    void listCards(notebookId).then((list) => {
      setCards(list)
      setQueue(studyOrder(list))
      setDone(0)
    })
  useEffect(reload, [notebookId])

  const card = queue[0]
  const answer = async (knew: boolean): Promise<void> => {
    if (!card) return
    await gradeCard(card, knew)
    setFlipped(false)
    setDone((d) => d + 1)
    // A missed card comes back at the end of this round.
    setQueue((q) => (knew ? q.slice(1) : [...q.slice(1), card]))
  }

  return (
    <Sheet title="Flashcards" onClose={onClose} width={560}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <SegmentedControl
          aria-label="Flashcards"
          items={[
            { value: 'study', label: 'Study' },
            { value: 'cards', label: `Cards (${cards?.length ?? 0})` }
          ]}
          value={view}
          onValueChange={(v) => setView(v as 'study' | 'cards')}
        />
        {onMakeWithAi && (
          <button type="button" onClick={onMakeWithAi} className="press flex items-center gap-1.5 rounded-full bg-clay/15 px-3 py-1.5 text-[13px] font-semibold text-clay-deep">
            <Sparkles size={14} /> Make from this page
          </button>
        )}
      </div>

      {view === 'study' &&
        (card ? (
          <div className="flex flex-col items-center gap-4">
            <button
              type="button"
              onClick={() => setFlipped(!flipped)}
              className="press relative h-56 w-full [perspective:1200px]"
              aria-label={flipped ? 'Show the question' : 'Show the answer'}
            >
              <span className="absolute inset-0 transition-transform duration-500 [transform-style:preserve-3d]" style={{ transform: flipped ? 'rotateY(180deg)' : 'none', transitionTimingFunction: 'cubic-bezier(.2,.9,.3,1.15)' }}>
                <span className="absolute inset-0 flex items-center justify-center rounded-3xl bg-card p-6 text-center font-serif text-[22px] leading-snug shadow-[0_2px_8px_rgba(0,0,0,.08),0_16px_40px_rgba(0,0,0,.10)] [backface-visibility:hidden]">{card.front}</span>
                <span className="absolute inset-0 flex items-center justify-center rounded-3xl bg-[#fff8e1] p-6 text-center text-[19px] leading-snug text-[#2b2a28] shadow-[0_2px_8px_rgba(0,0,0,.08),0_16px_40px_rgba(0,0,0,.10)] [backface-visibility:hidden] [transform:rotateY(180deg)]">{card.back}</span>
              </span>
            </button>
            <p className="text-[12px] text-ink-muted">{flipped ? 'Did you know it?' : 'Tap the card to see the answer.'}</p>
            {flipped && (
              <div className="grid w-full grid-cols-2 gap-3">
                <button type="button" className="press rounded-full bg-[#c8372d]/12 py-3 text-[15px] font-semibold text-[#c8372d]" onClick={() => void answer(false)}>
                  Not yet
                </button>
                <button type="button" className="press rounded-full bg-[#23864a]/14 py-3 text-[15px] font-semibold text-[#23864a]" onClick={() => void answer(true)}>
                  I knew it
                </button>
              </div>
            )}
            <p className="text-[12px] text-ink-faint">
              {done} done · {queue.length} left · box {card.box} of 5
            </p>
          </div>
        ) : (
          <p className="py-8 text-center text-[15px] text-ink-muted">{cards?.length ? 'All done for now. Cards come back when it’s time to review them.' : 'No cards yet. Add some, or make them from a page.'}</p>
        ))}

      {view === 'cards' && (
        <div className="flex flex-col gap-3">
          <form
            className="flex flex-col gap-2 rounded-2xl bg-black/[.03] p-3 dark:bg-white/5"
            onSubmit={(e) => {
              e.preventDefault()
              void addCards(notebookId, [{ front, back }]).then(() => {
                setFront('')
                setBack('')
                reload()
              })
            }}
          >
            <input value={front} onChange={(e) => setFront(e.target.value)} placeholder="Question" className="rounded-xl border border-rule bg-card px-3 py-2 text-[15px] outline-none focus:border-clay" />
            <textarea value={back} onChange={(e) => setBack(e.target.value)} placeholder="Answer" rows={2} className="resize-none rounded-xl border border-rule bg-card px-3 py-2 text-[15px] outline-none focus:border-clay" />
            <button type="submit" disabled={!front.trim() || !back.trim()} className="press flex items-center justify-center gap-1.5 self-end rounded-full bg-clay px-4 py-2 text-[14px] font-semibold text-white disabled:opacity-40">
              <Plus size={15} /> Add card
            </button>
          </form>
          {cards?.map((c) => (
            <div key={c.id} className="flex items-start gap-2 rounded-2xl bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,.06)]">
              <div className="min-w-0 flex-1 text-[14px]">
                <div className="font-semibold">{c.front}</div>
                <div className="text-ink-muted">{c.back}</div>
              </div>
              <button type="button" aria-label="Delete card" className="press rounded-full p-1.5 text-ink-muted" onClick={() => void deleteCard(c).then(reload)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  )
}
