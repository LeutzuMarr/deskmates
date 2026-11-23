/**
 * The store's packs: one per school subject, each with templates (in Romanian) and stickers. This
 * file is read at build time only (scripts/store-files.ts) and turned into /store/catalog.json and
 * /store/packs/<id>.json; the app downloads a pack when "Get" is tapped, so none of this is in the
 * app itself.
 */
import { box, header, table } from '../templates/builtin'
import type { TemplateElement, TemplateSpec } from '../templates/spec'

export interface PackDefinition {
  id: string
  name: string
  subject: string
  description: string
  accent: string
  /** The sticker shown on the pack's card (file name without .svg). */
  cover: string
  version: number
  credits: string
  templates: Array<Omit<TemplateSpec, 'group' | 'accent'>>
}

type E = TemplateElement

const FLUENT = 'Stickers: Microsoft Fluent Emoji (MIT licence) and Deskmates.'

function labelLines(x: number, y: number, count: number, step: number, width: number, numbered = true): E[] {
  const out: E[] = []
  for (let i = 0; i < count; i++) {
    const yy = y + i * step
    if (numbered) out.push({ t: 'circle', cx: x + 3, cy: yy - 1.4, r: 3, fill: 'tint', stroke: 'accent', sw: 0.3 }, { t: 'text', x: x + 3, y: yy, text: String(i + 1), size: 3, weight: 700, c: 'accent', align: 'center' })
    out.push({ t: 'line', x1: x + 8, y1: yy + 0.5, x2: x + width, y2: yy + 0.5, c: 'line' })
  }
  return out
}

export const PACKS: PackDefinition[] = [
  {
    id: 'study',
    name: 'Studiu',
    subject: 'Study',
    description: 'Etichete, săgeți și stickere pentru orice materie, plus notițe de curs.',
    accent: '#c96442',
    cover: 'books',
    version: 1,
    credits: FLUENT,
    templates: [
      {
        id: 'lecture',
        name: 'Notițe de curs',
        paper: 'blank',
        color: 'white',
        elements: [...header('Lecția'), { t: 'text', x: 14, y: 36, text: 'Materia:', size: 3.6, weight: 600, c: 'muted' }, { t: 'line', x1: 32, y1: 36.5, x2: 120, y2: 36.5, c: 'strong' }, { t: 'lines', x: 14, y: 40, w: 182, h: 246, step: 8 }]
      },
      {
        id: 'study-plan',
        name: 'Plan de învățare',
        paper: 'blank',
        color: 'cream',
        elements: [...header('Plan de învățare'), ...table(12, 32, 186, 180, ['Materia', 'Ce învăț', 'Când', '✓'], 14, [1.2, 3, 1, 0.5]), ...box(12, 218, 186, 68, 'Obiectivul săptămânii')]
      }
    ]
  },
  {
    id: 'algebra',
    name: 'Algebră',
    subject: 'Algebra',
    description: 'Exerciții, funcții și ecuații, cu simboluri matematice.',
    accent: '#1f4fd1',
    cover: 'abacus',
    version: 1,
    credits: FLUENT,
    templates: [
      {
        id: 'exercises',
        name: 'Exerciții',
        paper: 'grid',
        color: 'white',
        elements: [
          ...header('Exerciții'),
          { t: 'rect', x: 10, y: 30, w: 14, h: 260, fill: 'tint' },
          ...[0, 1, 2, 3, 4].map((i): E => ({ t: 'text', x: 17, y: 42 + i * 52, text: `${i + 1}.`, size: 5, weight: 700, c: 'accent', align: 'center' })),
          ...[1, 2, 3, 4].map((i): E => ({ t: 'line', x1: 10, y1: 30 + i * 52, x2: 200, y2: 30 + i * 52, c: 'strong', dash: true }))
        ]
      },
      {
        id: 'functions',
        name: 'Funcții',
        paper: 'grid',
        color: 'white',
        elements: [
          ...header('Funcția'),
          { t: 'text', x: 14, y: 38, text: 'f : ℝ → ℝ,  f(x) =', size: 4.6, weight: 600, c: 'ink', serif: true },
          { t: 'line', x1: 58, y1: 38.5, x2: 196, y2: 38.5, c: 'strong' },
          { t: 'rect', x: 14, y: 46, w: 182, h: 120, r: 2, fill: 'tint' },
          { t: 'axes', x: 16, y: 48, w: 178, h: 116 },
          ...table(14, 172, 182, 26, ['x', '', '', '', '', '', ''], 1),
          { t: 'text', x: 16, y: 194, text: 'f(x)', size: 3.4, weight: 700, c: 'accent' },
          ...box(14, 204, 182, 82, 'Proprietăți: monotonie, semn, intersecții cu axele')
        ]
      },
      {
        id: 'equations',
        name: 'Ecuații',
        paper: 'grid',
        color: 'white',
        elements: [...header('Ecuații'), ...box(12, 32, 186, 30, 'Ecuația'), ...box(12, 68, 120, 186, 'Rezolvare', { grid: true }), ...box(136, 68, 62, 186, 'Verificare', { grid: true }), ...box(12, 260, 186, 26, 'S = {   }', { lines: false })]
      }
    ]
  },
  {
    id: 'geometry',
    name: 'Geometrie',
    subject: 'Geometry',
    description: 'Probleme cu ipoteză și concluzie, construcții și forme.',
    accent: '#0f9d76',
    cover: 'triangular-ruler',
    version: 1,
    credits: FLUENT,
    templates: [
      {
        id: 'problem',
        name: 'Problemă de geometrie',
        paper: 'blank',
        color: 'white',
        elements: [
          ...header('Problemă'),
          ...box(12, 32, 186, 34, 'Enunț'),
          ...box(12, 72, 91, 42, 'Ipoteză'),
          ...box(107, 72, 91, 42, 'Concluzie'),
          { t: 'rect', x: 12, y: 120, w: 186, h: 76, r: 2.5, stroke: 'strong', sw: 0.3 },
          { t: 'text', x: 15.5, y: 125.6, text: 'Figura', size: 3.7, weight: 700, c: 'accent' },
          { t: 'dots', x: 16, y: 130, w: 178, h: 62, step: 5 },
          ...box(12, 202, 186, 84, 'Demonstrație')
        ]
      },
      { id: 'constructions', name: 'Construcții', paper: 'isometric', color: 'white', elements: header('Construcții') },
      {
        id: 'areas',
        name: 'Arii și volume',
        paper: 'blank',
        color: 'cream',
        elements: [...header('Arii și volume', { date: false }), ...table(12, 32, 186, 254, ['Figura', 'Desen', 'Arie / Volum', 'Perimetru / Arie laterală'], 8, [1, 1.3, 1.5, 1.5])]
      }
    ]
  },
  {
    id: 'physics',
    name: 'Fizică',
    subject: 'Physics',
    description: 'Probleme (Se dă, Se cere), laborator și mărimi fizice.',
    accent: '#f2711c',
    cover: 'atom-symbol',
    version: 1,
    credits: FLUENT,
    templates: [
      {
        id: 'problem',
        name: 'Problemă de fizică',
        paper: 'blank',
        color: 'white',
        elements: [...header('Problemă'), ...box(12, 32, 186, 36, 'Enunț'), ...box(12, 74, 70, 70, 'Se dă'), ...box(12, 150, 70, 40, 'Se cere'), ...box(86, 74, 112, 116, 'Formule'), ...box(12, 196, 186, 64, 'Rezolvare', { grid: true }), ...box(12, 266, 186, 20, 'Rezultat (cu unitate de măsură)', { lines: false })]
      },
      {
        id: 'lab',
        name: 'Lucrare de laborator',
        paper: 'blank',
        color: 'white',
        elements: [...header('Lucrare de laborator'), ...box(12, 32, 186, 28, 'Scopul lucrării'), ...box(12, 66, 91, 50, 'Materiale'), ...box(107, 66, 91, 50, 'Mod de lucru'), ...table(12, 122, 186, 70, ['Nr.', 'Mărimea 1', 'Mărimea 2', 'Rezultat', 'Media'], 6, [0.5, 1, 1, 1, 1]), ...box(12, 198, 110, 88, 'Grafic', { grid: true }), ...box(126, 198, 72, 88, 'Concluzii')]
      },
      {
        id: 'quantities',
        name: 'Mărimi fizice',
        paper: 'blank',
        color: 'cream',
        elements: [...header('Mărimi fizice', { date: false }), ...table(12, 32, 186, 254, ['Mărimea', 'Simbol', 'Formula', 'Unitate SI'], 16, [1.6, 0.8, 1.6, 1])]
      }
    ]
  },
  {
    id: 'sciences',
    name: 'Științe și chimie',
    subject: 'Sciences',
    description: 'Fișe de laborator, ecuații chimice și elemente.',
    accent: '#8e44ad',
    cover: 'test-tube',
    version: 1,
    credits: FLUENT,
    templates: [
      {
        id: 'lab-sheet',
        name: 'Fișă de laborator',
        paper: 'blank',
        color: 'white',
        elements: [...header('Experiment'), ...box(12, 32, 91, 40, 'Scop'), ...box(107, 32, 91, 40, 'Ipoteză'), ...box(12, 78, 91, 56, 'Materiale și substanțe'), ...box(107, 78, 91, 56, 'Măsuri de protecție'), ...box(12, 140, 186, 62, 'Mod de lucru'), ...box(12, 208, 120, 78, 'Observații'), ...box(136, 208, 62, 78, 'Concluzie')]
      },
      {
        id: 'chemical-equations',
        name: 'Ecuații chimice',
        paper: 'ruled',
        color: 'white',
        elements: [...header('Ecuații chimice'), ...table(12, 32, 186, 254, ['Reactanți', '→', 'Produși', 'Tipul reacției'], 18, [2, 0.4, 2, 1.2])]
      },
      {
        id: 'element',
        name: 'Element chimic',
        paper: 'blank',
        color: 'white',
        elements: [
          ...header('Element chimic'),
          { t: 'rect', x: 12, y: 32, w: 60, h: 60, r: 4, fill: 'tint', stroke: 'accent', sw: 0.6 },
          { t: 'text', x: 15, y: 40, text: 'Z', size: 3.6, weight: 700, c: 'muted' },
          { t: 'text', x: 15, y: 88, text: 'A', size: 3.6, weight: 700, c: 'muted' },
          { t: 'text', x: 42, y: 70, text: 'Simbol', size: 4, weight: 600, c: 'muted', align: 'center' },
          ...box(78, 32, 120, 60, 'Nume, grupă, perioadă'),
          ...box(12, 98, 91, 90, 'Structura atomului'),
          ...box(107, 98, 91, 90, 'Proprietăți'),
          ...box(12, 194, 186, 92, 'Compuși și utilizări')
        ]
      }
    ]
  },
  {
    id: 'biology',
    name: 'Biologie',
    subject: 'Biology',
    description: 'Desene de etichetat, celula, organisme și comparații.',
    accent: '#4caf50',
    cover: 'dna',
    version: 1,
    credits: FLUENT,
    templates: [
      {
        id: 'label-drawing',
        name: 'Desen de etichetat',
        paper: 'blank',
        color: 'white',
        elements: [...header('Desen'), { t: 'rect', x: 12, y: 32, w: 130, h: 196, r: 3, stroke: 'strong', sw: 0.3 }, ...labelLines(148, 42, 10, 19, 50), ...box(12, 234, 186, 52, 'Observații')]
      },
      {
        id: 'cell',
        name: 'Celula',
        paper: 'blank',
        color: 'white',
        elements: [
          ...header('Celula'),
          { t: 'circle', cx: 75, cy: 110, r: 62, stroke: 'accent', sw: 0.6, dash: true },
          { t: 'circle', cx: 75, cy: 110, r: 18, fill: 'tint', stroke: 'accent', sw: 0.4 },
          ...labelLines(148, 46, 8, 17, 50),
          ...table(12, 186, 186, 100, ['Organit', 'Rol'], 7, [1, 3])
        ]
      },
      {
        id: 'organism',
        name: 'Fișa organismului',
        paper: 'blank',
        color: 'cream',
        elements: [...header('Organism'), { t: 'rect', x: 12, y: 32, w: 80, h: 80, r: 3, stroke: 'strong', sw: 0.3 }, { t: 'text', x: 52, y: 74, text: 'Desen', size: 4, weight: 600, c: 'muted', align: 'center' }, ...table(96, 32, 102, 80, ['Clasificare', ''], 6, [1, 1.4]), ...box(12, 118, 91, 80, 'Habitat'), ...box(107, 118, 91, 80, 'Hrănire'), ...box(12, 204, 186, 82, 'Caracteristici')]
      },
      {
        id: 'compare',
        name: 'Comparație',
        paper: 'blank',
        color: 'white',
        elements: [...header('Comparație'), ...table(12, 32, 186, 254, ['Criteriu', 'A', 'B'], 12, [1, 1.5, 1.5])]
      }
    ]
  },
  {
    id: 'anatomy',
    name: 'Anatomie',
    subject: 'Anatomy',
    description: 'Planșe de etichetat, organe și sisteme ale corpului.',
    accent: '#e03131',
    cover: 'anatomical-heart',
    version: 1,
    credits: FLUENT,
    templates: [
      {
        id: 'plate',
        name: 'Planșă de etichetat',
        paper: 'blank',
        color: 'white',
        elements: [...header('Planșă'), { t: 'rect', x: 12, y: 32, w: 120, h: 254, r: 3, stroke: 'strong', sw: 0.3 }, ...labelLines(138, 44, 12, 20.5, 60)]
      },
      {
        id: 'organ',
        name: 'Organ / sistem',
        paper: 'blank',
        color: 'white',
        elements: [...header('Organ / sistem'), ...box(12, 32, 186, 30, 'Localizare'), ...box(12, 68, 91, 70, 'Structură'), ...box(107, 68, 91, 70, 'Funcții'), ...table(12, 144, 186, 76, ['Componentă', 'Rol'], 6, [1, 2]), ...box(12, 226, 91, 60, 'Boli'), ...box(107, 226, 91, 60, 'Igienă și prevenire')]
      },
      {
        id: 'systems',
        name: 'Sistemele corpului',
        paper: 'blank',
        color: 'cream',
        elements: [...header('Sistemele corpului', { date: false }), ...table(12, 32, 186, 254, ['Sistemul', 'Organe', 'Funcția principală'], 10, [1.1, 2, 2])]
      }
    ]
  }
]
