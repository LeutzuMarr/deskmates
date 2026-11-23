import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Folder as FolderIcon, MoreHorizontal, Plus, Star } from 'lucide-react'
import { Menu } from 'glisse'
import {
  COVERS,
  createFolder,
  deleteFolder,
  duplicateNotebook,
  listFolders,
  listNotebooks,
  putAsset,
  renameFolder,
  trashNotebook,
  updateNotebook,
  type Folder,
  type Notebook
} from '../db'
import { NameSheet, Sheet } from '../ui/Sheet'
import { Cover } from './Cover'
import { NewNotebookSheet } from './NewNotebook'

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

type Dialog =
  | { kind: 'new-notebook'; whiteboard?: boolean }
  | { kind: 'new-folder' }
  | { kind: 'rename-notebook'; notebook: Notebook }
  | { kind: 'rename-folder'; folder: Folder }
  | { kind: 'move'; notebook: Notebook }
  | { kind: 'cover'; notebook: Notebook }

/** Extra "new" entries added by later parts (import a PDF…). */
export const libraryActions: { newMenu?: (context: { folderId: string | null; opened: (n: Notebook) => void; notice: (s: string) => void }) => Array<{ label: string; onSelect: () => void }> } = {}

export function NotesTab({ onOpen, notice }: { onOpen: (notebook: Notebook) => void; notice: (text: string) => void }) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const coverInput = useRef<HTMLInputElement>(null)
  const coverFor = useRef<Notebook | null>(null)

  const reload = useCallback(() => {
    void Promise.all([listFolders(), listNotebooks()])
      .then(([f, n]) => {
        setFolders(f)
        setNotebooks(n)
      })
      .catch(() => {
        setNotebooks([])
        notice('Notes can’t be saved in this browser. Add Deskmates to the Home Screen and open it from there.')
      })
  }, [notice])
  useEffect(reload, [reload])

  const path = useMemo(() => {
    const out: Folder[] = []
    let id = folderId
    while (id) {
      const f = folders.find((x) => x.id === id)
      if (!f) break
      out.unshift(f)
      id = f.parentId
    }
    return out
  }, [folderId, folders])

  const here = favoritesOnly ? [] : folders.filter((f) => f.parentId === folderId)
  const books = (notebooks ?? []).filter((n) => (favoritesOnly ? n.favorite : n.folderId === folderId))
  const close = (): void => setDialog(null)

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-2">
        <nav aria-label="Folders" className="flex min-w-0 items-center gap-1 text-[15px]">
          <button type="button" className={`press rounded-full px-2 py-1 ${folderId || favoritesOnly ? 'text-ink-muted' : 'font-semibold'}`} onClick={() => { setFolderId(null); setFavoritesOnly(false) }}>
            All notes
          </button>
          {path.map((f) => (
            <span key={f.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={15} className="shrink-0 text-ink-faint" />
              <button type="button" className={`press truncate rounded-full px-2 py-1 ${f.id === folderId ? 'font-semibold' : 'text-ink-muted'}`} onClick={() => setFolderId(f.id)}>
                {f.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <button type="button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)} className={`press flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium ${favoritesOnly ? 'bg-clay/15 text-clay-deep' : 'glass'}`}>
            <Star size={15} /> Favourites
          </button>
          <Menu
            aria-label="New"
            align="end"
            icon={<Plus size={20} />}
            items={[
              { label: 'New notebook', onSelect: () => setDialog({ kind: 'new-notebook' }) },
              { label: 'New whiteboard', onSelect: () => setDialog({ kind: 'new-notebook', whiteboard: true }) },
              { label: 'New folder', onSelect: () => setDialog({ kind: 'new-folder' }) },
              ...(libraryActions.newMenu?.({ folderId, opened: onOpen, notice }) ?? [])
            ]}
          />
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-6 gap-y-8 px-6 pt-3">
        <button type="button" onClick={() => setDialog({ kind: 'new-notebook' })} className="press flex flex-col gap-2 text-left">
          <div className="flex aspect-[3/4] w-full items-center justify-center rounded-2xl border-2 border-dashed border-rule text-ink-muted">
            <Plus size={34} strokeWidth={1.6} />
          </div>
          <div className="text-[14px] font-medium">New notebook</div>
        </button>
        {here.map((f) => (
          <div key={f.id} className="flex flex-col gap-2">
            <button type="button" className="press" onClick={() => setFolderId(f.id)} aria-label={`Open folder ${f.name}`}>
              <div className="relative flex aspect-[3/4] w-full items-end">
                <div className="absolute left-0 top-[18%] h-[12%] w-[45%] rounded-t-xl bg-[var(--cover-sky)] opacity-80" />
                <div className="relative flex h-[76%] w-full items-center justify-center rounded-2xl bg-[var(--cover-sky)] text-white shadow-[0_8px_22px_rgba(0,0,0,.12)]">
                  <FolderIcon size={34} strokeWidth={1.6} />
                </div>
              </div>
            </button>
            <div className="flex items-start justify-between gap-1">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium">{f.name}</div>
                <div className="text-[12px] text-ink-muted">{(notebooks ?? []).filter((n) => n.folderId === f.id).length} notebooks</div>
              </div>
              <Menu
                aria-label={`${f.name} options`}
                align="end"
                icon={<MoreHorizontal size={18} />}
                items={[
                  { label: 'Rename', onSelect: () => setDialog({ kind: 'rename-folder', folder: f }) },
                  { label: 'Delete folder (keeps its notebooks)', destructive: true, onSelect: () => void deleteFolder(f.id).then(reload) }
                ]}
              />
            </div>
          </div>
        ))}
        {books.map((n) => (
          <div key={n.id} className="flex flex-col gap-2">
            <button type="button" className="press" onClick={() => onOpen(n)} aria-label={`Open ${n.title}`}>
              <Cover cover={n.cover} title={n.title} whiteboard={n.cover === 'whiteboard'} />
            </button>
            <div className="flex items-start justify-between gap-1">
              <div className="min-w-0">
                <div className="flex items-center gap-1 truncate text-[14px] font-medium">
                  {n.favorite && <Star size={12} className="shrink-0 fill-current text-clay" />}
                  <span className="truncate">{n.title}</span>
                </div>
                <div className="text-[12px] text-ink-muted">{shortDate(n.updatedAt)}</div>
              </div>
              <Menu
                aria-label={`${n.title} options`}
                align="end"
                icon={<MoreHorizontal size={18} />}
                items={[
                  { label: 'Rename', onSelect: () => setDialog({ kind: 'rename-notebook', notebook: n }) },
                  { label: n.favorite ? 'Remove from favourites' : 'Add to favourites', onSelect: () => void updateNotebook(n.id, { favorite: !n.favorite }).then(reload) },
                  ...(n.cover === 'whiteboard' ? [] : [{ label: 'Change cover', onSelect: () => setDialog({ kind: 'cover', notebook: n }) }]),
                  { label: 'Move to folder', onSelect: () => setDialog({ kind: 'move', notebook: n }) },
                  { label: 'Duplicate', onSelect: () => void duplicateNotebook(n.id).then(reload) },
                  'separator',
                  { label: 'Move to trash', destructive: true, onSelect: () => void trashNotebook(n.id).then(reload) }
                ]}
              />
            </div>
          </div>
        ))}
      </div>
      {notebooks && books.length === 0 && here.length === 0 && (
        <p className="mx-6 mt-10 max-w-sm text-[15px] leading-relaxed text-ink-muted">
          {favoritesOnly ? 'Star a notebook to keep it here.' : folderId ? 'This folder is empty.' : 'Your notebooks live on this device and open even without internet.'}
        </p>
      )}

      {dialog?.kind === 'new-notebook' && (
        <NewNotebookSheet
          folderId={folderId}
          whiteboard={dialog.whiteboard}
          onClose={close}
          onCreated={(n) => {
            close()
            onOpen(n)
          }}
        />
      )}
      {dialog?.kind === 'new-folder' && <NameSheet title="New folder" placeholder="e.g. Grade 10" action="Create" onClose={close} onDone={(name) => void createFolder(name, folderId).then(() => { close(); reload() })} />}
      {dialog?.kind === 'rename-folder' && <NameSheet title="Rename folder" initial={dialog.folder.name} action="Rename" onClose={close} onDone={(name) => void renameFolder(dialog.folder.id, name).then(() => { close(); reload() })} />}
      {dialog?.kind === 'rename-notebook' && <NameSheet title="Rename notebook" initial={dialog.notebook.title} action="Rename" onClose={close} onDone={(name) => void updateNotebook(dialog.notebook.id, { title: name }).then(() => { close(); reload() })} />}
      {dialog?.kind === 'move' && (
        <Sheet title={`Move “${dialog.notebook.title}”`} onClose={close} width={420}>
          <div className="flex flex-col gap-1">
            {[{ id: null as string | null, name: 'All notes', depth: 0 }, ...folderTree(folders)].map((f) => (
              <button
                key={f.id ?? 'root'}
                type="button"
                disabled={f.id === dialog.notebook.folderId}
                onClick={() => void updateNotebook(dialog.notebook.id, { folderId: f.id }).then(() => { close(); reload() })}
                className="press flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[15px] hover:bg-black/5 disabled:opacity-40"
                style={{ paddingLeft: 12 + f.depth * 18 }}
              >
                <FolderIcon size={17} className="text-[var(--cover-sky)]" /> {f.name}
              </button>
            ))}
          </div>
        </Sheet>
      )}
      {dialog?.kind === 'cover' && (
        <Sheet title="Cover" onClose={close} width={420}>
          <div className="flex flex-wrap gap-3">
            {COVERS.map((c) => (
              <button key={c} type="button" aria-label={c} className="press w-16" onClick={() => void updateNotebook(dialog.notebook.id, { cover: c }).then(() => { close(); reload() })}>
                <Cover cover={c} title="" />
              </button>
            ))}
          </div>
          <button
            type="button"
            className="press mt-5 w-full rounded-full bg-black/5 py-3 text-[15px] font-semibold dark:bg-white/10"
            onClick={() => {
              coverFor.current = dialog.notebook
              coverInput.current?.click()
            }}
          >
            Use a picture…
          </button>
        </Sheet>
      )}
      <input
        ref={coverInput}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          const notebook = coverFor.current
          e.target.value = ''
          if (!file || !notebook) return
          void putAsset(file, { name: file.name })
            .then((asset) => updateNotebook(notebook.id, { cover: `asset:${asset.id}` }))
            .then(() => {
              close()
              reload()
            })
        }}
      />
    </div>
  )
}

function folderTree(folders: Folder[], parent: string | null = null, depth = 1): Array<{ id: string; name: string; depth: number }> {
  return folders.filter((f) => f.parentId === parent).flatMap((f) => [{ id: f.id, name: f.name, depth }, ...folderTree(folders, f.id, depth + 1)])
}
