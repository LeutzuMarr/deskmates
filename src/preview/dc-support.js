// @ts-check
/**
 * The Design Component ("DC") runtime.
 *
 * A `.dc.html` file loads this as a classic script in its <head>:
 *   <script src="deskmates-preview://editor/dc-support.js"></script>
 * After the page is parsed it renders the <x-dc> template with the logic class from
 * <script data-dc-script>, and re-renders whenever the logic calls setState. Child DCs
 * (<dc-import name="Card">) are fetched from sibling `Card.dc.html` files and external
 * components (<x-import>) from sibling `.js` files, so a DC only renders where this file is
 * served: inside Deskmates on the preview scheme; anywhere else, serve a copy of this file over
 * http(s) next to the design and point that script tag at it.
 *
 * `globalThis.DCSupport` exposes the runtime for tests and for exports, which wait on
 * `DCSupport.ready` before capturing the page.
 */
;(function () {
  'use strict'

  /** @type {any} */
  const G = globalThis
  if (G.DCSupport) return

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const VNODE = Symbol.for('deskmates.dc.element')
  const Fragment = Symbol.for('deskmates.dc.fragment')
  const DC_IMPORT = Symbol('dc-import')
  const X_IMPORT = Symbol('x-import')
  const PSEUDO = '__dcPseudo'
  const LOAD_TIMEOUT_MS = 10000
  const PATH_RE = /^[$A-Za-z_][\w$]*(?:\.[\w$]+)*$/
  const RAW_TEXT_TAGS = new Set(['style', 'script', 'textarea', 'title'])
  /** @type {Record<string, string>} */
  const PSEUDO_STATES = {
    hover: ':hover',
    active: ':active',
    focus: ':focus',
    'focus-visible': ':focus-visible',
    'focus-within': ':focus-within',
    disabled: ':disabled',
    checked: ':checked',
    before: '::before',
    after: '::after',
    placeholder: '::placeholder',
    selection: '::selection'
  }
  const UNITLESS = new Set([
    'animationIterationCount', 'aspectRatio', 'borderImageOutset', 'borderImageSlice', 'borderImageWidth',
    'columnCount', 'columns', 'flex', 'flexGrow', 'flexShrink', 'flexOrder', 'fontWeight', 'gridArea', 'gridRow',
    'gridRowEnd', 'gridRowStart', 'gridColumn', 'gridColumnEnd', 'gridColumnStart', 'lineClamp', 'lineHeight',
    'opacity', 'order', 'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom', 'fillOpacity', 'floodOpacity',
    'stopOpacity', 'strokeDasharray', 'strokeDashoffset', 'strokeMiterlimit', 'strokeOpacity', 'strokeWidth'
  ])
  const SVG_KEBAB_RE =
    /^(stroke|fill|font|text|stop|clip|flood|dominant|alignment|baseline|color|word|letter|pointer|shape|image|vector|paint|lighting|writing|glyph|unicode|overline|underline|strikethrough)[A-Z]/
  const ERROR_STYLE = {
    font: '12px/1.5 system-ui, sans-serif',
    color: '#b42318',
    background: '#fef3f2',
    border: '1px dashed #fda29b',
    borderRadius: 8,
    padding: '10px 12px',
    whiteSpace: 'pre-wrap',
    boxSizing: 'border-box'
  }

  const options = {
    /** How every DC, module and script file is read. Tests replace it. */
    fetchText: /** @param {string} url @returns {Promise<string>} */ async (url) => {
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim())
      return response.text()
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Small helpers

  /** @type {Set<string>} */
  const warned = new Set()
  /** @param {string} key @param {string} message */
  function warnOnce(key, message) {
    if (warned.has(key)) return
    warned.add(key)
    console.warn(`[dc] ${message}`)
  }

  /** @param {unknown} error */
  const messageOf = (error) => (error instanceof Error ? error.message : String(error))
  /** @param {string} url */
  const fileName = (url) => {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || url)
    } catch {
      return url
    }
  }
  /** @param {string} name */
  const camel = (name) => name.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
  /** @param {string} name */
  const kebab = (name) => name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()).replace(/^ms-/, '-ms-')
  /** @param {string} value */
  const cssLength = (value) => (/^-?\d+(\.\d+)?$/.test(value) ? `${value}px` : value)
  /** @param {() => void} fn */
  function tryCall(fn) {
    try {
      fn()
    } catch (error) {
      console.error('[dc]', error)
    }
  }
  /** @param {any} a @param {any} b */
  function shallowEqual(a, b) {
    if (a === b) return true
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]))
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduling: setState marks a unit (a DC or a component) dirty; one microtask re-renders them,
  // parents first, then runs the queued lifecycle calls and effects.

  /** @type {Set<any>} */
  const dirty = new Set()
  let flushQueued = false
  let flushId = 0
  /** @type {Array<() => void>} */
  let commitQueue = []

  /** @param {any} unit @param {Function} [callback] */
  function schedule(unit, callback) {
    if (!unit || unit.dead) return
    dirty.add(unit)
    if (callback) (unit.callbacks || (unit.callbacks = [])).push(callback)
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flush)
    }
  }

  function flush() {
    flushQueued = false
    flushId++
    const units = [...dirty].sort((a, b) => a.depth - b.depth)
    dirty.clear()
    for (const unit of units) {
      if (unit.dead || unit.renderedIn === flushId) continue
      try {
        unit.update()
      } catch (error) {
        console.error('[dc] re-render failed', error)
      }
    }
    runCommit()
    for (const unit of units) {
      const callbacks = unit.callbacks
      unit.callbacks = null
      if (callbacks) for (const callback of callbacks) tryCall(() => callback.call(unit.instance))
    }
  }

  /** @param {() => void} fn */
  function afterCommit(fn) {
    commitQueue.push(fn)
  }

  function runCommit() {
    while (commitQueue.length) {
      const queue = commitQueue
      commitQueue = []
      for (const fn of queue) tryCall(fn)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // A minimal React: createElement builds descriptors that the reconciler below turns into DOM.

  /** @param {any} type @param {any} [config] @param {...any} children */
  function createElement(type, config, ...children) {
    /** @type {Record<string, any>} */
    const props = {}
    let key = null
    if (config != null) {
      for (const name in config) {
        if (name === 'key') key = config.key == null ? null : String(config.key)
        else if (name !== '__self' && name !== '__source') props[name] = config[name]
      }
    }
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    if (type && type.defaultProps) {
      for (const name in type.defaultProps) if (props[name] === undefined) props[name] = type.defaultProps[name]
    }
    return { $$typeof: VNODE, type, key, props }
  }

  /** @param {any} element @param {any} [config] @param {...any} children */
  function cloneElement(element, config, ...children) {
    const props = { ...element.props }
    let key = element.key
    if (config != null) {
      for (const name in config) {
        if (name === 'key') key = config.key == null ? null : String(config.key)
        else props[name] = config[name]
      }
    }
    if (children.length === 1) props.children = children[0]
    else if (children.length > 1) props.children = children
    return { $$typeof: VNODE, type: element.type, key, props }
  }

  /** @param {any} value */
  const isValidElement = (value) => !!value && value.$$typeof === VNODE

  /** @param {any} children @returns {any[]} */
  function toArray(children) {
    /** @type {any[]} */
    const out = []
    /** @param {any} child */
    const walk = (child) => {
      if (Array.isArray(child)) child.forEach(walk)
      else if (child != null && typeof child !== 'boolean') out.push(child)
    }
    walk(children)
    return out
  }

  const Children = {
    toArray,
    /** @param {any} children @param {(child: any, index: number) => any} fn */
    map: (children, fn) => toArray(children).map(fn),
    /** @param {any} children @param {(child: any, index: number) => void} fn */
    forEach: (children, fn) => toArray(children).forEach(fn),
    /** @param {any} children */
    count: (children) => toArray(children).length,
    /** @param {any} children */
    only: (children) => {
      const list = toArray(children)
      if (list.length !== 1) throw new Error('React.Children.only expected exactly one child.')
      return list[0]
    }
  }

  class Component {
    /** @param {any} [props] */
    constructor(props) {
      /** @type {any} */
      this.props = props || {}
      /** @type {any} */
      this.state = {}
      /** @type {any} */
      this.__unit = null
    }

    /** @param {any} update @param {Function} [callback] */
    setState(update, callback) {
      const patch = typeof update === 'function' ? update(this.state, this.props) : update
      if (patch == null) return
      this.state = Object.assign({}, this.state, patch)
      if (this.__unit) schedule(this.__unit, callback)
    }

    /** @param {Function} [callback] */
    forceUpdate(callback) {
      if (this.__unit) schedule(this.__unit, callback)
    }
  }
  /** @type {any} */ (Component.prototype).isReactComponent = {}

  /** The base class of every DC's logic: a React class component whose renderVals() feeds the template. */
  class DCLogic extends Component {
    /** @returns {Record<string, any>} */
    renderVals() {
      return {}
    }
  }

  // Hooks, for function components mounted through <x-import> or React.createElement.

  /** @type {any} */
  let currentComp = null

  function hookSlot() {
    const comp = currentComp
    if (!comp) throw new Error('Hooks can only be called inside a function component.')
    return { comp, index: comp.hookIndex++ }
  }

  /** @param {any} a @param {any} b */
  const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((/** @type {any} */ v, /** @type {number} */ i) => !Object.is(v, b[i]))

  /** @param {(state: any, action: any) => any} reducer @param {any} initialArg @param {(arg: any) => any} [init] */
  function useReducer(reducer, initialArg, init) {
    const { comp, index } = hookSlot()
    if (!comp.hooks[index]) {
      /** @type {any} */
      const hook = { value: init ? init(initialArg) : initialArg, reducer }
      hook.dispatch = (/** @type {any} */ action) => {
        const next = hook.reducer(hook.value, action)
        if (Object.is(next, hook.value)) return
        hook.value = next
        schedule(comp)
      }
      comp.hooks[index] = hook
    }
    const hook = comp.hooks[index]
    hook.reducer = reducer
    return [hook.value, hook.dispatch]
  }

  /** @param {any} initial */
  const useState = (initial) =>
    useReducer(
      (state, action) => (typeof action === 'function' ? action(state) : action),
      initial,
      (value) => (typeof value === 'function' ? value() : value)
    )

  /** @param {any} initial */
  function useRef(initial) {
    const { comp, index } = hookSlot()
    if (!comp.hooks[index]) comp.hooks[index] = { current: initial }
    return comp.hooks[index]
  }

  /** @param {() => any} factory @param {any[]} [deps] */
  function useMemo(factory, deps) {
    const { comp, index } = hookSlot()
    const hook = comp.hooks[index]
    if (!hook || depsChanged(hook.deps, deps)) comp.hooks[index] = { value: factory(), deps }
    return comp.hooks[index].value
  }

  /** @param {Function} fn @param {any[]} [deps] */
  const useCallback = (fn, deps) => useMemo(() => fn, deps)

  /** @param {() => any} effect @param {any[]} [deps] */
  function useEffect(effect, deps) {
    const { comp, index } = hookSlot()
    const hook = comp.hooks[index] || (comp.hooks[index] = { deps: undefined, cleanup: null, ran: false })
    if (hook.ran && !depsChanged(hook.deps, deps)) return
    hook.deps = deps
    hook.ran = true
    afterCommit(() => {
      if (comp.dead) return
      if (typeof hook.cleanup === 'function') hook.cleanup()
      const cleanup = effect()
      hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    })
  }

  /** @param {any} context */
  const useContext = (context) => context._value

  let idCounter = 0
  const useId = () => useMemo(() => `:dc${++idCounter}:`, [])

  /** Context without provider scoping: the last rendered Provider's value wins. */
  /** @param {any} defaultValue */
  function createContext(defaultValue) {
    /** @type {any} */
    const context = { _value: defaultValue }
    context.Provider = (/** @type {any} */ props) => {
      context._value = props.value
      return props.children
    }
    context.Consumer = (/** @type {any} */ props) => props.children(context._value)
    return context
  }

  const React = {
    createElement,
    cloneElement,
    isValidElement,
    Fragment,
    Children,
    Component,
    PureComponent: Component,
    createRef: () => ({ current: null }),
    /** @param {(props: any, ref: any) => any} render */
    forwardRef: (render) => (/** @type {any} */ props) => render(props, props.ref),
    /** @param {any} component */
    memo: (component) => component,
    createContext,
    useState,
    useReducer,
    useRef,
    useMemo,
    useCallback,
    useEffect,
    useLayoutEffect: useEffect,
    useContext,
    useId,
    version: '0.0.0-deskmates-dc'
  }

  // ---------------------------------------------------------------------------------------------
  // Templates. The source between <x-dc> and </x-dc> is parsed with an inert <template> element
  // after <sc-for>/<sc-if> become <template> blocks (so they survive inside tables and selects),
  // then compiled once into plain objects that every render evaluates.

  /**
   * @typedef {{ src: string, lit?: any, path?: string[], bad?: boolean }} Expr
   * @typedef {{ name: string, kind: 's', value: string } | { name: string, kind: 'w', expr: Expr } | { name: string, kind: 'i', parts: Array<string | Expr> }} AttrSpec
   */

  /** @param {string} source @returns {string | null} */
  function extractTemplate(source) {
    const open = /<x-dc\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(source)
    if (!open) return null
    const start = open.index + open[0].length
    const end = source.toLowerCase().lastIndexOf('</x-dc>')
    if (end < start) return null
    return source.slice(start, end)
  }

  /** The HTML parser lowercases attribute names, so camelCase prop names on imports become kebab-case first. */
  /** @param {string} attrs */
  function kebabAttributeNames(attrs) {
    return attrs.replace(
      /([^\s"'>/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g,
      (_, /** @type {string} */ name, /** @type {string | undefined} */ value = '') =>
        (/[A-Z]/.test(name) && !/^(data|aria)-/i.test(name) ? kebab(name) : name) + value
    )
  }

  /** @param {string} source */
  function prepareTemplateSource(source) {
    return source
      .replace(/<(dc-import|x-import)\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/>/gi, '<$1$2></$1>')
      .replace(
        /<(dc-import|x-import)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi,
        (_, /** @type {string} */ tag, /** @type {string} */ attrs) => `<${tag}${kebabAttributeNames(attrs)}>`
      )
      .replace(/<sc-(for|if)\b/gi, (_, /** @type {string} */ kind) => `<template data-dc-block="${kind.toLowerCase()}"`)
      .replace(/<\/sc-(for|if)\s*>/gi, '</template>')
  }

  /** @param {Document} doc @param {string} source */
  function parseTemplate(doc, source) {
    const template = doc.createElement('template')
    template.innerHTML = prepareTemplateSource(source)
    return template.content
  }

  /** @param {string} raw @returns {Expr} */
  function parseExpr(raw) {
    const src = raw.trim()
    if (src === 'true') return { src, lit: true }
    if (src === 'false') return { src, lit: false }
    if (src === 'null') return { src, lit: null }
    if (src === 'undefined') return { src, lit: undefined }
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(src)) return { src, lit: Number(src) }
    const quoted = /^(["'])([\s\S]*)\1$/.exec(src)
    if (quoted) return { src, lit: quoted[2] }
    if (PATH_RE.test(src)) return { src, path: src.split('.') }
    return { src, bad: true }
  }

  /** @param {string} text @returns {Array<string | Expr> | null} */
  function parseInterp(text) {
    if (!text.includes('{{')) return null
    /** @type {Array<string | Expr>} */
    const parts = []
    const re = /\{\{([\s\S]*?)\}\}/g
    let last = 0
    let match
    while ((match = re.exec(text))) {
      if (match.index > last) parts.push(text.slice(last, match.index))
      parts.push(parseExpr(match[1]))
      last = match.index + match[0].length
    }
    if (last === 0) return null
    if (last < text.length) parts.push(text.slice(last))
    return parts
  }

  /** @param {string} name @param {string} value @returns {AttrSpec} */
  function attrSpec(name, value) {
    const parts = parseInterp(value)
    if (!parts) return { name, kind: 's', value }
    const meaningful = parts.filter((part) => typeof part !== 'string' || part.trim() !== '')
    const only = meaningful[0]
    if (meaningful.length === 1 && typeof only !== 'string') return { name, kind: 'w', expr: only }
    return { name, kind: 'i', parts }
  }

  /** @param {any} def @param {ArrayLike<Node>} nodes @returns {any[]} */
  function compileNodes(def, nodes) {
    const out = []
    for (const node of Array.from(nodes)) {
      const compiled = compileNode(def, node)
      if (compiled) out.push(compiled)
    }
    return out
  }

  /** @param {any} def @param {any} node */
  function compileNode(def, node) {
    if (node.nodeType === 3) {
      const parts = parseInterp(node.data)
      return parts ? { k: 'text', parts } : { k: 'text', value: node.data }
    }
    if (node.nodeType !== 1) return null
    const tag = node.localName
    if (tag === 'template' && node.hasAttribute('data-dc-block')) {
      return node.getAttribute('data-dc-block') === 'for' ? compileFor(def, node) : compileIf(def, node)
    }
    if (tag === 'helmet') {
      for (const child of Array.from(/** @type {NodeList} */ (node.childNodes))) {
        if (child.nodeType === 1) def.helmet.push(child)
      }
      return null
    }
    if (tag === 'dc-import' || tag === 'x-import') return compileImport(def, node, tag === 'dc-import' ? 'dc' : 'x')
    return compileElement(def, node)
  }

  /** @param {any} def @param {any} el */
  function compileElement(def, el) {
    /** @type {AttrSpec[]} */
    const attrs = []
    /** @type {Array<{ state: string, spec: AttrSpec }>} */
    const pseudo = []
    /** @type {AttrSpec | null} */
    let key = null
    for (const attr of Array.from(/** @type {NamedNodeMap} */ (el.attributes))) {
      let name = attr.name
      if (name.startsWith('hint-')) continue
      if (name === 'classname') name = 'class'
      else if (name === 'htmlfor') name = 'for'
      if (name.startsWith('style-') && name.slice(6) in PSEUDO_STATES) {
        pseudo.push({ state: name.slice(6), spec: attrSpec(name, attr.value) })
        continue
      }
      const spec = attrSpec(name, attr.value)
      if (name === 'key') key = spec
      else attrs.push(spec)
    }
    let children
    if (RAW_TEXT_TAGS.has(el.localName)) {
      const text = el.textContent || ''
      const parts = parseInterp(text)
      children = text ? [parts ? { k: 'text', parts } : { k: 'text', value: text }] : []
    } else {
      children = compileNodes(def, el.childNodes)
    }
    return {
      k: 'el',
      tag: el.localName,
      ns: el.namespaceURI === SVG_NS ? SVG_NS : null,
      attrs,
      pseudo: pseudo.length ? pseudo : null,
      key,
      children
    }
  }

  /** @param {any} def @param {any} el */
  function compileFor(def, el) {
    return {
      k: 'for',
      list: attrSpec('list', el.getAttribute('list') || ''),
      as: (el.getAttribute('as') || 'item').trim(),
      hint: Math.max(0, Math.min(100, parseInt(el.getAttribute('hint-placeholder-count') || '0', 10) || 0)),
      body: compileNodes(def, el.content.childNodes)
    }
  }

  /** @param {any} def @param {any} el */
  function compileIf(def, el) {
    const hint = el.getAttribute('hint-placeholder-val')
    return {
      k: 'if',
      value: attrSpec('value', el.getAttribute('value') || ''),
      hint: hint == null ? null : attrSpec('hint-placeholder-val', hint),
      body: compileNodes(def, el.content.childNodes)
    }
  }

  /** @param {any} def @param {any} el @param {'dc' | 'x'} kind */
  function compileImport(def, el, kind) {
    /** @type {any} */
    const spec = {
      k: kind,
      attrs: [],
      style: null,
      hintSize: null,
      key: null,
      spread: null,
      name: null,
      component: null,
      global: null,
      from: null
    }
    for (const attr of Array.from(/** @type {NamedNodeMap} */ (el.attributes))) {
      const name = attr.name
      if (name === 'hint-size') spec.hintSize = attr.value
      else if (name.startsWith('hint-')) continue
      else if (name === 'key') spec.key = attrSpec(name, attr.value)
      else if (name === 'style') spec.style = attrSpec(name, attr.value)
      else if (name === 'dc-props') spec.spread = attrSpec(name, attr.value)
      else if (kind === 'dc' && name === 'name') spec.name = attrSpec(name, attr.value)
      else if (kind === 'x' && name === 'component') spec.component = attrSpec(name, attr.value)
      else if (kind === 'x' && name === 'component-from-global-scope') spec.global = attrSpec(name, attr.value)
      else if (kind === 'x' && name === 'from') {
        spec.from = attr.value.trim()
        if (spec.from.includes('{{')) {
          warnOnce(`${def.url}|from`, `<x-import from="${spec.from}"> in ${fileName(def.url)} must be a literal URL.`)
          spec.from = null
        }
      } else spec.attrs.push(attrSpec(name, attr.value))
    }
    spec.body = compileNodes(def, el.childNodes)
    return spec
  }

  // ---------------------------------------------------------------------------------------------
  // Evaluation: a compiled template plus a scope becomes a list of element descriptors.

  /** @param {any} scope @param {string} name */
  function caseInsensitiveKey(scope, name) {
    const lower = name.toLowerCase()
    for (const key in scope) if (key.toLowerCase() === lower) return key
    return undefined
  }

  /** @param {Expr} expr @param {any} scope @param {any} env */
  function resolve(expr, scope, env) {
    if ('lit' in expr) return expr.lit
    const where = fileName(env.url)
    if (expr.bad || !expr.path) {
      warnOnce(
        `${env.url}|${expr.src}`,
        `{{ ${expr.src} }} in ${where} isn't a name or dotted path, so it renders nothing. Compute it in renderVals() and expose the result by name.`
      )
      return undefined
    }
    const path = expr.path
    let head = path[0]
    if (!(head in scope)) {
      const match = caseInsensitiveKey(scope, head)
      if (match === undefined) {
        if (!scope.$placeholder) {
          warnOnce(`${env.url}|${expr.src}`, `{{ ${expr.src} }} in ${where} didn't resolve: nothing named "${head}" is in props or renderVals().`)
        }
        return undefined
      }
      head = match
    }
    let value = scope[head]
    for (let i = 1; i < path.length; i++) {
      if (value == null) {
        if (!scope.$placeholder) {
          warnOnce(`${env.url}|${expr.src}`, `{{ ${expr.src} }} in ${where} didn't resolve: ${path.slice(0, i).join('.')} is ${value}.`)
        }
        return undefined
      }
      value = value[path[i]]
    }
    return value
  }

  /** @param {any} value */
  const toText = (value) =>
    value == null || typeof value === 'boolean' ? '' : Array.isArray(value) ? value.join(' ') : typeof value === 'object' ? '' : String(value)

  /** @param {AttrSpec} spec @param {any} scope @param {any} env */
  function evalSpec(spec, scope, env) {
    if (spec.kind === 's') return spec.value
    if (spec.kind === 'w') return resolve(spec.expr, scope, env)
    let out = ''
    for (const part of spec.parts) out += typeof part === 'string' ? part : toText(resolve(part, scope, env))
    return out
  }

  /** @param {any} value @param {any} env */
  function childValue(value, env) {
    if (value == null || typeof value !== 'object' || Array.isArray(value) || value.$$typeof === VNODE || value.nodeType) {
      if (typeof value === 'function') {
        warnOnce(`${env.url}|fn-child`, `A function can't be rendered as text in ${fileName(env.url)}.`)
        return null
      }
      return value
    }
    warnOnce(`${env.url}|obj-child`, `An object can't be rendered as text in ${fileName(env.url)}; expose a string, number, element or array.`)
    return null
  }

  /** @param {any[]} nodes @param {any} scope @param {any} env @param {any[]} [out] */
  function evalNodes(nodes, scope, env, out = []) {
    for (const node of nodes) evalNode(node, scope, env, out)
    return out
  }

  /** @param {any} node @param {any} scope @param {any} env @param {any[]} out */
  function evalNode(node, scope, env, out) {
    switch (node.k) {
      case 'text':
        if ('value' in node) out.push(node.value)
        else for (const part of node.parts) out.push(typeof part === 'string' ? part : childValue(resolve(part, scope, env), env))
        return
      case 'el':
        out.push(evalElement(node, scope, env))
        return
      case 'for':
        out.push(evalFor(node, scope, env))
        return
      case 'if':
        out.push(evalIf(node, scope, env))
        return
      case 'dc':
      case 'x':
        out.push(evalImport(node, scope, env))
        return
    }
  }

  /** @param {any} value */
  const keyString = (value) => (value == null || value === '' ? null : String(value))

  /** @param {any} node @param {any} scope @param {any} env */
  function evalElement(node, scope, env) {
    /** @type {Record<string, any>} */
    const props = {}
    for (const spec of node.attrs) props[spec.name] = evalSpec(spec, scope, env)
    if (node.pseudo) {
      /** @type {Record<string, string>} */
      const pseudo = {}
      for (const entry of node.pseudo) pseudo[entry.state] = toText(evalSpec(entry.spec, scope, env))
      props[PSEUDO] = pseudo
    }
    props.children = evalNodes(node.children, scope, env)
    return { $$typeof: VNODE, type: node.tag, key: node.key ? keyString(evalSpec(node.key, scope, env)) : null, props, ns: node.ns }
  }

  /** @param {any} node @param {any} scope @param {any} env */
  function evalFor(node, scope, env) {
    let list = evalSpec(node.list, scope, env)
    let placeholder = false
    if (list == null) {
      placeholder = true
      list = new Array(node.hint).fill(undefined)
    } else if (!Array.isArray(list)) {
      if (typeof list === 'object' && typeof list[Symbol.iterator] === 'function') list = Array.from(list)
      else {
        warnOnce(`${env.url}|for|${node.as}`, `<sc-for as="${node.as}"> in ${fileName(env.url)} needs list="{{ name }}" pointing at an array.`)
        list = []
      }
    }
    return list.map((/** @type {any} */ item, /** @type {number} */ index) => {
      const local = Object.create(scope)
      local[node.as] = item
      local.$index = index
      if (placeholder) local.$placeholder = true
      const children = evalNodes(node.body, local, env)
      const first = children.find((child) => child && child.$$typeof === VNODE && child.key != null)
      return { $$typeof: VNODE, type: Fragment, key: first ? first.key : `$${index}`, props: { children } }
    })
  }

  /** @param {any} node @param {any} scope @param {any} env */
  function evalIf(node, scope, env) {
    let value = evalSpec(node.value, scope, env)
    if (value === undefined && node.hint) value = evalSpec(node.hint, scope, env)
    if (typeof value === 'string' && node.value.kind === 's') value = !/^(false|0|no|)$/i.test(value.trim())
    return value ? { $$typeof: VNODE, type: Fragment, key: null, props: { children: evalNodes(node.body, scope, env) } } : null
  }

  /** @param {any[]} items */
  const hasContent = (items) => items.some((item) => !(typeof item === 'string' && item.trim() === '') && item != null)

  /** @param {any} node @param {any} scope @param {any} env */
  function evalImport(node, scope, env) {
    /** @type {Record<string, any>} */
    const props = {}
    /** @type {Record<string, any>} */
    const attrs = {}
    for (const spec of node.attrs) {
      const value = evalSpec(spec, scope, env)
      attrs[spec.name] = value
      props[/^(data|aria)-/.test(spec.name) ? spec.name : camel(spec.name)] = value
    }
    if (node.spread) {
      const extra = evalSpec(node.spread, scope, env)
      if (extra && typeof extra === 'object') {
        Object.assign(props, extra)
        Object.assign(attrs, extra)
      }
    }
    const children = evalNodes(node.body, scope, env)
    /** @type {any} */
    const payload = {
      props,
      attrs,
      children: hasContent(children) ? children : null,
      style: node.style ? evalSpec(node.style, scope, env) : null,
      hintSize: node.hintSize,
      base: env.url
    }
    if (node.k === 'dc') payload.name = node.name ? toText(evalSpec(node.name, scope, env)).trim() : ''
    else {
      payload.component = node.component ? toText(evalSpec(node.component, scope, env)).trim() : ''
      payload.global = node.global ? toText(evalSpec(node.global, scope, env)).trim() : ''
      payload.from = node.from
    }
    return {
      $$typeof: VNODE,
      type: node.k === 'dc' ? DC_IMPORT : X_IMPORT,
      key: node.key ? keyString(evalSpec(node.key, scope, env)) : null,
      props: payload
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Reconciler. Each rendered item keeps a record; the next render patches records of the same
  // kind (matched by key, else by position) so elements, their listeners and running transitions
  // survive re-renders.

  /** @param {any} children @returns {any[]} */
  const childList = (children) => (children === undefined ? [] : Array.isArray(children) ? children : [children])

  /** @param {any} item */
  const keyOf = (item) => (item != null && item.$$typeof === VNODE ? item.key : null)

  /** @param {any} p */
  const xSpecKey = (p) => `${p.global ? 'g' : 'c'}|${p.global || p.component || ''}|${p.from || ''}`

  /** @param {any} rec @param {any} item */
  function canReuse(rec, item) {
    if (item == null || typeof item === 'boolean') return rec.t === 'empty'
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'bigint') return rec.t === 'text'
    if (Array.isArray(item)) return rec.t === 'frag' && rec.key == null
    if (item.nodeType) return rec.t === 'node' && rec.dom === item
    if (item.$$typeof !== VNODE) return rec.t === 'empty'
    if (rec.key !== item.key) return false
    const type = item.type
    if (type === Fragment) return rec.t === 'frag'
    if (typeof type === 'string') return rec.t === 'el' && rec.type === type
    if (type === DC_IMPORT) return rec.t === 'dc' && rec.name === item.props.name
    if (type === X_IMPORT) return rec.t === 'x' && rec.spec === xSpecKey(item.props)
    return rec.t === 'comp' && rec.type === type
  }

  /** @param {any[]} oldRecs @param {any[]} items @param {any} ctx @returns {any[]} */
  function diffList(oldRecs, items, ctx) {
    /** @type {Map<any, any>} */
    const keyed = new Map()
    /** @type {any[]} */
    const unkeyed = []
    for (const rec of oldRecs) {
      if (rec.key != null) keyed.set(rec.key, rec)
      else unkeyed.push(rec)
    }
    const kept = new Set()
    let cursor = 0
    const next = items.map((item) => {
      const key = keyOf(item)
      const old = key != null ? keyed.get(key) : unkeyed[cursor++]
      if (old && !kept.has(old) && canReuse(old, item)) {
        kept.add(old)
        return patch(old, item, ctx)
      }
      return create(item, ctx)
    })
    for (const rec of oldRecs) if (!kept.has(rec)) unmount(rec, true)
    return next
  }

  /** @param {any} item @param {any} ctx @returns {any} */
  function create(item, ctx) {
    if (item == null || typeof item === 'boolean') return { t: 'empty', key: null }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'bigint') {
      const value = String(item)
      return { t: 'text', key: null, value, dom: ctx.doc.createTextNode(value) }
    }
    if (Array.isArray(item)) return { t: 'frag', key: null, kids: diffList([], item, ctx) }
    if (item.nodeType) return { t: 'node', key: null, dom: item }
    if (item.$$typeof !== VNODE) {
      warnOnce(`${ctx.url}|object`, `An object can't be rendered in ${fileName(ctx.url)}; render a string, number, element or array.`)
      return { t: 'empty', key: null }
    }
    const type = item.type
    if (type === Fragment) return { t: 'frag', key: item.key, kids: diffList([], childList(item.props.children), ctx) }
    if (typeof type === 'string') return createElementRec(item, ctx)
    if (type === DC_IMPORT) return createDcRec(item, ctx)
    if (type === X_IMPORT) return createXRec(item, ctx)
    if (typeof type === 'function') return createCompRec(item, ctx)
    warnOnce(`${ctx.url}|type`, `An element with an unknown type can't be rendered in ${fileName(ctx.url)}.`)
    return { t: 'empty', key: item.key }
  }

  /** @param {any} rec @param {any} item @param {any} ctx @returns {any} */
  function patch(rec, item, ctx) {
    switch (rec.t) {
      case 'text': {
        const value = String(item)
        if (value !== rec.value) {
          rec.dom.data = value
          rec.value = value
        }
        return rec
      }
      case 'frag':
        rec.kids = diffList(rec.kids, Array.isArray(item) ? item : childList(item.props.children), ctx)
        return rec
      case 'el':
        applyProps(rec, item.props, ctx)
        fillChildren(rec, item.props, rec.childCtx)
        return rec
      case 'comp':
        rec.props = item.props
        renderComp(rec)
        return rec
      case 'dc':
        updateDcRec(rec, item)
        return rec
      case 'x':
        updateXRec(rec, item)
        return rec
      default:
        return rec
    }
  }

  /** @param {any} item @param {any} ctx */
  function createElementRec(item, ctx) {
    const ns = item.ns !== undefined ? item.ns : item.type === 'svg' ? SVG_NS : ctx.ns
    const dom = ns ? ctx.doc.createElementNS(ns, item.type) : ctx.doc.createElement(item.type)
    const childNs = item.type === 'foreignObject' ? null : ns
    const rec = {
      t: 'el',
      key: item.key,
      type: item.type,
      dom,
      props: {},
      kids: [],
      childCtx: childNs === ctx.ns ? ctx : { ...ctx, ns: childNs }
    }
    applyProps(rec, item.props, ctx)
    fillChildren(rec, item.props, rec.childCtx)
    return rec
  }

  /** @param {any} rec @param {any} props @param {any} ctx */
  function fillChildren(rec, props, ctx) {
    if (props.dangerouslySetInnerHTML) {
      for (const kid of rec.kids) unmount(kid, true)
      rec.kids = []
      return
    }
    rec.kids = diffList(rec.kids, childList(props.children), ctx)
    place(rec.dom, rec.kids, null)
  }

  /** Puts the records' DOM nodes, in order, right before `before`, moving only what's out of place. */
  /** @param {Node} parent @param {any[]} recs @param {Node | null} before */
  function place(parent, recs, before) {
    let next = before
    for (let i = recs.length - 1; i >= 0; i--) next = placeRec(parent, recs[i], next)
  }

  /** @param {Node} parent @param {any} rec @param {Node | null} next @returns {Node | null} */
  function placeRec(parent, rec, next) {
    switch (rec.t) {
      case 'empty':
        return next
      case 'frag':
        for (let i = rec.kids.length - 1; i >= 0; i--) next = placeRec(parent, rec.kids[i], next)
        return next
      case 'comp':
        if (rec.anchor.parentNode !== parent || rec.anchor.nextSibling !== next) parent.insertBefore(rec.anchor, next)
        next = rec.anchor
        for (let i = rec.kids.length - 1; i >= 0; i--) next = placeRec(parent, rec.kids[i], next)
        return next
      default: {
        const dom = rec.dom
        if (dom.parentNode !== parent || dom.nextSibling !== next) parent.insertBefore(dom, next)
        return dom
      }
    }
  }

  /** @param {any} rec @param {boolean} removeDom */
  function unmount(rec, removeDom) {
    switch (rec.t) {
      case 'el':
        if (rec.props.ref) setRef(rec.props.ref, null)
        for (const kid of rec.kids) unmount(kid, false)
        break
      case 'frag':
        for (const kid of rec.kids) unmount(kid, removeDom)
        return
      case 'comp': {
        rec.dead = true
        const instance = rec.instance
        if (instance && typeof instance.componentWillUnmount === 'function') tryCall(() => instance.componentWillUnmount())
        for (const hook of rec.hooks) if (hook && typeof hook.cleanup === 'function') tryCall(hook.cleanup)
        for (const kid of rec.kids) unmount(kid, removeDom)
        if (removeDom) rec.anchor.remove()
        return
      }
      case 'dc':
        rec.dead = true
        if (rec.host) rec.host.destroy()
        for (const kid of rec.inner) unmount(kid, false)
        break
      case 'x':
        rec.dead = true
        if (rec.reactRoot) tryCall(() => rec.reactRoot.unmount())
        for (const kid of rec.inner) unmount(kid, false)
        break
    }
    if (removeDom && rec.dom && rec.dom.parentNode) rec.dom.parentNode.removeChild(rec.dom)
  }

  /** @param {any} ref @param {any} value */
  function setRef(ref, value) {
    if (typeof ref === 'function') tryCall(() => ref(value))
    else if (ref && typeof ref === 'object') ref.current = value
  }

  // Props on DOM elements, for both template attributes (lowercase names) and createElement props.

  /** @param {any} rec @param {Record<string, any>} next @param {any} ctx */
  function applyProps(rec, next, ctx) {
    const el = rec.dom
    const prev = rec.props
    for (const name in prev) {
      if (!(name in next) && name !== 'children' && name !== 'key') setProp(el, name, undefined, prev[name], ctx)
    }
    for (const name in next) {
      if (name === 'children' || name === 'key') continue
      const value = next[name]
      const old = prev[name]
      if (value !== old || name === PSEUDO || (name === 'style' && value && typeof value === 'object')) setProp(el, name, value, old, ctx)
    }
    rec.props = next
  }

  /** @param {any} el */
  function isTextInput(el) {
    if (el.localName === 'textarea') return true
    if (el.localName !== 'input') return false
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    return type !== 'checkbox' && type !== 'radio' && type !== 'file'
  }

  /** @param {any} el @param {string} name @param {any} value @param {any} old @param {any} ctx */
  function setProp(el, name, value, old, ctx) {
    if (name === 'ref') {
      if (old !== value) {
        setRef(old, null)
        setRef(value, el)
      }
      return
    }
    if (name === PSEUDO) return applyPseudo(el, value || {}, ctx)
    if (name === 'dangerouslySetInnerHTML') {
      const html = value && value.__html != null ? String(value.__html) : ''
      if (!old || old.__html !== html) el.innerHTML = html
      return
    }
    if (name === 'style') return applyStyle(el, value, old)
    if (name === 'className' || name === 'class') {
      if (value == null || value === false) el.removeAttribute('class')
      else el.setAttribute('class', toText(value))
      return
    }
    if (/^on./i.test(name) && (typeof value === 'function' || typeof old === 'function')) return setEvent(el, name, value)
    if (value != null && (typeof value === 'object' || typeof value === 'function')) {
      el[camel(name)] = value
      return
    }
    if (old != null && typeof old === 'object' && value == null) el[camel(name)] = undefined
    if ((name === 'value' || name === 'checked' || name === 'selected' || name === 'muted' || name === 'indeterminate') && name in el) {
      const property = value == null ? (name === 'value' ? '' : false) : name === 'value' ? String(value) : value !== false && value !== 'false'
      if (el[name] !== property) el[name] = property
      if (name === 'value') return
    }
    let attr = name === 'htmlFor' ? 'for' : name
    if (el.namespaceURI === SVG_NS) {
      if (attr === 'xlinkHref') attr = 'href'
      else if (SVG_KEBAB_RE.test(attr)) attr = kebab(attr)
    }
    const aria = /^(aria|data)-/.test(attr)
    if (value == null || (value === false && !aria)) el.removeAttribute(attr)
    else el.setAttribute(attr, value === true && !aria ? '' : String(value))
  }

  /** @param {any} el @param {string} name @param {any} handler */
  function setEvent(el, name, handler) {
    let type = name.slice(2)
    let capture = false
    if (/capture$/i.test(type)) {
      capture = true
      type = type.slice(0, -7)
    }
    type = type.toLowerCase()
    if (type === 'doubleclick') type = 'dblclick'
    if (type === 'change' && isTextInput(el)) type = 'input'
    const store = el.__dcEvents || (el.__dcEvents = {})
    const slot = type + (capture ? ':capture' : '')
    const entry = store[slot]
    if (entry) {
      entry.handler = typeof handler === 'function' ? handler : null
      return
    }
    if (typeof handler !== 'function') return
    /** @type {any} */
    const created = { handler }
    created.listener = (/** @type {Event} */ event) => {
      if (created.handler) created.handler.call(el, event)
    }
    store[slot] = created
    el.addEventListener(type, created.listener, capture)
  }

  /** @param {any} style @param {string} key @param {any} value */
  function setStyleProp(style, key, value) {
    const text =
      value == null || typeof value === 'boolean'
        ? ''
        : typeof value === 'number' && value !== 0 && !UNITLESS.has(key) && !key.startsWith('--')
          ? `${value}px`
          : String(value)
    const prop = key.startsWith('--') || key.includes('-') ? key : kebab(key)
    const important = /\s*!important\s*$/i.exec(text)
    style.setProperty(prop, important ? text.slice(0, important.index) : text, important ? 'important' : '')
  }

  /** @param {any} el @param {any} value @param {any} old */
  function applyStyle(el, value, old) {
    if (value == null || value === '' || value === false) {
      if (old != null && old !== '') el.removeAttribute('style')
      return
    }
    if (typeof value === 'string') {
      if (value !== old) el.style.cssText = value
      return
    }
    const style = el.style
    let previous = old
    if (typeof previous !== 'object' || previous === null) {
      if (typeof previous === 'string') style.cssText = ''
      previous = null
    }
    if (previous) for (const key in previous) if (!(key in value)) setStyleProp(style, key, '')
    for (const key in value) if (!previous || previous[key] !== value[key]) setStyleProp(style, key, value[key])
  }

  // style-hover and friends: one generated rule per distinct declaration block, matched by a data
  // attribute. Declarations get !important so they win over the element's inline style.

  /** @type {Map<string, string>} */
  const pseudoRules = new Map()

  /** @param {Document} doc */
  function pseudoSheet(doc) {
    let sheet = doc.querySelector('style[data-dc-pseudo]')
    if (!sheet) {
      sheet = doc.createElement('style')
      sheet.setAttribute('data-dc-pseudo', '')
      ;(doc.head || doc.documentElement).appendChild(sheet)
    }
    return sheet
  }

  /** @param {Document} doc @param {string} state @param {string} css */
  function pseudoRule(doc, state, css) {
    const cacheKey = `${state}\n${css}`
    const known = pseudoRules.get(cacheKey)
    if (known) return known
    const id = `p${pseudoRules.size + 1}`
    pseudoRules.set(cacheKey, id)
    const element = state === 'before' || state === 'after'
    const declarations = css
      .replace(/[{}<]/g, '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (element || /!important$/i.test(part) ? part : `${part} !important`))
    if (element && !declarations.some((part) => /^content\s*:/i.test(part))) declarations.unshift('content: ""')
    pseudoSheet(doc).appendChild(
      doc.createTextNode(`[data-dc-${state}="${id}"]${PSEUDO_STATES[state]} { ${declarations.join('; ')} }\n`)
    )
    return id
  }

  /** @param {any} el @param {Record<string, string>} states @param {any} ctx */
  function applyPseudo(el, states, ctx) {
    const known = el.__dcPseudo || (el.__dcPseudo = {})
    for (const state of new Set([...Object.keys(known), ...Object.keys(states)])) {
      const css = (states[state] || '').trim()
      const attr = `data-dc-${state}`
      if (!css) {
        if (known[state]) el.removeAttribute(attr)
        delete known[state]
        continue
      }
      const id = pseudoRule(ctx.doc, state, css)
      if (known[state] !== id) {
        el.setAttribute(attr, id)
        known[state] = id
      }
    }
  }

  // Function and class components.

  /** @param {any} item @param {any} ctx */
  function createCompRec(item, ctx) {
    /** @type {any} */
    const rec = {
      t: 'comp',
      key: item.key,
      type: item.type,
      props: item.props,
      kids: [],
      hooks: [],
      hookIndex: 0,
      anchor: ctx.doc.createTextNode(''),
      depth: ctx.depth + 1,
      dead: false,
      instance: null,
      renderedIn: 0,
      callbacks: null
    }
    rec.childCtx = { ...ctx, depth: rec.depth }
    rec.update = () => {
      if (rec.dead) return
      renderComp(rec)
      const parent = rec.anchor.parentNode
      if (parent) place(parent, [rec], rec.anchor.nextSibling)
    }
    renderComp(rec)
    return rec
  }

  /** @param {any} rec */
  function renderComp(rec) {
    rec.renderedIn = flushId
    const type = rec.type
    let output
    try {
      if (type.prototype && type.prototype.isReactComponent) output = renderClassComp(rec)
      else {
        const previous = currentComp
        currentComp = rec
        rec.hookIndex = 0
        try {
          output = type(rec.props)
        } finally {
          currentComp = previous
        }
      }
    } catch (error) {
      console.error('[dc] a component failed to render', error)
      output = errorElement(`${type.displayName || type.name || 'A component'} failed to render: ${messageOf(error)}`)
    }
    rec.kids = diffList(rec.kids, [output], rec.childCtx)
  }

  /** @param {any} rec */
  function renderClassComp(rec) {
    let instance = rec.instance
    if (!instance) {
      instance = rec.instance = new rec.type(rec.props)
      instance.props = rec.props
      instance.__unit = rec
      const output = instance.render()
      afterCommit(() => {
        if (!rec.dead && typeof instance.componentDidMount === 'function') instance.componentDidMount()
      })
      rec.prevState = instance.state
      return output
    }
    const prevProps = instance.props
    const prevState = rec.prevState
    instance.props = rec.props
    const output = instance.render()
    afterCommit(() => {
      if (!rec.dead && typeof instance.componentDidUpdate === 'function') instance.componentDidUpdate(prevProps, prevState)
    })
    rec.prevState = instance.state
    return output
  }

  /** @param {string} message */
  const errorElement = (message) => createElement('div', { 'data-dc-error': '', role: 'alert', style: ERROR_STYLE }, message)

  // ---------------------------------------------------------------------------------------------
  // Design Components: a compiled file ("def") plus a logic instance rendering into a mount element.

  /** @type {Map<string, Promise<any>>} */
  const defs = new Map()
  /** @type {Set<Promise<any>>} */
  const pending = new Set()

  /** Loads that `ready` waits for. @param {Promise<any>} promise */
  function track(promise) {
    pending.add(promise)
    const done = () => pending.delete(promise)
    promise.then(done, done)
    return promise
  }

  async function settle() {
    while (pending.size) await Promise.allSettled([...pending])
    runCommit()
  }

  /** @param {string} text */
  function parseDcSource(text) {
    const parsed = new DOMParser().parseFromString(text, 'text/html')
    const script = parsed.querySelector('script[data-dc-script]')
    return {
      template: extractTemplate(text),
      logic: script ? script.textContent || '' : '',
      propsJson: script ? script.getAttribute('data-props') : null
    }
  }

  /** @param {string} source @param {string} url */
  function evalLogic(source, url) {
    if (!source || !source.trim()) return DCLogic
    const body = `${source.replace(/\bimport\s*\(/g, '__dcImport(')}\n;return typeof Component === 'undefined' ? undefined : Component\n//# sourceURL=${url}.logic.js`
    const factory = new Function('DCLogic', 'React', '__dcImport', body)
    const Logic = factory(DCLogic, React, (/** @type {string} */ specifier) => import(/* @vite-ignore */ new URL(specifier, url).href))
    if (typeof Logic !== 'function') throw new Error('it must define `class Component extends DCLogic { … }`.')
    return Logic
  }

  /** @param {any} def @param {string | null} json */
  function readPropsMeta(def, json) {
    if (!json || !json.trim()) return
    try {
      const meta = JSON.parse(json)
      if (!meta || typeof meta !== 'object') return
      for (const [name, entry] of Object.entries(meta)) {
        if (name === '$preview') def.preview = entry
        else if (entry && typeof entry === 'object' && 'default' in entry) def.defaults[name] = entry.default
      }
    } catch (error) {
      warnOnce(`${def.url}|props`, `The data-props of ${fileName(def.url)} isn't valid JSON: ${messageOf(error)}`)
    }
  }

  /** @param {string} url @param {{ template: string | null, logic: string, propsJson: string | null }} source @param {Document} doc */
  function buildDef(url, source, doc) {
    /** @type {any} */
    const def = { url, nodes: [], helmet: [], helmetDone: false, Logic: DCLogic, defaults: {}, preview: null, error: null }
    if (source.template == null) {
      def.error = `${fileName(url)} has no <x-dc> template.`
      return def
    }
    try {
      def.nodes = compileNodes(def, parseTemplate(doc, source.template).childNodes)
    } catch (error) {
      def.error = `The template of ${fileName(url)} couldn't be read: ${messageOf(error)}`
      return def
    }
    try {
      def.Logic = evalLogic(source.logic, url)
    } catch (error) {
      def.error = `The logic class of ${fileName(url)} failed to load: ${messageOf(error)}`
      console.error(`[dc] ${def.error}`, error)
    }
    readPropsMeta(def, source.propsJson)
    return def
  }

  /** @param {string} url @param {Document} doc */
  function loadDef(url, doc) {
    let def = defs.get(url)
    if (!def) {
      def = options.fetchText(url).then((text) => buildDef(url, parseDcSource(text), doc))
      defs.set(url, def)
    }
    return def
  }

  /** Copies a DC's <helmet> into the page head once, skipping scripts, links and styles already there. */
  /** @param {any} def @param {Document} doc */
  function applyHelmet(def, doc) {
    if (def.helmetDone) return
    def.helmetDone = true
    const head = doc.head || doc.documentElement
    for (const node of def.helmet) {
      const tag = node.localName
      if (tag === 'script') {
        const src = node.getAttribute('src')
        const abs = src ? new URL(src, def.url).href : null
        if (abs && Array.from(doc.scripts).some((script) => script.src === abs)) continue
        const script = doc.createElement('script')
        for (const attr of Array.from(/** @type {NamedNodeMap} */ (node.attributes))) {
          script.setAttribute(attr.name, attr.name === 'src' && abs ? abs : attr.value)
        }
        script.text = node.textContent || ''
        if (abs) {
          track(
            new Promise((resolve) => {
              script.addEventListener('load', resolve)
              script.addEventListener('error', resolve)
              setTimeout(resolve, LOAD_TIMEOUT_MS)
            })
          )
        }
        head.appendChild(script)
      } else if (tag === 'link') {
        const href = node.getAttribute('href')
        const abs = href ? new URL(href, def.url).href : null
        if (abs && Array.from(doc.querySelectorAll('link[href]')).some((link) => /** @type {HTMLLinkElement} */ (link).href === abs)) continue
        const link = /** @type {Element} */ (doc.importNode(node, true))
        if (abs) link.setAttribute('href', abs)
        head.appendChild(link)
      } else if (tag === 'style') {
        const text = node.textContent || ''
        if (Array.from(doc.querySelectorAll('style')).some((style) => style.textContent === text)) continue
        head.appendChild(doc.importNode(node, true))
      } else if (def.root && (tag === 'meta' || tag === 'base')) {
        head.appendChild(doc.importNode(node, true))
      } else if (def.root && tag === 'title') {
        doc.title = node.textContent || ''
      }
    }
  }

  class DcHost {
    /** @param {any} def @param {Record<string, any>} props @param {Element} mount @param {any} parent */
    constructor(def, props, mount, parent) {
      this.def = def
      this.props = props
      this.mount = mount
      /** @type {number} */
      this.depth = parent ? parent.depth + 1 : 0
      this.dead = false
      this.renderedIn = 0
      /** @type {Function[] | null} */
      this.callbacks = null
      /** @type {any} */
      this.instance = null
      /** @type {string | null} */
      this.error = null
      /** @type {any[]} */
      this.recs = []
      /** @type {Set<string>} */
      this.chain = new Set(parent ? parent.chain : [])
      this.chain.add(def.url)
      /** @type {any} */
      this.renderedProps = null
      /** @type {any} */
      this.renderedState = null
      this.ctx = { doc: /** @type {Document} */ (mount.ownerDocument), ns: null, depth: this.depth, url: def.url, host: this }
    }

    start() {
      if (!this.def.error) {
        try {
          const logic = new this.def.Logic(this.props)
          logic.props = this.props
          logic.__unit = this
          this.instance = logic
        } catch (error) {
          this.error = `The logic class of ${fileName(this.def.url)} failed to start: ${messageOf(error)}`
          console.error(`[dc] ${this.error}`, error)
        }
      }
      this.render()
      const logic = this.instance
      afterCommit(() => {
        if (!this.dead && logic && typeof logic.componentDidMount === 'function') logic.componentDidMount()
      })
    }

    update() {
      const logic = this.instance
      const prevProps = this.renderedProps
      const prevState = this.renderedState
      this.render()
      afterCommit(() => {
        if (!this.dead && logic && typeof logic.componentDidUpdate === 'function') logic.componentDidUpdate(prevProps, prevState)
      })
    }

    render() {
      this.renderedIn = flushId
      const fatal = this.error || this.def.error
      /** @type {any[]} */
      let items
      if (fatal || !this.instance) items = [errorElement(fatal || 'This design component could not start.')]
      else {
        /** @type {any} */
        let vals = {}
        let failure = null
        try {
          vals = this.instance.renderVals() || {}
        } catch (error) {
          failure = `renderVals() in ${fileName(this.def.url)} threw: ${messageOf(error)}`
          console.error(`[dc] ${failure}`, error)
        }
        const scope = Object.create(null)
        scope.props = this.props
        scope.state = this.instance.state
        Object.assign(scope, this.props, vals)
        items = [failure ? errorElement(failure) : null, evalNodes(this.def.nodes, scope, this.ctx)]
      }
      this.recs = diffList(this.recs, items, this.ctx)
      place(this.mount, this.recs, null)
      this.renderedProps = this.props
      this.renderedState = this.instance ? this.instance.state : null
    }

    /** @param {Record<string, any>} props */
    setProps(props) {
      if (shallowEqual(props, this.props)) return
      this.props = props
      if (this.instance) this.instance.props = props
      this.update()
    }

    destroy() {
      if (this.dead) return
      this.dead = true
      const logic = this.instance
      if (logic && typeof logic.componentWillUnmount === 'function') tryCall(() => logic.componentWillUnmount())
      for (const rec of this.recs) unmount(rec, true)
      this.recs = []
    }
  }

  /** @param {string} name @param {string} base */
  const dcUrl = (name, base) => new URL(/\.dc\.html$/i.test(name) ? name : `${name}.dc.html`, base).href

  /** @param {any} def @param {any} p */
  const childProps = (def, p) => ({ ...def.defaults, ...p.props, ...(p.children ? { children: p.children } : {}) })

  /** Styles the <dc-import>/<x-import> element that holds a mounted component. */
  /** @param {any} rec @param {boolean} loading */
  function styleMount(rec, loading) {
    const { style, hintSize } = rec.p
    const signature = `${loading}|${hintSize}|${typeof style === 'string' ? style : JSON.stringify(style)}`
    if (rec.mountSignature === signature) return
    rec.mountSignature = signature
    const s = rec.dom.style
    s.cssText = `${style || (loading && hintSize) ? 'display:block;' : 'display:contents;'}${typeof style === 'string' ? style : ''}`
    if (style && typeof style === 'object') for (const key in style) setStyleProp(s, key, style[key])
    if (loading && hintSize) {
      const [width, height] = String(hintSize).split(',').map((part) => cssLength(part.trim()))
      if (width && !s.width) s.width = width
      if (height && !s.height && !s.minHeight) s.minHeight = height
    }
  }

  /** @param {any} rec @param {string} message */
  function showMountError(rec, message) {
    console.error(`[dc] ${message}`)
    rec.inner = diffList(rec.inner, [errorElement(message)], rec.ctx)
    place(rec.dom, rec.inner, null)
  }

  /** @param {any} item @param {any} ctx */
  function createDcRec(item, ctx) {
    const p = item.props
    const dom = ctx.doc.createElement('dc-import')
    /** @type {any} */
    const rec = { t: 'dc', key: item.key, dom, name: p.name, p, host: null, inner: [], dead: false, ctx: { ...ctx, ns: null } }
    if (p.name) dom.setAttribute('name', p.name)
    styleMount(rec, true)
    if (!p.name) {
      showMountError(rec, '<dc-import> needs name="…", the basename of a sibling .dc.html file.')
      return rec
    }
    const url = dcUrl(p.name, ctx.url)
    if (ctx.host && ctx.host.chain.has(url)) {
      showMountError(rec, `${fileName(url)} imports itself, so it can't be rendered.`)
      return rec
    }
    track(
      loadDef(url, ctx.doc).then(
        (def) => {
          if (rec.dead) return
          applyHelmet(def, ctx.doc)
          rec.inner = diffList(rec.inner, [], rec.ctx)
          styleMount(rec, false)
          const host = new DcHost(def, childProps(def, rec.p), dom, ctx.host)
          rec.host = host
          host.start()
          runCommit()
        },
        (error) => {
          if (!rec.dead) showMountError(rec, `Couldn't load ${fileName(url)}: ${messageOf(error)}`)
        }
      )
    )
    return rec
  }

  /** @param {any} rec @param {any} item */
  function updateDcRec(rec, item) {
    rec.p = item.props
    if (!rec.host) return
    styleMount(rec, false)
    rec.host.setProps(childProps(rec.host.def, rec.p))
  }

  // External components: <x-import> mounts a web component, a window global, or an export of a
  // sibling .js file. Each file is fetched and evaluated once.

  /** @type {Map<string, Promise<void>>} */
  const scripts = new Map()
  /** @type {Map<string, Promise<any>>} */
  const modules = new Map()
  const globalEval = eval

  /** @param {string} url */
  function loadScriptOnce(url) {
    let loaded = scripts.get(url)
    if (!loaded) {
      loaded = options.fetchText(url).then((text) => {
        globalEval(`${text}\n//# sourceURL=${url}`)
      })
      scripts.set(url, loaded)
    }
    return loaded
  }

  function realReact() {
    const R = G.React
    const RD = G.ReactDOM
    return R && R !== React && typeof R.createElement === 'function' && RD && (RD.createRoot || RD.render) ? R : null
  }

  /** @param {string} name */
  function requireShim(name) {
    if (name === 'react') return realReact() || React
    if (name === 'react-dom' || name === 'react-dom/client') return G.ReactDOM
    throw new Error(`require('${name}') isn't available in the preview.`)
  }

  /** @param {string} url */
  function loadModuleOnce(url) {
    let loaded = modules.get(url)
    if (!loaded) {
      loaded = options.fetchText(url).then((text) => {
        const module = { exports: /** @type {any} */ ({}) }
        try {
          const factory = new Function('module', 'exports', 'require', 'React', 'ReactDOM', `${text}\n//# sourceURL=${url}`)
          factory(module, module.exports, requireShim, realReact() || React, G.ReactDOM)
          return module.exports
        } catch (error) {
          if (error instanceof SyntaxError && /\b(import|export)\b/.test(text)) return import(/* @vite-ignore */ url)
          throw error
        }
      })
      modules.set(url, loaded)
    }
    return loaded
  }

  /** @param {string} name */
  function lookupGlobal(name) {
    const parts = name.split('.')
    let value = G[parts[0]]
    if (value === undefined && /^[A-Za-z_$][\w$]*$/.test(parts[0])) {
      try {
        value = globalEval(`typeof ${parts[0]} === 'undefined' ? undefined : ${parts[0]}`)
      } catch {
        value = undefined
      }
    }
    for (const part of parts.slice(1)) {
      if (value == null) return undefined
      value = value[part]
    }
    return value
  }

  /** @param {() => any} read @param {string} message @returns {Promise<any>} */
  function waitFor(read, message) {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        let value
        try {
          value = read()
        } catch {
          value = undefined
        }
        if (value != null) resolve(value)
        else if (Date.now() - started > LOAD_TIMEOUT_MS) reject(new Error(message))
        else setTimeout(tick, 50)
      }
      tick()
    })
  }

  /** @param {any} exported @param {string} name */
  function pickExport(exported, name) {
    if (exported == null) return undefined
    if (exported[name] != null) return exported[name]
    if (exported.default && exported.default[name] != null) return exported.default[name]
    if (typeof exported === 'function') return exported
    if (typeof exported.default === 'function') return exported.default
    return undefined
  }

  /** @param {any} p */
  async function resolveTarget(p) {
    const name = p.global || p.component
    if (!name) throw new Error('<x-import> needs component="…" or component-from-global-scope="…".')
    const from = p.from ? new URL(p.from, p.base).href : null
    if (p.global || (name.includes('-') && !name.includes('.'))) {
      if (from) await loadScriptOnce(from)
      if (name.includes('-') && !name.includes('.')) {
        await Promise.race([
          customElements.whenDefined(name),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`<${name}> was never defined${from ? ` by ${fileName(from)}` : ''}.`)), LOAD_TIMEOUT_MS))
        ])
        return { kind: 'element', tag: name }
      }
      return { kind: 'component', comp: await waitFor(() => lookupGlobal(name), `${name} was not found on window${from ? ` after loading ${fileName(from)}` : ''}.`) }
    }
    const exported = from ? await loadModuleOnce(from) : null
    const comp = pickExport(exported, name) ?? lookupGlobal(name)
    if (comp == null) throw new Error(`${name} isn't exported by ${from ? fileName(from) : 'any loaded script'}.`)
    return { kind: 'component', comp }
  }

  /** @param {any} item @param {any} ctx */
  function createXRec(item, ctx) {
    const p = item.props
    const dom = ctx.doc.createElement('x-import')
    /** @type {any} */
    const rec = { t: 'x', key: item.key, dom, spec: xSpecKey(p), p, target: null, inner: [], dead: false, reactRoot: null, ctx: { ...ctx, ns: null } }
    styleMount(rec, true)
    if (p.from && /\.(jsx|tsx|ts)(?:[?#]|$)/i.test(p.from)) {
      showMountError(
        rec,
        `${p.from} is a JSX/TypeScript file, which the Deskmates preview can't run. Use plain JavaScript (React.createElement or a web component) in a .js file.`
      )
      return rec
    }
    track(
      resolveTarget(p).then(
        (target) => {
          if (rec.dead) return
          rec.target = target
          rec.inner = diffList(rec.inner, [], rec.ctx)
          styleMount(rec, false)
          renderX(rec)
          runCommit()
        },
        (error) => {
          if (!rec.dead) showMountError(rec, messageOf(error))
        }
      )
    )
    return rec
  }

  /** @param {any} rec @param {any} item */
  function updateXRec(rec, item) {
    rec.p = item.props
    if (!rec.target) return
    styleMount(rec, false)
    renderX(rec)
  }

  /** @param {any} rec */
  function renderX(rec) {
    const p = rec.p
    const target = rec.target
    const R = target.kind === 'component' ? realReact() : null
    if (R) {
      const RD = G.ReactDOM
      if (!rec.reactRoot) {
        rec.reactRoot = RD.createRoot
          ? RD.createRoot(rec.dom)
          : { render: (/** @type {any} */ el) => RD.render(el, rec.dom), unmount: () => RD.unmountComponentAtNode(rec.dom) }
      }
      if (p.children) warnOnce(`${p.base}|react-children`, `Template children aren't passed to ${p.global || p.component}, which renders with the page's own React.`)
      rec.reactRoot.render(R.createElement(target.comp, p.props))
      return
    }
    const item =
      target.kind === 'element'
        ? { $$typeof: VNODE, type: target.tag, key: null, ns: null, props: { ...p.attrs, children: p.children || [] } }
        : createElement(target.comp, p.children ? { ...p.props, children: p.children } : p.props)
    rec.inner = diffList(rec.inner, [item], rec.ctx)
    place(rec.dom, rec.inner, null)
  }

  // ---------------------------------------------------------------------------------------------
  // Mounting and boot.

  /** @type {() => void} */
  let resolveReady = () => {}
  /** Resolves once the page's DC and everything it imports has rendered. */
  const ready = new Promise((resolve) => {
    resolveReady = () => resolve(undefined)
  })

  /** @param {Element} root @param {any} preview */
  function applyPreviewSize(root, preview) {
    const style = /** @type {HTMLElement} */ (root).style
    if (preview && typeof preview === 'object' && (preview.width || preview.height)) {
      style.display = 'block'
      style.margin = '0 auto'
      if (preview.width) style.width = cssLength(String(preview.width))
      if (preview.height) style.height = cssLength(String(preview.height))
    } else {
      style.display = 'contents'
    }
  }

  /**
   * Renders DC source into `element` and returns its host. `source` is `{ template, logic, propsJson }`.
   * @param {Element} element
   * @param {{ template: string | null, logic?: string, propsJson?: string | null }} source
   * @param {{ url?: string, props?: Record<string, any>, root?: boolean, helmetDone?: boolean }} [config]
   */
  function mount(element, source, config = {}) {
    const doc = /** @type {Document} */ (element.ownerDocument)
    const url = config.url || doc.URL.split('#')[0]
    const def = buildDef(url, { template: source.template, logic: source.logic || '', propsJson: source.propsJson ?? null }, doc)
    def.root = config.root !== false
    def.helmetDone = !!config.helmetDone
    defs.set(url, Promise.resolve(def))
    applyHelmet(def, doc)
    element.textContent = ''
    element.setAttribute('data-dc-mounted', '')
    const host = new DcHost(def, { ...def.defaults, ...config.props }, element, null)
    host.start()
    runCommit()
    return host
  }

  /** Moves the <helmet> content the HTML parser already applied (scripts ran in place) into <head>. */
  /** @param {Element} root @param {Document} doc */
  function moveLiveHelmet(root, doc) {
    const helmets = Array.from(root.querySelectorAll('helmet'))
    for (const helmet of helmets) {
      for (const child of Array.from(helmet.childNodes)) {
        const element = /** @type {Element} */ (child)
        if (element.nodeType !== 1) continue
        if (element.localName === 'title') doc.title = element.textContent || ''
        else doc.head.appendChild(element)
      }
      helmet.remove()
    }
    return helmets.length > 0
  }

  /** @param {Window} win */
  async function boot(win) {
    const doc = win.document
    const root = doc.querySelector('x-dc')
    if (!root || root.hasAttribute('data-dc-mounted')) {
      resolveReady()
      return
    }
    try {
      const url = doc.URL.split('#')[0]
      const helmetDone = moveLiveHelmet(root, doc)
      const script = doc.querySelector('script[data-dc-script]')
      /** @type {{ template: string | null, logic: string, propsJson: string | null }} */
      let source = { template: root.innerHTML, logic: script ? script.textContent || '' : '', propsJson: script ? script.getAttribute('data-props') : null }
      try {
        const template = extractTemplate(await options.fetchText(url))
        if (template != null) source = { ...source, template }
      } catch {
        // Pages opened from disk can't fetch themselves; the parsed template is close enough.
      }
      const host = mount(root, source, { url, root: true, helmetDone })
      applyPreviewSize(root, host.def.preview)
      await settle()
    } catch (error) {
      console.error('[dc] the design component failed to render', error)
    } finally {
      resolveReady()
    }
  }

  function reset() {
    defs.clear()
    scripts.clear()
    modules.clear()
    warned.clear()
    pseudoRules.clear()
  }

  G.DCSupport = {
    React,
    DCLogic,
    options,
    ready,
    boot,
    mount,
    settle,
    reset,
    parseDcSource,
    extractTemplate
  }
  if (!G.React) G.React = React
  if (!G.DCLogic) G.DCLogic = DCLogic

  const current = typeof document !== 'undefined' ? document.currentScript : null
  if (current && current.getAttribute('src')) {
    const hide = document.createElement('style')
    hide.textContent = 'x-dc:not([data-dc-mounted]) { display: none; }'
    ;(document.head || document.documentElement).appendChild(hide)
    const start = () => void boot(window)
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
    else start()
  }
})()
