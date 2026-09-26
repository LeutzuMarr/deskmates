// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installEditor, type EditorHandle } from '../../src/preview/editor.js'

const EDITOR = 'deskmates-editor'
const APP = 'deskmates-app'

let handle: EditorHandle | undefined
let postSpy: ReturnType<typeof vi.spyOn>

function install(): void {
  handle = installEditor(window)
}

function messages(type: string): Record<string, any>[] {
  return (postSpy.mock.calls as any[][])
    .map((c: any[]) => c[0] as Record<string, any>)
    .filter((m: Record<string, any>) => m.type === type)
}

function lastMessage(type: string): Record<string, any> | undefined {
  const ms = messages(type)
  return ms[ms.length - 1]
}

function stubRect(el: Element, l: number, t: number, w: number, h: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h, x: l, y: t }) as DOMRect,
    configurable: true
  })
}

function pointerDown(target: EventTarget, init: PointerEventInit = {}): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, buttons: 1, ...init }))
}

function pointerMove(target: EventTarget, init: PointerEventInit = {}): void {
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, buttons: 1, ...init }))
}

function pointerUp(target: EventTarget, init: PointerEventInit = {}): void {
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, buttons: 0, ...init }))
}

function keyDown(target: EventTarget, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

function appMessage(data: Record<string, unknown>, source: unknown = window.parent): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: source as MessageEventSource | null }))
}

function selectViaClick(el: Element): void {
  pointerDown(el, { clientX: 10, clientY: 10 })
  pointerUp(window)
}

// I2: happy-dom would otherwise perform a real network fetch for the <link rel="stylesheet">
// that loadFont appends. Keep the whole suite offline instead of relying on the fetch losing a
// race with vitest tearing the window down.
type HappyDomSettings = { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean }
function happyDomSettings(): HappyDomSettings {
  return (window as unknown as { happyDOM: { settings: HappyDomSettings } }).happyDOM.settings
}

beforeEach(() => {
  document.documentElement.innerHTML = '<head></head><body></body>'
  postSpy = vi.spyOn(window.parent, 'postMessage')
  vi.useFakeTimers()
  happyDomSettings().disableCSSFileLoading = true
  happyDomSettings().handleDisabledFileLoadingAsSuccess = true
})

afterEach(() => {
  handle?.destroy()
  vi.runAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('element ids (rule 1)', () => {
  it('assigns eN ids, keeps existing, renumbers duplicates, skips script/style and svg children', () => {
    document.body.innerHTML = `
      <div data-dm-id="keep" id="a">a</div>
      <div data-dm-id="keep" id="b">b</div>
      <svg id="shape"><rect id="inner"></rect></svg>
      <b id="plain">no id</b>
      <script data-dm-editor="true">1</script>`
    install()
    const a = document.getElementById('a')!
    const b = document.getElementById('b')!
    const svg = document.getElementById('shape')!
    const plain = document.getElementById('plain')!
    expect(a.getAttribute('data-dm-id')).toBe('keep')
    expect(b.getAttribute('data-dm-id')).toBe('e1')
    expect(svg.getAttribute('data-dm-id')).toBe('e2')
    expect(plain.getAttribute('data-dm-id')).toBe('e3')
    expect(document.getElementById('inner')!.getAttribute('data-dm-id')).toBeNull()
    const script = document.querySelector('script')!
    expect(script.getAttribute('data-dm-id')).toBeNull()
  })
})

describe('svg selection (rule 1 / C1)', () => {
  it('selecting a shape inside an svg selects the outermost svg, not the shape', () => {
    document.body.innerHTML = '<svg id="icon"><rect id="shape" width="10" height="10"></rect></svg>'
    const svg = document.getElementById('icon')!
    const shape = document.getElementById('shape')!
    stubRect(svg, 10, 10, 40, 40)
    stubRect(shape, 15, 15, 10, 10)
    install()
    pointerDown(shape, { clientX: 20, clientY: 20 })
    pointerUp(window)
    const sel = lastMessage('select')
    expect(sel).toBeDefined()
    expect(typeof sel!.id).toBe('string')
    expect(sel!.id).not.toBe('')
    expect(sel!.id).toBe(svg.getAttribute('data-dm-id'))
    expect(shape.getAttribute('data-dm-id')).toBeNull()
  })
})

describe('ready (rule 13)', () => {
  it('posts { type: ready } once after install', () => {
    document.body.innerHTML = '<div>a</div>'
    install()
    expect(messages('ready')).toHaveLength(1)
    expect(lastMessage('ready')).toMatchObject({ source: EDITOR, type: 'ready' })
  })
})

describe('hover (rule 3)', () => {
  it('posts hover with id+label and null over body', () => {
    document.body.innerHTML = '<div id="card">Hi there</div>'
    const card = document.getElementById('card')!
    stubRect(card, 10, 10, 100, 50)
    install()
    pointerMove(window, { clientX: 40, clientY: 30, buttons: 0 })
    vi.runAllTimers()
    const hover = lastMessage('hover')
    expect(hover).toMatchObject({ source: EDITOR, type: 'hover', id: 'e1', label: 'div · Hi there' })
    expect(hover!.rect).toMatchObject({ x: 10, y: 10, width: 100, height: 50 })
    pointerMove(window, { clientX: 0, clientY: 0, buttons: 0 })
    vi.runAllTimers()
    expect(lastMessage('hover')).toMatchObject({ id: null })
  })
})

describe('select / deselect (rule 4)', () => {
  it('posts the full select payload with real style/html values, then deselect on body click', () => {
    document.body.innerHTML = '<h1 id="title" style="font-weight: bold; color: rgb(255, 0, 0)">Hello</h1>'
    const title = document.getElementById('title')!
    stubRect(title, 5, 5, 90, 30)
    install()
    selectViaClick(title)
    const sel = lastMessage('select')
    expect(sel).toMatchObject({
      source: EDITOR,
      type: 'select',
      id: 'e1',
      tag: 'h1',
      label: 'h1 · Hello',
      text: 'Hello',
      editableText: true
    })
    // I3: value-level checks instead of typeof — a bold, red h1 must extract real values.
    expect(sel!.style.fontWeight).toBe(700)
    expect(sel!.style.color).toBe('#ff0000')
    expect(sel!.rect).toMatchObject({ x: 5, y: 5, width: 90, height: 30 })
    expect(sel!.html).toContain('data-dm-id')

    // I3: html must stay clean even when selected while a text edit is in progress on it.
    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(title.getAttribute('contenteditable')).toBe('true')
    handle!.selectById('e1')
    const midEdit = lastMessage('select')!
    expect(midEdit.html).toContain('data-dm-id')
    expect(midEdit.html).not.toContain('data-dm-editing')
    expect(midEdit.html).not.toContain('contenteditable')

    pointerDown(document.body, { clientX: 0, clientY: 0 })
    expect(lastMessage('deselect')).toMatchObject({ source: EDITOR, type: 'deselect' })
  })
})

describe('page interaction blocking (rule 4)', () => {
  it('prevents a link click while editing, not after setEditing(false)', () => {
    document.body.innerHTML = '<a id="link" href="#x">go</a>'
    const link = document.getElementById('link')!
    install()
    const click = () => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.dispatchEvent(ev)
      return ev
    }
    const blocked = click()
    expect(blocked.defaultPrevented).toBe(true)
    appMessage({ source: APP, type: 'setEditing', editing: false })
    const allowed = click()
    expect(allowed.defaultPrevented).toBe(false)
  })
})

describe('move (rule 5)', () => {
  it('sets translate to 30px 20px, posts a move change, and serialize contains it', () => {
    document.body.innerHTML = '<div id="card">Move</div>'
    const card = document.getElementById('card')!
    stubRect(card, 10, 10, 100, 50)
    install()
    pointerDown(card, { clientX: 10, clientY: 10 })
    pointerMove(window, { clientX: 40, clientY: 30 })
    pointerUp(window)
    expect(card.style.translate).toBe('30px 20px')
    expect(card.getAttribute('style')).toContain('translate: 30px 20px')
    expect(lastMessage('change')).toMatchObject({ source: EDITOR, type: 'change', reason: 'move' })
    expect(String(lastMessage('change')!.html)).toContain('translate: 30px 20px')
    expect(String(lastMessage('change')!.html)).toContain('data-dm-id')
    expect(handle!.serialize()).toContain('translate: 30px 20px')
  })

  it('locks the move to the dominant axis when Shift is held', () => {
    document.body.innerHTML = '<div id="card">Move</div>'
    const card = document.getElementById('card')!
    stubRect(card, 10, 10, 100, 50)
    install()
    pointerDown(card, { clientX: 10, clientY: 10, shiftKey: true })
    pointerMove(window, { clientX: 40, clientY: 30, shiftKey: true })
    pointerUp(window)
    expect(card.style.translate).toBe('30px 0px')
  })
})

describe('resize (rule 5)', () => {
  it('east handle grows width; west handle grows width and shifts translate', () => {
    document.body.innerHTML = '<div id="box">R</div>'
    const box = document.getElementById('box')!
    stubRect(box, 10, 10, 100, 50)
    install()
    selectViaClick(box)
    const overlay = document.querySelector('dm-editor-overlay')!
    const root = overlay.shadowRoot as unknown as ShadowRoot
    const east = root.querySelector('.dm-handle[data-dir="e"]')!
    pointerDown(east, { clientX: 110, clientY: 25, composed: true })
    pointerMove(window, { clientX: 160, clientY: 25 })
    pointerUp(window)
    expect(box.style.width).toBe('150px')
    const west = root.querySelector('.dm-handle[data-dir="w"]')!
    pointerDown(west, { clientX: 10, clientY: 25, composed: true })
    pointerMove(window, { clientX: -40, clientY: 25 })
    pointerUp(window)
    expect(box.style.width).toBe('150px')
    expect(box.style.translate).toBe('-50px 0px')
    expect(lastMessage('change')!.reason).toBe('resize')
  })
})

describe('text editing (rule 6)', () => {
  it('starts on double-click and commits on Escape with a text change', () => {
    document.body.innerHTML = '<h1 id="head">Title</h1>'
    const head = document.getElementById('head')!
    stubRect(head, 5, 5, 100, 40)
    install()
    head.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(head.getAttribute('contenteditable')).toBe('true')
    expect(head.hasAttribute('data-dm-editing')).toBe(true)
    head.innerHTML = 'New Title'
    keyDown(head, { key: 'Escape' })
    expect(head.getAttribute('contenteditable')).toBeNull()
    expect(head.hasAttribute('data-dm-editing')).toBe(false)
    expect(head.innerHTML).toBe('New Title')
    expect(lastMessage('change')).toMatchObject({ source: EDITOR, type: 'change', reason: 'text' })
  })
})

describe('setStyle (rule 10)', () => {
  it('applies valid values, ignores invalid ones, and fires one debounced change', () => {
    document.body.innerHTML = '<h1 id="head">Title</h1>'
    const head = document.getElementById('head')!
    install()
    appMessage({ source: APP, type: 'setStyle', id: 'e1', style: { fontSize: 24, fontFamily: 'Arial', color: '#ff0000' } })
    expect(head.style.fontSize).toBe('24px')
    expect(head.style.fontFamily).toBe('Arial')
    expect(head.style.color).toBe('#ff0000')
    appMessage({ source: APP, type: 'setStyle', id: 'e1', style: { fontSize: 2e308, fontFamily: 'x;}', color: 'url(#x)' } as any })
    expect(head.style.fontSize).toBe('24px')
    expect(head.style.fontFamily).toBe('Arial')
    expect(head.style.color).toBe('#ff0000')
    vi.runAllTimers()
    expect(messages('change').filter((m) => m.reason === 'style')).toHaveLength(1)
  })
})

describe('delete / undo / redo (rule 9)', () => {
  it('deletes, then undo restores the same id, and redo removes it again', () => {
    document.body.innerHTML = '<div id="d1">Del</div><p id="p1">Keep</p>'
    const d1 = document.getElementById('d1')!
    install()
    selectViaClick(d1)
    expect(d1.getAttribute('data-dm-id')).toBe('e1')
    appMessage({ source: APP, type: 'command', name: 'delete' })
    expect(document.getElementById('d1')).toBeNull()
    expect(lastMessage('change')).toMatchObject({ source: EDITOR, type: 'change', reason: 'delete' })
    appMessage({ source: APP, type: 'command', name: 'undo' })
    expect(document.getElementById('d1')!.getAttribute('data-dm-id')).toBe('e1')
    expect(lastMessage('change')!.reason).toBe('undo')
    appMessage({ source: APP, type: 'command', name: 'redo' })
    expect(document.getElementById('d1')).toBeNull()
    expect(lastMessage('change')!.reason).toBe('redo')
  })
})

describe('duplicate (rule 9)', () => {
  it('creates a clone with a unique id and selects it', () => {
    document.body.innerHTML = '<div id="d1">A</div>'
    const d1 = document.getElementById('d1')!
    install()
    selectViaClick(d1)
    appMessage({ source: APP, type: 'command', name: 'duplicate' })
    const divs = Array.from(document.body.querySelectorAll('div'))
    expect(divs).toHaveLength(2)
    const ids = divs.map((d) => d.getAttribute('data-dm-id'))
    expect(ids[0]).toBe('e1')
    expect(ids[1]).toMatch(/^e\d+$/)
    expect(ids[0] !== ids[1]).toBe(true)
    expect(lastMessage('select')!.id).toBe(ids[1])
    expect(lastMessage('change')!.reason).toBe('duplicate')
  })
})

describe('keyboard nudge (rule 7)', () => {
  it('moves by 1, by 10 with Shift, and coalesces into one debounced change', () => {
    document.body.innerHTML = '<div id="d1">N</div>'
    const d1 = document.getElementById('d1')!
    install()
    selectViaClick(d1)
    keyDown(window, { key: 'ArrowRight' })
    expect(d1.style.translate).toBe('1px 0px')
    keyDown(window, { key: 'ArrowDown', shiftKey: true })
    expect(d1.style.translate).toBe('1px 10px')
    vi.runAllTimers()
    expect(messages('change').filter((m) => m.reason === 'move')).toHaveLength(1)
  })
})

describe('nudge undo coalescing (rule 7 / I1)', () => {
  it('gives a nudge its own undo entry, separate from a preceding drag', () => {
    document.body.innerHTML = '<div id="d1">N</div>'
    let d1 = document.getElementById('d1')!
    stubRect(d1, 10, 10, 100, 50)
    install()
    pointerDown(d1, { clientX: 10, clientY: 10 })
    pointerMove(window, { clientX: 40, clientY: 30 })
    pointerUp(window)
    d1 = document.getElementById('d1')!
    expect(d1.style.translate).toBe('30px 20px')
    keyDown(window, { key: 'ArrowRight' })
    d1 = document.getElementById('d1')!
    expect(d1.style.translate).toBe('31px 20px')
    appMessage({ source: APP, type: 'command', name: 'undo' })
    d1 = document.getElementById('d1')!
    expect(d1.style.translate).toBe('30px 20px')
    appMessage({ source: APP, type: 'command', name: 'undo' })
    d1 = document.getElementById('d1')!
    expect(d1.style.translate).toBe('')
  })
})

describe('message validation (rule 8)', () => {
  it('ignores foreign-source, malformed, and non-app messages', () => {
    document.body.innerHTML = '<h1 id="head">T</h1>'
    const head = document.getElementById('head')!
    install()
    appMessage({ source: 'evil', type: 'setStyle', id: 'e1', style: { fontSize: 99 } })
    appMessage({ source: APP, type: 'setStyle', id: 'e1', style: 'nope' })
    appMessage({ nope: true })
    appMessage({ source: APP, type: 'mystery' })
    appMessage({ source: APP, type: 'command', name: 'delete' })
    expect(head.style.fontSize).toBe('')
    expect(head.isConnected).toBe(true)
  })
})

describe('message source gate (rule 8 / I4)', () => {
  it('ignores a well-formed app message whose event.source is not window.parent', () => {
    document.body.innerHTML = '<h1 id="head">T</h1>'
    const head = document.getElementById('head')!
    install()
    appMessage({ source: APP, type: 'setStyle', id: 'e1', style: { fontSize: 42 } }, null)
    expect(head.style.fontSize).toBe('')
    const otherWindow = { name: 'not-parent' } as unknown as MessageEventSource
    appMessage({ source: APP, type: 'setStyle', id: 'e1', style: { fontSize: 42 } }, otherWindow)
    expect(head.style.fontSize).toBe('')
  })
})

describe('loadFont (rule 15)', () => {
  it('adds a single stylesheet link for a google fonts URL and ignores others', () => {
    document.body.innerHTML = '<div>x</div>'
    install()
    appMessage({ source: APP, type: 'loadFont', family: 'Inter', href: 'https://fonts.googleapis.com/css2?family=Inter' })
    appMessage({ source: APP, type: 'loadFont', family: 'Inter', href: 'https://fonts.googleapis.com/css2?family=Inter' })
    const links = Array.from(document.querySelectorAll('head link'))
    const fonts = links.filter((l) => l.getAttribute('href') === 'https://fonts.googleapis.com/css2?family=Inter')
    expect(fonts).toHaveLength(1)
    expect(fonts[0].getAttribute('rel')).toBe('stylesheet')
    expect(fonts[0].getAttribute('data-dm-font')).toBe('Inter')
    appMessage({ source: APP, type: 'loadFont', family: 'X', href: 'https://evil.example/font.css' })
    expect(Array.from(document.querySelectorAll('head link'))).toHaveLength(1)
  })
})

describe('serialize (rule 11)', () => {
  it('keeps doctype and data-dm-id while stripping the overlay and editing markers', () => {
    const dt = document.implementation.createDocumentType('html', '', '')
    document.insertBefore(dt, document.firstChild)
    document.body.innerHTML = '<div id="a" data-dm-id="e1">Keep</div><div id="b">B</div>'
    const b = document.getElementById('b')!
    install()
    b.setAttribute('data-dm-editing', '')
    b.setAttribute('contenteditable', 'true')
    const script = document.createElement('script')
    script.setAttribute('data-dm-editor', 'true')
    document.body.appendChild(script)
    const html = handle!.serialize()
    expect(html).toContain('<!DOCTYPE')
    expect(html).toContain('data-dm-id="e1"')
    expect(html).not.toContain('dm-editor-overlay')
    expect(html).not.toContain('data-dm-editor')
    expect(html).not.toContain('contenteditable')
    expect(html).not.toContain('data-dm-editing')
    expect(handle!.serialize()).toBe(html)
  })
})