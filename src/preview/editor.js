// @ts-check
/**
 * The Design tab's live editor. Injected by the Electron main process into every design
 * page as <script type="module" src="deskmates-preview://editor/editor.js"> at the end of
 * <body>. Draws a selection overlay over the page and lets you move, resize and edit the
 * page's own elements directly (like Canva or PowerPoint), talking to the app with
 * window.parent.postMessage. The message contract lives in src/shared/design-bridge.ts.
 */

/** @typedef {import('../shared/design-bridge').ElementStyle} ElementStyle */
/** @typedef {import('../shared/design-bridge').Rect} Rect */
/** @typedef {import('../shared/design-bridge').ChangeReason} ChangeReason */
/** @typedef {import('../shared/design-bridge').EditorCommand} EditorCommand */
/** @typedef {import('../shared/design-bridge').EditorToApp} EditorToApp */
/** @typedef {import('../shared/design-bridge').AppToEditor} AppToEditor */
/** @typedef {ChangeReason | 'nudge'} UndoKind */
/** @typedef {{ bodyHtml: string, bodyStyle: string | null, selectedId: string | null, kind: UndoKind, targetId: string | null, at: number }} UndoEntry */
/** @typedef {{ kind: 'move' | 'resize', el: Element, startX: number, startY: number, rect0: DOMRect, tx0: number, ty0: number, moved: boolean, shift: boolean, snapshot: UndoEntry | null, dir?: string, w0?: number, h0?: number }} DragSession */
/** @typedef {{ destroy(): void, serialize(): string, selectById(id: string): void }} EditorHandle */

const EDITOR_SOURCE = 'deskmates-editor'
const APP_SOURCE = 'deskmates-app'
const ID_ATTR = 'data-dm-id'
const OVERLAY_TAG = 'dm-editor-overlay'
const EDITOR_SCRIPT_ATTR = 'data-dm-editor'
const EDITING_ATTR = 'data-dm-editing'
const MIN_SIZE = 8
const MOVE_THRESHOLD_PX = 3
const SNAP_DISTANCE_PX = 4
const HANDLE_SIZE = 8
const CHANGE_DEBOUNCE_MS = 300
const NUDGE_COALESCE_MS = 1000
const STYLE_COALESCE_MS = 700
const MAX_UNDO = 100
const HOVER_TEXT_CUT = 30
const SELECT_TEXT_CUT = 500
const HTML_CUT = 2000
/** Identical to design-bridge.ts's GOOGLE_FONTS_CSS. */
const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com/css2'
const GOOGLE_FONTS_CSS_PREFIX = GOOGLE_FONTS_CSS + '?'

/** Tags that never get an id and can't be selected. */
const SKIP_TAGS = new Set(['script', 'style', 'link', 'meta', 'noscript', 'template', 'br'])
/** Tags that never count as having editable text. */
const NON_TEXT_TAGS = new Set(['script', 'style', 'svg', 'textarea', 'input', 'select'])
/** Element children that may appear inside editable text. */
const INLINE_FORMAT_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'span', 'a', 'small', 'sup', 'sub', 'code', 'mark', 'br'])
/** Tags whose aspect ratio is kept while resizing unless Shift frees it. */
const MEDIA_TAGS = new Set(['img', 'video', 'svg', 'canvas'])
/** Tags that commit a text edit on Enter (without Shift). */
const ENTER_COMMITS_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'span', 'label', 'li'])

const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
/** @type {Record<string, string>} */
const HANDLE_CURSORS = {
  nw: 'nw-resize',
  n: 'n-resize',
  ne: 'ne-resize',
  e: 'e-resize',
  se: 'se-resize',
  s: 's-resize',
  sw: 'sw-resize',
  w: 'w-resize'
}

/** @param {Element} el */
function elTag(el) {
  return el.tagName ? String(el.tagName).toLowerCase() : ''
}

/** @param {string} dir */
function isCorner(dir) {
  return dir === 'nw' || dir === 'ne' || dir === 'sw' || dir === 'se'
}

/** The outermost <svg> containing `el` (or `el` itself, if it is one); null when there is none.
 * Rule 1 / C1: an <svg> counts as one element, so any node inside one resolves to the
 * outermost enclosing <svg>, even when svgs are nested. */
/** @param {Element} el
 * @returns {Element | null} */
function outermostSvgOf(el) {
  let found = /** @type {Element | null} */ (null)
  /** @type {Element | null} */
  let n = el
  while (n) {
    if (elTag(n) === 'svg') found = n
    n = n.parentElement
  }
  return found
}

/** The x/y of an element's inline `translate` style (0 when unset or unparseable). */
/** @param {Element} el */
function readTranslate(el) {
  const style = /** @type {HTMLElement | SVGElement} */ (el).style
  const value = style && style.translate
  if (typeof value === 'string') {
    const m = /^(-?(?:\d+(?:\.\d+)?|\.\d+))px\s+(-?(?:\d+(?:\.\d+)?|\.\d+))px$/.exec(value.trim())
    if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]) }
  }
  return { x: 0, y: 0 }
}

/** @param {Element} el
 * @param {number} x
 * @param {number} y */
function writeTranslate(el, x, y) {
  const style = /** @type {HTMLElement | SVGElement} */ (el).style
  if (x === 0 && y === 0) {
    style.removeProperty('translate')
    return
  }
  style.translate = `${x}px ${y}px`
}

/** Transforms and sizes don't apply to inline boxes; promote them first. */
/** @param {Window & typeof globalThis} win
 * @param {Element} el */
function ensureBlock(win, el) {
  const style = /** @type {HTMLElement | SVGElement} */ (el).style
  if (win.getComputedStyle(el).display === 'inline') style.display = 'inline-block'
}

/**
 * Rule 1. Gives every eligible element a `data-dm-id` of the form `e<N>`. Existing ids are
 * kept; duplicates (after the AI copied markup) are kept for the first element and the rest
 * are renumbered; each fresh number is one more than the highest already used. An <svg>
 * counts as one element and its children get nothing. Run it again after duplicate, undo
 * and redo, when the document has changed.
 * @param {Document} doc
 */
function assignElementIds(doc) {
  if (!doc.body) return
  let next = 0
  const seen = new Set()
  for (const el of doc.body.querySelectorAll(`[${ID_ATTR}]`)) {
    const m = /^e(\d+)$/.exec(el.getAttribute(ID_ATTR) || '')
    if (m && Number(m[1]) > next) next = Number(m[1])
  }
  next += 1
  const stack = /** @type {Element[]} */ ([doc.body])
  while (stack.length) {
    const el = stack.pop()
    if (!el || el.nodeType !== 1) continue
    const tag = elTag(el)
    if (el === doc.body) {
      const children = el.children
      for (let i = children.length - 1; i >= 0; i--) stack.push(/** @type {Element} */ (children[i]))
      continue
    }
    if (SKIP_TAGS.has(tag)) continue
    const attr = el.getAttribute(ID_ATTR)
    if (attr && !seen.has(attr)) {
      seen.add(attr)
    } else {
      const fresh = 'e' + next++
      el.setAttribute(ID_ATTR, fresh)
      seen.add(fresh)
    }
    if (tag === 'svg') continue
    const children = el.children
    for (let i = children.length - 1; i >= 0; i--) stack.push(/** @type {Element} */ (children[i]))
  }
}

/** Rule 3/4 label: lowercase tag, then ` · ` and a short hint (text or first class). */
/** @param {Element} el */
function labelFor(el) {
  const tag = elTag(el)
  const text = (el.textContent || '').trim()
  let hint = ''
  if (text) {
    hint = text.length > HOVER_TEXT_CUT ? text.slice(0, HOVER_TEXT_CUT) + '…' : text
  } else if (el.classList && el.classList.length) {
    hint = typeof el.classList[0] === 'string' ? el.classList[0] : ''
  }
  return hint ? `${tag} · ${hint}` : tag
}

/** Rule 6. An element has editable text when it has non-whitespace text children and every
 * element child is inline formatting, and it isn't a script/style/svg/textarea/input/select. */
/** @param {Element} el */
function hasEditableText(el) {
  const tag = elTag(el)
  if (NON_TEXT_TAGS.has(tag)) return false
  let hasText = false
  for (const node of el.childNodes) {
    if (node.nodeType === 3) {
      if ((node.textContent || '').trim() !== '') hasText = true
    } else if (node.nodeType === 1) {
      if (!INLINE_FORMAT_TAGS.has(elTag(/** @type {Element} */ (node)))) return false
    }
  }
  return hasText
}

const OVERLAY_HTML = `<style>
  .dm-hover, .dm-select, .dm-chip, .dm-readout, .dm-handle, .dm-guide-v, .dm-guide-h { display: none; position: absolute; pointer-events: none; }
  .dm-hover { border: 1px solid rgba(217,119,87,0.55); }
  .dm-select { border: 2px solid #d97757; }
  .dm-handle { width: 8px; height: 8px; background: #ffffff; border: 1.5px solid #d97757; border-radius: 50%; pointer-events: auto; }
  .dm-chip, .dm-readout { font: 11px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #ffffff; background: #d97757; border-radius: 6px; padding: 2px 6px; white-space: nowrap; }
  .dm-guide-v { width: 0; border-left: 1px dashed #d97757; }
  .dm-guide-h { height: 0; border-top: 1px dashed #d97757; }
</style>
<div class="dm-hover"></div>
<div class="dm-select"></div>
${HANDLE_DIRS.map((d) => `<div class="dm-handle" data-dir="${d}" style="cursor:${HANDLE_CURSORS[d]}"></div>`).join('\n')}
<div class="dm-chip"></div>
<div class="dm-readout"></div>
<div class="dm-guide-v"></div>
<div class="dm-guide-h"></div>`

/** Rule 2. Creates the overlay custom element (appended after <body> by the caller) with an
 * open shadow root holding the hover box, selection box, 8 handles, label chip, live readout
 * and snap guide lines. */
/** @param {Window & typeof globalThis} win */
function createOverlay(win) {
  if (typeof win.customElements.get(OVERLAY_TAG) !== 'function') {
    const klass = class DmEditorOverlay extends win.HTMLElement {
      constructor() {
        super()
        this.attachShadow({ mode: 'open' })
      }
    }
    win.customElements.define(OVERLAY_TAG, klass)
  }
  const overlay = /** @type {HTMLElement} */ (win.document.createElement(OVERLAY_TAG))
  overlay.style.setProperty('position', 'fixed')
  overlay.style.setProperty('inset', '0')
  overlay.style.setProperty('pointer-events', 'none')
  overlay.style.setProperty('z-index', '2147483647')
  const root = /** @type {ShadowRoot} */ (overlay.shadowRoot)
  root.innerHTML = OVERLAY_HTML
  const q = (/** @type {string} */ sel) => /** @type {HTMLElement} */ (root.querySelector(sel))
  return {
    overlay,
    hoverBox: q('.dm-hover'),
    selBox: q('.dm-select'),
    chip: q('.dm-chip'),
    readout: q('.dm-readout'),
    guideV: q('.dm-guide-v'),
    guideH: q('.dm-guide-h'),
    handles: Object.fromEntries(HANDLE_DIRS.map((d) => [d, q(`.dm-handle[data-dir="${d}"]`)]))
  }
}

/**
 * Installs the editor into `win` (the design page's window) and returns a handle.
 * @param {Window & typeof globalThis} win
 * @returns {EditorHandle}
 */
export function installEditor(win) {
  const doc = win.document
  if (!doc || !doc.documentElement) throw new Error('installEditor needs a window with a document')
  const ui = createOverlay(win)
  doc.documentElement.appendChild(ui.overlay)

  const state = {
    editing: true,
    selection: /** @type {Element | null} */ (null),
    hoverTarget: /** @type {Element | null} */ (null),
    textEl: /** @type {Element | null} */ (null),
    textStartHtml: '',
    textSnapshot: /** @type {UndoEntry | null} */ (null),
    drag: /** @type {DragSession | null} */ (null),
    guide: /** @type {{ axis: 'v' | 'h', pos: number } | null} */ (null),
    readout: /** @type {{ text: string, x: number, y: number } | null} */ (null),
    undo: /** @type {UndoEntry[]} */ ([]),
    redo: /** @type {UndoEntry[]} */ ([]),
    lastHoverId: /** @type {string | null} */ (null),
    changeTimer: 0,
    frameId: 0,
    destroyed: false
  }

  /** @param {object} msg */
  function post(msg) {
    win.parent.postMessage(msg, '*')
  }

  function requestUI() {
    if (state.destroyed || state.frameId) return
    state.frameId = win.requestAnimationFrame(() => {
      state.frameId = 0
      draw()
      postHover()
    })
  }

  /** @param {Element} el */
  function rectOf(el) {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
  }

  /** @param {string} id */
  function byId(id) {
    if (typeof id !== 'string' || !id) return null
    const escaped = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return /** @type {Element | null} */ (doc.querySelector(`[${ID_ATTR}="${escaped}"]`))
  }

  /** Shared eligibility helper for hover (eligibleAtPoint) and select (nearestEligible), so
   * they can't diverge again. Whether `el` may be hovered/selected on its own: inside <body>,
   * not body itself, not a skip tag, and — rule 1 / C1 — not inside an <svg> (an element
   * strictly inside an svg is never eligible itself; only the outermost enclosing svg is). */
  /** @param {Element} el */
  function isEligible(el) {
    if (!el || el.nodeType !== 1) return false
    if (el === doc.body) return false
    if (!doc.body || !doc.body.contains(el)) return false
    const svg = outermostSvgOf(el)
    if (svg) return svg === el
    return !SKIP_TAGS.has(elTag(el))
  }

  /** Nearest selectable element walking up from `node`, via the shared isEligible helper.
   * An element inside an <svg> is never eligible itself, so the walk continues past it up to
   * the outermost enclosing svg (rule 1 / C1). */
  /** @param {Node} node
 * @returns {Element | null} */
  function nearestEligible(node) {
    /** @type {Node | null} */
    let n = node
    while (n && n.nodeType === 1) {
      const el = /** @type {Element} */ (n)
      if (isEligible(el)) return el
      n = el.parentElement
    }
    return null
  }

  /** Topmost eligible element whose bounding rect contains the point (document order). */
  /** @param {number} x
 * @param {number} y
 * @returns {Element | null} */
  function eligibleAtPoint(x, y) {
    if (!doc.body) return null
    let best = null
    const stack = /** @type {Element[]} */ ([doc.body])
    while (stack.length) {
      const el = stack.pop()
      if (!el) continue
      const tag = elTag(el)
      if (tag !== 'svg') {
        const children = el.children
        for (let i = children.length - 1; i >= 0; i--) stack.push(/** @type {Element} */ (children[i]))
      }
      if (!isEligible(el)) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) best = el
    }
    return best
  }

  /** @param {Element} el */
  function ensureId(el) {
    const id = el.getAttribute(ID_ATTR) || ''
    if (/^e\d+$/.test(id)) return
    assignElementIds(doc)
  }

  /** @param {Element} el */
  function postSelect(el) {
    const text = (el.textContent || '').trim()
    post({
      source: EDITOR_SOURCE,
      type: 'select',
      id: /** @type {string} */ (el.getAttribute(ID_ATTR)),
      tag: elTag(el),
      label: labelFor(el),
      text: text ? text.slice(0, SELECT_TEXT_CUT) : null,
      editableText: hasEditableText(el),
      style: extractElementStyle(win, el),
      rect: rectOf(el),
      html: cleanOuterHtml(el).slice(0, HTML_CUT)
    })
  }

  /** @param {Element} el */
  function selectElement(el) {
    ensureId(el)
    state.selection = el
    if (state.textEl && state.textEl !== el) commitTextEditing()
    postSelect(el)
    requestUI()
  }

  /** @param {boolean} [force] Post `deselect` even when nothing was selected. M5: undo/redo
   * must always post select-or-deselect after restoring, even a no-op deselect. */
  function deselect(force) {
    if (!state.selection && !force) return
    state.selection = null
    state.hoverTarget = null
    state.lastHoverId = null
    state.readout = null
    post({ source: EDITOR_SOURCE, type: 'deselect' })
    requestUI()
  }

  /** @param {string} id */
  function selectById(id) {
    const el = byId(id)
    if (el) selectElement(el)
    else deselect()
  }

  function postHover() {
    if (!state.editing) return
    const el = state.hoverTarget
    let id = null
    let label = ''
    let rect = null
    if (el && el !== state.selection) {
      id = /** @type {string} */ (el.getAttribute(ID_ATTR))
      label = labelFor(el)
      rect = rectOf(el)
    }
    if (id === state.lastHoverId) return
    state.lastHoverId = id
    post({ source: EDITOR_SOURCE, type: 'hover', id, label, rect })
  }

  /** @param {HTMLElement} node
 * @param {DOMRect} r */
  function setRectBox(node, r) {
    node.style.left = `${Math.round(r.left)}px`
    node.style.top = `${Math.round(r.top)}px`
    node.style.width = `${Math.max(0, Math.round(r.width))}px`
    node.style.height = `${Math.max(0, Math.round(r.height))}px`
  }

  /** @param {string} dir
 * @param {DOMRect} r */
  function handlePosition(dir, r) {
    const h = HANDLE_SIZE / 2
    const cx = r.left + r.width / 2 - h
    const cy = r.top + r.height / 2 - h
    const map = {
      nw: [r.left - h, r.top - h],
      n: [cx, r.top - h],
      ne: [r.right - h, r.top - h],
      e: [r.right - h, cy],
      se: [r.right - h, r.bottom - h],
      s: [cx, r.bottom - h],
      sw: [r.left - h, r.bottom - h],
      w: [r.left - h, cy]
    }
    const pos = map[/** @type {keyof typeof map} */ (dir)]
    return { x: pos[0], y: pos[1] }
  }

  function draw() {
    if (!state.editing) return
    const s = state.selection
    const hov = state.hoverTarget && state.hoverTarget !== s ? state.hoverTarget : null
    if (hov) {
      const hr = hov.getBoundingClientRect()
      setRectBox(ui.hoverBox, hr)
      ui.hoverBox.style.display = 'block'
      // Until something is selected, the hovered element shows its own grab handles so a
      // grab-to-resize drag needs no prior click.
      if (!s) {
        for (const dir of HANDLE_DIRS) {
          const pos = handlePosition(dir, hr)
          ui.handles[dir].style.display = 'block'
          ui.handles[dir].style.left = `${pos.x}px`
          ui.handles[dir].style.top = `${pos.y}px`
        }
      }
    } else {
      ui.hoverBox.style.display = 'none'
    }
    if (s) {
      const r = s.getBoundingClientRect()
      setRectBox(ui.selBox, r)
      ui.selBox.style.display = 'block'
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      ui.chip.textContent = `${elTag(s)} · ${w} × ${h}`
      ui.chip.style.display = 'block'
      ui.chip.style.left = `${Math.round(r.left)}px`
      ui.chip.style.top = `${Math.max(0, Math.round(r.top) - 24)}px`
      for (const dir of HANDLE_DIRS) {
        const pos = handlePosition(dir, r)
        ui.handles[dir].style.display = 'block'
        ui.handles[dir].style.left = `${pos.x}px`
        ui.handles[dir].style.top = `${pos.y}px`
      }
    } else {
      ui.selBox.style.display = 'none'
      ui.chip.style.display = 'none'
      for (const dir of HANDLE_DIRS) ui.handles[dir].style.display = 'none'
    }
    if (state.readout) {
      ui.readout.textContent = state.readout.text
      ui.readout.style.display = 'block'
      ui.readout.style.left = `${Math.round(state.readout.x)}px`
      ui.readout.style.top = `${Math.round(state.readout.y)}px`
    } else {
      ui.readout.style.display = 'none'
    }
    const guide = state.guide
    if (guide && guide.axis === 'v') {
      ui.guideV.style.display = 'block'
      ui.guideV.style.left = `${Math.round(guide.pos)}px`
      ui.guideV.style.top = '0px'
      ui.guideV.style.height = '100%'
      ui.guideH.style.display = 'none'
    } else if (guide && guide.axis === 'h') {
      ui.guideH.style.display = 'block'
      ui.guideH.style.top = `${Math.round(guide.pos)}px`
      ui.guideH.style.left = '0px'
      ui.guideH.style.width = '100%'
      ui.guideV.style.display = 'none'
    } else {
      ui.guideV.style.display = 'none'
      ui.guideH.style.display = 'none'
    }
  }

  /** @param {'v' | 'h'} axis
 * @param {number} pos */
  function showGuide(axis, pos) {
    state.guide = { axis, pos }
  }

  function hideGuide() {
    state.guide = null
  }

  /** The handle under a pointer event, if any. Handles live in the overlay's shadow root, so a
   * window listener sees `e.target` retargeted to the overlay host; only the composed path
   * still holds the handle itself. */
  /** @param {Event} e */
  function handleDirAt(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target]
    for (const n of path) {
      const el = /** @type {HTMLElement} */ (n)
      if (el && el.nodeType === 1 && el.classList && el.classList.contains('dm-handle')) {
        return String(el.getAttribute('data-dir') || '')
      }
    }
    return null
  }

  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    if (!state.editing || state.drag) return
    if (e.buttons && (e.buttons & 1) !== 0) return
    state.hoverTarget = eligibleAtPoint(e.clientX, e.clientY)
    requestUI()
  }

  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (!state.editing) return
    const dir = handleDirAt(e)
    if (dir) {
      e.preventDefault()
      if (!state.selection && state.hoverTarget) selectElement(state.hoverTarget)
      startResize(e, dir)
      return
    }
    const el = nearestEligible(/** @type {Node} */ (e.target))
    if (state.textEl && el !== state.textEl) commitTextEditing()
    if (el) {
      if (state.textEl === el) return
      selectElement(el)
      if (e.cancelable) e.preventDefault()
      startMove(e, el)
    } else {
      deselect()
    }
  }

  /** @param {MouseEvent} e */
  function onDblClick(e) {
    if (!state.editing) return
    const el = nearestEligible(/** @type {Node} */ (e.target))
    if (el && el !== state.textEl && hasEditableText(el)) startTextEditing(el)
  }

  /** A move or resize drag must not also select the page text it passes over. */
  /** @param {Event} e */
  function onSelectStart(e) {
    if (state.editing && state.drag) e.preventDefault()
  }

  function onScroll() {
    requestUI()
  }

  function onResize() {
    requestUI()
  }

  function attachDragListeners() {
    win.addEventListener('pointermove', dragPointerMove, true)
    win.addEventListener('pointerup', dragPointerUp, true)
    win.addEventListener('pointercancel', dragPointerCancel, true)
  }

  function cleanupDragListeners() {
    win.removeEventListener('pointermove', dragPointerMove, true)
    win.removeEventListener('pointerup', dragPointerUp, true)
    win.removeEventListener('pointercancel', dragPointerCancel, true)
  }

  /** Rule 5: a pointerdown on an element arms a possible move; it starts after 3px. */
  /** @param {PointerEvent} e
 * @param {Element} el */
  function startMove(e, el) {
    if (state.drag) return
    ensureBlock(win, el)
    state.drag = {
      kind: 'move',
      el,
      startX: e.clientX,
      startY: e.clientY,
      rect0: el.getBoundingClientRect(),
      tx0: readTranslate(el).x,
      ty0: readTranslate(el).y,
      moved: false,
      shift: e.shiftKey,
      snapshot: null
    }
    attachDragListeners()
  }

  /** The corrected offsets plus which guide lines (v/h) engaged. */
  /** @param {DragSession} d
 * @param {number} dx
 * @param {number} dy
 * @returns {{ dx: number, dy: number, v: number | null, h: number | null }} */
  function snapGuidesFor(d, dx, dy) {
    const parent = d.el.parentElement || doc.body
    const pr = parent ? parent.getBoundingClientRect() : null
    if (!pr) return { dx, dy, v: null, h: null }
    const pcx = pr.left + pr.width / 2
    const pcy = pr.top + pr.height / 2
    const cx = d.rect0.left + dx + d.rect0.width / 2
    const cy = d.rect0.top + dy + d.rect0.height / 2
    let v = null
    let h = null
    let sx = dx
    let sy = dy
    if (Math.abs(cx - pcx) <= SNAP_DISTANCE_PX) {
      sx = pcx - (d.rect0.left + d.rect0.width / 2)
      v = pcx
    }
    if (Math.abs(cy - pcy) <= SNAP_DISTANCE_PX) {
      sy = pcy - (d.rect0.top + d.rect0.height / 2)
      h = pcy
    }
    return { dx: sx, dy: sy, v, h }
  }

  /** @param {PointerEvent} e */
  function dragMove(e) {
    const d = state.drag
    if (!d || d.kind !== 'move') return
    const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY)
    if (!d.moved && dist < MOVE_THRESHOLD_PX) return
    if (!d.moved) {
      d.moved = true
      d.snapshot = snapshotOf('move', d.el)
    }
    let dx = e.clientX - d.startX
    let dy = e.clientY - d.startY
    if (d.shift || e.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0
      else dx = 0
    }
    hideGuide()
    const snap = snapGuidesFor(d, dx, dy)
    if (snap.v !== null) showGuide('v', snap.v)
    else if (snap.h !== null) showGuide('h', snap.h)
    const nx = d.tx0 + snap.dx
    const ny = d.ty0 + snap.dy
    writeTranslate(d.el, nx, ny)
    state.readout = { text: `${Math.round(nx)}, ${Math.round(ny)}`, x: e.clientX + 10, y: e.clientY + 10 }
    requestUI()
  }

  /** Rule 5 resize: a corner/east/west handle drag changes width/height; west and north
   * also shift `translate` so the opposite edge stays put. */
  /** @param {PointerEvent} e
 * @param {string} dir */
  function startResize(e, dir) {
    if (state.drag || !state.selection) return
    const el = state.selection
    ensureBlock(win, el)
    const r = el.getBoundingClientRect()
    state.drag = {
      kind: 'resize',
      el,
      dir: /** @type {string} */ (dir),
      startX: e.clientX,
      startY: e.clientY,
      rect0: r,
      tx0: readTranslate(el).x,
      ty0: readTranslate(el).y,
      w0: r.width,
      h0: r.height,
      moved: false,
      shift: e.shiftKey,
      snapshot: null
    }
    attachDragListeners()
  }

  /** @param {PointerEvent} e */
  function resizeMove(e) {
    const d = state.drag
    if (!d || d.kind !== 'resize') return
    if (!d.moved && e.clientX === d.startX && e.clientY === d.startY) return
    if (!d.moved) {
      d.moved = true
      d.snapshot = snapshotOf('resize', d.el)
    }
    const dir = /** @type {string} */ (d.dir)
    const isW = dir.includes('w')
    const isE = dir.includes('e')
    const isN = dir.includes('n')
    const isS = dir.includes('s')
    let w = d.w0 || 0
    let h = d.h0 || 0
    if (isE) w = (d.w0 || 0) + (e.clientX - d.startX)
    else if (isW) w = (d.w0 || 0) - (e.clientX - d.startX)
    if (isS) h = (d.h0 || 0) + (e.clientY - d.startY)
    else if (isN) h = (d.h0 || 0) - (e.clientY - d.startY)
    w = Math.round(w)
    h = Math.round(h)
    // Rule 5 / M2: Shift toggles the aspect lock live, the same way move's axis lock reads it
    // (down at drag-start or right now both keep it engaged).
    const shiftNow = d.shift || e.shiftKey
    const keepAspect = isCorner(dir) && (MEDIA_TAGS.has(elTag(d.el)) ? !shiftNow : shiftNow)
    if (keepAspect && (d.h0 || 0) > 0) h = Math.round(w / ((d.w0 || 0) / (d.h0 || 0)))
    w = Math.max(MIN_SIZE, w)
    h = Math.max(MIN_SIZE, h)
    const style = /** @type {HTMLElement | SVGElement} */ (d.el).style
    style.width = `${w}px`
    style.height = `${h}px`
    let tx = d.tx0
    let ty = d.ty0
    if (isW) tx = d.tx0 - (w - (d.w0 || 0))
    if (isN) ty = d.ty0 - (h - (d.h0 || 0))
    writeTranslate(d.el, tx, ty)
    state.readout = { text: `${w} × ${h}`, x: e.clientX + 10, y: e.clientY + 10 }
    requestUI()
  }

  /** @param {PointerEvent} e */
  function dragPointerMove(e) {
    const d = state.drag
    if (!d) return
    if (e.cancelable) e.preventDefault()
    if (d.kind === 'move') dragMove(e)
    else resizeMove(e)
  }

  function endDrag() {
    const d = state.drag
    cleanupDragListeners()
    state.drag = null
    state.readout = null
    hideGuide()
    if (d && d.moved) {
      commitUndo(d.snapshot)
      postChange(d.kind === 'move' ? 'move' : 'resize')
      selectElement(d.el)
    }
    requestUI()
  }

  function dragPointerUp() {
    endDrag()
  }

  function dragPointerCancel() {
    endDrag()
  }

  /** Rule 7: keyboard shortcuts, handled in the capture phase while editing is on, an
   * element is selected, no text is being edited, and the event didn't start in a form field. */
  /** @param {KeyboardEvent} e */
  function onKeyDown(e) {
    if (!state.editing || state.textEl) return
    const t = /** @type {Node} */ (e.target)
    let n = t && t.nodeType === 1 ? /** @type {Element} */ (t) : null
    while (n) {
      if (/** @type {HTMLElement} */ (n).isContentEditable) return
      if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT') return
      n = n.parentElement
    }
    const meta = e.ctrlKey || e.metaKey
    const key = e.key
    const arrows = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1]
    }
    if (arrows[/** @type {keyof typeof arrows} */ (key)] && state.selection) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      nudge(key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0, key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0)
      return
    }
    if ((key === 'Delete' || key === 'Backspace') && state.selection) {
      e.preventDefault()
      deleteEl()
      return
    }
    if (meta && key === 'd' && state.selection) {
      e.preventDefault()
      duplicateEl()
      return
    }
    if (meta && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (meta && key === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if (key === 'Escape') {
      if (state.selection) {
        e.preventDefault()
        deselect()
      }
      return
    }
    if (key === 'Enter' && state.selection && !e.shiftKey && hasEditableText(state.selection)) {
      e.preventDefault()
      startTextEditing(state.selection)
      return
    }
    if (meta && key === ']' && state.selection) {
      e.preventDefault()
      bringForward()
      return
    }
    if (meta && key === '[' && state.selection) {
      e.preventDefault()
      sendBackward()
      return
    }
  }

  /** Rule 7 / I1: a burst of nudges on the same element makes one undo entry — its own 'nudge'
   * kind, distinct from a drag's 'move' entry, so a nudge right after a drag doesn't merge into
   * it — and one debounced change. */
  /** @param {number} dx
 * @param {number} dy */
  function nudge(dx, dy) {
    const el = /** @type {Element} */ (state.selection)
    const last = state.undo[state.undo.length - 1]
    if (!(last && last.kind === 'nudge' && last.targetId === el.getAttribute(ID_ATTR) && Date.now() - last.at < NUDGE_COALESCE_MS)) {
      commitUndo(snapshotOf('nudge', el))
    }
    ensureBlock(win, el)
    const t = readTranslate(el)
    writeTranslate(el, t.x + dx, t.y + dy)
    scheduleChange('move')
    requestUI()
  }

  /** Rule 6: start editing text on an element (double-click, Enter, or app driving it). */
  /** @param {Element} el */
  function startTextEditing(el) {
    if (state.textEl === el) return
    if (state.textEl) commitTextEditing()
    if (!hasEditableText(el)) return
    state.textEl = el
    state.textStartHtml = el.innerHTML
    state.textSnapshot = snapshotOf('text', el)
    el.setAttribute('contenteditable', 'true')
    el.setAttribute(EDITING_ATTR, '')
    const elHtml = /** @type {HTMLElement} */ (el)
    elHtml.addEventListener('keydown', onTextElKeydown)
    elHtml.focus()
    const range = doc.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const sel = win.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
    requestUI()
  }

  /** While editing, the element's own keys pass through; Escape and (for the listed tags)
   * plain Enter commit. */
  /** @param {Event} e */
  function onTextElKeydown(e) {
    const el = state.textEl
    if (!el) return
    const key = /** @type {KeyboardEvent} */ (e).key
    if (key === 'Escape') {
      e.preventDefault()
      commitTextEditing()
    } else if (key === 'Enter' && !/** @type {KeyboardEvent} */ (e).shiftKey && ENTER_COMMITS_TAGS.has(elTag(el))) {
      e.preventDefault()
      commitTextEditing()
    }
  }

  function commitTextEditing() {
    const el = state.textEl
    const snap = state.textSnapshot
    if (!el) return
    const changed = el.innerHTML !== state.textStartHtml
    el.removeAttribute('contenteditable')
    el.removeAttribute(EDITING_ATTR)
    el.removeEventListener('keydown', onTextElKeydown)
    state.textEl = null
    state.textSnapshot = null
    if (changed && snap) {
      commitUndo(snap)
      postChange('text')
      selectElement(el)
    }
    requestUI()
  }

  /** Rule 4: while editing, stop links, buttons and form submits from acting. */
  /** @param {Event} e */
  function onStaticClick(e) {
    if (!state.editing) return
    e.preventDefault()
    e.stopPropagation()
  }

  /** @param {Event} e */
  function onStaticSubmit(e) {
    if (!state.editing) return
    e.preventDefault()
  }

  /** Rule 9: delete. */
  function deleteEl() {
    const el = state.selection
    if (!el) return
    commitUndo(snapshotOf('delete', el))
    el.remove()
    state.selection = null
    state.hoverTarget = null
    state.lastHoverId = null
    post({ source: EDITOR_SOURCE, type: 'deselect' })
    postChange('delete')
    requestUI()
  }

  /** Rule 9: duplicate — a deep clone right after the element with fresh ids, then select it. */
  function duplicateEl() {
    const el = state.selection
    if (!el || !el.parentElement) return
    commitUndo(snapshotOf('duplicate', el))
    const clone = /** @type {Element} */ (el.cloneNode(true))
    el.parentElement.insertBefore(clone, el.nextSibling)
    assignElementIds(doc)
    selectElement(clone)
    postChange('duplicate')
    requestUI()
  }

  function bringForward() {
    reorder(1)
  }

  function sendBackward() {
    reorder(-1)
  }

  /** Rule 9: reorder the selected element in z. */
  /** @param {number} delta */
  function reorder(delta) {
    const el = state.selection
    if (!el) return
    commitUndo(snapshotOf('reorder', el))
    const style = /** @type {HTMLElement | SVGElement} */ (el).style
    const pos = win.getComputedStyle(el).position
    if (pos === 'static' || pos === '') style.position = 'relative'
    const cur = parseInt(style.zIndex, 10)
    const next = (Number.isNaN(cur) ? 0 : cur) + delta
    style.zIndex = String(next)
    postChange('reorder')
    requestUI()
  }

  /** Rule 10: a snapshot of the body for undo/redo. */
  /** @param {UndoKind} kind
 * @param {Element | null} targetEl */
  function snapshotOf(kind, targetEl) {
    const body = doc.body
    return {
      bodyHtml: body ? body.innerHTML : '',
      bodyStyle: body ? body.getAttribute('style') : null,
      selectedId: state.selection ? state.selection.getAttribute(ID_ATTR) : null,
      kind,
      targetId: targetEl ? targetEl.getAttribute(ID_ATTR) : null,
      at: Date.now()
    }
  }

  /** Push a captured snapshot; any new action clears the redo stack, and entry count is capped. */
  /** @param {UndoEntry | null} snap */
  function commitUndo(snap) {
    if (!snap) return
    state.undo.push(snap)
    if (state.undo.length > MAX_UNDO) state.undo.shift()
    state.redo.length = 0
  }

  function undo() {
    const entry = state.undo.pop()
    if (!entry) return
    state.redo.push(snapshotOf('redo', null))
    restore(entry, 'undo')
  }

  function redo() {
    const entry = state.redo.pop()
    if (!entry) return
    state.undo.push(snapshotOf('undo', null))
    restore(entry, 'redo')
  }

  /** @param {UndoEntry} entry
 * @param {ChangeReason} reason */
  function restore(entry, reason) {
    const body = doc.body
    if (!body) return
    if (entry.bodyStyle == null) body.removeAttribute('style')
    else body.setAttribute('style', entry.bodyStyle)
    body.innerHTML = entry.bodyHtml
    assignElementIds(doc)
    postChange(reason)
    if (entry.selectedId) {
      const el = byId(entry.selectedId)
      if (el) selectElement(el)
      else deselect(true)
    } else {
      deselect(true)
    }
    requestUI()
  }

  /** Rule 11: remove the overlay, editor scripts and editing markers from a subtree. */
  /** @param {Element} root */
  function stripEditorArtifacts(root) {
    const overlayEl = root.querySelector(OVERLAY_TAG)
    if (overlayEl) overlayEl.remove()
    for (const s of root.querySelectorAll(`[${EDITOR_SCRIPT_ATTR}]`)) s.remove()
    for (const el of root.querySelectorAll(`[${EDITING_ATTR}]`)) {
      el.removeAttribute('contenteditable')
      el.removeAttribute(EDITING_ATTR)
    }
  }

  /** Rule 11: serialize the page: doctype (when present), then the clean <html> clone. */
  function serialize() {
    let out = ''
    if (doc.doctype) out += `<!DOCTYPE ${doc.doctype.name}>\n`
    if (!doc.documentElement) return out
    const clone = /** @type {Element} */ (doc.documentElement.cloneNode(true))
    stripEditorArtifacts(clone)
    return out + clone.outerHTML
  }

  /** A select message's `html`: the element's outerHTML from a cleaned clone. */
  /** @param {Element} el */
  function cleanOuterHtml(el) {
    const clone = /** @type {Element} */ (el.cloneNode(true))
    for (const s of clone.querySelectorAll(`[${EDITOR_SCRIPT_ATTR}]`)) s.remove()
    for (const e of clone.querySelectorAll(`[${EDITING_ATTR}]`)) {
      e.removeAttribute('contenteditable')
      e.removeAttribute(EDITING_ATTR)
    }
    if (clone.getAttribute(EDITING_ATTR) != null) {
      clone.removeAttribute('contenteditable')
      clone.removeAttribute(EDITING_ATTR)
    }
    return clone.outerHTML
  }

  /** @param {ChangeReason} reason */
  function postChange(reason) {
    post({ source: EDITOR_SOURCE, type: 'change', html: serialize(), reason })
  }

  /** Debounce a `change` post; style nudges and setStyle coalesce by firing (only) 300ms
   * after the last one. */
  /** @param {ChangeReason} reason */
  function scheduleChange(reason) {
    if (state.changeTimer) win.clearTimeout(state.changeTimer)
    state.changeTimer = win.setTimeout(() => {
      state.changeTimer = 0
      postChange(reason)
    }, CHANGE_DEBOUNCE_MS)
  }

  /** @param {unknown} v */
  function validFontFamily(v) {
    return typeof v === 'string' && v.length <= 200 && !/[;{}<>]/.test(v)
  }

  /** @param {unknown} v
 * @param {number} min
 * @param {number} max */
  function validNum(v, min, max) {
    return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
  }

  /** @param {unknown} v */
  function validColor(v) {
    if (typeof v !== 'string') return false
    if (v === 'transparent') return true
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true
    if (/^rgba?\([^)]*\)$/.test(v)) return true
    return /^[A-Za-z]+$/.test(v)
  }

  /** @param {unknown} v */
  function validAlign(v) {
    return typeof v === 'string' && ['left', 'center', 'right', 'justify', 'start', 'end'].includes(v)
  }

  /** `normal`, a bare number, or a number with px/em/rem/%. */
  /** @param {unknown} v */
  function validSizeValue(v) {
    if (v === 'normal') return true
    if (typeof v === 'number' && Number.isFinite(v)) return true
    return typeof v === 'string' && /^-?(\d+(\.\d+)?|\.\d+)(px|em|rem|%)?$/.test(v)
  }

  /** `normal` or a (possibly negative) number with optional px/em/rem. */
  /** @param {unknown} v */
  function validLetterSpacing(v) {
    if (v === 'normal') return true
    if (typeof v === 'number' && Number.isFinite(v)) return true
    return typeof v === 'string' && /^-?(\d+(\.\d+)?|\.\d+)(px|em|rem)?$/.test(v)
  }

  /** @param {string | number} v
 * @returns {string} */
  function asCssNumber(v) {
    return typeof v === 'number' ? String(v) : v
  }

  /** Rule 8 setStyle: apply only the valid properties, as inline styles. */
  /** @param {Element} el
 * @param {ElementStyle} style */
  function applyStyle(el, style) {
    const s = style
    const elStyle = /** @type {HTMLElement | SVGElement} */ (el).style
    if (validFontFamily(s.fontFamily)) elStyle.fontFamily = s.fontFamily
    if (validNum(s.fontSize, 1, 1000)) elStyle.fontSize = `${s.fontSize}px`
    if (validNum(s.fontWeight, 1, 1000)) elStyle.fontWeight = String(s.fontWeight)
    if (validColor(s.color)) elStyle.color = s.color
    if (validColor(s.backgroundColor)) elStyle.backgroundColor = s.backgroundColor
    if (validAlign(s.textAlign)) elStyle.textAlign = s.textAlign
    if (validSizeValue(s.lineHeight)) elStyle.lineHeight = asCssNumber(s.lineHeight)
    if (validSizeValue(s.borderRadius)) elStyle.borderRadius = asCssNumber(s.borderRadius)
    if (validLetterSpacing(s.letterSpacing)) elStyle.letterSpacing = asCssNumber(s.letterSpacing)
    if (validNum(s.opacity, 0, 1)) elStyle.opacity = String(s.opacity)
    const widthChange = s.width === 0 || s.width === null
    const heightChange = s.height === 0 || s.height === null
    if (widthChange) elStyle.removeProperty('width')
    else if (typeof s.width === 'number' && s.width > 0) {
      ensureBlock(win, el)
      elStyle.width = `${s.width}px`
    }
    if (heightChange) elStyle.removeProperty('height')
    else if (typeof s.height === 'number' && s.height > 0) {
      ensureBlock(win, el)
      elStyle.height = `${s.height}px`
    }
    if (typeof s.translateX === 'number' || typeof s.translateY === 'number') {
      const t = readTranslate(el)
      const tx = typeof s.translateX === 'number' ? s.translateX : t.x
      const ty = typeof s.translateY === 'number' ? s.translateY : t.y
      writeTranslate(el, tx, ty)
    }
  }

  /** @param {Extract<AppToEditor, { type: 'setStyle' }>} data */
  function handleSetStyle(data) {
    const { id, style } = data
    if (typeof id !== 'string' || !style || typeof style !== 'object') return
    const el = byId(id)
    if (!el) return
    const last = state.undo[state.undo.length - 1]
    if (!(last && last.kind === 'style' && last.targetId === id && Date.now() - last.at < STYLE_COALESCE_MS)) {
      commitUndo(snapshotOf('style', el))
    }
    applyStyle(el, /** @type {ElementStyle} */ (style))
    selectElement(el)
    scheduleChange('style')
  }

  /** @param {Extract<AppToEditor, { type: 'setText' }>} data */
  function handleSetText(data) {
    const { id, text } = data
    if (typeof id !== 'string' || typeof text !== 'string') return
    const el = byId(id)
    if (!el || !hasEditableText(el)) return
    commitUndo(snapshotOf('text', el))
    el.textContent = text
    postChange('text')
    selectElement(el)
  }

  /** @param {Extract<AppToEditor, { type: 'command' }>} data */
  function handleCommand(data) {
    switch (data.name) {
      case 'undo':
        undo()
        break
      case 'redo':
        redo()
        break
      case 'delete':
        deleteEl()
        break
      case 'duplicate':
        duplicateEl()
        break
      case 'deselect':
        deselect()
        break
      case 'bringForward':
        bringForward()
        break
      case 'sendBackward':
        sendBackward()
        break
    }
  }

  /** @param {Extract<AppToEditor, { type: 'setEditing' }>} data */
  function handleSetEditing(data) {
    if (typeof data.editing !== 'boolean') return
    if (data.editing) {
      state.editing = true
      ui.overlay.hidden = false
      requestUI()
    } else {
      state.readout = null
      hideGuide()
      if (state.textEl) commitTextEditing()
      if (state.drag) {
        cleanupDragListeners()
        state.drag = null
      }
      state.hoverTarget = null
      state.lastHoverId = null
      state.editing = false
      ui.overlay.hidden = true
    }
  }

  /** @param {Extract<AppToEditor, { type: 'loadFont' }>} data */
  function handleLoadFont(data) {
    const { family, href } = data
    if (typeof href !== 'string' || !href.startsWith(GOOGLE_FONTS_CSS_PREFIX)) return
    const head = doc.head
    if (!head) return
    for (const link of head.querySelectorAll('link[href]')) {
      if (link.getAttribute('href') === href) return
    }
    const link = doc.createElement('link')
    link.setAttribute('rel', 'stylesheet')
    link.setAttribute('href', href)
    if (typeof family === 'string') link.setAttribute('data-dm-font', family)
    head.appendChild(link)
  }

  /** Rule 8: accept only messages from the app. */
  /** @param {MessageEvent} e */
  function onMessage(e) {
    if (state.destroyed) return
    if (e.source !== win.parent) return
    const data = e.data
    if (!data || typeof data !== 'object' || data.source !== APP_SOURCE) return
    switch (data.type) {
      case 'setStyle':
        handleSetStyle(data)
        break
      case 'setText':
        handleSetText(data)
        break
      case 'command':
        handleCommand(data)
        break
      case 'setEditing':
        handleSetEditing(data)
        break
      case 'loadFont':
        handleLoadFont(data)
        break
    }
  }

  /** Rule 14. */
  function destroy() {
    state.destroyed = true
    win.removeEventListener('pointerdown', onPointerDown, true)
    win.removeEventListener('selectstart', onSelectStart, true)
    win.removeEventListener('pointermove', onPointerMove, true)
    win.removeEventListener('dblclick', onDblClick, true)
    win.removeEventListener('keydown', onKeyDown, true)
    win.removeEventListener('click', onStaticClick, true)
    win.removeEventListener('auxclick', onStaticClick, true)
    win.removeEventListener('submit', onStaticSubmit, true)
    win.removeEventListener('message', onMessage)
    win.removeEventListener('scroll', onScroll, true)
    win.removeEventListener('resize', onResize)
    cleanupDragListeners()
    if (state.textEl) state.textEl.removeEventListener('keydown', onTextElKeydown)
    if (state.changeTimer) win.clearTimeout(state.changeTimer)
    if (state.frameId) win.cancelAnimationFrame(state.frameId)
    ui.overlay.remove()
  }

  win.addEventListener('pointerdown', onPointerDown, true)
  win.addEventListener('selectstart', onSelectStart, true)
  win.addEventListener('pointermove', onPointerMove, true)
  win.addEventListener('dblclick', onDblClick, true)
  win.addEventListener('keydown', onKeyDown, true)
  win.addEventListener('click', onStaticClick, true)
  win.addEventListener('auxclick', onStaticClick, true)
  win.addEventListener('submit', onStaticSubmit, true)
  win.addEventListener('message', onMessage)
  win.addEventListener('scroll', onScroll, { capture: true, passive: true })
  win.addEventListener('resize', onResize)

  assignElementIds(doc)
  post({ source: EDITOR_SOURCE, type: 'ready' })
  requestUI()

  return { destroy, serialize, selectById }
}

// Auto-install only when served by the app (tests import the file from disk, so they don't):
if (import.meta.url.startsWith('deskmates-preview:')) installEditor(window)

/** Rule 12: read the computed style into an ElementStyle, plus the inline translate. Never
 * throws: every value falls back to a sensible default. */
/** @param {Window & typeof globalThis} win
 * @param {Element} el
 * @returns {ElementStyle} */
function extractElementStyle(win, el) {
  const cs = win.getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  const t = readTranslate(el)
  return {
    fontFamily: firstFontFamily(cs.fontFamily),
    fontSize: pxValue(cs.fontSize, 16),
    fontWeight: weightNumber(cs.fontWeight),
    color: makeHex(cs.color, '#000000'),
    backgroundColor: makeHex(cs.backgroundColor, 'transparent'),
    textAlign: cs.textAlign || '',
    lineHeight: cs.lineHeight || '',
    letterSpacing: cs.letterSpacing || '',
    borderRadius: cs.borderRadius || '',
    opacity: inOpacity(cs.opacity),
    width: Math.round(rect.width ?? parseFloat(/** @type {string} */ (cs.width)) ?? 0),
    height: Math.round(rect.height ?? parseFloat(/** @type {string} */ (cs.height)) ?? 0),
    translateX: t.x,
    translateY: t.y
  }
}

/** First family of a font-family list, without quotes.
 * @param {unknown} value */
function firstFontFamily(value) {
  if (typeof value !== 'string') return 'sans-serif'
  const first = (value.split(',')[0] || '').trim()
  if (!first) return 'sans-serif'
  return first.replace(/^['"]|['"]$/g, '')
}

/** @param {unknown} value
 * @param {number} fallback */
function pxValue(value, fallback) {
  if (typeof value === 'string') {
    const m = /^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/.exec(value.trim())
    if (m) return parseFloat(m[1])
  }
  return fallback
}

/** @param {unknown} value */
function weightNumber(value) {
  if (value === 'normal') return 400
  if (value === 'bold') return 700
  const n = parseFloat(/** @type {string} */ (value))
  return Number.isFinite(n) ? n : 400
}

/** @param {unknown} n */
function hex2(n) {
  const h = Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0')
  return h
}

/** Convert a computed color to #rrggbb. `transparent` (alpha 0) becomes the fallback.
 * @param {unknown} value
 * @param {string} fallback */
function makeHex(value, fallback) {
  if (typeof value !== 'string') return fallback
  const s = value.trim()
  let m
  if ((m = /^#([0-9a-fA-F]{3})$/.exec(s))) return `#${m[1].split('').map((c) => c + c).join('')}`
  if (/^#([0-9a-fA-F]{6})$/.test(s)) return s
  if ((m = /^#([0-9a-fA-F]{4})$/.exec(s))) return `#${m[1].split('').slice(0, 3).map((c) => c + c).join('')}`
  if (/^#([0-9a-fA-F]{8})$/.test(s)) return s.slice(0, 7)
  if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(s))) {
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4])
    if (alpha === 0) return fallback
    return `#${hex2(m[1])}${hex2(m[2])}${hex2(m[3])}`
  }
  return fallback
}

/** @param {unknown} value */
function inOpacity(value) {
  const n = parseFloat(/** @type {string} */ (value))
  if (!Number.isFinite(n)) return 1
  return Math.max(0, Math.min(1, n))
}