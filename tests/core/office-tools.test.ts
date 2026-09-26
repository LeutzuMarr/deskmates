import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import type { CellValue } from 'exceljs'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { officeTools, wrapText } from '../../src/core/tools/office'
import { makeTestContext, runTool, type TestContext } from './helpers'

let t: TestContext
let tools: ReturnType<typeof officeTools>

beforeEach(() => {
  t = makeTestContext()
  tools = officeTools(t.ctx)
})
afterEach(() => t.cleanup())

describe('create_word_document', () => {
  it('creates a Word document and reads it back with read_document', async () => {
    const created = await runTool(tools.create_word_document, {
      path: 'report.docx',
      title: 'Weekly report',
      content: '# Summary\nSales grew **12%**.\n- North\n- South'
    })
    expect(created).toMatchObject({ path: 'report.docx', created: true })

    const read = await runTool(tools.read_document, { path: 'report.docx' })
    expect(read.text).toContain('Weekly report')
    expect(read.text).toContain('Summary')
    expect(read.text).toContain('Sales grew 12%.')
    expect(read.text).toContain('North')
    expect(read.text).toContain('South')

    expect(t.repos.changes.list(t.taskId).map((c) => c.kind)).toEqual(['create'])
  })
})

describe('create_spreadsheet', () => {
  it('dedupes duplicate sheet names and reads back rows with read_document', async () => {
    await runTool(tools.create_spreadsheet, {
      path: 'data.xlsx',
      sheets: [
        {
          name: 'Q1',
          rows: [
            ['Region', 'Sales'],
            ['North', 120]
          ]
        },
        { name: 'Q1', rows: [['other']] }
      ]
    })

    const read = await runTool(tools.read_document, { path: 'data.xlsx' })
    expect(read.text).toContain('## Sheet: Q1')
    expect(read.text).toContain('North\t120')
    expect(read.text).toContain('## Sheet: Q1 (2)')
  })
})

describe('create_presentation', () => {
  it('creates a presentation and reads back slide text with read_document', async () => {
    await runTool(tools.create_presentation, {
      path: 'plan.pptx',
      slides: [{ title: 'Plan', bullets: ['Ship v1', 'Collect feedback'] }]
    })

    const read = await runTool(tools.read_document, { path: 'plan.pptx' })
    expect(read.text).toContain('## Slide 1')
    expect(read.text).toContain('Plan')
    expect(read.text).toContain('Ship v1')
  })
})

describe('create_pdf', () => {
  it('creates a PDF with a non-Latin1 title and reads back the body with read_document', async () => {
    const created = await runTool(tools.create_pdf, {
      path: 'notes.pdf',
      title: 'Șapte zile',
      content: 'Hello PDF world'
    })
    expect(created.pages).toBeGreaterThanOrEqual(1)

    const read = await runTool(tools.read_document, { path: 'notes.pdf' })
    expect(read.text).toContain('Hello PDF world')
  })
})

describe('validation', () => {
  it('rejects a non-.docx path for create_word_document and an unsupported extension for read_document', async () => {
    await expect(runTool(tools.create_word_document, { path: 'a.txt', content: 'x' })).rejects.toThrow(/\.docx/)
    await expect(runTool(tools.read_document, { path: 'x.zip' })).rejects.toThrow(/Unsupported/)
  })
})

describe('read_document', () => {
  it('reads a markdown file as plain text', async () => {
    writeFileSync(join(t.root, 'notes.md'), '# Notes\nsome content')
    const read = await runTool(tools.read_document, { path: 'notes.md' })
    expect(read.text).toBe('# Notes\nsome content')
  })

  it('reads a hyperlink cell whose label is rich text as the joined label text', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Links')
    sheet.getCell('A1').value = {
      text: { richText: [{ text: 'Visit ' }, { text: 'example' }] },
      hyperlink: 'https://example.com'
    } as unknown as CellValue
    writeFileSync(join(t.root, 'links.xlsx'), Buffer.from(await workbook.xlsx.writeBuffer()))
    const read = await runTool(tools.read_document, { path: 'links.xlsx' })
    expect(read.text).toContain('Visit example')
  })
})

describe('wrapText', () => {
  it('splits a word wider than maxWidth into chunks that each fit, preserving the text', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const size = 11
    const maxWidth = 80
    const text = 'https://example.com/this/is/a/really/long/path/that/overflows/the/line/entirely'
    const lines = wrapText(text, font, size, maxWidth)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, size)).toBeLessThanOrEqual(maxWidth)
    }
    expect(lines.join('')).toBe(text.replace(/\s+/g, ''))
  })

  it('keeps every line within maxWidth when words and overflowed chunks mix', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    const text = 'short https://example.com/this/is/a/really/long/path/that/overflows the end of the paragraph'
    const size = 11
    const maxWidth = 100
    const lines = wrapText(text, font, size, maxWidth)
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, size)).toBeLessThanOrEqual(maxWidth)
    }
    expect(lines.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })
})
