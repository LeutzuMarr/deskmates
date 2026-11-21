/**
 * Scripts the Chrome tools run inside a page. Plain JavaScript strings (not compiled functions), so
 * nothing the bundler adds can leak into the page. Elements get stable `ref_N` ids, kept in a
 * per-page registry, that the other tools accept.
 */

/** The registry and helpers every script starts with. Defines `R` (refs), `roleOf`, `nameOf`, `visible`, `interactive`. */
const PRELUDE = String.raw`
const KEY = '__deskmatesRefs';
const R = window[KEY] || (Object.defineProperty(window, KEY, { value: { map: new Map(), ids: new WeakMap(), next: 1 }, enumerable: false }), window[KEY]);
const refOf = (el) => {
  let id = R.ids.get(el);
  if (!id) { id = 'ref_' + (R.next++); R.ids.set(el, id); R.map.set(id, new WeakRef(el)); }
  return id;
};
const byRef = (ref) => { const w = R.map.get(String(ref)); const el = w && w.deref(); return el && el.isConnected ? el : null; };
const clip = (t, n) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox', password: 'textbox', date: 'textbox', 'datetime-local': 'textbox', month: 'textbox', time: 'textbox', week: 'textbox', color: 'button', file: 'button' };
const TAG_ROLES = { button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo', aside: 'complementary', form: 'form', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', ul: 'list', ol: 'list', li: 'listitem', dialog: 'dialog', p: 'paragraph', label: 'label', option: 'option', summary: 'button', video: 'video', audio: 'audio', iframe: 'iframe', article: 'article' };
const roleOf = (el) => {
  const explicit = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
  if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'input') return el.type === 'hidden' ? 'hidden' : (INPUT_ROLES[el.type] || 'textbox');
  if (tag === 'section' && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) return 'region';
  if (el.isContentEditable && (el.parentElement ? !el.parentElement.isContentEditable : true)) return 'textbox';
  return TAG_ROLES[tag] || 'generic';
};
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem']);
const interactive = (el, role) => INTERACTIVE.has(role) || (el.tabIndex >= 0 && el.hasAttribute('tabindex')) || el.hasAttribute('onclick');
const nameOf = (el) => {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return clip(aria, 120);
  const by = el.getAttribute('aria-labelledby');
  if (by) { const t = by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText || n.textContent : ''; }).join(' '); if (t.trim()) return clip(t, 120); }
  const tag = el.tagName.toLowerCase();
  if (tag === 'img') return clip(el.getAttribute('alt') || el.getAttribute('title') || '', 120);
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && l.innerText.trim()) return clip(l.innerText, 120); }
    const wrap = el.closest('label'); if (wrap && wrap.innerText.trim()) return clip(wrap.innerText, 120);
    if (['button', 'submit', 'reset'].includes(el.type) && el.value) return clip(el.value, 120);
    return clip(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '', 120);
  }
  const text = el.innerText || el.textContent || '';
  if (text.trim()) return clip(text, 120);
  return clip(el.getAttribute('title') || '', 120);
};
const visible = (el) => {
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 || style.display === 'contents';
};
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'path', 'defs']);
const children = (el) => { const kids = [...el.children]; if (el.shadowRoot) kids.unshift(...el.shadowRoot.children); return kids; };
const fieldInfo = (el) => ({ inputType: el.type || '', name: el.getAttribute('name') || '', autocomplete: el.getAttribute('autocomplete') || '', id: el.id || '', label: nameOf(el) });
const CONTAINERS = new Set(['main', 'form', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'list', 'table', 'row', 'dialog', 'article', 'listitem', 'group', 'menu', 'menubar', 'tablist', 'toolbar', 'grid', 'tree', 'listbox', 'radiogroup', 'tabpanel', 'document', 'application', 'feed', 'search']);
const ariaName = (el) => { const a = el.getAttribute('aria-label'); if (a && a.trim()) return clip(a, 120); const by = el.getAttribute('aria-labelledby'); if (by) { const t = by.split(/\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText || n.textContent : ''; }).join(' '); return clip(t, 120); } return ''; };
const lineFor = (el, role) => {
  const name = CONTAINERS.has(role) ? ariaName(el) : nameOf(el);
  let line = role + (name ? ' "' + name.replace(/"/g, "'") + '"' : '') + ' [' + refOf(el) + ']';
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' && el.getAttribute('href')) line += ' href="' + clip(el.getAttribute('href'), 100) + '"';
  if (/^h[1-6]$/.test(tag)) line += ' level=' + tag[1];
  if ((tag === 'input' || tag === 'textarea' || tag === 'select') && el.type !== 'password') {
    if (el.type === 'checkbox' || el.type === 'radio') line += el.checked ? ' checked' : ' unchecked';
    else if (el.value) line += ' value="' + clip(el.value, 80).replace(/"/g, "'") + '"';
  }
  if (el.type === 'password') line += ' (password: only the user types here)';
  if (el.disabled) line += ' disabled';
  return line;
};
`

/** read_page: the page as an indented accessibility-style tree, or only its interactive elements. */
export function readPageScript(options: { filter: 'all' | 'interactive'; depth: number; refId?: string; maxChars: number }): string {
  return `(() => { ${PRELUDE}
const opts = ${JSON.stringify(options)};
const root = opts.refId ? byRef(opts.refId) : document.body;
if (!root) return { error: 'No element ' + opts.refId + ' on the page any more. Read the page again.' };
const out = []; let size = 0; let cut = false;
const push = (depth, text) => { if (cut) return; const line = '  '.repeat(depth) + '- ' + text; size += line.length + 1; if (size > opts.maxChars) { cut = true; return; } out.push(line); };
const walk = (el, depth) => {
  if (cut || depth > opts.depth) return;
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag) || !visible(el)) return;
  const role = roleOf(el);
  if (role === 'hidden') return;
  const isInteractive = interactive(el, role);
  let next = depth;
  if (opts.filter === 'interactive') {
    if (isInteractive) push(0, lineFor(el, role));
  } else {
    if (role !== 'generic' || isInteractive) {
      push(depth, lineFor(el, role)); next = depth + 1;
      if (['heading', 'link', 'button', 'textbox', 'paragraph', 'option', 'label', 'img', 'cell', 'columnheader'].includes(role) && !el.querySelector('a,button,input,select,textarea,[role]')) return;
    }
    // Loose text right inside a container or a plain element (text in named elements is their name).
    if (role === 'generic' || CONTAINERS.has(role)) {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) { const t = clip(node.textContent, 160); if (t.length > 1) push(next, 'text "' + t.replace(/"/g, "'") + '"'); }
      }
    }
  }
  for (const kid of children(el)) walk(kid, next);
};
walk(root, 0);
return { url: location.href, title: document.title, tree: out.join('\\n'), truncated: cut };
})()`
}

/** find: elements whose tree line contains every word of the query, best matches first. */
export function findScript(query: string, limit = 20): string {
  return `(() => { ${PRELUDE}
const words = ${JSON.stringify(query.toLowerCase().split(/\s+/).filter(Boolean))};
const found = [];
const walk = (el) => {
  const tag = el.tagName.toLowerCase();
  if (SKIP.has(tag) || !visible(el)) return;
  const role = roleOf(el);
  if (role !== 'generic' && role !== 'hidden') {
    const line = lineFor(el, role);
    const hay = (line + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('name') || '')).toLowerCase();
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits === words.length && words.length > 0) found.push({ line, score: (interactive(el, role) ? 2 : 0) + (nameOf(el).toLowerCase() === words.join(' ') ? 3 : 0) });
  }
  for (const kid of children(el)) walk(kid);
};
walk(document.body);
found.sort((a, b) => b.score - a.score);
return { url: location.href, matches: found.slice(0, ${limit}).map((f) => f.line), total: found.length };
})()`
}

/** get_page_text: the article or main content first, else the whole body. */
export function pageTextScript(maxChars: number): string {
  return `(() => {
const main = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]') || document.body;
let text = (main && main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
if (main !== document.body && text.length < 200) text = (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
const truncated = text.length > ${maxChars};
return { url: location.href, title: document.title, text: truncated ? text.slice(0, ${maxChars}) : text, truncated };
})()`
}

/** Where to click an element (its centre, scrolled into view), and what it is. */
export function locateScript(ref: string, scroll = true): string {
  return `(() => { ${PRELUDE}
const el = byRef(${JSON.stringify(ref)});
if (!el) return { error: 'No element ${ref} on the page any more. Read the page again (read_page or find).' };
if (${scroll}) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
const r = el.getBoundingClientRect();
const target = el.closest('button,a,[role=button],[role=link],input,[role=menuitem],[role=tab]') || el;
return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: nameOf(target), role: roleOf(target), field: fieldInfo(el), url: location.href };
})()`
}

/** What sits under a point: the control a click there would press. */
export function pointScript(x: number, y: number): string {
  return `(() => { ${PRELUDE}
const el = document.elementFromPoint(${x}, ${y});
if (!el) return { name: '', role: '', url: location.href };
const target = el.closest('button,a,[role=button],[role=link],input,[role=menuitem],[role=tab],summary') || el;
return { name: nameOf(target), role: roleOf(target), field: fieldInfo(target), url: location.href, ref: refOf(target) };
})()`
}

/** The focused field, so typing into a password or code field can be refused. */
export const FOCUSED_FIELD_SCRIPT = `(() => { ${PRELUDE}
let el = document.activeElement;
while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
if (!el || el === document.body) return null;
return fieldInfo(el);
})()`

/** The name of the button a plain Enter in the focused field would press, or null. */
export const ENTER_TARGET_SCRIPT = `(() => { ${PRELUDE}
const el = document.activeElement;
if (!el || el.tagName.toLowerCase() !== 'input') return null;
const form = el.form;
if (!form) return null;
const button = form.querySelector('button[type=submit],input[type=submit],button:not([type])');
return button ? nameOf(button) : 'submit the form';
})()`

/** Scrolls an element into view. */
export function scrollToScript(ref: string): string {
  return `(() => { ${PRELUDE}
const el = byRef(${JSON.stringify(ref)});
if (!el) return { error: 'No element ${ref} on the page any more. Read the page again.' };
el.scrollIntoView({ block: 'center', behavior: 'instant' });
return { ok: true };
})()`
}

/** The field behind a ref, for checks before form_input. */
export function fieldScript(ref: string): string {
  return `(() => { ${PRELUDE}
const el = byRef(${JSON.stringify(ref)});
if (!el) return { error: 'No element ${ref} on the page any more. Read the page again.' };
return { field: fieldInfo(el), tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el), url: location.href };
})()`
}

/** form_input: sets a field's value the way a person would, firing input and change events. */
export function formInputScript(ref: string, value: unknown): string {
  return `(() => { ${PRELUDE}
const el = byRef(${JSON.stringify(ref)});
const value = ${JSON.stringify(value)};
if (!el) return { error: 'No element ${ref} on the page any more. Read the page again.' };
const tag = el.tagName.toLowerCase();
const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
el.scrollIntoView({ block: 'center', behavior: 'instant' });
if (tag === 'select') {
  const want = String(value);
  const option = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => o.text.trim().toLowerCase() === want.toLowerCase());
  if (!option) return { error: 'That list has no option "' + want + '". Its options: ' + [...el.options].map((o) => o.text.trim()).slice(0, 30).join(', ') };
  el.value = option.value; fire(); return { ok: true, set: option.text.trim() };
}
if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
  const on = value === true || value === 'true' || value === 'on' || value === 1;
  if (el.checked !== on) el.click();
  return { ok: true, set: el.checked ? 'checked' : 'unchecked' };
}
if (tag === 'input' || tag === 'textarea') {
  el.focus();
  const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
  fire(); return { ok: true, set: String(value) };
}
if (el.isContentEditable) { el.focus(); el.textContent = String(value); el.dispatchEvent(new InputEvent('input', { bubbles: true })); return { ok: true, set: String(value) }; }
return { error: '${ref} is a ' + roleOf(el) + ', not a field. Use computer to click it instead.' };
})()`
}

/** The page's viewport in CSS pixels, which is the screenshot's coordinate frame. */
export const VIEWPORT_SCRIPT = `({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1, url: location.href, title: document.title })`

/** document.readyState, for waiting after a navigation. */
export const READY_SCRIPT = `({ state: document.readyState, url: location.href, title: document.title })`
