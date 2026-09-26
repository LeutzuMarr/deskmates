import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildDcFile, designComponentTools, lintTemplate, readDcParts } from '../../src/core/tools/design-components'
import { makeTestContext, runTool, type TestContext } from './helpers'

let t: TestContext
let tools: ReturnType<typeof designComponentTools>
let shown: string[]

beforeEach(() => {
  t = makeTestContext()
  shown = []
  t.ctx.showInPreview = (path) => void shown.push(path)
  tools = designComponentTools(t.ctx)
})
afterEach(() => t.cleanup())

const read = (name: string): string => readFileSync(join(t.root, name), 'utf8')

const counter = {
  a_filename: 'Counter.dc.html',
  b_dc_html: '<helmet><style>body { margin: 0 }</style></helmet>\n<button onClick="{{ inc }}" style="padding: 8px">Count {{ n }}</button>',
  c_dc_js: 'class Component extends DCLogic {\n  state = { n: 0 }\n  renderVals() { return { n: this.state.n, inc: () => this.setState((s) => ({ n: s.n + 1 })) } }\n}',
  d_props_json: '{"$preview":{"width":320,"height":120},"label":{"editor":"text","default":"It\'s <b>"}}'
}

describe('dc_write', () => {
  it('assembles a full DC file that references the runtime and round-trips its parts', async () => {
    const result = await runTool(tools.dc_write, counter)
    expect(result).toMatchObject({ path: 'Counter.dc.html', created: true })
    const text = read('Counter.dc.html')
    expect(text).toMatch(/^<!DOCTYPE html>/)
    expect(text).toContain('<script src="deskmates-preview://editor/dc-support.js"></script>')
    expect(text).toContain('<title>Counter</title>')
    expect(text).toContain('<script type="text/x-dc-logic" data-dc-script data-props=')
    const parts = readDcParts(text)
    expect(parts.template).toBe(counter.b_dc_html)
    expect(parts.logic).toBe(counter.c_dc_js)
    expect(JSON.parse(parts.propsJson)).toEqual(JSON.parse(counter.d_props_json))
  })

  it('records every write so it can be undone', async () => {
    await runTool(tools.dc_write, counter)
    await runTool(tools.dc_write, { ...counter, b_dc_html: '<p>v2</p>' })
    expect(t.repos.changes.list(t.taskId).map((c) => c.kind)).toEqual(['create', 'modify'])
    expect(t.events.changes).toBe(2)
  })

  it('rejects bad file names, document scaffolding, stray scripts, bad logic and bad JSON', async () => {
    await expect(runTool(tools.dc_write, { ...counter, a_filename: 'Counter.html' })).rejects.toThrow(/\.dc\.html/)
    await expect(runTool(tools.dc_write, { ...counter, a_filename: '../escape.dc.html' })).rejects.toThrow(/outside/)
    await expect(runTool(tools.dc_write, { ...counter, b_dc_html: '<x-dc><p>x</p></x-dc>' })).rejects.toThrow(/between <x-dc>/)
    await expect(runTool(tools.dc_write, { ...counter, b_dc_html: '<html><body></body></html>' })).rejects.toThrow(/DOCTYPE/)
    await expect(runTool(tools.dc_write, { ...counter, b_dc_html: '<p>x</p><script>alert(1)</script>' })).rejects.toThrow(/helmet/)
    await expect(runTool(tools.dc_write, { ...counter, c_dc_js: 'const x = 1' })).rejects.toThrow(/class Component/)
    await expect(runTool(tools.dc_write, { ...counter, c_dc_js: '<script>class Component {}</script>' })).rejects.toThrow(/script/)
    await expect(runTool(tools.dc_write, { ...counter, d_props_json: '{nope' })).rejects.toThrow(/not valid/)
    expect(existsSync(join(t.root, 'Counter.dc.html'))).toBe(false)
  })

  it('allows scripts inside helmet and template-only components', async () => {
    const result = await runTool(tools.dc_write, {
      a_filename: 'pages/Static.dc.html',
      b_dc_html: '<helmet><script src="./bundle.js"></script></helmet><p>hi</p>',
      c_dc_js: ''
    })
    expect(result.path).toBe('pages/Static.dc.html')
    expect(readDcParts(read('pages/Static.dc.html')).logic).toBe('')
  })

  it('warns about expressions in holes, capitalized tags and missing hint-size', async () => {
    const result = await runTool(tools.dc_write, {
      ...counter,
      b_dc_html: '<p>{{ a + b }}</p><Card></Card><dc-import name="Card"></dc-import>'
    })
    expect(result.warnings.join('\n')).toMatch(/a \+ b/)
    expect(result.warnings.join('\n')).toMatch(/capitalized/)
    expect(result.warnings.join('\n')).toMatch(/hint-size/)
    expect(lintTemplate('<p>{{ user.name }} {{ $index }} {{ true }}</p>')).toEqual([])
  })
})

describe('dc_html_str_replace and dc_js_str_replace', () => {
  beforeEach(async () => {
    await runTool(tools.dc_write, counter)
  })

  it('edits only the template', async () => {
    const result = await runTool(tools.dc_html_str_replace, {
      a_filename: 'Counter.dc.html',
      c_find: 'Count {{ n }}',
      d_replace: 'Clicked {{ n }}',
      e_success_message: 'Renamed the button.'
    })
    expect(result).toMatchObject({ replacements: 1, message: 'Renamed the button.' })
    const parts = readDcParts(read('Counter.dc.html'))
    expect(parts.template).toContain('Clicked {{ n }}')
    expect(parts.logic).toBe(counter.c_dc_js)
  })

  it('does not find text that only exists in the logic, and appends on an empty find', async () => {
    await expect(
      runTool(tools.dc_html_str_replace, { a_filename: 'Counter.dc.html', c_find: 'renderVals', d_replace: 'x' })
    ).rejects.toThrow(/not found/)
    await runTool(tools.dc_html_str_replace, { a_filename: 'Counter.dc.html', c_find: '', d_replace: '\n<footer>end</footer>' })
    expect(readDcParts(read('Counter.dc.html')).template.endsWith('<footer>end</footer>')).toBe(true)
  })

  it('requires a unique match unless b_multi is set', async () => {
    await expect(
      runTool(tools.dc_js_str_replace, { a_filename: 'Counter.dc.html', c_find: 'n:', d_replace: 'count:' })
    ).rejects.toThrow(/appears/)
    const result = await runTool(tools.dc_js_str_replace, { a_filename: 'Counter.dc.html', c_find: 's.n + 1', d_replace: 's.n + 2', b_multi: true })
    expect(result.replacements).toBe(1)
    const parts = readDcParts(read('Counter.dc.html'))
    expect(parts.logic).toContain('s.n + 2')
    expect(parts.template).toBe(counter.b_dc_html)
  })

  it('refuses edits that would break the file or files that are not DCs', async () => {
    await expect(
      runTool(tools.dc_html_str_replace, { a_filename: 'Counter.dc.html', c_find: '<button', d_replace: '</x-dc><button' })
    ).rejects.toThrow(/x-dc/)
    writeFileSync(join(t.root, 'Plain.dc.html'), '<p>not a dc</p>')
    await expect(runTool(tools.dc_html_str_replace, { a_filename: 'Plain.dc.html', c_find: 'p', d_replace: 'q' })).rejects.toThrow(
      /no <x-dc>/
    )
    await expect(runTool(tools.dc_html_str_replace, { a_filename: 'Missing.dc.html', c_find: 'p', d_replace: 'q' })).rejects.toThrow(
      /does not exist/
    )
  })

  it('matches text in files saved with Windows line endings', async () => {
    writeFileSync(join(t.root, 'Crlf.dc.html'), buildDcFile({ title: 'Crlf', template: '<p>a</p>\n<p>b</p>', logic: '', propsJson: '' }).replace(/\n/g, '\r\n'))
    await runTool(tools.dc_html_str_replace, { a_filename: 'Crlf.dc.html', c_find: '<p>a</p>\n<p>b</p>', d_replace: '<p>c</p>' })
    expect(readDcParts(read('Crlf.dc.html')).template).toBe('<p>c</p>')
  })
})

describe('dc_set_props', () => {
  it('replaces and clears the data-props JSON', async () => {
    await runTool(tools.dc_write, counter)
    await runTool(tools.dc_set_props, { a_filename: 'Counter.dc.html', b_props_json: '{"accent":{"editor":"color","default":"#d97757"}}' })
    expect(JSON.parse(readDcParts(read('Counter.dc.html')).propsJson)).toEqual({ accent: { editor: 'color', default: '#d97757' } })
    await runTool(tools.dc_set_props, { a_filename: 'Counter.dc.html', b_props_json: '' })
    const text = read('Counter.dc.html')
    expect(text).not.toContain('data-props')
    expect(readDcParts(text).logic).toBe(counter.c_dc_js)
    await expect(runTool(tools.dc_set_props, { a_filename: 'Counter.dc.html', b_props_json: '[1]' })).rejects.toThrow(/object/)
  })
})

describe('copy_starter_component', () => {
  it('copies the deck stage with mounting instructions', async () => {
    const result = await runTool(tools.copy_starter_component, { kind: 'deck_stage.js' })
    expect(result).toMatchObject({ path: 'deck-stage.js', created: true })
    expect(result.usage).toContain('component-from-global-scope="deck-stage" from="./deck-stage.js"')
    expect(read('deck-stage.js')).toContain("customElements.define('deck-stage'")
  })

  it('copies frames as plain JavaScript web components into a subfolder', async () => {
    const result = await runTool(tools.copy_starter_component, { kind: 'ios_frame.jsx', directory: 'frames/' })
    expect(result.path).toBe('frames/ios-frame.js')
    expect(result.usage).toContain('from="./frames/ios-frame.js"')
    expect(read('frames/ios-frame.js')).toContain("customElements.define('ios-frame'")
    for (const kind of ['android_frame.jsx', 'macos_window.jsx', 'browser_window.jsx', 'image_slot.js', 'doc_page.js']) {
      const copied = await runTool(tools.copy_starter_component, { kind })
      expect(read(copied.path)).toContain('customElements.define(')
    }
  })

  it('explains the kinds that are not available', async () => {
    await expect(runTool(tools.copy_starter_component, { kind: 'tweaks_panel.jsx' })).rejects.toThrow(/props/)
    await expect(runTool(tools.copy_starter_component, { kind: 'three_d_stage.js' })).rejects.toThrow(/not available/)
    await expect(runTool(tools.copy_starter_component, { kind: 'deck_stage.js', directory: '../out' })).rejects.toThrow(/outside/)
  })
})

describe('show_to_user', () => {
  it('shows an existing file in the preview by its project-relative path', async () => {
    mkdirSync(join(t.root, 'pages'))
    writeFileSync(join(t.root, 'pages', 'Home.dc.html'), 'x')
    expect(await runTool(tools.show_to_user, { path: 'pages\\Home.dc.html' })).toEqual({ shown: true, path: 'pages/Home.dc.html' })
    expect(shown).toEqual(['pages/Home.dc.html'])
  })

  it('refuses missing files, folders and paths outside the design', async () => {
    mkdirSync(join(t.root, 'assets'))
    await expect(runTool(tools.show_to_user, { path: 'nope.html' })).rejects.toThrow(/not a file/)
    await expect(runTool(tools.show_to_user, { path: 'assets' })).rejects.toThrow(/not a file/)
    await expect(runTool(tools.show_to_user, { path: '../secret.txt' })).rejects.toThrow(/outside/)
    expect(shown).toEqual([])
  })
})
