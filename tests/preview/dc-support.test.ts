// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../src/preview/dc-support.js'

const DC = (globalThis as any).DCSupport
const BASE = 'http://design.test/'

let files: Record<string, string>
let warn: { mock: { calls: unknown[][] }; mockRestore(): void }
let error: { mockRestore(): void }

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function root(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

function render(template: string, logic = '', options: { propsJson?: string; props?: Record<string, unknown> } = {}) {
  const el = root()
  const host = DC.mount(el, { template, logic, propsJson: options.propsJson ?? null }, { url: `${BASE}Main.dc.html`, props: options.props })
  return { el, host }
}

function dcFile(template: string, logic = '', props = ''): string {
  const propsAttr = props ? ` data-props='${props}'` : ''
  return `<!DOCTYPE html>\n<html><head><script src="deskmates-preview://editor/dc-support.js"></script></head><body>\n<x-dc>\n${template}\n</x-dc>\n<script type="text/x-dc-logic" data-dc-script${propsAttr}>\n${logic}\n</script>\n</body></html>`
}

beforeEach(() => {
  DC.reset()
  files = {}
  DC.options.fetchText = async (url: string) => {
    if (url in files) return files[url]
    throw new Error('404 Not Found')
  }
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  error.mockRestore()
})

describe('holes', () => {
  it('resolves dotted paths, literals and props, and warns on what it cannot resolve', () => {
    const { el } = render(
      '<p>{{ user.name }} / {{ title }} / {{ 42 }} / {{ "hi" }} / [{{ missing }}] / [{{ a + b }}] / [{{ user.pet.name }}]</p>',
      'class Component extends DCLogic { renderVals() { return { user: { name: "Ada" } } } }',
      { props: { title: 'Home' } }
    )
    expect(el.querySelector('p')!.textContent).toBe('Ada / Home / 42 / hi / [] / [] / []')
    const warnings = warn.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(warnings.some((w: string) => w.includes('{{ missing }}'))).toBe(true)
    expect(warnings.some((w: string) => w.includes('{{ a + b }}'))).toBe(true)
    expect(warnings.some((w: string) => w.includes('user.pet'))).toBe(true)
  })

  it('renders elements, arrays and numbers, and nothing for booleans and null', () => {
    const { el } = render(
      '<div>{{ node }}{{ list }}{{ zero }}{{ no }}{{ nothing }}</div>',
      `class Component extends DCLogic {
        renderVals() {
          return { node: React.createElement('b', { className: 'x' }, 'bold'), list: ['a', 'b'], zero: 0, no: false, nothing: null }
        }
      }`
    )
    expect(el.querySelector('div')!.innerHTML).toBe('<b class="x">bold</b>ab0')
  })
})

describe('attributes', () => {
  it('binds literal, whole-value and interpolated attributes', () => {
    const { el } = render(
      '<a id="lit" href="{{ url }}" title="Go to {{ name }} now" class="{{ cls }}" for="x" data-count="{{ count }}" hidden="{{ off }}">x</a>' +
        '<input value="{{ text }}" disabled="{{ on }}">',
      `class Component extends DCLogic {
        renderVals() { return { url: '/next', name: 'Ada', cls: 'big red', count: 3, off: false, text: 'typed', on: true } }
      }`
    )
    const a = el.querySelector('a')!
    expect(a.getAttribute('id')).toBe('lit')
    expect(a.getAttribute('href')).toBe('/next')
    expect(a.getAttribute('title')).toBe('Go to Ada now')
    expect(a.getAttribute('class')).toBe('big red')
    expect(a.getAttribute('data-count')).toBe('3')
    expect(a.hasAttribute('hidden')).toBe(false)
    const input = el.querySelector('input')!
    expect(input.value).toBe('typed')
    expect(input.hasAttribute('disabled')).toBe(true)
  })

  it('passes objects and functions to elements as properties and applies style objects', () => {
    const { el } = render(
      '<div data-rows="{{ rows }}" style="{{ box }}"></div>',
      `class Component extends DCLogic { renderVals() { return { rows: [1, 2], box: { width: 120, opacity: 0.5, backgroundColor: 'red' } } } }`
    )
    const div = el.querySelector('div') as any
    expect(div.dataRows).toEqual([1, 2])
    expect(div.style.width).toBe('120px')
    expect(div.style.opacity).toBe('0.5')
    expect(div.style.backgroundColor).toBe('red')
  })

  it('turns style-hover and style-before into generated rules', () => {
    const { el } = render('<button style="color: black" style-hover="color: red; background: blue" style-before="color: green">b</button>')
    const button = el.querySelector('button')!
    expect(button.style.color).toBe('black')
    const id = button.getAttribute('data-dc-hover')
    expect(id).toBeTruthy()
    const css = document.querySelector('style[data-dc-pseudo]')!.textContent!
    expect(css).toContain(`[data-dc-hover="${id}"]:hover { color: red !important; background: blue !important }`)
    expect(css).toContain(`[data-dc-before="${button.getAttribute('data-dc-before')}"]::before { content: ""; color: green }`)
  })
})

describe('state and events', () => {
  const counter = `class Component extends DCLogic {
    state = { n: 0 }
    renderVals() { return { n: this.state.n, inc: () => this.setState((s) => ({ n: s.n + 1 })) } }
  }`

  it('re-renders on setState and keeps the same DOM nodes', async () => {
    const { el } = render('<div><button onClick="{{ inc }}">+</button><span>{{ n }}</span></div>', counter)
    const button = el.querySelector('button')!
    const span = el.querySelector('span')!
    button.click()
    button.click()
    await tick()
    expect(el.querySelector('span')!.textContent).toBe('2')
    expect(el.querySelector('span')).toBe(span)
    expect(el.querySelector('button')).toBe(button)
  })

  it('maps onChange on text inputs to input events', async () => {
    const { el } = render(
      '<input value="{{ text }}" onChange="{{ change }}"><p>{{ text }}</p>',
      `class Component extends DCLogic {
        state = { text: '' }
        renderVals() { return { text: this.state.text, change: (e) => this.setState({ text: e.target.value }) } }
      }`
    )
    const input = el.querySelector('input')!
    input.value = 'hello'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
    expect(el.querySelector('p')!.textContent).toBe('hello')
  })

  it('runs componentDidMount after mounting, with refs set, and setState callbacks after the update', async () => {
    const calls: string[] = []
    ;(globalThis as any).__calls = calls
    const { el } = render(
      '<div ref="{{ box }}">{{ label }}</div>',
      `class Component extends DCLogic {
        box = React.createRef()
        state = { label: 'first' }
        componentDidMount() {
          __calls.push('mount:' + this.box.current.textContent)
          this.setState({ label: 'second' }, () => __calls.push('callback:' + this.box.current.textContent))
        }
        componentDidUpdate(prevProps, prevState) { __calls.push('update:' + prevState.label) }
        renderVals() { return { box: this.box, label: this.state.label } }
      }`
    )
    await tick()
    expect(el.textContent).toBe('second')
    expect(calls).toEqual(['mount:first', 'update:first', 'callback:second'])
  })

  it('reads data-props defaults as the root props', () => {
    const { el } = render(
      '<h1>{{ heading }}</h1><p>{{ accent }}</p>',
      `class Component extends DCLogic { renderVals() { return { accent: this.props.accent ?? 'none' } } }`,
      { propsJson: '{"$preview":{"width":400},"heading":{"editor":"text","default":"Hello"},"accent":{"editor":"color","default":"#f00"}}' }
    )
    expect(el.querySelector('h1')!.textContent).toBe('Hello')
    expect(el.querySelector('p')!.textContent).toBe('#f00')
  })

  it('shows an error box when the logic class cannot load', () => {
    const { el } = render('<p>hi</p>', 'class Component extends DCLogic { renderVals() { return { ')
    expect(el.querySelector('[data-dc-error]')!.textContent).toContain('logic class')
  })

  it('shows the error but keeps rendering when renderVals throws', () => {
    const { el } = render('<p>static</p>', `class Component extends DCLogic { renderVals() { throw new Error('boom') } }`)
    expect(el.querySelector('[data-dc-error]')!.textContent).toContain('boom')
    expect(el.querySelector('p')!.textContent).toBe('static')
  })
})

describe('control flow', () => {
  it('repeats sc-for bodies with the item and $index in scope', () => {
    const { el } = render(
      '<ul><sc-for list="{{ items }}" as="it" hint-placeholder-count="2"><li>{{ $index }}:{{ it.name }}</li></sc-for></ul>',
      `class Component extends DCLogic { renderVals() { return { items: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } } }`
    )
    expect(Array.from(el.querySelectorAll('li')).map((li) => li.textContent)).toEqual(['0:a', '1:b', '2:c'])
  })

  it('renders hint-placeholder-count copies while the list is undefined, without warnings', () => {
    const { el } = render('<sc-for list="{{ items }}" as="it" hint-placeholder-count="3"><div class="card">{{ it.name }}</div></sc-for>', `
      class Component extends DCLogic { renderVals() { return { items: undefined } } }`)
    expect(el.querySelectorAll('.card')).toHaveLength(3)
    expect(warn).not.toHaveBeenCalled()
  })

  it('reuses keyed sc-for rows when the list is reordered', async () => {
    const { el, host } = render(
      '<sc-for list="{{ items }}" as="it"><p key="{{ it.id }}">{{ it.id }}</p></sc-for>',
      `class Component extends DCLogic {
        state = { items: [{ id: 'a' }, { id: 'b' }] }
        renderVals() { return { items: this.state.items } }
      }`
    )
    const [a, b] = Array.from(el.querySelectorAll('p'))
    host.instance.setState({ items: [{ id: 'b' }, { id: 'a' }] })
    await tick()
    const swapped = Array.from(el.querySelectorAll('p'))
    expect(swapped.map((p) => p.textContent)).toEqual(['b', 'a'])
    expect(swapped[0]).toBe(b)
    expect(swapped[1]).toBe(a)
  })

  it('shows sc-if bodies for truthy values and uses hint-placeholder-val while undefined', async () => {
    const { el, host } = render(
      '<sc-if value="{{ open }}" hint-placeholder-val="{{ true }}"><p>body</p></sc-if><span>after</span>',
      `class Component extends DCLogic {
        state = { open: undefined }
        renderVals() { return { open: this.state.open } }
      }`
    )
    const span = el.querySelector('span')
    expect(el.querySelector('p')).not.toBeNull()
    host.instance.setState({ open: false })
    await tick()
    expect(el.querySelector('p')).toBeNull()
    expect(el.querySelector('span')).toBe(span)
    host.instance.setState({ open: true })
    await tick()
    expect(el.querySelector('p')!.textContent).toBe('body')
  })
})

describe('helmet', () => {
  it('moves helmet content into the head instead of the body', () => {
    const { el } = render(
      '<helmet><style>@keyframes spin { to { transform: rotate(1turn) } }</style><link rel="preconnect" href="fonts.css"></helmet><p>x</p>'
    )
    expect(el.querySelector('style')).toBeNull()
    expect(el.querySelector('helmet')).toBeNull()
    expect(document.head.querySelector('style')!.textContent).toContain('@keyframes spin')
    expect(document.head.querySelector('link')!.getAttribute('href')).toBe(`${BASE}fonts.css`)
  })
})

describe('React.createElement output', () => {
  it('keeps elements from renderVals stable across re-renders', async () => {
    const { el, host } = render(
      '<div>{{ bar }}</div>',
      `class Component extends DCLogic {
        state = { pct: 10 }
        renderVals() { return { bar: React.createElement('div', { className: 'bar', style: { width: this.state.pct + '%', transition: 'width 1s' } }) } }
      }`
    )
    const bar = el.querySelector('.bar') as HTMLElement
    expect(bar.style.width).toBe('10%')
    host.instance.setState({ pct: 60 })
    await tick()
    expect(el.querySelector('.bar')).toBe(bar)
    expect(bar.style.width).toBe('60%')
  })

  it('renders function components with hooks', async () => {
    const { el } = render(
      '<section>{{ counter }}</section>',
      `function Counter(props) {
        const [n, setN] = React.useState(props.start)
        return React.createElement('button', { onClick: () => setN(n + 1) }, 'n=' + n)
      }
      class Component extends DCLogic { renderVals() { return { counter: React.createElement(Counter, { start: 5 }) } } }`
    )
    const button = el.querySelector('button')!
    expect(button.textContent).toBe('n=5')
    button.click()
    await tick()
    expect(el.querySelector('button')).toBe(button)
    expect(button.textContent).toBe('n=6')
  })

  it('creates SVG elements in the SVG namespace', () => {
    const { el } = render(
      '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="{{ r }}"></circle>{{ extra }}</svg>',
      `class Component extends DCLogic { renderVals() { return { r: 4, extra: React.createElement('rect', { width: 2, height: 2, strokeWidth: 1 }) } } }`
    )
    const svg = el.querySelector('svg')!
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 10')
    expect(el.querySelector('circle')!.getAttribute('r')).toBe('4')
    const rect = el.querySelector('rect')!
    expect(rect.namespaceURI).toBe('http://www.w3.org/2000/svg')
    expect(rect.getAttribute('stroke-width')).toBe('1')
  })
})

describe('dc-import', () => {
  it('mounts a sibling DC with kebab-to-camel props, a hint-size placeholder, and live prop updates', async () => {
    files[`${BASE}Card.dc.html`] = dcFile(
      '<div class="card"><h2>{{ itemTitle }}</h2><p>{{ note }}</p></div>',
      'class Component extends DCLogic { renderVals() { return { note: "by child" } } }'
    )
    const { el, host } = render(
      '<dc-import name="Card" item-title="{{ title }}" note="from parent" hint-size="100%,120px"></dc-import>',
      `class Component extends DCLogic { state = { title: 'One' }; renderVals() { return { title: this.state.title } } }`
    )
    const mountEl = el.querySelector('dc-import') as HTMLElement
    expect(mountEl.style.minHeight).toBe('120px')
    await DC.settle()
    expect(el.querySelector('.card h2')!.textContent).toBe('One')
    expect(el.querySelector('.card p')!.textContent).toBe('by child')
    expect(mountEl.style.display).toBe('contents')
    host.instance.setState({ title: 'Two' })
    await tick()
    expect(el.querySelector('.card h2')!.textContent).toBe('Two')
  })

  it('keeps camelCase attribute names as props and passes children', async () => {
    files[`${BASE}Box.dc.html`] = dcFile('<div class="box" data-count="{{ itemCount }}">{{ children }}</div>')
    const { el } = render('<dc-import name="Box" itemCount="{{ 3 }}" hint-size="10,10"><b>inner</b></dc-import>')
    await DC.settle()
    expect(el.querySelector('.box')!.getAttribute('data-count')).toBe('3')
    expect(el.querySelector('.box b')!.textContent).toBe('inner')
  })

  it('treats a self-closed dc-import as empty instead of swallowing siblings', async () => {
    files[`${BASE}Card.dc.html`] = dcFile('<i>card</i>')
    const { el } = render('<dc-import name="Card" hint-size="1,1" /><p>after</p>')
    await DC.settle()
    expect(el.querySelector('dc-import i')!.textContent).toBe('card')
    expect(el.querySelector('dc-import p')).toBeNull()
    expect(el.querySelector(':scope > p')!.textContent).toBe('after')
  })

  it('shows a readable error when the file is missing or imports itself', async () => {
    files[`${BASE}Loop.dc.html`] = dcFile('<dc-import name="Loop" hint-size="1,1"></dc-import>')
    const { el } = render('<dc-import name="Nope" hint-size="1,1"></dc-import><dc-import name="Loop" hint-size="1,1"></dc-import>')
    await DC.settle()
    const errors = Array.from(el.querySelectorAll('[data-dc-error]')).map((e) => e.textContent)
    expect(errors.some((t) => t!.includes('Nope.dc.html'))).toBe(true)
    expect(errors.some((t) => t!.includes('imports itself'))).toBe(true)
  })

  it('unmounts child DCs and calls componentWillUnmount', async () => {
    ;(globalThis as any).__unmounted = 0
    files[`${BASE}Child.dc.html`] = dcFile('<i>child</i>', 'class Component extends DCLogic { componentWillUnmount() { __unmounted++ } }')
    const { el, host } = render(
      '<sc-if value="{{ show }}"><dc-import name="Child" hint-size="1,1"></dc-import></sc-if>',
      'class Component extends DCLogic { state = { show: true }; renderVals() { return { show: this.state.show } } }'
    )
    await DC.settle()
    expect(el.querySelector('i')).not.toBeNull()
    host.instance.setState({ show: false })
    await tick()
    expect(el.querySelector('i')).toBeNull()
    expect((globalThis as any).__unmounted).toBe(1)
  })
})

describe('x-import', () => {
  it('mounts a web component from a global script with the template children inside it', async () => {
    files[`${BASE}fancy-box.js`] = `customElements.define('fancy-box', class extends HTMLElement {})`
    const { el } = render(
      '<x-import component-from-global-scope="fancy-box" from="./fancy-box.js" width="1920" hint-size="100%,100%"><section data-label="One">{{ title }}</section></x-import>',
      'class Component extends DCLogic { renderVals() { return { title: "Slide" } } }'
    )
    await DC.settle()
    const box = el.querySelector('fancy-box')!
    expect(box.getAttribute('width')).toBe('1920')
    expect(box.querySelector('section')!.textContent).toBe('Slide')
  })

  it('mounts a component exported with module.exports', async () => {
    files[`${BASE}Chart.js`] = `module.exports = { Chart: (props) => React.createElement('figure', { 'data-points': props.points.length }, props.label) }`
    const { el } = render(
      '<x-import component="Chart" from="./Chart.js" points="{{ rows }}" label="Sales" hint-size="100%,320px"></x-import>',
      'class Component extends DCLogic { renderVals() { return { rows: [1, 2, 3] } } }'
    )
    await DC.settle()
    const figure = el.querySelector('figure')!
    expect(figure.getAttribute('data-points')).toBe('3')
    expect(figure.textContent).toBe('Sales')
  })

  it('resolves dotted window globals', async () => {
    ;(globalThis as any).NS = { Button: (props: any) => (globalThis as any).React.createElement('button', null, props.children) }
    const { el } = render('<x-import component-from-global-scope="NS.Button" hint-size="10,10">Press</x-import>')
    await DC.settle()
    expect(el.querySelector('button')!.textContent).toBe('Press')
    delete (globalThis as any).NS
  })

  it('shows a placeholder message for .jsx files instead of loading them', async () => {
    const { el } = render('<x-import component="Frame" from="./ios-frame.jsx" hint-size="390,844"></x-import>')
    await DC.settle()
    expect(el.querySelector('[data-dc-error]')!.textContent).toContain("can't run")
    expect((el.querySelector('x-import') as HTMLElement).style.minHeight).toBe('844px')
  })
})

describe('source files and boot', () => {
  it('splits a DC file into its template, logic and props', () => {
    const source = DC.parseDcSource(dcFile('<p>{{ a }}</p>', 'class Component extends DCLogic {}', '{"x":{"default":1}}'))
    expect(source.template.trim()).toBe('<p>{{ a }}</p>')
    expect(source.logic.trim()).toBe('class Component extends DCLogic {}')
    expect(JSON.parse(source.propsJson)).toEqual({ x: { default: 1 } })
  })

  it('boots the page: moves the parsed helmet into the head and renders from the live template', async () => {
    document.body.innerHTML =
      '<x-dc><helmet><style>body { margin: 0 }</style></helmet><main><h1>{{ heading }}</h1></main></x-dc>' +
      `<script type="text/x-dc-logic" data-dc-script data-props='{"heading":{"default":"Live"}}'>class Component extends DCLogic {}</script>`
    await DC.boot(window)
    await DC.ready
    const xdc = document.querySelector('x-dc') as HTMLElement
    expect(xdc.hasAttribute('data-dc-mounted')).toBe(true)
    expect(xdc.style.display).toBe('contents')
    expect(xdc.querySelector('h1')!.textContent).toBe('Live')
    expect(xdc.querySelector('helmet')).toBeNull()
    expect(document.head.querySelector('style')!.textContent).toBe('body { margin: 0 }')
  })
})
