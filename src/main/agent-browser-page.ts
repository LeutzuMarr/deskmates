/**
 * Scripts the agent browser runs inside pages. They stay self-contained strings (no imports): they
 * are evaluated in the page with `executeJavaScript`, in the page's own world. The sensitive-field
 * rule is repeated here on purpose, so a field is refused by the page itself even if the caller's
 * list of elements is stale.
 */

/** Shared helpers, prepended to each script below. */
const HELPERS = String.raw`
  const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const SENSITIVE_NAME = /pass(word|wd|code)?\b|parol|passwort|contrasena|\botp\b|otp[_-]?code|one[\s_-]?time|2fa|mfa|totp|verification[\s_-]?code|cod[\s_-]?(de[\s_-]?)?verificare|\bcvv\b|\bcvc\b|\bcsc\b|card[\s_-]?(number|num|no)|cardnumber|\bcc[\s_-]?(num|number)\b|\biban\b|\bcnp\b|\bssn\b|social[\s_-]?security|passport|pasaport|\bpin\b/;
  const labelOf = (el) => {
    const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (aria.trim()) return aria.trim();
    if (el.id) {
      const forLabel = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (forLabel && forLabel.innerText.trim()) return forLabel.innerText.trim();
    }
    const wrapping = el.closest('label');
    if (wrapping && wrapping.innerText.trim()) return wrapping.innerText.trim();
    const text = (el.innerText || el.value || '').trim();
    if (text) return text;
    return (el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('alt') || '').trim();
  };
  const isField = (el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || ['textbox', 'combobox', 'searchbox'].includes(el.getAttribute('role') || '');
  const isSensitive = (el) => {
    if (!isField(el)) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/current-password|new-password|one-time-code|(^|\s)cc-/.test(ac)) return true;
    return [el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.tagName === 'INPUT' ? labelOf(el) : '']
      .some((v) => v && SENSITIVE_NAME.test(fold(v)));
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const find = (n) => document.querySelector('[data-dm-n="' + n + '"]');
`

/** Numbers the page's interactive elements and returns its text and the list. */
export const READ_PAGE_SCRIPT = String.raw`(() => {
  ${HELPERS}
  const MAX_TEXT = 30000, MAX_ELEMENTS = 300;
  document.querySelectorAll('[data-dm-n]').forEach((el) => el.removeAttribute('data-dm-n'));
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=radio], [role=option], [role=switch], [role=combobox], [role=textbox], [contenteditable=""], [contenteditable=true]';
  const elements = [];
  let n = 0, more = false, signIn = false;
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el) || el.closest('[aria-hidden=true]') || el.disabled) continue;
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : undefined;
    const sensitive = isSensitive(el);
    if (inputType === 'password') signIn = true;
    if (n >= MAX_ELEMENTS) { more = true; break; }
    n += 1;
    el.setAttribute('data-dm-n', String(n));
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'select' ? 'select' : tag === 'textarea' ? 'textbox' : tag === 'input' ? (['checkbox', 'radio', 'submit', 'button'].includes(inputType) ? inputType : 'textbox') : el.isContentEditable ? 'textbox' : tag);
    const item = { n, role, name: labelOf(el).replace(/\s+/g, ' ').slice(0, 120), tag, sensitive };
    if (inputType) item.inputType = inputType;
    if (!sensitive && (tag === 'input' || tag === 'textarea' || tag === 'select') && el.value && inputType !== 'submit' && inputType !== 'button') item.value = String(el.value).slice(0, 200);
    if (inputType === 'checkbox' || inputType === 'radio') item.value = el.checked ? 'checked' : 'unchecked';
    elements.push(item);
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  return { url: location.href, title: document.title, text: text.slice(0, MAX_TEXT), elements, signIn, truncated: text.length > MAX_TEXT || more };
})()`

/** Scrolls element `n` into view and returns its centre, or why it can't be clicked. */
export function locateScript(n: number): string {
  return String.raw`(() => {
    ${HELPERS}
    const el = find(${Number(n)});
    if (!el) return { error: 'missing' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + Math.min(r.width / 2, Math.max(4, r.width - 4)));
    const y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    return { x, y, name: labelOf(el).replace(/\s+/g, ' ').slice(0, 120), covered: !!top && top !== el && !el.contains(top) && !top.contains(el) };
  })()`
}

/** Focuses element `n` for typing and selects what's in it, refusing sensitive fields. */
export function focusForTypingScript(n: number): string {
  return String.raw`(() => {
    ${HELPERS}
    const el = find(${Number(n)});
    if (!el) return { error: 'missing' };
    if (isSensitive(el)) return { error: 'sensitive' };
    const tag = el.tagName.toLowerCase();
    if (!(tag === 'input' || tag === 'textarea' || el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox')) return { error: 'not-a-field' };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (tag === 'input' || tag === 'textarea') { el.select && el.select(); }
    else {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { ok: true, name: labelOf(el).replace(/\s+/g, ' ').slice(0, 120) };
  })()`
}

/** Whether the focused element is a sensitive field (checked before every key press). */
export const FOCUSED_IS_SENSITIVE_SCRIPT = String.raw`(() => {
  ${HELPERS}
  const el = document.activeElement;
  return !!el && el !== document.body && isSensitive(el);
})()`

/** Name of element `n`, without touching the page. */
export function nameOfScript(n: number): string {
  return String.raw`(() => {
    ${HELPERS}
    const el = find(${Number(n)});
    return el ? labelOf(el).replace(/\s+/g, ' ').slice(0, 120) : null;
  })()`
}

/** The label of the form submit button the focused field would trigger with Enter, if any. */
export const ENTER_SUBMITS_SCRIPT = String.raw`(() => {
  ${HELPERS}
  const el = document.activeElement;
  if (!el || el.tagName === 'TEXTAREA' || el.isContentEditable) return null;
  const form = el.form || el.closest('form');
  if (!form) return null;
  const button = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
  return button ? labelOf(button) || 'Submit' : 'Submit';
})()`

export function scrollScript(direction: 'up' | 'down' | 'top' | 'bottom', amount: number): string {
  const by = Math.max(0.2, Math.min(amount, 5))
  const code =
    direction === 'top'
      ? 'window.scrollTo(0, 0)'
      : direction === 'bottom'
        ? 'window.scrollTo(0, document.documentElement.scrollHeight)'
        : `window.scrollBy(0, ${direction === 'down' ? '' : '-'}window.innerHeight * ${by})`
  return `(() => { ${code}; return { y: Math.round(window.scrollY), max: Math.round(document.documentElement.scrollHeight - window.innerHeight) }; })()`
}
