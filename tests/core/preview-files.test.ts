import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PREVIEW_CSP,
  contentTypeFor,
  injectEditor,
  isDesignComponentPath,
  previewResponseHeaders,
  resolvePreviewRequest,
  stripEditorIds
} from '../../src/main/preview-files'

const ID = randomUUID()
const DESIGN_URL = (rest: string): string => `deskmates-preview://design/${ID}/${rest}`

let temps: { root: string; cleanup(): void }[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'deskmates-preview-'))
  temps.push({ root, cleanup: () => rmSync(root, { recursive: true, force: true }) })
  return root
}

afterEach(() => {
  for (const temp of temps.splice(0)) temp.cleanup()
})

const EDITOR_PATH = 'C:\\fake\\editor.js'

describe('resolvePreviewRequest', () => {
  it('serves the editor script host', () => {
    const result = resolvePreviewRequest('deskmates-preview://editor/editor.js', 'C:\\data', EDITOR_PATH)
    expect(result).toEqual({ kind: 'file', path: EDITOR_PATH, contentType: 'text/javascript', isHtml: false })
    expect(resolvePreviewRequest('deskmates-preview://editor/other.js', 'C:\\data', EDITOR_PATH)).toEqual({
      kind: 'not-found'
    })
  })

  it('serves the Design Component runtime on the editor host only when its path is known', () => {
    const DC_PATH = 'C:/fake/dc-support.js'
    expect(resolvePreviewRequest('deskmates-preview://editor/dc-support.js', 'C:/data', EDITOR_PATH, DC_PATH)).toEqual({
      kind: 'file',
      path: DC_PATH,
      contentType: 'text/javascript',
      isHtml: false
    })
    expect(resolvePreviewRequest('deskmates-preview://editor/dc-support.js', 'C:/data', EDITOR_PATH)).toEqual({ kind: 'not-found' })
    expect(resolvePreviewRequest('deskmates-preview://editor/editor.js', 'C:/data', EDITOR_PATH, DC_PATH)).toMatchObject({
      path: EDITOR_PATH
    })
  })

  it('tells Design Component files apart, since the editor is never injected into them', () => {
    expect(isDesignComponentPath('C:/data/designs/x/Landing Page.dc.html')).toBe(true)
    expect(isDesignComponentPath('/a/b/CARD.DC.HTML')).toBe(true)
    expect(isDesignComponentPath('/a/index.html')).toBe(false)
    expect(isDesignComponentPath('/a/dc.html')).toBe(false)
  })

  it('serves files inside the design folder, including nested and bare paths', () => {
    const root = makeRoot()
    const designDir = join(root, 'designs', ID)
    mkdirSync(join(designDir, 'assets'), { recursive: true })
    writeFileSync(join(designDir, 'index.html'), '<p>hi</p>')
    writeFileSync(join(designDir, 'assets', 'styles.css'), 'body{}')

    const index = resolvePreviewRequest(DESIGN_URL('index.html'), root, EDITOR_PATH)
    expect(index.kind).toBe('file')
    if (index.kind === 'file') {
      expect(index.path).toBe(join(designDir, 'index.html'))
      expect(index.contentType).toBe('text/html')
      expect(index.isHtml).toBe(true)
    }

    // No path segment (root URL) and a trailing slash both fall back to index.html.
    for (const url of [`deskmates-preview://design/${ID}/`, `deskmates-preview://design/${ID}`]) {
      const bare = resolvePreviewRequest(url, root, EDITOR_PATH)
      expect(bare.kind).toBe('file')
      if (bare.kind === 'file') expect(bare.path).toBe(join(designDir, 'index.html'))
    }

    const nested = resolvePreviewRequest(DESIGN_URL('assets/styles.css'), root, EDITOR_PATH)
    expect(nested).toEqual({
      kind: 'file',
      path: join(designDir, 'assets', 'styles.css'),
      contentType: 'text/css',
      isHtml: false
    })
  })

  it('404s missing files, unknown projects and unknown hosts', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'designs', ID), { recursive: true })

    expect(resolvePreviewRequest(DESIGN_URL('nope.html'), root, EDITOR_PATH)).toEqual({ kind: 'not-found' })
    expect(resolvePreviewRequest(`deskmates-preview://design/${randomUUID()}/index.html`, root, EDITOR_PATH)).toEqual({
      kind: 'not-found'
    })
    expect(resolvePreviewRequest('deskmates-preview://other/index.html', root, EDITOR_PATH)).toEqual({
      kind: 'not-found'
    })
  })

  it('404s a request that resolves to an existing directory', () => {
    const root = makeRoot()
    const designDir = join(root, 'designs', ID)
    mkdirSync(join(designDir, 'assets'), { recursive: true })
    writeFileSync(join(designDir, 'index.html'), '<p>hi</p>')

    expect(resolvePreviewRequest(DESIGN_URL('assets'), root, EDITOR_PATH)).toEqual({ kind: 'not-found' })
  })

  it('404s traversal, backslashes, NUL, encoded escapes and non-UUID ids', () => {
    const root = makeRoot()
    mkdirSync(join(root, 'designs', ID), { recursive: true })

    for (const rest of [
      '../secrets.txt',
      '..%2Fsecrets.txt',
      'a\\b.html',
      'a%5Cb.html',
      'a%00b.html',
      'x'.repeat(600),
      'sub/../../index.html'
    ]) {
      expect(resolvePreviewRequest(DESIGN_URL(rest), root, EDITOR_PATH), rest).toEqual({ kind: 'not-found' })
    }
    expect(resolvePreviewRequest('deskmates-preview://design/not-a-uuid/index.html', root, EDITOR_PATH)).toEqual({
      kind: 'not-found'
    })
  })

  it('404s files over 50 MB', () => {
    const root = makeRoot()
    const designDir = join(root, 'designs', ID)
    mkdirSync(designDir, { recursive: true })
    writeFileSync(join(designDir, 'huge.bin'), Buffer.alloc(51 * 1024 * 1024))

    expect(resolvePreviewRequest(DESIGN_URL('huge.bin'), root, EDITOR_PATH)).toEqual({ kind: 'not-found' })
  })

  it('404s symlinks that leave the design folder', () => {
    const root = makeRoot()
    const designDir = join(root, 'designs', ID)
    mkdirSync(designDir, { recursive: true })
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'secret')
    try {
      symlinkSync(outside, join(designDir, 'link.txt'))
    } catch {
      // Symlink creation needs privileges on some Windows setups; skip this case.
      return
    }

    expect(resolvePreviewRequest(DESIGN_URL('link.txt'), root, EDITOR_PATH)).toEqual({ kind: 'not-found' })
  })
})

describe('injectEditor and stripEditorIds', () => {
  it('inserts the editor tag before the last closing body tag, or appends without one', () => {
    const html = '<html><body><p>one</p></body></html>'
    expect(injectEditor(html)).toBe(
      '<html><body><p>one</p><script type="module" src="deskmates-preview://editor/editor.js" data-dm-editor></script></body></html>'
    )
    expect(injectEditor('<html><p>x</p></html>')).toBe(
      '<html><p>x</p></html><script type="module" src="deskmates-preview://editor/editor.js" data-dm-editor></script>'
    )
  })

  it('strips every data-dm-id attribute', () => {
    expect(stripEditorIds('<p>keep</p><p data-dm-id="7">drop</p><img data-dm-id="9">')).toBe(
      '<p>keep</p><p>drop</p><img>'
    )
  })
})

describe('contentTypeFor and PREVIEW_CSP', () => {
  it('maps file extensions and falls back to octet-stream', () => {
    expect(contentTypeFor('index.html')).toBe('text/html')
    expect(contentTypeFor('page.htm')).toBe('text/html')
    expect(contentTypeFor('app.JS')).toBe('text/javascript')
    expect(contentTypeFor('pic.png')).toBe('image/png')
    expect(contentTypeFor('font.woff2')).toBe('font/woff2')
    expect(contentTypeFor('clip.webm')).toBe('video/webm')
    expect(contentTypeFor('file.unknown')).toBe('application/octet-stream')
  })

  it('ships a CSP for exported HTML', () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'")
    expect(PREVIEW_CSP).toContain("script-src 'unsafe-inline' 'unsafe-eval' deskmates-preview: https:")
    expect(PREVIEW_CSP).toContain("img-src deskmates-preview: data: blob: https:")
    expect(PREVIEW_CSP).toContain('connect-src deskmates-preview: https:')
    expect(PREVIEW_CSP).toContain("form-action 'none'")
    expect(PREVIEW_CSP).toContain("base-uri 'none'")
  })
})

describe('previewResponseHeaders', () => {
  it('gives every HTML response the CSP, and HTML, CSS and JS responses the three common headers', () => {
    const html = previewResponseHeaders('text/html', true)
    expect(html['Content-Type']).toBe('text/html')
    expect(html['Cache-Control']).toBe('no-store')
    expect(html['Access-Control-Allow-Origin']).toBe('*')
    expect(html['X-Content-Type-Options']).toBe('nosniff')
    expect(html['Content-Security-Policy']).toBe(PREVIEW_CSP)

    for (const contentType of ['text/css', 'text/javascript', 'application/json', 'image/png'] as const) {
      const headers = previewResponseHeaders(contentType, false)
      expect(headers['Content-Type']).toBe(contentType)
      expect(headers['Cache-Control']).toBe('no-store')
      expect(headers['Access-Control-Allow-Origin']).toBe('*')
      expect(headers['X-Content-Type-Options']).toBe('nosniff')
      expect(headers['Content-Security-Policy']).toBeUndefined()
    }
  })
})