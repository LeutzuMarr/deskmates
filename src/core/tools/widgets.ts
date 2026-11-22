/**
 * Inline widgets: the display tools the user's prompt describes (chart_display_v0, the card,
 * itinerary, recipe, quiz, map and message-compose displays, image_search results, the Visualizer's
 * show_widget and Artifact pages). Each becomes a self-contained HTML page saved under
 * <dataDir>/widgets and shown in the chat in a sandboxed frame (deskmates-preview://widget/<id>.html),
 * which reports its height so the frame fits it.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const WIDGET_URL_PREFIX = 'deskmates-preview://widget/'

/** What a widget tool returns; the chat draws `widget` as a frame. */
export interface WidgetResult {
  shown: true
  widget: string
  title: string
  note?: string
}

type Data = Record<string, unknown>

export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const str = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '')
const list = (value: unknown): Data[] => (Array.isArray(value) ? value.filter((v): v is Data => !!v && typeof v === 'object') : [])
const safeUrl = (value: unknown): string => {
  const url = str(value)
  return /^https?:\/\//i.test(url) ? url : ''
}

const BASE_CSS = `
:root{--bg:transparent;--card:#fffdf8;--ink:#1f1d1a;--muted:#6b665e;--faint:#9a958c;--rule:#e6e0d4;--accent:#c96442;--accent-soft:#f4e3da;--good:#2f7d4f;--bad:#b3412f;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--card:#262421;--ink:#f1ede4;--muted:#b4ada1;--faint:#8a8378;--rule:#3a3631;--accent:#e08a68;--accent-soft:#3b2a22;--good:#6cc290;--bad:#ec8b78}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,"Segoe UI",system-ui,sans-serif;overflow:hidden}
body{padding:2px}
h1{font-size:17px;margin:0 0 4px}h2{font-size:15px;margin:14px 0 6px}h3{font-size:14px;margin:0 0 2px}
p{margin:4px 0}.muted{color:var(--muted)}.faint{color:var(--faint);font-size:12px}
a{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:12px 14px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.stack{display:flex;flex-direction:column;gap:10px}
.row{display:flex;gap:10px;align-items:flex-start}
img.thumb{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;background:var(--rule)}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:12px;margin:2px 4px 2px 0}
button{font:inherit;border:1px solid var(--rule);background:var(--card);color:var(--ink);border-radius:999px;padding:5px 12px;cursor:pointer}
button:hover{border-color:var(--accent)}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--rule);padding:6px 8px;text-align:left;vertical-align:top}
ol,ul{margin:4px 0;padding-left:20px}
`

/** Reports the page height to the chat, so the frame grows and shrinks with the widget. */
const HEIGHT_SCRIPT = `<script>(function(){var id=location.pathname.split('/').pop();function send(){var d=document.documentElement;parent.postMessage({type:'deskmates-widget-height',id:id,height:Math.ceil(Math.max(d.scrollHeight,d.getBoundingClientRect().height,document.body?document.body.scrollHeight:0))+2},'*')}new ResizeObserver(send).observe(document.documentElement);addEventListener('load',send);send()})();</script>`

/** A whole page around a widget body. */
export function widgetPage(title: string, body: string, extraHead = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${BASE_CSS}</style>${extraHead}</head><body>${body}${HEIGHT_SCRIPT}</body></html>`
}

/** The colour ramps of the Visualizer's guide (prompts/visualize/visualize.md): 50, 100, 200, 400, 600, 800, 900. */
const RAMPS: Record<string, string[]> = {
  purple: ['#EEEDFE', '#CECBF6', '#AFA9EC', '#7F77DD', '#534AB7', '#3C3489', '#26215C'],
  teal: ['#E1F5EE', '#9FE1CB', '#5DCAA5', '#1D9E75', '#0F6E56', '#085041', '#04342C'],
  coral: ['#FAECE7', '#F5C4B3', '#F0997B', '#D85A30', '#993C1D', '#712B13', '#4A1B0C'],
  pink: ['#FBEAF0', '#F4C0D1', '#ED93B1', '#D4537E', '#993556', '#72243E', '#4B1528'],
  gray: ['#F1EFE8', '#D3D1C7', '#B4B2A9', '#888780', '#5F5E5A', '#444441', '#2C2C2A'],
  blue: ['#E6F1FB', '#B5D4F4', '#85B7EB', '#378ADD', '#185FA5', '#0C447C', '#042C53'],
  green: ['#EAF3DE', '#C0DD97', '#97C459', '#639922', '#3B6D11', '#27500A', '#173404'],
  amber: ['#FAEEDA', '#FAC775', '#EF9F27', '#BA7517', '#854F0B', '#633806', '#412402'],
  red: ['#FCEBEB', '#F7C1C1', '#F09595', '#E24B4A', '#A32D2D', '#791F1F', '#501313']
}

/** The ramp classes (c-blue…) for light and dark mode, as the guide describes them. */
function rampCss(): string {
  const shapes = (c: string): string => `.c-${c}>rect,.c-${c}>circle,.c-${c}>ellipse,.c-${c}>polygon,rect.c-${c},circle.c-${c},ellipse.c-${c}`
  const light = Object.entries(RAMPS)
    .map(([c, r]) => `${shapes(c)}{fill:${r[0]};stroke:${r[4]}}.c-${c}>.t,.c-${c}>.th{fill:${r[5]}}.c-${c}>.ts{fill:${r[4]}}`)
    .join('')
  const dark = Object.entries(RAMPS)
    .map(([c, r]) => `${shapes(c)}{fill:${r[5]};stroke:${r[2]}}.c-${c}>.t,.c-${c}>.th{fill:${r[1]}}.c-${c}>.ts{fill:${r[2]}}`)
    .join('')
  return `${light}@media (prefers-color-scheme:dark){${dark}}`
}

/** The host side of the Visualizer's design system: variables, SVG classes and pre-styled controls. */
const VISUAL_CSS = `
:root{--color-background-primary:#ffffff;--color-background-secondary:#f5f3ee;--color-background-tertiary:#efece5;--color-background-info:${RAMPS.blue![0]};--color-background-danger:${RAMPS.red![0]};--color-background-success:${RAMPS.green![0]};--color-background-warning:${RAMPS.amber![0]};
--color-text-primary:#1f1d1a;--color-text-secondary:#6b665e;--color-text-tertiary:#9a958c;--color-text-info:${RAMPS.blue![4]};--color-text-danger:${RAMPS.red![4]};--color-text-success:${RAMPS.green![4]};--color-text-warning:${RAMPS.amber![4]};
--color-border-tertiary:rgba(31,29,26,.15);--color-border-secondary:rgba(31,29,26,.3);--color-border-primary:rgba(31,29,26,.4);--color-border-info:${RAMPS.blue![4]};--color-border-danger:${RAMPS.red![4]};--color-border-success:${RAMPS.green![4]};--color-border-warning:${RAMPS.amber![4]};
--font-sans:"Inter Variable","Segoe UI",system-ui,sans-serif;--font-serif:"Source Serif 4","Georgia",serif;--font-mono:"JetBrains Mono",Consolas,monospace;
--border-radius-md:8px;--border-radius-lg:12px;--border-radius-xl:16px;
--p:var(--color-text-primary);--s:var(--color-text-secondary);--t:var(--color-text-tertiary);--bg2:var(--color-background-secondary);--b:var(--color-border-tertiary);color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--color-background-primary:#262421;--color-background-secondary:#2f2c28;--color-background-tertiary:#1f1d1a;--color-background-info:${RAMPS.blue![5]};--color-background-danger:${RAMPS.red![5]};--color-background-success:${RAMPS.green![5]};--color-background-warning:${RAMPS.amber![5]};
--color-text-primary:#f1ede4;--color-text-secondary:#b4ada1;--color-text-tertiary:#8a8378;--color-text-info:${RAMPS.blue![2]};--color-text-danger:${RAMPS.red![2]};--color-text-success:${RAMPS.green![2]};--color-text-warning:${RAMPS.amber![2]};
--color-border-tertiary:rgba(241,237,228,.15);--color-border-secondary:rgba(241,237,228,.3);--color-border-primary:rgba(241,237,228,.4);--color-border-info:${RAMPS.blue![2]};--color-border-danger:${RAMPS.red![2]};--color-border-success:${RAMPS.green![2]};--color-border-warning:${RAMPS.amber![2]}}}
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:var(--color-text-primary);font:400 16px/1.7 var(--font-sans);overflow:hidden}
body{padding:2px}h1{font-size:22px;font-weight:500;margin:0 0 8px}h2{font-size:18px;font-weight:500;margin:12px 0 6px}h3{font-size:16px;font-weight:500;margin:8px 0 4px}
a{color:var(--color-text-info)}code{font-family:var(--font-mono);font-size:.9em}
svg{display:block;max-width:100%}svg text{font-family:var(--font-sans)}
.t{font:400 14px var(--font-sans);fill:var(--color-text-primary)}.ts{font:400 12px var(--font-sans);fill:var(--color-text-secondary)}.th{font:500 14px var(--font-sans);fill:var(--color-text-primary)}
.box{fill:var(--color-background-secondary);stroke:var(--color-border-secondary)}.node{cursor:pointer}.node:hover{opacity:.82}
.arr{stroke:var(--color-text-secondary);stroke-width:1.5;fill:none}.leader{stroke:var(--color-text-tertiary);stroke-width:.5;stroke-dasharray:3 3;fill:none}
${rampCss()}
.vz-card{background:var(--color-background-primary);border:.5px solid var(--color-border-tertiary);border-radius:var(--border-radius-lg);padding:12px}
input[type=text],input[type=email],input[type=number],input[type=search],input[type=url],input[type=tel],input[type=password],input[type=date],input:not([type]),select,textarea{font:inherit;font-size:14px;height:36px;padding:0 10px;color:var(--color-text-primary);background:var(--color-background-primary);border:.5px solid var(--color-border-secondary);border-radius:var(--border-radius-md);outline:none}
textarea{height:auto;padding:8px 10px}input:hover,select:hover,textarea:hover{border-color:var(--color-border-primary)}input:focus,select:focus,textarea:focus{box-shadow:0 0 0 2px var(--color-border-info)}
button{font:inherit;font-size:14px;padding:6px 14px;color:var(--color-text-primary);background:transparent;border:.5px solid var(--color-border-secondary);border-radius:var(--border-radius-md);cursor:pointer}
button:hover{background:var(--color-background-secondary)}button:active{transform:scale(.98)}
input[type=range]{accent-color:var(--color-text-info);width:100%}
table{border-collapse:collapse}td,th{padding:4px 8px}
`

/** sendPrompt and openLink for Visualizer widgets; plain links open in the browser. */
const VISUAL_SCRIPT = `<script>(function(){var id=location.pathname.split('/').pop();window.sendPrompt=function(t){parent.postMessage({type:'deskmates-widget-prompt',id:id,text:String(t)},'*')};window.openLink=function(u){window.open(String(u),'_blank','noopener')};document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(a&&/^https?:/i.test(a.href)){e.preventDefault();window.open(a.href,'_blank','noopener')}},true)})();</script>`

/** A Visualizer widget (mcp__visualize__show_widget): SVG in a card, or an HTML fragment, on the guide's design system. */
export function visualPage(title: string, code: string): string {
  const body = /^\s*<svg/i.test(code) ? `<div class="vz-card">${code}</div>` : code
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${VISUAL_CSS}</style>${VISUAL_SCRIPT}</head><body>${body}</body></html>`
}

/** Saves a page as a widget and returns what the tool hands back. */
export function saveWidget(dataDir: string, title: string, html: string, note?: string): WidgetResult {
  const dir = join(dataDir, 'widgets')
  mkdirSync(dir, { recursive: true })
  const id = `${randomUUID()}.html`
  // A page that already has its own document gets the height reporter added before </body>.
  const page = /<html[\s>]/i.test(html) ? (/<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${HEIGHT_SCRIPT}</body>`) : html + HEIGHT_SCRIPT) : widgetPage(title, html)
  writeFileSync(join(dir, id), page, 'utf8')
  return { shown: true, widget: `${WIDGET_URL_PREFIX}${id}`, title, ...(note ? { note } : {}) }
}

// ---- Per-tool bodies --------------------------------------------------------------------------

function header(data: Data): string {
  const title = str(data.title) || str(data.summary_title)
  const summary = str(data.summary) || str(data.description)
  return `${title ? `<h1>${esc(title)}</h1>` : ''}${summary ? `<p class="muted">${esc(summary)}</p>` : ''}`
}

/** One product/option/place/link as a card: picture, name, details, price, rating, link. */
function itemCard(item: Data): string {
  const name = str(item.name) || str(item.title) || str(item.label)
  const image = safeUrl(item.image_url) || safeUrl(item.image) || safeUrl(item.thumbnail) || safeUrl(item.photo_url)
  const url = safeUrl(item.url) || safeUrl(item.link) || safeUrl(item.website)
  const detail = str(item.description) || str(item.blurb) || str(item.summary) || str(item.snippet) || str(item.tip) || str(item.notes) || str(item.address)
  const facts: string[] = []
  for (const key of ['price', 'rating', 'brand', 'category', 'duration', 'time', 'address', 'retailer', 'source']) {
    const value = str(item[key])
    if (value && value !== detail) facts.push(`<span class="pill">${esc(key === 'rating' ? `★ ${value}` : value)}</span>`)
  }
  const attributes = list(item.attributes)
  if (attributes.length) {
    facts.push(`<table>${attributes.map((a) => `<tr><td class="faint">${esc(str(a.label))}</td><td>${typeof a.value === 'boolean' ? (a.value ? '✓' : '✗') : esc(str(a.value))}</td></tr>`).join('')}</table>`)
  }
  for (const key of ['pros', 'cons', 'highlights', 'features', 'bullets', 'tips']) {
    const values = Array.isArray(item[key]) ? (item[key] as unknown[]).map(str).filter(Boolean) : []
    if (values.length) facts.push(`${key === 'bullets' ? '' : `<div class="faint">${esc(key)}</div>`}<ul>${values.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>`)
  }
  return `<div class="card">${image ? `<img class="thumb" src="${esc(image)}" alt="">` : ''}<h3>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(name || url)}</a>` : esc(name)}</h3>${detail ? `<p class="muted">${esc(detail)}</p>` : ''}${facts.join('')}</div>`
}

function cards(data: Data, key: string): string {
  return `${header(data)}<div class="grid">${list(data[key]).map(itemCard).join('')}</div>`
}

function itinerary(data: Data): string {
  const days = list(data.days)
    .map((day, i) => {
      const title = str(day.day_label) || str(day.title) || str(day.date) || `Day ${i + 1}`
      const items = list(day.items ?? day.activities ?? day.stops ?? day.locations)
        .map((it) => {
          const note = str(it.description) || str(it.blurb) || str(it.notes)
          return `<li><b>${esc(str(it.time) || str(it.arrival_time))}</b> ${esc(str(it.title) || str(it.name))}${note ? ` <span class="muted">— ${esc(note)}</span>` : ''}</li>`
        })
        .join('')
      return `<div class="card"><h3>${esc(title)}</h3>${str(day.summary) ? `<p class="muted">${esc(str(day.summary))}</p>` : ''}<ul>${items}</ul></div>`
    })
    .join('')
  return `${header(data)}<div class="stack">${days}</div>`
}

function steps(data: Data): string {
  const items = list(data.steps)
    .map((step, i) => `<div class="card row"><span class="pill">${i + 1}</span><div><h3>${esc(str(step.title) || str(step.name))}</h3><p class="muted">${esc(str(step.description) || str(step.body) || str(step.text))}</p></div></div>`)
    .join('')
  return `${header(data)}<div class="stack">${items}</div>`
}

function recipe(data: Data): string {
  const ingredients = list(data.ingredients)
    .map((it) => `<li>${esc([str(it.amount), str(it.unit), str(it.name) || str(it.item)].filter(Boolean).join(' '))}${str(it.notes) ? ` <span class="muted">(${esc(str(it.notes))})</span>` : ''}</li>`)
    .join('')
  // Steps refer to ingredients as {0001}: show that ingredient's amount and name there.
  const byId = new Map(list(data.ingredients).map((it) => [str(it.id), [str(it.amount), str(it.unit), str(it.name) || str(it.item)].filter(Boolean).join(' ')]))
  const method = list(data.steps)
    .map((s) => {
      const text = (str(s.content) || str(s.text) || str(s.instruction) || str(s.description)).replace(/\{(\w+)\}/g, (all, id: string) => byId.get(id) ?? all)
      return `<li>${str(s.title) ? `<b>${esc(str(s.title))}.</b> ` : ''}${esc(text)}${Number(s.timer_seconds) > 0 ? ` <span class="pill">${Math.round(Number(s.timer_seconds) / 60) || 1} min</span>` : ''}</li>`
    })
    .join('')
  return `${header(data)}${data.base_servings ? `<p class="faint">Serves ${esc(str(data.base_servings))}</p>` : ''}<div class="card"><h2>Ingredients</h2><ul>${ingredients}</ul><h2>Method</h2><ol>${method}</ol>${str(data.notes) ? `<p class="muted">${esc(str(data.notes))}</p>` : ''}</div>`
}

function translation(data: Data): string {
  const from = str(data.source_language) || str(data.source_lang)
  const to = str(data.target_language) || str(data.target_lang)
  return `${str(data.summary) ? `<p class="muted">${esc(str(data.summary))}</p>` : ''}<div class="card"><div class="faint">${esc(from)}</div><p>${esc(str(data.source_text))}</p><div class="faint" style="margin-top:8px">${esc(to)}</div><h1>${esc(str(data.translation))}</h1>${str(data.pronunciation) ? `<p class="muted">${esc(str(data.pronunciation))}</p>` : ''}</div>`
}

function messageCompose(data: Data): string {
  const kind = str(data.kind)
  const variants = list(data.variants)
    .map((v, i) => {
      const subject = str(v.subject)
      const body = str(v.body)
      const send = kind === 'email' ? `<a href="mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}" target="_blank"><button>Open in mail</button></a>` : ''
      return `<div class="card"><div class="faint">${esc(str(v.label))}</div>${subject ? `<h3>${esc(subject)}</h3>` : ''}<p id="b${i}" style="white-space:pre-wrap">${esc(body)}</p><div class="row"><button onclick="navigator.clipboard.writeText(document.getElementById('b${i}').innerText).then(()=>{this.textContent='Copied'})">Copy</button>${send}</div></div>`
    })
    .join('')
  return `${str(data.summary_title) ? `<h1>${esc(str(data.summary_title))}</h1>` : ''}<div class="stack">${variants}</div>`
}

function quiz(data: Data): string {
  const questions = list(data.questions)
  const payload = JSON.stringify(
    questions.map((q) => ({
      prompt: str(q.prompt) || str(q.question),
      options: list(q.options).map((o) => ({ id: str(o.id), text: str(o.text) })),
      correct: str(q.correct_option_id),
      explanation: str(q.explanation),
      hint: str(q.hint),
      good: str(q.correct_feedback),
      bad: str(q.incorrect_feedback)
    }))
  ).replace(/</g, '\\u003c')
  return `${header(data)}<div id="quiz" class="stack"></div><script>
var Q=${payload},score=0,done=0;var root=document.getElementById('quiz');
Q.forEach(function(q,i){var c=document.createElement('div');c.className='card';var h=document.createElement('h3');h.textContent=(i+1)+'. '+q.prompt;c.appendChild(h);
var box=document.createElement('div');box.className='row';box.style.flexWrap='wrap';var out=document.createElement('p');out.className='muted';
q.options.forEach(function(o){var b=document.createElement('button');b.textContent=o.text;b.onclick=function(){if(c.dataset.answered)return;c.dataset.answered=1;done++;var ok=o.id===q.correct;if(ok)score++;
b.style.borderColor=ok?'var(--good)':'var(--bad)';Array.prototype.forEach.call(box.children,function(x,k){if(q.options[k].id===q.correct)x.style.borderColor='var(--good)'});
out.textContent=(ok?(q.good||'Correct.'):(q.bad||'Not quite.'))+(q.explanation?' '+q.explanation:'');if(done===Q.length){var s=document.createElement('p');s.innerHTML='<b>Score: '+score+' / '+Q.length+'</b>';root.appendChild(s)}};box.appendChild(b)});
c.appendChild(box);if(q.hint){var hb=document.createElement('button');hb.textContent='Hint';hb.style.marginTop='6px';hb.onclick=function(){out.textContent=q.hint};c.appendChild(hb)}c.appendChild(out);root.appendChild(c)});
</script>`
}

const PALETTE = ['#c96442', '#3b7dd8', '#2f9e6e', '#d4a017', '#8e5cc7', '#d6457a', '#4aa3a3', '#7a7a7a', '#e07b39', '#5468d4', '#76a83a', '#b0506b']

/** chart_display_v0: a line, bar or scatter chart drawn as SVG. */
function chart(data: Data): string {
  const style = str(data.style) || 'bar'
  const series = list(data.series).slice(0, 12)
  const xLabels = Array.isArray((data.x_axis as Data | undefined)?.data) ? ((data.x_axis as Data).data as unknown[]).map(str) : []
  const W = 640
  const H = 300
  const pad = { l: 48, r: 12, t: 12, b: 36 }
  const pw = W - pad.l - pad.r
  const ph = H - pad.t - pad.b
  const points = series.map((s) =>
    style === 'scatter'
      ? list(s.points).map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      : (Array.isArray(s.values) ? (s.values as unknown[]) : []).map((v, i) => ({ x: i, y: Number(v) }))
  )
  const ys = points.flat().map((p) => p.y).filter(Number.isFinite)
  const xs = points.flat().map((p) => p.x).filter(Number.isFinite)
  if (ys.length === 0) return `${header(data)}<p class="muted">No data to draw.</p>`
  const yMin = Math.min(0, ...ys)
  const yMax = Math.max(...ys) === yMin ? yMin + 1 : Math.max(...ys)
  const count = style === 'scatter' ? 0 : Math.max(...points.map((p) => p.length), xLabels.length, 1)
  const xMin = style === 'scatter' ? Math.min(...xs) : 0
  const xMax = style === 'scatter' ? (Math.max(...xs) === xMin ? xMin + 1 : Math.max(...xs)) : count
  const sx = (x: number): number => pad.l + (style === 'scatter' ? ((x - xMin) / (xMax - xMin)) * pw : ((x + 0.5) / count) * pw)
  const sy = (y: number): number => pad.t + ph - ((y - yMin) / (yMax - yMin)) * ph
  let marks = ''
  points.forEach((pts, si) => {
    const color = str(series[si]?.color) || PALETTE[si % PALETTE.length]!
    if (style === 'bar') {
      const groupW = (pw / count) * 0.8
      const barW = groupW / points.length
      pts.forEach((p) => {
        const x = pad.l + (p.x / count) * pw + (pw / count) * 0.1 + si * barW
        marks += `<rect x="${x.toFixed(1)}" y="${Math.min(sy(p.y), sy(0)).toFixed(1)}" width="${Math.max(barW - 2, 1).toFixed(1)}" height="${Math.abs(sy(p.y) - sy(0)).toFixed(1)}" rx="3" fill="${esc(color)}"><title>${esc(str(series[si]?.name))}: ${p.y}</title></rect>`
      })
    } else if (style === 'line') {
      marks += `<polyline fill="none" stroke="${esc(color)}" stroke-width="2.5" points="${pts.filter((p) => Number.isFinite(p.y)).map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' ')}"/>`
      marks += pts.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${esc(color)}"><title>${esc(str(series[si]?.name))}: ${p.y}</title></circle>`).join('')
    } else {
      marks += pts.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" fill="${esc(color)}" fill-opacity=".8"><title>${p.x}, ${p.y}</title></circle>`).join('')
    }
  })
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin))
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${sy(t).toFixed(1)}" y2="${sy(t).toFixed(1)}" stroke="var(--rule)"/><text x="${pad.l - 6}" y="${(sy(t) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--muted)">${Number(t.toPrecision(4))}</text>`).join('')
  const step = Math.max(1, Math.ceil(count / 10))
  const xText =
    style === 'scatter'
      ? [0, 0.5, 1].map((f) => { const v = xMin + f * (xMax - xMin); return `<text x="${sx(v).toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="var(--muted)">${Number(v.toPrecision(4))}</text>` }).join('')
      : xLabels.map((label, i) => (i % step === 0 ? `<text x="${sx(i).toFixed(1)}" y="${H - 14}" text-anchor="middle" font-size="11" fill="var(--muted)">${esc(label.slice(0, 14))}</text>` : '')).join('')
  const legend = series.length > 1 || str(series[0]?.name) ? `<div>${series.map((s, i) => `<span class="pill" style="background:transparent;color:var(--ink)"><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${esc(str(s.color) || PALETTE[i % PALETTE.length]!)};margin-right:5px"></span>${esc(str(s.name))}</span>`).join('')}</div>` : ''
  return `${header(data)}<div class="card"><svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${grid}${marks}${xText}</svg>${legend}</div>`
}

/** places_list_display_v0 / places_map_display_v0: a map (OpenStreetMap) above the places. */
function places(data: Data, withMap: boolean): string {
  const items = list(data.places ?? data.locations)
  const located = items.filter((p) => Number.isFinite(Number(p.latitude ?? p.lat)) && Number.isFinite(Number(p.longitude ?? p.lng ?? p.lon)))
  let map = ''
  if (withMap && located.length > 0) {
    const lats = located.map((p) => Number(p.latitude ?? p.lat))
    const lngs = located.map((p) => Number(p.longitude ?? p.lng ?? p.lon))
    const m = 0.01
    const bbox = [Math.min(...lngs) - m, Math.min(...lats) - m, Math.max(...lngs) + m, Math.max(...lats) + m].join(',')
    const marker = located.length === 1 ? `&marker=${lats[0]},${lngs[0]}` : ''
    map = `<iframe title="Map" src="https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik${marker}" style="width:100%;height:280px;border:1px solid var(--rule);border-radius:14px"></iframe>`
  }
  const cardsHtml = items
    .map((p, i) => {
      const lat = Number(p.latitude ?? p.lat)
      const lng = Number(p.longitude ?? p.lng ?? p.lon)
      const osm = Number.isFinite(lat) && Number.isFinite(lng) ? `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}` : ''
      return itemCard({ ...p, name: `${i + 1}. ${str(p.name) || str(p.title)}`, url: safeUrl(p.url) || safeUrl(p.website) || osm })
    })
    .join('')
  return `${header(data)}<div class="stack">${map}<div class="grid">${cardsHtml}</div></div>`
}

/** Anything else: its fields laid out readably. */
function generic(data: unknown, depth = 0): string {
  if (Array.isArray(data)) {
    if (data.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return `<div class="grid">${(data as Data[]).map((v) => (depth < 2 ? itemCard(v) : generic(v, depth + 1))).join('')}</div>`
    return `<ul>${data.map((v) => `<li>${typeof v === 'object' ? generic(v, depth + 1) : esc(str(v))}</li>`).join('')}</ul>`
  }
  if (data && typeof data === 'object') {
    return Object.entries(data as Data)
      .map(([key, value]) => (typeof value === 'object' && value !== null ? `<h2>${esc(key.replace(/_/g, ' '))}</h2>${generic(value, depth + 1)}` : `<p><span class="faint">${esc(key.replace(/_/g, ' '))}</span> ${esc(str(value))}</p>`))
      .join('')
  }
  return esc(str(data))
}

/** The HTML body for one display tool's input. */
export function displayBody(toolName: string, input: Data): string {
  switch (toolName) {
    case 'chart_display_v0':
      return chart(input)
    case 'comparison_card_display_v0':
    case 'featured_card_display_v0':
    case 'product_carousel_display_v0':
      return cards(input, 'products')
    case 'link_preview_display_v0':
      return cards(input, 'links')
    case 'options_card_display_v0':
      return cards(input, 'options')
    case 'itinerary_display_v0':
      return itinerary(input)
    case 'step_card_display_v0':
      return steps(input)
    case 'recipe_display_v0':
      return recipe(input)
    case 'translation_display_v0':
      return translation(input)
    case 'message_compose_v1':
      return messageCompose(input)
    case 'quiz_display_v0':
      return quiz(input)
    case 'places_list_display_v0':
      return places(input, false)
    case 'places_map_display_v0':
      return places(input, true)
    default:
      return `${header(input)}${generic(Object.fromEntries(Object.entries(input).filter(([k]) => !['title', 'summary', 'description'].includes(k))))}`
  }
}

/** image_search results as a gallery. */
export function imageGallery(query: string, images: Array<{ title: string; url: string; thumbnail: string; source: string; license: string }>): string {
  return `<p class="faint">Images for “${esc(query)}”</p><div class="grid">${images
    .map((img) => `<div class="card"><a href="${esc(img.source || img.url)}" target="_blank" rel="noopener"><img class="thumb" src="${esc(img.thumbnail || img.url)}" alt="${esc(img.title)}"></a><p class="faint">${esc(img.title)}${img.license ? ` · ${esc(img.license)}` : ''}</p></div>`)
    .join('')}</div>`
}

/** Deletes the widget pages a chat's stored messages point to, when that chat is deleted. */
export function removeWidgetsOf(dataDir: string, messages: unknown): number {
  const text = JSON.stringify(messages ?? '')
  const ids = new Set(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.html/gi) ?? [])
  let removed = 0
  for (const id of ids) {
    if (!text.includes(`${WIDGET_URL_PREFIX}${id}`)) continue
    try {
      rmSync(join(dataDir, 'widgets', id), { force: true })
      removed++
    } catch {
      // Already gone, or locked: nothing to do.
    }
  }
  return removed
}
