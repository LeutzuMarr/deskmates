import { useEffect, useMemo, useState } from 'react'
import { SegmentedControl } from 'glisse'
import type { PageStyle, Paper, PaperColor } from '../model'
import { PAPERS } from '../editor/PaperPicker'
import { allTemplates, onTemplatesChanged, type StoredTemplate } from '../templates/registry'
import type { TemplateSpec } from '../templates/spec'
import { templatePage, usePageThumb } from '../ink/thumb'

export interface PageChoice {
  style: PageStyle
  template?: string
  /** Picture/PDF templates: one background per page. */
  backgrounds?: string[]
  name: string
}

const NO_ITEMS: never[] = []

function Thumb({ style, spec, width }: { style: PageStyle; spec: TemplateSpec | null; width: number }) {
  const page = useMemo(() => {
    const base = templatePage(spec ?? style)
    const background = spec && 'backgrounds' in spec && (spec as StoredTemplate).backgrounds?.[0]
    return background ? { ...base, background: { assetId: background } } : base
  }, [style, spec])
  const ref = usePageThumb(page, NO_ITEMS, width, spec)
  return <canvas ref={ref} className="rounded-md shadow-[0_0_0_1px_rgba(0,0,0,.08),0_3px_10px_rgba(0,0,0,.10)]" />
}

const GROUP_LABELS: Record<string, string> = { Study: 'Study', Planning: 'Planning', Work: 'Work', Mine: 'Mine' }

/** Paper and templates to start a notebook or page with. */
export function TemplatePicker({ value, onChange, allowWhiteboard }: { value: PageChoice; onChange: (choice: PageChoice) => void; allowWhiteboard?: boolean }) {
  const [, setVersion] = useState(0)
  useEffect(() => onTemplatesChanged(() => setVersion((v) => v + 1)), [])
  const [color, setColor] = useState<PaperColor>(value.style.color)
  const templates = allTemplates()
  const groups = useMemo(() => {
    const map = new Map<string, TemplateSpec[]>()
    for (const t of templates) {
      const group = 'source' in t && (t as StoredTemplate).source === 'mine' ? 'Mine' : t.group
      map.set(group, [...(map.get(group) ?? []), t])
    }
    return map
  }, [templates])
  const [group, setGroup] = useState('Paper')
  const tabs = ['Paper', ...groups.keys()]

  const pickPaper = (paper: Paper): void => onChange({ style: { paper, color, size: 'a4' }, name: PAPERS.find((p) => p.value === paper)!.label })
  const pickTemplate = (t: TemplateSpec): void =>
    onChange({
      style: { paper: t.paper, color: t.color, size: t.size ?? 'a4', landscape: t.landscape },
      template: (t as StoredTemplate).backgrounds ? undefined : t.id,
      backgrounds: (t as StoredTemplate).backgrounds,
      name: t.name
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        <div className="flex w-max gap-1.5">
          {tabs.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setGroup(t)}
              className={`press rounded-full px-3.5 py-1.5 text-[13px] font-semibold ${group === t ? 'bg-ink text-canvas' : 'bg-black/5 dark:bg-white/10'}`}
            >
              {GROUP_LABELS[t] ?? t}
            </button>
          ))}
        </div>
      </div>
      {group === 'Paper' && (
        <SegmentedControl
          aria-label="Paper colour"
          items={[
            { value: 'white', label: 'White' },
            { value: 'cream', label: 'Cream' },
            { value: 'dark', label: 'Dark' }
          ]}
          value={color}
          onValueChange={(v) => {
            setColor(v as PaperColor)
            if (!value.template && !value.backgrounds && value.style.size !== 'infinite') onChange({ ...value, style: { ...value.style, color: v as PaperColor } })
          }}
        />
      )}
      <div className="grid max-h-[46vh] grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-3 overflow-y-auto p-1">
        {group === 'Paper' && (
          <>
            {PAPERS.map((p) => {
              const selected = !value.template && !value.backgrounds && value.style.size !== 'infinite' && value.style.paper === p.value
              return (
                <button key={p.value} type="button" onClick={() => pickPaper(p.value)} className={`press flex flex-col items-center gap-1.5 rounded-2xl p-2 text-[12px] ${selected ? 'bg-clay/15 font-semibold text-clay-deep' : ''}`}>
                  <Thumb style={{ paper: p.value, color, size: 'a4' }} spec={null} width={76} />
                  {p.label}
                </button>
              )
            })}
            {allowWhiteboard && (
              <button
                type="button"
                onClick={() => onChange({ style: { paper: 'dots', color, size: 'infinite' }, name: 'Whiteboard' })}
                className={`press flex flex-col items-center gap-1.5 rounded-2xl p-2 text-[12px] ${value.style.size === 'infinite' ? 'bg-clay/15 font-semibold text-clay-deep' : ''}`}
              >
                <span className="flex h-[76px] w-[76px] items-center justify-center rounded-md border border-dashed border-rule text-[26px] text-ink-muted">∞</span>
                Whiteboard
              </button>
            )}
          </>
        )}
        {group !== 'Paper' &&
          (groups.get(group) ?? []).map((t) => {
            const selected = value.template === t.id || (value.backgrounds && value.backgrounds === (t as StoredTemplate).backgrounds)
            return (
              <button key={t.id} type="button" onClick={() => pickTemplate(t)} className={`press flex flex-col items-center gap-1.5 rounded-2xl p-2 text-center text-[12px] leading-tight ${selected ? 'bg-clay/15 font-semibold text-clay-deep' : ''}`}>
                <Thumb style={{ paper: t.paper, color: t.color, size: 'a4', landscape: t.landscape }} spec={t} width={t.landscape ? 96 : 76} />
                {t.name}
              </button>
            )
          })}
      </div>
    </div>
  )
}
