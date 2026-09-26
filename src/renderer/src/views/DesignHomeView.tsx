import { useId, useState } from 'react'
import { useStore } from '../lib/store'
import { formatRelative } from '../lib/format'
import { concentricVars, designsByActivity, lastActivity } from '../lib/design'

export function DesignHomeView() {
  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const createDesign = useStore((s) => s.createDesign)
  const navigate = useStore((s) => s.navigate)

  const [prompt, setPrompt] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const promptId = useId()
  const nameId = useId()

  const canSubmit = name.trim().length > 0 || prompt.trim().length > 0
  const recent = designsByActivity(projects, tasksByProject).slice(0, 6)

  const start = async (): Promise<void> => {
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      const trimmedPrompt = prompt.trim()
      const finalName = name.trim() || trimmedPrompt.slice(0, 40)
      const result = await createDesign(finalName, trimmedPrompt || undefined)
      if (result) navigate({ name: 'design', projectId: result.project.id })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex h-full flex-col">
      <div className="scroll-area min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[720px] px-8 py-10">
          <h1 className="font-serif text-[44px] leading-[1.1]">What would you like to design?</h1>

          {recent.length > 0 && (
            <div className="mt-12">
              <h2 className="caption">Recent designs</h2>
              <div className="mt-3 grid grid-cols-2 gap-3">
                {recent.map((project) => (
                  <button
                    type="button"
                    key={project.id}
                    className="rounded-3xl border border-rule bg-card p-5 text-left hover:bg-oat"
                    onClick={() => navigate({ name: 'design', projectId: project.id })}
                  >
                    <div className="truncate font-serif text-[17px]">{project.name}</div>
                    <div className="mt-1 text-[12px] text-ink-faint">{formatRelative(lastActivity(project, tasksByProject))}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-rule">
        <div className="mx-auto w-full max-w-[720px] px-8 pb-6 pt-5">
          <div className="rounded-3xl border border-rule bg-card p-3">
            <label htmlFor={promptId} className="sr-only">
              Describe your design
            </label>
            <textarea
              id={promptId}
              rows={3}
              value={prompt}
              placeholder="A landing page for a mountain coffee roaster, warm and minimal…"
              onChange={(event) => setPrompt(event.target.value)}
              className="w-full resize-none bg-transparent text-[15px] leading-normal text-ink outline-none placeholder:text-ink-faint"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <label htmlFor={nameId} className="sr-only">
                Name
              </label>
              <input
                id={nameId}
                value={name}
                placeholder="Name"
                onChange={(event) => setName(event.target.value)}
                className="r-concentric min-w-0 flex-1 border border-rule bg-transparent px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint"
                style={concentricVars(8)}
              />
              <button
                type="button"
                className="btn btn-clay r-concentric shrink-0"
                style={concentricVars(8)}
                disabled={!canSubmit || busy}
                onClick={() => void start()}
              >
                Start designing
              </button>
            </div>
          </div>
        </div>
      </footer>
    </main>
  )
}
