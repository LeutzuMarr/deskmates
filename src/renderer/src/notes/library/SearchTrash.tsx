import { useEffect, useState } from 'react'
import { RotateCcw, Trash2 } from 'lucide-react'
import { SearchField } from 'glisse'
import { deleteNotebookForGood, emptyOldTrash, listTrash, restoreNotebook, searchNotes, type Notebook, type SearchHit } from '../db'
import { Cover } from './Cover'

export function SearchTab({ onOpen }: { onOpen: (notebook: Notebook, pageId?: string) => void }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)
  useEffect(() => {
    if (!query.trim()) {
      setHits(null)
      return
    }
    const timer = setTimeout(() => void searchNotes(query).then(setHits), 160)
    return () => clearTimeout(timer)
  }, [query])
  return (
    <div className="flex flex-col gap-4 px-6">
      <div className="max-w-xl">
        <SearchField autoFocus value={query} onValueChange={setQuery} placeholder="Search titles and typed text" aria-label="Search notes" />
      </div>
      {hits && hits.length === 0 && <p className="text-[15px] text-ink-muted">Nothing found. Search looks in titles, text boxes and sticky notes, not handwriting.</p>}
      <ul className="flex max-w-2xl flex-col gap-2">
        {hits?.map((hit, i) => (
          <li key={i}>
            <button type="button" onClick={() => onOpen(hit.notebook, hit.pageId)} className="press glass flex w-full items-center gap-3 rounded-2xl p-3 text-left">
              <div className="w-10 shrink-0">
                <Cover cover={hit.notebook.cover} title="" whiteboard={hit.notebook.cover === 'whiteboard'} />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold">
                  {hit.notebook.title}
                  {hit.pageNumber ? <span className="font-normal text-ink-muted"> · page {hit.pageNumber}</span> : null}
                </div>
                {hit.snippet && <div className="line-clamp-2 text-[13px] text-ink-muted">{hit.snippet}</div>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TrashTab() {
  const [trash, setTrash] = useState<Notebook[] | null>(null)
  const reload = (): void => void listTrash().then(setTrash)
  useEffect(() => {
    void emptyOldTrash().then(reload)
  }, [])
  return (
    <div className="flex flex-col gap-4 px-6">
      <div className="flex items-center justify-between">
        <p className="text-[14px] text-ink-muted">Notebooks stay here for 30 days, then they’re deleted.</p>
        {trash && trash.length > 0 && (
          <button
            type="button"
            className="press rounded-full bg-[#c8372d]/10 px-3.5 py-1.5 text-[13px] font-semibold text-[#c8372d]"
            onClick={() => {
              if (!confirm('Delete everything in the trash for good? This can’t be undone.')) return
              void Promise.all(trash.map((n) => deleteNotebookForGood(n.id))).then(reload)
            }}
          >
            Empty trash
          </button>
        )}
      </div>
      {trash?.length === 0 && <p className="text-[15px] text-ink-muted">The trash is empty.</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-6 gap-y-8">
        {trash?.map((n) => (
          <div key={n.id} className="flex flex-col gap-2 opacity-90">
            <Cover cover={n.cover} title={n.title} whiteboard={n.cover === 'whiteboard'} />
            <div className="truncate text-[14px] font-medium">{n.title}</div>
            <div className="flex gap-2">
              <button type="button" className="press flex flex-1 items-center justify-center gap-1 rounded-full bg-black/5 py-1.5 text-[12px] font-semibold dark:bg-white/10" onClick={() => void restoreNotebook(n.id).then(reload)}>
                <RotateCcw size={13} /> Restore
              </button>
              <button
                type="button"
                aria-label={`Delete ${n.title} for good`}
                className="press rounded-full bg-[#c8372d]/10 px-2.5 text-[#c8372d]"
                onClick={() => {
                  if (confirm(`Delete “${n.title}” for good? This can’t be undone.`)) void deleteNotebookForGood(n.id).then(reload)
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
