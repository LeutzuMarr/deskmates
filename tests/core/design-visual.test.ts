import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readImageMetadata } from '../../src/core/designs/image-metadata'
import type { RenderClient, RenderRequest, RenderResult } from '../../src/core/render/types'
import { designVisualTools, getCaptures, lastVerdict, noteUserView } from '../../src/core/tools/design-visual'
import { makeTestContext, runTool, type TestContext } from './helpers'

/** Records every request and answers with whatever `respond` returns. */
class FakeRender implements RenderClient {
  requests: RenderRequest[] = []
  respond: (request: RenderRequest) => Partial<RenderResult> | Promise<Partial<RenderResult>> = () => ({})
  async render(request: RenderRequest): Promise<RenderResult> {
    this.requests.push(request)
    return { screenshots: [], logs: [], ...(await this.respond(request)) }
  }
}

// ---------------------------------------------------------------- image fixtures

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

/** An 8-bit PNG; `rows` are unfiltered pixel bytes, one buffer per row. */
function makePng(width: number, height: number, colorType: number, rows: Buffer[], extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = colorType
  const raw = Buffer.concat(rows.map((row, index) => Buffer.concat([Buffer.from([index % 2 ? 2 : 0]), filterUp(row, rows[index - 1], index % 2 === 1)])))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...extra,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Applies the "Up" filter to odd rows so the decoder's unfiltering is exercised too. */
function filterUp(row: Buffer, previous: Buffer | undefined, up: boolean): Buffer {
  if (!up || !previous) return row
  return Buffer.from(row.map((value, i) => (value - previous[i]) & 0xff))
}

const rgba = (...pixels: number[][]): Buffer => Buffer.from(pixels.flat())

const PNG_1PX = makePng(1, 1, 2, [Buffer.from([255, 0, 0])])

describe('image_metadata parsing', () => {
  it('reads PNG size and finds real transparency in RGBA rows', () => {
    const opaque = makePng(2, 2, 6, [rgba([1, 2, 3, 255], [4, 5, 6, 255]), rgba([7, 8, 9, 255], [1, 1, 1, 255])])
    const see = makePng(2, 2, 6, [rgba([1, 2, 3, 255], [4, 5, 6, 255]), rgba([7, 8, 9, 255], [1, 1, 1, 10])])
    expect(readImageMetadata(opaque)).toMatchObject({
      format: 'png',
      width: 2,
      height: 2,
      hasAlphaChannel: true,
      hasTransparentPixels: false,
      animated: false
    })
    expect(readImageMetadata(see).hasTransparentPixels).toBe(true)
    expect(readImageMetadata(PNG_1PX)).toMatchObject({ hasAlphaChannel: false, hasTransparentPixels: false })
  })

  it('checks palette transparency and APNG frames', () => {
    const palette = chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]))
    const trns = chunk('tRNS', Buffer.from([255, 0]))
    const usesClear = makePng(2, 1, 3, [Buffer.from([0, 1])], [palette, trns])
    const usesSolid = makePng(2, 1, 3, [Buffer.from([0, 0])], [palette, trns])
    expect(readImageMetadata(usesClear).hasTransparentPixels).toBe(true)
    expect(readImageMetadata(usesSolid).hasTransparentPixels).toBe(false)

    const actl = Buffer.alloc(8)
    actl.writeUInt32BE(3, 0)
    const apng = makePng(1, 1, 2, [Buffer.from([0, 0, 0])], [chunk('acTL', actl)])
    expect(readImageMetadata(apng)).toMatchObject({ animated: true, frames: 3 })
  })

  it('reads JPEG, GIF, WebP, BMP and SVG headers', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03])
    expect(readImageMetadata(jpeg)).toMatchObject({ format: 'jpeg', width: 600, height: 300, formatSupportsTransparency: false })
    expect(readImageMetadata(jpeg).details.progressive).toBe(true)

    const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x01, 0x00, 0x00]
    const gce = [0x21, 0xf9, 0x04, 0x01, 0, 0, 0, 0]
    const gif = Buffer.from([...Buffer.from('GIF89a'), 5, 0, 7, 0, 0, 0, 0, ...gce, ...frame, ...gce, ...frame, 0x3b])
    expect(readImageMetadata(gif)).toMatchObject({ format: 'gif', width: 5, height: 7, animated: true, frames: 2, hasAlphaChannel: true })

    const vp8x = Buffer.alloc(10)
    vp8x[0] = 0x10
    vp8x.writeUIntLE(99, 4, 3)
    vp8x.writeUIntLE(49, 7, 3)
    const body = Buffer.concat([Buffer.from('WEBP'), Buffer.from('VP8X'), Buffer.from([10, 0, 0, 0]), vp8x])
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([body.length, 0, 0, 0]), body])
    expect(readImageMetadata(webp)).toMatchObject({ format: 'webp', width: 100, height: 50, hasAlphaChannel: true })

    const bmp = Buffer.alloc(54)
    bmp.write('BM', 0, 'latin1')
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(12, 18)
    bmp.writeInt32LE(-8, 22)
    bmp.writeUInt16LE(24, 28)
    expect(readImageMetadata(bmp)).toMatchObject({ format: 'bmp', width: 12, height: 8, hasAlphaChannel: false })

    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="400"><animate/></svg>')
    expect(readImageMetadata(svg)).toMatchObject({ format: 'svg', width: 400, height: 200, animated: true })

    expect(() => readImageMetadata(Buffer.from('hello'))).toThrow(/Not a supported image/)
  })
})

// ---------------------------------------------------------------- tools

let t: TestContext
let fake: FakeRender
let shown: string[]
let tools: ReturnType<typeof designVisualTools>

const write = (path: string, content: string | Buffer): void => {
  mkdirSync(join(t.root, path, '..'), { recursive: true })
  writeFileSync(join(t.root, path), content)
}
const png = (b64: string): string => b64
const SHOT = PNG_1PX.toString('base64')

beforeEach(() => {
  t = makeTestContext()
  fake = new FakeRender()
  shown = []
  t.ctx.render = fake
  t.ctx.showInPreview = (path) => shown.push(path)
  tools = designVisualTools(t.ctx)
})
afterEach(() => t.cleanup())

const modelOutput = (tool: { toModelOutput?: unknown }, output: unknown): any =>
  (tool.toModelOutput as (options: { toolCallId: string; input: unknown; output: unknown }) => unknown)({
    toolCallId: 'x',
    input: {},
    output
  })

describe('page URLs and rendering', () => {
  it('loads design files on the preview scheme in export mode and keeps logs for get_webview_logs', async () => {
    write('sub dir/page one.html', '<html><body>hi</body></html>')
    fake.respond = () => ({ screenshots: [SHOT], previews: [SHOT], logs: [{ level: 'error', message: 'boom (page one.html:3)' }] })
    const result = await runTool(tools.show_html, { path: 'sub dir/page one.html', screenshot: true })
    expect(fake.requests[0].url).toBe(`deskmates-preview://design/${t.projectId}/sub%20dir/page%20one.html?export=1`)
    expect(fake.requests[0]).toMatchObject({ width: 1440, height: 900, screenshots: true })
    expect(result.console_errors).toEqual(['boom (page one.html:3)'])

    const logs = await runTool(tools.get_webview_logs, {})
    expect(logs).toMatchObject({ path: 'sub dir/page one.html', logs: ['[error] boom (page one.html:3)'] })
    expect(fake.requests).toHaveLength(1)
  })

  it('sends images only to providers that accept them in tool results', async () => {
    write('index.html', '<p>x</p>')
    fake.respond = () => ({ screenshots: [SHOT], previews: [png(SHOT)] })
    const output = await runTool(tools.show_html, { path: 'index.html', screenshot: true })

    const google = modelOutput(tools.show_html, output)
    expect(google.type).toBe('content')
    expect(google.value.find((part: any) => part.type === 'file')).toMatchObject({
      mediaType: 'image/jpeg',
      data: { type: 'data', data: SHOT }
    })

    t.ctx.modelRef = { provider: 'groq', modelId: 'm' }
    const groq = modelOutput(designVisualTools(t.ctx).show_html, output)
    expect(groq.type).toBe('json')
    expect(JSON.stringify(groq.value)).not.toContain(SHOT)
    expect(groq.value.images_not_shown).toMatch(/can't receive images/)
  })

  it('fails clearly without a renderer, and rejects paths outside the design', async () => {
    write('index.html', '<p>x</p>')
    delete t.ctx.render
    await expect(runTool(designVisualTools(t.ctx).screenshot, { path: 'index.html' })).rejects.toThrow(/Page rendering is not available/)
    await expect(runTool(tools.screenshot, { path: '../outside.html' })).rejects.toThrow(/outside the project/)
    await expect(runTool(tools.view_image, { path: '/projects/other/x.png' })).rejects.toThrow(/own folder/)
  })

  it('surfaces render errors with the console errors', async () => {
    write('index.html', '<p>x</p>')
    fake.respond = () => ({ error: 'The page took longer than 30 seconds to render.', logs: [{ level: 'error', message: 'loop' }] })
    await expect(runTool(tools.screenshot, { path: 'index.html' })).rejects.toThrow(/30 seconds.*loop/)
  })

  it('evaluates user-view code in the noted page, falling back to the newest design page', async () => {
    write('index.html', '<p>x</p>')
    write('cards.dc.html', '<p>y</p>')
    utimesSync(join(t.root, 'index.html'), new Date(2020, 0, 1), new Date(2020, 0, 1))
    fake.respond = (request) => ({ scriptResult: { url: request.url, code: request.script } })

    const first = await runTool(tools.eval_js_user_view, { code: 'document.title' })
    expect(first).toMatchObject({ path: 'cards.dc.html', result: { code: 'document.title' } })

    noteUserView(t.projectId, 'index.html')
    const second = await runTool(tools.eval_js_user_view, { code: '1' })
    expect(second.path).toBe('index.html')

    fake.respond = () => ({ scriptError: 'ReferenceError: nope is not defined' })
    expect(await runTool(tools.eval_js, { code: 'nope' })).toMatchObject({ error: 'ReferenceError: nope is not defined' })
  })
})

describe('file-writing tools', () => {
  it('save_screenshot numbers several captures and records every write for undo', async () => {
    write('index.html', '<p>x</p>')
    fake.respond = (request) => ({
      screenshots: (request.steps ?? []).map(() => SHOT),
      previews: (request.steps ?? []).map(() => SHOT),
      sizes: (request.steps ?? []).map(() => ({ width: 1440, height: 900 }))
    })
    const result = await runTool(tools.save_screenshot, {
      path: 'index.html',
      save_path: 'shots/hero.jpg',
      steps: [{}, { code: 'go(1)' }, { code: 'go(2)', delay: 900 }]
    })
    expect(result.saved).toEqual(['shots/01-hero.jpg', 'shots/02-hero.jpg', 'shots/03-hero.jpg'])
    expect(fake.requests[0]).toMatchObject({ format: 'jpeg', scale: 1 })
    expect(fake.requests[0].steps).toEqual([{ delay: 50 }, { code: 'go(1)', delay: 200 }, { code: 'go(2)', delay: 900 }])
    expect(t.repos.changes.list(t.taskId).map((change) => change.kind)).toEqual(['create', 'create', 'create'])
    expect(result.images).toHaveLength(3)

    const memory = await runTool(tools.save_screenshot, { path: 'index.html', in_memory_png_key: 'deck', steps: [{}] })
    expect(memory.captures).toBe(1)
    expect(fake.requests[1]).toMatchObject({ format: 'png' })
    expect(getCaptures(t.projectId, 'deck')[0].equals(PNG_1PX)).toBe(true)

    await expect(runTool(tools.save_screenshot, { path: 'index.html', steps: [] })).rejects.toThrow(/exactly one/)
    await expect(runTool(tools.save_screenshot, { path: 'index.html', save_path: 'a.gif', steps: [] })).rejects.toThrow(/\.png or \.jpg/)
  })

  it('snapshot_element saves into exports and tells the user', async () => {
    write('index.html', '<p>x</p>')
    fake.respond = () => ({ screenshots: [SHOT], sizes: [{ width: 20, height: 10 }] })
    const result = await runTool(tools.snapshot_element, { selector: '.card', filename: 'my card' })
    expect(result).toMatchObject({ path: 'exports/my card.png', width: 20, height: 10, scale: 2 })
    expect(fake.requests[0]).toMatchObject({ selector: '.card', scale: 2 })
    expect(readFileSync(join(t.root, 'exports', 'my card.png')).equals(PNG_1PX)).toBe(true)
    expect(t.events.notes[0].title).toBe('Snapshot saved')
  })

  it('gen_pptx builds one slide per capture and flags duplicates, size mismatches and missing notes', async () => {
    write('deck.dc.html', '<deck-stage></deck-stage>')
    const other = makePng(1, 1, 2, [Buffer.from([0, 0, 255])]).toString('base64')
    fake.respond = () => ({
      screenshots: [SHOT, SHOT, other],
      sizes: [
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
        { width: 960, height: 540 }
      ],
      scriptResult: null
    })
    const result = await runTool(tools.gen_pptx, {
      width: 1920,
      height: 1080,
      slides: [{ selector: 'section:nth-child(1)' }, { selector: 'section:nth-child(2)', showJs: 'go(1)' }, { selector: 'x' }],
      hideSelectors: ['.nav'],
      save_to_project_path: 'export/deck.pptx'
    })
    expect(result.flags).toEqual({
      duplicate_adjacent: [2],
      slide_size_mismatch: [{ slide: 3, size: '960x540' }],
      no_speaker_notes: true,
      failed_slides: []
    })
    expect(fake.requests[0].steps?.[1]).toMatchObject({ selector: 'section:nth-child(2)', delay: 600 })
    expect(String((fake.requests[0].steps?.[1] as { code: string }).code)).toContain('go(1)')

    const zip = await JSZip.loadAsync(readFileSync(join(t.root, 'export', 'deck.pptx')))
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    expect(slides).toHaveLength(3)
    expect(t.repos.changes.list(t.taskId)).toHaveLength(1)
  })

  it('show_pdf_export_dialog refuses pages that are not print-ready unless allowed, and saves the PDF', async () => {
    write('poster.html', '<main>poster</main>')
    write('deck.html', '<x-import component-from-global-scope="deck-stage" from="./deck-stage.js"></x-import>')
    write('deck-print.html', '<deck-stage></deck-stage>')
    const doc = await PDFDocument.create()
    doc.addPage()
    doc.addPage()
    const pdf = Buffer.from(await doc.save()).toString('base64')
    fake.respond = () => ({ pdf })

    await expect(runTool(tools.show_pdf_export_dialog, { project_relative_file_path: 'poster.html' })).rejects.toThrow(/not print-ready/)
    await expect(runTool(tools.show_pdf_export_dialog, { project_relative_file_path: 'deck-print.html' })).rejects.toThrow(/omelette-print-source/)

    const deck = await runTool(tools.show_pdf_export_dialog, { project_relative_file_path: 'deck.html' })
    expect(deck).toMatchObject({ path: 'deck.pdf', pages: 2, print_based: true })
    expect(fake.requests[0].pdfOptions).toEqual({ preferCSSPageSize: true, noMargins: true })

    const poster = await runTool(tools.show_pdf_export_dialog, { project_relative_file_path: 'poster.html', allow_non_print_document: true })
    expect(poster.path).toBe('poster.pdf')
    expect(fake.requests[1].pdfOptions).toEqual({ fitToContent: true })
    expect(t.events.notes.map((note) => note.title)).toEqual(['PDF saved', 'PDF saved'])
  })

  it('present_fs_item_for_download zips a folder into downloads/ and points at files', async () => {
    write('assets/a.txt', 'a')
    write('assets/deep/b.txt', 'b')
    const zipped = await runTool(tools.present_fs_item_for_download, { path: 'assets' })
    expect(zipped).toMatchObject({ path: 'downloads/assets.zip', files: 2 })
    const zip = await JSZip.loadAsync(readFileSync(join(t.root, 'downloads', 'assets.zip')))
    expect(Object.keys(zip.files).filter((name) => !name.endsWith('/')).sort()).toEqual(['a.txt', 'deep/b.txt'])

    const whole = await runTool(tools.present_fs_item_for_download, {})
    expect(whole.path).toBe('downloads/Project.zip')
    const all = await JSZip.loadAsync(readFileSync(join(t.root, 'downloads', 'Project.zip')))
    expect(Object.keys(all.files).some((name) => name.startsWith('downloads'))).toBe(false)

    const file = await runTool(tools.present_fs_item_for_download, { path: 'assets/a.txt', label: 'Notes' })
    expect(file).toMatchObject({ path: 'assets/a.txt', size_bytes: 1 })
    expect(t.events.notes.at(-1)?.body).toContain('a.txt')
  })
})

describe('inlining', () => {
  it('inlines stylesheets, imports, fonts, images and scripts, and reports what it could not', async () => {
    write('css/base.css', 'body { background: url("../img/dot.png") }')
    write('css/site.css', '@import "base.css";\n@font-face { font-family: X; src: url(fonts/x.woff2) }')
    write('css/fonts/x.woff2', 'FONT')
    write('img/dot.png', PNG_1PX)
    write('app.js', 'window.ran = "</script>"')
    write('late.js', 'window.late = 1')
    write(
      'index.html',
      [
        '<html><head><link rel="stylesheet" href="css/site.css"><script src="late.js" defer></script></head>',
        '<body><img src="img/dot.png" srcset="img/dot.png 1x, img/dot.png 2x" alt="">',
        '<div style="background-image: url(\'img/dot.png\')"></div>',
        '<img src="img/missing.png"><a href="https://example.com">x</a>',
        '<iframe src="other.html"></iframe>',
        '<script>var inline = "<img src=\\"nope.png\\">"</script>',
        '<script src="app.js"></script></body></html>'
      ].join('\n')
    )
    write('other.html', '<p>other</p>')

    const result = await runTool(tools.super_inline_html, { input_path: 'index.html', output_path: 'dist-bundle/index.html' })
    const html = readFileSync(join(t.root, 'dist-bundle', 'index.html'), 'utf8')
    expect(result.missing).toEqual(['img/missing.png'])
    expect(result.skipped.some((note: string) => note.startsWith('other.html'))).toBe(true)
    expect(html).not.toContain('href="css/site.css"')
    expect(html).toContain('data:font/woff2;base64,')
    expect(html).toContain(`url("data:image/png;base64,${SHOT}")`)
    expect(html).toContain(`<img src="data:image/png;base64,${SHOT}" srcset="data:image/png;base64,${SHOT} 1x, data:image/png;base64,${SHOT} 2x"`)
    expect(html).toContain('window.ran = "<\\/script>"')
    expect(html).toContain('<a href="https://example.com">')
    expect(html).toContain('var inline = "<img src=\\"nope.png\\">"')
    // The deferred script moves to the end of the body so it still runs after the page is parsed.
    expect(html.indexOf('window.late = 1')).toBeGreaterThan(html.indexOf('window.ran'))
    expect(html).not.toContain(' defer')
    expect(t.repos.changes.list(t.taskId).map((change) => change.kind)).toEqual(['create'])

    const bundle = await runTool(tools.bundle_project, { input_path: 'index.html' })
    expect(bundle).toMatchObject({ url: null, bundled_path: 'index.bundle.html', expires_at: null })
    expect(bundle.note).toMatch(/no public/)
    expect(existsSync(join(t.root, 'index.bundle.html'))).toBe(true)

    const url = await runTool(tools.get_public_file_url, { project_relative_file_path: 'index.bundle.html' })
    expect(url).toMatchObject({ url: null, path: 'index.bundle.html' })
  })
})

describe('verification', () => {
  const probe = (overrides: Record<string, unknown> = {}) => ({
    viewportWidth: 1440,
    scrollWidth: 1440,
    scrollHeight: 2000,
    textLength: 300,
    blank: false,
    emptyRoot: false,
    overflow: false,
    wide: [],
    broken: [],
    ...overrides
  })

  it('opens the page for the user and reports console errors, missing files, overflow and broken images', async () => {
    write('index.html', '<link rel="stylesheet" href="gone.css"><p>x</p>')
    fake.respond = (request) => ({
      screenshots: [SHOT],
      previews: [SHOT],
      logs: [{ level: 'error', message: 'Uncaught TypeError: x is undefined (index.html:9)' }],
      scriptResult:
        request.width === 390
          ? probe({ viewportWidth: 390, scrollWidth: 520, overflow: true, wide: ['img.hero (right edge at 520px)'], broken: ['a.png'] })
          : probe({ broken: ['a.png'] })
    })
    const result = await runTool(tools.ready_for_verification, { path: 'index.html' })
    expect(shown).toEqual(['index.html'])
    expect(fake.requests.map((request) => request.width)).toEqual([1440, 834, 390])
    expect(fake.requests[0]).toMatchObject({ fullPage: true, screenshots: true, maxHeight: 1800 })
    expect(result.ok).toBe(false)
    expect(result.findings).toEqual([
      'Console error: Uncaught TypeError: x is undefined (index.html:9)',
      "Missing file: gone.css is referenced but doesn't exist.",
      'Horizontal overflow at 390px: the page is 520px wide. Sticking out: img.hero (right edge at 520px).',
      'Broken image: a.png'
    ])
    expect(result.images.map((image: { label: string }) => image.label)).toEqual(['Desktop 1440px', 'Tablet 834px', 'Phone 390px'])

    // The user-view tools now follow the file shown to the user.
    fake.respond = () => ({ scriptResult: 1 })
    expect((await runTool(tools.eval_js_user_view, { code: '1' })).path).toBe('index.html')
  })

  it('flags a blank page once, and the skip option checks only the desktop width without screenshots', async () => {
    write('index.html', '<div id="root"></div>')
    fake.respond = () => ({ scriptResult: probe({ textLength: 0, blank: true, emptyRoot: true }) })
    const result = await runTool(tools.ready_for_verification, { path: 'index.html', skip_verifier_agent: true })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0].screenshots).toBe(false)
    expect(result.findings).toEqual(["#root is empty: the page's app didn't render."])
  })

  it('passes a clean page and records verdicts', async () => {
    write('index.html', '<p>fine</p>')
    fake.respond = () => ({ scriptResult: probe(), screenshots: [SHOT], previews: [SHOT] })
    const result = await runTool(tools.ready_for_verification, { path: 'index.html' })
    expect(result).toMatchObject({ ok: true, findings: [] })

    await expect(runTool(tools.verification_feedback, { verdict: 'needs_work' })).rejects.toThrow(/Describe/)
    expect(await runTool(tools.verification_feedback, { verdict: 'needs_work', description: 'Nav overlaps hero' })).toMatchObject({
      recorded: true
    })
    expect(lastVerdict(t.taskId)).toEqual({ verdict: 'needs_work', description: 'Nav overlaps hero' })
  })
})

describe('images and waiting', () => {
  it('view_image sends small images as they are and has the host shrink large or vector ones', async () => {
    write('small.png', PNG_1PX)
    const small = await runTool(tools.view_image, { path: 'small.png' })
    expect(small.images[0]).toMatchObject({ mediaType: 'image/png', data: SHOT })
    expect(fake.requests).toHaveLength(0)

    write('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="3000" height="1500"></svg>')
    fake.respond = () => ({ screenshots: [SHOT], sizes: [{ width: 1000, height: 500 }] })
    const big = await runTool(tools.view_image, { path: 'logo.svg' })
    expect(fake.requests[0]).toMatchObject({ width: 3000, height: 1500, format: 'jpeg' })
    expect(fake.requests[0].scale).toBeCloseTo(1000 / 3000)
    expect(fake.requests[0].url).not.toContain('export=1')
    expect(big).toMatchObject({ format: 'svg', width: 3000, shown_at: '1000x500' })

    const meta = await runTool(tools.image_metadata, { path: 'small.png' })
    expect(meta).toMatchObject({ path: 'small.png', format: 'png', width: 1, height: 1, bytes: PNG_1PX.length })
  })

  it('sleep is capped and stops when the run is stopped', async () => {
    const controller = new AbortController()
    const sleeping = tools.sleep.execute!({ seconds: 500 }, { toolCallId: 'x', messages: [], abortSignal: controller.signal } as never)
    controller.abort()
    await expect(sleeping).rejects.toThrow(/Stopped/)
    expect(await runTool(tools.sleep, { seconds: 0.01 })).toEqual({ slept_seconds: 0.01 })
  })
})
