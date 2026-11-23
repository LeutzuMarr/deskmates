import { useState } from 'react'
import { COVERS, backgroundPages, createNotebook, type Notebook } from '../db'
import { DEFAULT_PAGE_STYLE } from '../model'
import { Sheet } from '../ui/Sheet'
import { Cover } from './Cover'
import { TemplatePicker, type PageChoice } from './TemplatePicker'

export function NewNotebookSheet({ folderId, whiteboard, onClose, onCreated }: { folderId: string | null; whiteboard?: boolean; onClose: () => void; onCreated: (notebook: Notebook) => void }) {
  const [title, setTitle] = useState('')
  const [cover, setCover] = useState<string>(COVERS[0])
  const [choice, setChoice] = useState<PageChoice>(whiteboard ? { style: { paper: 'dots', color: 'white', size: 'infinite' }, name: 'Whiteboard' } : { style: DEFAULT_PAGE_STYLE, name: 'Ruled' })
  const [busy, setBusy] = useState(false)
  const isWhiteboard = choice.style.size === 'infinite'

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const firstPages = choice.backgrounds ? await backgroundPages(choice.backgrounds) : undefined
      const notebook = await createNotebook({
        title: title || (isWhiteboard ? 'Whiteboard' : 'Untitled notebook'),
        cover: isWhiteboard ? 'whiteboard' : cover,
        folderId,
        pageStyle: choice.style,
        pageTemplate: choice.template,
        firstPages
      })
      onCreated(notebook)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={isWhiteboard ? 'New whiteboard' : 'New notebook'} onClose={onClose} width={620}>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <div className="flex gap-4">
          <div className="w-24 shrink-0">
            <Cover cover={cover} title={title || (isWhiteboard ? 'Whiteboard' : 'Untitled notebook')} whiteboard={isWhiteboard} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={isWhiteboard ? 'Name, e.g. Mind map' : 'Name, e.g. Math'}
              maxLength={80}
              className="w-full rounded-xl border border-rule bg-card px-3 py-2.5 text-[16px] outline-none focus:border-clay"
            />
            {!isWhiteboard && (
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Cover colour">
                {COVERS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={cover === c} aria-label={c} onClick={() => setCover(c)} className="swatch" aria-pressed={cover === c} style={{ background: `var(--cover-${c})` }} />
                ))}
              </div>
            )}
            <p className="text-[13px] text-ink-muted">
              Pages: <span className="font-semibold text-ink">{choice.name}</span>
            </p>
          </div>
        </div>
        <TemplatePicker value={choice} onChange={setChoice} allowWhiteboard />
        <button type="submit" disabled={busy} className="press w-full rounded-full bg-clay py-3 text-[15px] font-semibold text-white disabled:opacity-50">
          Create
        </button>
      </form>
    </Sheet>
  )
}
