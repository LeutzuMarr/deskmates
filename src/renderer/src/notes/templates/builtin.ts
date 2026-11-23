/**
 * The templates that come with the app, in Romanian (they're printed on school pages), plus the
 * small builders the store's subject packs are made with too. A4: 210 × 297 mm.
 */
import type { TemplateElement, TemplateSpec } from './spec'

type E = TemplateElement

/** A title band across the top, with a place for the date. */
export function header(title: string, opts: { date?: boolean } = {}): E[] {
  return [
    { t: 'rect', x: 12, y: 10, w: 186, h: 16, r: 3, fill: 'tint' },
    { t: 'text', x: 18, y: 21, text: title, size: 6.2, weight: 700, c: 'accent', serif: true },
    ...(opts.date === false
      ? []
      : ([
          { t: 'text', x: 150, y: 21, text: 'Data:', size: 3.6, weight: 600, c: 'muted' },
          { t: 'line', x1: 161, y1: 21.5, x2: 192, y2: 21.5, c: 'strong' }
        ] as E[]))
  ]
}

/** A labelled box with ruled lines inside. */
export function box(x: number, y: number, w: number, h: number, label: string, opts: { lines?: boolean; step?: number; grid?: boolean } = {}): E[] {
  const out: E[] = [
    { t: 'rect', x, y, w, h, r: 2.5, stroke: 'strong', sw: 0.3 },
    { t: 'rect', x, y, w, h: 8, r: 2.5, fill: 'tint' },
    { t: 'text', x: x + 3.5, y: y + 5.6, text: label, size: 3.7, weight: 700, c: 'accent' }
  ]
  if (opts.grid) out.push({ t: 'grid', x: x + 2, y: y + 10, w: w - 4, h: h - 12, step: opts.step ?? 5 })
  else if (opts.lines !== false) out.push({ t: 'lines', x: x + 3, y: y + 8, w: w - 6, h: h - 10, step: opts.step ?? 8 })
  return out
}

/** A table with a header row. */
export function table(x: number, y: number, w: number, h: number, headings: string[], rows: number, widths?: number[]): E[] {
  const out: E[] = [{ t: 'rect', x, y, w, h, r: 2, stroke: 'strong', sw: 0.3 }, { t: 'rect', x, y, w, h: 9, r: 2, fill: 'tint' }]
  const total = widths?.reduce((a, b) => a + b, 0) ?? headings.length
  let cx = x
  headings.forEach((heading, i) => {
    const cw = ((widths?.[i] ?? 1) / total) * w
    out.push({ t: 'text', x: cx + 2.5, y: y + 6, text: heading, size: 3.4, weight: 700, c: 'accent' })
    if (i > 0) out.push({ t: 'line', x1: cx, y1: y, x2: cx, y2: y + h, c: 'line' })
    cx += cw
  })
  const rowH = (h - 9) / rows
  for (let r = 1; r < rows; r++) out.push({ t: 'line', x1: x, y1: y + 9 + r * rowH, x2: x + w, y2: y + 9 + r * rowH, c: 'line' })
  out.push({ t: 'line', x1: x, y1: y + 9, x2: x + w, y2: y + 9, c: 'strong' })
  return out
}

function checklist(x: number, y: number, count: number, step = 9, width = 180): E[] {
  const out: E[] = []
  for (let i = 0; i < count; i++) {
    out.push({ t: 'check', x, y: y + i * step - 3.4, size: 4.2 })
    out.push({ t: 'line', x1: x + 7, y1: y + i * step + 1, x2: x + width, y2: y + i * step + 1, c: 'line' })
  }
  return out
}

const STUDY = '#c96442'
const PLAN = '#4b7fb8'
const WORK = '#5f7249'

export const BUILTIN_TEMPLATES: TemplateSpec[] = [
  // ---- Studiu ----
  {
    id: 'builtin:recap',
    name: 'Recapitulare',
    group: 'Study',
    paper: 'blank',
    color: 'white',
    accent: STUDY,
    elements: [
      ...header('Recapitulare'),
      { t: 'text', x: 14, y: 36, text: 'Lecția / capitolul:', size: 3.6, weight: 600, c: 'muted' },
      { t: 'line', x1: 50, y1: 36.5, x2: 196, y2: 36.5, c: 'strong' },
      ...box(12, 44, 91, 84, 'Idei principale'),
      ...box(107, 44, 91, 84, 'Cuvinte cheie'),
      ...box(12, 134, 186, 84, 'Explicații și exemple'),
      ...box(12, 224, 120, 62, 'Rezumat'),
      ...box(136, 224, 62, 62, 'Întrebări')
    ]
  },
  {
    id: 'builtin:formulas',
    name: 'Foaie de formule',
    group: 'Study',
    paper: 'blank',
    color: 'cream',
    accent: '#8e44ad',
    elements: [
      ...header('Foaie de formule'),
      ...box(12, 32, 91, 82, 'Formule', { grid: true }),
      ...box(107, 32, 91, 82, 'Formule', { grid: true }),
      ...box(12, 120, 91, 82, 'Unități de măsură'),
      ...box(107, 120, 91, 82, 'Constante'),
      ...box(12, 208, 186, 78, 'De nu uitat')
    ]
  },
  {
    id: 'builtin:mindmap',
    name: 'Hartă mentală',
    group: 'Study',
    paper: 'dots',
    color: 'white',
    landscape: true,
    accent: '#0f9d76',
    elements: [
      { t: 'circle', cx: 105, cy: 74, r: 22, fill: 'tint', stroke: 'accent', sw: 0.6 },
      { t: 'text', x: 105, y: 76, text: 'Tema', size: 6, weight: 700, c: 'accent', align: 'center', serif: true },
      ...[0, 1, 2, 3, 4, 5].map((i): E => {
        const a = (i / 6) * Math.PI * 2 + 0.3
        return { t: 'circle', cx: 105 + Math.cos(a) * 62, cy: 74 + Math.sin(a) * 50, r: 12, stroke: 'accent', sw: 0.35, dash: true }
      })
    ]
  },
  {
    id: 'builtin:flashcards',
    name: 'Flashcarduri',
    group: 'Study',
    paper: 'blank',
    color: 'white',
    accent: '#d6336c',
    elements: [
      ...header('Flashcarduri', { date: false }),
      ...[0, 1, 2, 3].flatMap((i): E[] => {
        const y = 32 + i * 64
        return [
          { t: 'rect', x: 12, y, w: 90, h: 58, r: 4, stroke: 'strong', fill: 'tint' },
          { t: 'text', x: 16, y: y + 7, text: 'Întrebare', size: 3.2, weight: 700, c: 'accent' },
          { t: 'rect', x: 108, y, w: 90, h: 58, r: 4, stroke: 'strong' },
          { t: 'text', x: 112, y: y + 7, text: 'Răspuns', size: 3.2, weight: 700, c: 'muted' }
        ]
      })
    ]
  },
  // ---- Planificare ----
  {
    id: 'builtin:day',
    name: 'Planificare zilnică',
    group: 'Planning',
    paper: 'blank',
    color: 'white',
    accent: PLAN,
    elements: [
      ...header('Ziua mea'),
      ...table(12, 32, 110, 254, ['Ora', 'Program'], 13, [1, 4]),
      ...[8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((h, i): E => ({ t: 'text', x: 15, y: 47 + i * 18.85, text: `${h}:00`, size: 3.4, weight: 600, c: 'muted' })),
      ...box(126, 32, 72, 120, 'De făcut', { lines: false }),
      ...checklist(130, 52, 11, 9, 66),
      ...box(126, 158, 72, 64, 'Prioritate'),
      ...box(126, 228, 72, 58, 'Notițe')
    ]
  },
  {
    id: 'builtin:week',
    name: 'Planificare săptămânală',
    group: 'Planning',
    paper: 'blank',
    color: 'white',
    accent: PLAN,
    elements: [
      ...header('Săptămâna'),
      ...['Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'].flatMap((d, i) => box(12 + (i % 2) * 95, 32 + Math.floor(i / 2) * 66, 91, 62, d)),
      ...box(12, 230, 91, 56, 'Duminică'),
      ...box(107, 230, 91, 56, 'Obiective')
    ]
  },
  {
    id: 'builtin:timetable',
    name: 'Orar',
    group: 'Planning',
    paper: 'blank',
    color: 'white',
    landscape: true,
    accent: PLAN,
    elements: [
      { t: 'rect', x: 10, y: 8, w: 277, h: 14, r: 3, fill: 'tint' },
      { t: 'text', x: 16, y: 18, text: 'Orar', size: 6.2, weight: 700, c: 'accent', serif: true },
      ...table(10, 28, 277, 172, ['Ora', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri'], 8, [0.6, 1, 1, 1, 1, 1]),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n, i): E => ({ t: 'text', x: 14, y: 46 + i * 20.4, text: `${n}`, size: 4, weight: 700, c: 'muted' }))
    ]
  },
  {
    id: 'builtin:homework',
    name: 'Teme',
    group: 'Planning',
    paper: 'blank',
    color: 'white',
    accent: PLAN,
    elements: [...header('Teme'), ...table(12, 32, 186, 254, ['Materia', 'Tema', 'Termen', '✓'], 18, [1.3, 3, 1.1, 0.5])]
  },
  // ---- Muncă ----
  {
    id: 'builtin:meeting',
    name: 'Ședință',
    group: 'Work',
    paper: 'blank',
    color: 'white',
    accent: WORK,
    elements: [
      ...header('Ședință'),
      ...box(12, 32, 91, 40, 'Participanți'),
      ...box(107, 32, 91, 40, 'Subiect'),
      ...box(12, 78, 186, 96, 'Notițe'),
      ...box(12, 180, 91, 106, 'Decizii'),
      ...box(107, 180, 91, 106, 'De făcut', { lines: false }),
      ...checklist(111, 200, 9, 9.6, 83)
    ]
  },
  {
    id: 'builtin:project',
    name: 'Proiect',
    group: 'Work',
    paper: 'blank',
    color: 'white',
    accent: WORK,
    elements: [
      ...header('Proiect'),
      ...box(12, 32, 186, 40, 'Scop'),
      ...table(12, 78, 186, 130, ['Pas', 'Ce trebuie făcut', 'Cine', 'Termen'], 10, [0.5, 3, 1, 1]),
      ...box(12, 214, 91, 72, 'Resurse'),
      ...box(107, 214, 91, 72, 'Idei')
    ]
  },
  {
    id: 'builtin:todo',
    name: 'Listă de sarcini',
    group: 'Work',
    paper: 'blank',
    color: 'white',
    accent: WORK,
    elements: [...header('De făcut'), ...checklist(16, 44, 26, 9.4, 192)]
  }
]

export const TEMPLATE_GROUPS: Record<string, string> = {
  Study: 'Study',
  Planning: 'Planning',
  Work: 'Work'
}
