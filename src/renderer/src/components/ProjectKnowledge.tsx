import { useEffect, useRef, useState } from 'react'
import { FileText, Upload } from 'lucide-react'
import { core } from '../lib/rpc'
import { useStore } from '../lib/store'
import type { KnowledgeFile } from '../../../shared/protocol'

/** Up to this many characters, the files go to the agent whole; past it, they are searched. */
const INLINE_CHARS = 60_000

const size = (bytes: number): string => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`)

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Project knowledge, as in Claude's projects: files the user adds (documents, notes, data, code)
 * that every chat in the project can use. Word, Excel, PowerPoint, PDF and text files are read as text.
 */
export function ProjectKnowledge({ projectId }: { projectId: string }) {
  const showToast = useStore((s) => s.showToast)
  const [files, setFiles] = useState<KnowledgeFile[] | null>(null)
  const [adding, setAdding] = useState(0)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    core
      .call('knowledge.list', { projectId })
      .then((list) => live && setFiles(list))
      .catch(() => live && setFiles([]))
    const off = core.onEvent((event) => {
      if (event.type === 'knowledge.updated' && event.projectId === projectId) setFiles(event.files)
    })
    return () => {
      live = false
      off()
    }
  }, [projectId])

  const add = async (list: File[]): Promise<void> => {
    for (const file of list) {
      setAdding((n) => n + 1)
      try {
        setFiles(await core.call('knowledge.add', { projectId, name: file.name, dataBase64: await fileBase64(file) }))
      } catch (error) {
        showToast(`Couldn't add ${file.name}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setAdding((n) => n - 1)
      }
    }
  }

  const remove = async (file: KnowledgeFile): Promise<void> => {
    try {
      setFiles(await core.call('knowledge.delete', { projectId, id: file.id }))
    } catch (error) {
      showToast(`Couldn't remove ${file.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const total = (files ?? []).reduce((n, f) => n + f.chars, 0)
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className="caption">Project knowledge</h2>
        <button type="button" className="btn btn-outline" onClick={() => input.current?.click()} disabled={adding > 0}>
          {adding > 0 ? 'Adding…' : 'Add files'}
        </button>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          accept=".pdf,.docx,.xlsx,.xlsm,.pptx,.txt,.md,.csv,.json,.html,.xml,.yaml,.yml,.js,.ts,.tsx,.py,.java,.c,.cpp,.cs,.go,.rs,.rb,.php,.sql,.css,.log,text/*"
          onChange={(event) => {
            void add(Array.from(event.target.files ?? []))
            event.target.value = ''
          }}
        />
      </div>
      <div
        className={`knowledge-drop mt-3 ${dragging ? 'is-dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          void add(Array.from(event.dataTransfer.files))
        }}
      >
        {files && files.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {files.map((file) => (
              <li key={file.id} className="flex items-center gap-3 rounded-2xl border border-rule bg-card px-4 py-2.5">
                <FileText size={16} aria-hidden="true" className="shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{file.name}</span>
                  <span className="block text-[12px] text-ink-faint">
                    {size(file.size)} · {file.chars < 1000 ? `${file.chars} characters` : `${Math.round(file.chars / 1000)}K characters`} of text
                  </span>
                </span>
                <button type="button" className="btn btn-text shrink-0 px-0 text-[13px]" aria-label={`Remove ${file.name}`} onClick={() => void remove(file)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-ink-faint">
            <Upload size={14} aria-hidden="true" />
            Drop documents, notes or data here. Every chat in this project can use them.
          </p>
        )}
        {files && files.length > 0 && (
          <p className="mt-2 text-[12px] text-ink-faint">
            {total <= INLINE_CHARS ? 'The agents read these whole in every chat.' : 'Too long to read whole every time: the agents search them (project_knowledge_search) when a question needs them.'}
          </p>
        )}
      </div>
    </section>
  )
}
