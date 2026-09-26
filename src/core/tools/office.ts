import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import mammoth from 'mammoth'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import pdfLib from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx'
import PptxGenJS from 'pptxgenjs'
import { extractText, getDocumentProxy } from 'unpdf'
import { resolveInside, toProjectRelative } from '../fs/safe-path'
import { writeTracked } from './files'
import type { ToolContext } from './context'

const { PDFDocument, StandardFonts } = pdfLib

const MAX_TEXT_CHARS = 100_000
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json'])

const PDF_PAGE_WIDTH = 595.28
const PDF_PAGE_HEIGHT = 841.89
const PDF_MARGIN = 56

/** A line of simple markdown, classified into the shape used by both create_word_document and create_pdf. */
type LineKind = 'h1' | 'h2' | 'h3' | 'bullet' | 'para'

function classifyLine(line: string): { kind: LineKind; text: string } {
  if (line.startsWith('### ')) return { kind: 'h3', text: line.slice(4) }
  if (line.startsWith('## ')) return { kind: 'h2', text: line.slice(3) }
  if (line.startsWith('# ')) return { kind: 'h1', text: line.slice(2) }
  if (line.startsWith('- ') || line.startsWith('* ')) return { kind: 'bullet', text: line.slice(2) }
  return { kind: 'para', text: line }
}

function nonEmptyLines(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.trim() !== '')
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Reads an exceljs cell value the way a person would read the sheet: formula results, rich text and hyperlink labels. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (Array.isArray(v.richText)) return (v.richText as Array<{ text: string }>).map((run) => run.text).join('')
    if (typeof v.formula === 'string') return cellText(v.result ?? '')
    if (typeof v.hyperlink === 'string') return cellText(v.text)
    if ('error' in v) return String(v.error)
  }
  return String(value)
}

async function readDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer })
  return result.value
}

async function readXlsx(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  const sections = workbook.worksheets.map((sheet) => {
    const lines = [`## Sheet: ${sheet.name}`]
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = []
      for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c).value))
      lines.push(cells.join('\t'))
    })
    return lines.join('\n')
  })
  return sections.join('\n\n')
}

async function readPptx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  const slides = Object.keys(zip.files)
    .map((name) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)
      return match ? { name, n: Number(match[1]) } : null
    })
    .filter((entry): entry is { name: string; n: number } => entry !== null)
    .sort((a, b) => a.n - b.n)

  const sections: string[] = []
  for (const { name, n } of slides) {
    const xml = await zip.file(name)!.async('string')
    const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => decodeXmlEntities(m[1]))
    sections.push([`## Slide ${n}`, ...texts].join('\n'))
  }
  return sections.join('\n\n')
}

async function readPdf(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

/** Splits text on **bold** spans into docx runs. */
function parseInlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  const pattern = /\*\*(.+?)\*\*/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) runs.push(new TextRun(text.slice(lastIndex, match.index)))
    runs.push(new TextRun({ text: match[1], bold: true }))
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) runs.push(new TextRun(text.slice(lastIndex)))
  return runs.length > 0 ? runs : [new TextRun('')]
}

function buildWordParagraphs(title: string | undefined, content: string): Paragraph[] {
  const paragraphs: Paragraph[] = []
  if (title) paragraphs.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }))
  for (const line of nonEmptyLines(content)) {
    const { kind, text } = classifyLine(line)
    const children = parseInlineRuns(text)
    if (kind === 'h1') paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children }))
    else if (kind === 'h2') paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children }))
    else if (kind === 'h3') paragraphs.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children }))
    else if (kind === 'bullet') paragraphs.push(new Paragraph({ bullet: { level: 0 }, children }))
    else paragraphs.push(new Paragraph({ children }))
  }
  return paragraphs
}

const ILLEGAL_SHEET_CHARS = /[[\]:*?/\\]/g

/** Sanitizes a sheet name to Excel's rules and dedupes it against names already used in this workbook. */
function sanitizeSheetName(rawName: string, used: Set<string>): string {
  const base = rawName.replace(ILLEGAL_SHEET_CHARS, '-').slice(0, 31)
  let candidate = base
  let n = 2
  while (used.has(candidate)) {
    const suffix = ` (${n})`
    candidate = base.slice(0, Math.max(0, 31 - suffix.length)) + suffix
    n++
  }
  used.add(candidate)
  return candidate
}

export interface MeasurableFont {
  widthOfTextAtSize(text: string, size: number): number
}

/** Splits a single word (no spaces) into chunks that each fit at most maxWidth. */
function splitLongWord(word: string, font: MeasurableFont, size: number, maxWidth: number): string[] {
  const chunks: string[] = []
  let rest = word
  while (rest.length > 0) {
    let lo = 1
    let hi = rest.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (font.widthOfTextAtSize(rest.slice(0, mid), size) > maxWidth) hi = mid - 1
      else lo = mid
    }
    chunks.push(rest.slice(0, lo))
    rest = rest.slice(lo)
  }
  return chunks
}

/** Greedily wraps text into lines that fit maxWidth at the given font and size. */
export function wrapText(text: string, font: MeasurableFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const lines: string[] = []
  let current = ''
  const place = (chunk: string): void => {
    if (!current) {
      current = chunk
      return
    }
    const candidate = `${current} ${chunk}`
    if (font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current)
      current = chunk
    } else {
      current = candidate
    }
  }
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      place(word)
    } else {
      const chunks = splitLongWord(word, font, size, maxWidth)
      chunks.forEach((chunk, index) => {
        if (index === 0) place(chunk)
        else {
          if (current) lines.push(current)
          current = chunk
        }
      })
    }
  }
  if (current) lines.push(current)
  return lines
}

export function officeTools(ctx: ToolContext) {
  const rel = (absPath: string) => toProjectRelative(ctx.root, absPath)

  return {
    read_document: tool({
      description:
        'Read the text of a Word, Excel, PowerPoint or PDF file, or a plain text file. Returns up to 100,000 characters.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const abs = resolveInside(ctx.root, path)
        const ext = extname(path).toLowerCase()

        let text: string
        if (ext === '.docx') text = await readDocx(await readFile(abs))
        else if (ext === '.xlsx' || ext === '.xlsm') text = await readXlsx(await readFile(abs))
        else if (ext === '.pptx') text = await readPptx(await readFile(abs))
        else if (ext === '.pdf') text = await readPdf(await readFile(abs))
        else if (TEXT_EXTENSIONS.has(ext)) text = await readFile(abs, 'utf8')
        else {
          throw new Error(
            `Unsupported document type: ${ext}. Supported: .docx, .xlsx, .xlsm, .pptx, .pdf, .txt, .md, .csv, .json`
          )
        }

        return {
          path: rel(abs),
          format: ext.slice(1),
          text: text.slice(0, MAX_TEXT_CHARS),
          truncated: text.length > MAX_TEXT_CHARS
        }
      }
    }),

    create_word_document: tool({
      description: 'Create a Word document (.docx) from an optional title and simple markdown content.',
      inputSchema: z.object({
        path: z.string(),
        title: z.string().optional(),
        content: z.string()
      }),
      execute: async ({ path, title, content }) => {
        if (!path.toLowerCase().endsWith('.docx')) throw new Error('The file name must end with .docx')
        const doc = new Document({ sections: [{ children: buildWordParagraphs(title, content) }] })
        const buffer = await Packer.toBuffer(doc)
        return writeTracked(ctx, resolveInside(ctx.root, path), buffer)
      }
    }),

    create_spreadsheet: tool({
      description: 'Create an Excel workbook (.xlsx) with one or more sheets of rows.',
      inputSchema: z.object({
        path: z.string(),
        sheets: z
          .array(
            z.object({
              name: z.string().min(1).max(100),
              rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
            })
          )
          .min(1)
          .max(20)
      }),
      execute: async ({ path, sheets }) => {
        if (!path.toLowerCase().endsWith('.xlsx')) throw new Error('The file name must end with .xlsx')
        const workbook = new ExcelJS.Workbook()
        const usedNames = new Set<string>()
        for (const sheet of sheets) {
          const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name, usedNames))
          for (const row of sheet.rows) worksheet.addRow(row)
          if (sheet.rows.length > 0) worksheet.getRow(1).font = { bold: true }
        }
        const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
        const written = await writeTracked(ctx, resolveInside(ctx.root, path), buffer)
        return { ...written, sheets: sheets.length }
      }
    }),

    create_presentation: tool({
      description: 'Create a PowerPoint presentation (.pptx) with one slide per item: a title, bullets and optional speaker notes.',
      inputSchema: z.object({
        path: z.string(),
        slides: z
          .array(
            z.object({
              title: z.string(),
              bullets: z.array(z.string()).max(12),
              notes: z.string().optional()
            })
          )
          .min(1)
          .max(50)
      }),
      execute: async ({ path, slides }) => {
        if (!path.toLowerCase().endsWith('.pptx')) throw new Error('The file name must end with .pptx')
        const pptx = new PptxGenJS()
        pptx.layout = 'LAYOUT_WIDE'
        for (const slide of slides) {
          const pptxSlide = pptx.addSlide()
          pptxSlide.addText(slide.title, { x: 0.5, y: 0.3, w: '90%', h: 1, fontSize: 32, bold: true })
          if (slide.bullets.length > 0) {
            pptxSlide.addText(
              slide.bullets.map((bullet) => ({ text: bullet, options: { bullet: true, breakLine: true } })),
              { x: 0.5, y: 1.3, w: '90%', h: 4, fontSize: 20 }
            )
          }
          if (slide.notes) pptxSlide.addNotes(slide.notes)
        }
        const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
        const written = await writeTracked(ctx, resolveInside(ctx.root, path), buffer)
        return { ...written, slides: slides.length }
      }
    }),

    create_pdf: tool({
      description: 'Create a PDF (A4) from an optional title and simple markdown content.',
      inputSchema: z.object({
        path: z.string(),
        title: z.string().optional(),
        content: z.string()
      }),
      execute: async ({ path, title, content }) => {
        if (!path.toLowerCase().endsWith('.pdf')) throw new Error('The file name must end with .pdf')
        const abs = resolveInside(ctx.root, path)

        const doc = await PDFDocument.create()
        doc.registerFontkit(fontkit)
        const winDir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
        let asciiOnly = false
        let regularFont
        let boldFont
        try {
          const [regularBytes, boldBytes] = await Promise.all([
            readFile(join(winDir, 'Fonts', 'arial.ttf')),
            readFile(join(winDir, 'Fonts', 'arialbd.ttf'))
          ])
          regularFont = await doc.embedFont(regularBytes, { subset: true })
          boldFont = await doc.embedFont(boldBytes, { subset: true })
        } catch {
          regularFont = await doc.embedFont(StandardFonts.Helvetica)
          boldFont = await doc.embedFont(StandardFonts.HelveticaBold)
          asciiOnly = true
        }
        const sanitize = (text: string) => (asciiOnly ? text.replace(/[^\x00-\xFF]/g, '?') : text)
        const contentWidth = PDF_PAGE_WIDTH - PDF_MARGIN * 2

        let page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
        let y = PDF_PAGE_HEIGHT - PDF_MARGIN

        const ensureSpace = (lineHeight: number) => {
          if (y - lineHeight < PDF_MARGIN) {
            page = doc.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT])
            y = PDF_PAGE_HEIGHT - PDF_MARGIN
          }
        }

        const drawBlock = (text: string, size: number, indent: number, bold: boolean) => {
          const font = bold ? boldFont : regularFont
          const lineHeight = size * 1.4
          for (const line of wrapText(text, font, size, contentWidth - indent)) {
            ensureSpace(lineHeight)
            page.drawText(line, { x: PDF_MARGIN + indent, y, size, font })
            y -= lineHeight
          }
        }

        if (title) {
          drawBlock(sanitize(title), 20, 0, true)
          y -= 8
        }

        for (const line of nonEmptyLines(content)) {
          const { kind, text } = classifyLine(line)
          const plain = sanitize(text.replace(/\*\*/g, ''))
          if (kind === 'h1') drawBlock(plain, 18, 0, true)
          else if (kind === 'h2') drawBlock(plain, 15, 0, true)
          else if (kind === 'h3') drawBlock(plain, 13, 0, true)
          else if (kind === 'bullet') drawBlock(`\u2022 ${plain}`, 11, 12, false)
          else drawBlock(plain, 11, 0, false)
        }

        const bytes = await doc.save()
        const written = await writeTracked(ctx, abs, bytes)
        return { ...written, pages: doc.getPageCount() }
      }
    })
  }
}
