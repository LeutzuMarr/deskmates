import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { DC_RUNTIME_URL } from '../../shared/design-bridge'
import { MAX_DESIGN_HTML_BYTES } from '../../shared/protocol'
import { resolveInside, toProjectRelative } from '../fs/safe-path'
import type { ToolContext } from './context'
import { writeTracked } from './files'
import { noteUserView } from './design-visual'
import androidFrame from './starters/android-frame.js?raw'
import browserWindow from './starters/browser-window.js?raw'
import deckStage from './starters/deck-stage.js?raw'
import motionStage from './starters/motion-stage.js?raw'
import docPage from './starters/doc-page.js?raw'
import imageSlot from './starters/image-slot.js?raw'
import iosFrame from './starters/ios-frame.js?raw'
import macosWindow from './starters/macos-window.js?raw'


const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const escapeAttr = (text: string): string => text.replace(/&/g, '&amp;').replace(/'/g, '&#39;')
const unescapeAttr = (text: string): string =>
  text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

export interface DcParts {
  title: string
  template: string
  logic: string
  propsJson: string
}

/** The whole `.dc.html` file for a template, logic class and data-props JSON. */
export function buildDcFile({ title, template, logic, propsJson }: DcParts): string {
  const props = propsJson.trim() ? ` data-props='${escapeAttr(propsJson.trim())}'` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<!-- A Design Component: dc-support.js renders the x-dc template below with the logic class. It is served inside Deskmates; to open this file anywhere else, serve a copy of dc-support.js over http(s) and point this script at it. -->
<script src="${DC_RUNTIME_URL}"></script>
</head>
<body>
<x-dc>
${template}
</x-dc>
<script type="text/x-dc-logic" data-dc-script${props}>
${logic}
</script>
</body>
</html>
`
}

const X_DC_OPEN = /<x-dc\b(?:[^>"']|"[^"]*"|'[^']*')*>/i
const LOGIC_OPEN = /<script\b(?:[^>"']|"[^"]*"|'[^']*')*\bdata-dc-script\b(?:[^>"']|"[^"]*"|'[^']*')*>/i

interface Region {
  start: number
  end: number
}

/** The template's and the logic script's positions in a DC file; the regions exclude the surrounding newline dc_write adds. */
function locate(text: string): { template: Region; logic: Region; logicTag: Region } {
  const commentless = text.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length))
  const open = X_DC_OPEN.exec(commentless)
  const close = text.toLowerCase().lastIndexOf('</x-dc>')
  if (!open || close < open.index) throw new Error('This file has no <x-dc> template, so it is not a Design Component. Rewrite it with dc_write.')
  const template = trimNewlines(text, open.index + open[0].length, close)
  const tag = LOGIC_OPEN.exec(text.slice(close))
  if (!tag) throw new Error('This file has no <script data-dc-script> logic block. Rewrite it with dc_write.')
  const tagStart = close + tag.index
  const bodyStart = tagStart + tag[0].length
  const bodyEnd = text.toLowerCase().indexOf('</script', bodyStart)
  if (bodyEnd === -1) throw new Error('The logic <script> block is not closed. Rewrite the file with dc_write.')
  return { template, logic: trimNewlines(text, bodyStart, bodyEnd), logicTag: { start: tagStart, end: bodyStart } }
}

function trimNewlines(text: string, start: number, end: number): Region {
  let s = start
  let e = end
  if (text.startsWith('\r\n', s)) s += 2
  else if (text[s] === '\n') s += 1
  if (e - 2 >= s && text.slice(e - 2, e) === '\r\n') e -= 2
  else if (e - 1 >= s && text[e - 1] === '\n') e -= 1
  return { start: s, end: e }
}

/** Splits a DC file into its parts. */
export function readDcParts(text: string): DcParts {
  const { template, logic, logicTag } = locate(text)
  const props = /\bdata-props\s*=\s*(?:'([^']*)'|"([^"]*)")/i.exec(text.slice(logicTag.start, logicTag.end))
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)
  return {
    title: title ? title[1] : '',
    template: text.slice(template.start, template.end),
    logic: text.slice(logic.start, logic.end),
    propsJson: props ? unescapeAttr(props[1] ?? props[2] ?? '') : ''
  }
}

/** Throws when the template carries document scaffolding or scripts outside <helmet>. */
function checkTemplate(template: string): void {
  if (/<\/?x-dc\b/i.test(template)) throw new Error('Pass only the markup that goes between <x-dc> and </x-dc>, without those tags.')
  if (/<!doctype|<\/?(html|head|body)\b/i.test(template)) {
    throw new Error('The template must not contain <!DOCTYPE>, <html>, <head> or <body>; dc_write adds the document around it.')
  }
  const outsideHelmet = template.replace(/<helmet\b[\s\S]*?<\/helmet>/gi, '')
  if (/<script\b/i.test(outsideHelmet)) {
    throw new Error('<script> tags are only allowed inside <helmet>. Put logic in the logic class (c_dc_js).')
  }
}

function checkLogic(logic: string): void {
  if (/<\/?script\b/i.test(logic)) throw new Error('Pass the logic class source only, without <script> tags.')
  if (!logic.trim()) return
  if (/^\s*(import|export)\s[^(]/m.test(logic)) {
    throw new Error('The logic is plain classic JavaScript: no import/export statements (dynamic import() works).')
  }
  if (!/\bclass\s+Component\b/.test(logic)) throw new Error('The logic must define `class Component extends DCLogic { … }`.')
}

function checkProps(propsJson: string): void {
  if (!propsJson.trim()) return
  let parsed: unknown
  try {
    parsed = JSON.parse(propsJson)
  } catch (error) {
    throw new Error(`The props JSON is not valid: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The props JSON must be an object.')
}

const PATH_HOLE = /^\s*(?:[$A-Za-z_][\w$]*(?:\.[\w$]+)*|true|false|null|undefined|-?\d+(?:\.\d+)?|"[^"]*"|'[^']*')\s*$/

/** Non-fatal problems in a template, so the model can fix them before the user notices. */
export function lintTemplate(template: string): string[] {
  const warnings: string[] = []
  for (const match of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    if (!PATH_HOLE.test(match[1])) {
      warnings.push(`{{${match[1]}}} is not a plain name or dotted path and will render nothing; compute it in renderVals().`)
    }
  }
  for (const match of template.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
    warnings.push(`<${match[1]}> is a capitalized component tag; use <dc-import name="${match[1]}"></dc-import> instead.`)
  }
  if (/<(dc-import|x-import)\b(?:[^>"']|"[^"]*"|'[^']*')*\/>/i.test(template)) {
    warnings.push('Write an explicit closing tag for <dc-import>/<x-import> instead of self-closing it.')
  }
  for (const match of template.matchAll(/<(dc-import|x-import)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    if (!/\bhint-size\s*=/.test(match[2])) warnings.push(`A <${match[1]}> has no hint-size; add one (for example hint-size="100%,240px").`)
  }
  return [...new Set(warnings)].slice(0, 10)
}

function replaceIn(source: string, find: string, replacement: string, multi: boolean): { text: string; count: number } {
  if (find === '') return { text: source + replacement, count: 1 }
  let needle = find
  let value = replacement
  if (!source.includes(needle) && source.includes('\r\n')) {
    needle = find.replace(/\r?\n/g, '\r\n')
    value = replacement.replace(/\r?\n/g, '\r\n')
  }
  const count = source.split(needle).length - 1
  if (count === 0) throw new Error('c_find was not found. Read the file again and copy the exact current text.')
  if (count > 1 && !multi) throw new Error(`c_find appears ${count} times. Include more surrounding text to make it unique, or set b_multi.`)
  return { text: multi ? source.split(needle).join(value) : source.replace(needle, () => value), count: multi ? count : 1 }
}

interface Starter {
  file: string
  source: string
  usage: (from: string) => string
}

const elementUsage =
  (tag: string, attrs: string, children: string) =>
  (from: string): string =>
    `Mount it in the DC template with <x-import component-from-global-scope="${tag}" from="${from}" ${attrs} hint-size="…">${children}</x-import> (from is relative to the DC file). It is a web component: attributes configure it and the x-import's children render inside it.`

const STARTERS: Record<string, Starter | string> = {
  'deck_stage.js': {
    file: 'deck-stage.js',
    source: deckStage,
    usage: (from) =>
      `Put this at the top of the template, right after </helmet>:\n<x-import component-from-global-scope="deck-stage" from="${from}" width="1920" height="1080" hint-size="100%,100%">\n  <section data-label="Title" data-speaker-notes="…" style="…">…</section>\n</x-import>\nEach <section> is one slide (don't set position/inset on it). Arrow keys, Space, Home/End and clicks navigate; print gives one page per slide; document.querySelector('deck-stage').goTo(n) jumps (0-indexed).`
  },
  'ios_frame.jsx': {
    file: 'ios-frame.js',
    source: iosFrame,
    usage: elementUsage('ios-frame', 'width="393" height="852" time="9:41"', '<div style="…">screen content</div>')
  },
  'android_frame.jsx': {
    file: 'android-frame.js',
    source: androidFrame,
    usage: elementUsage('android-frame', 'width="412" height="915" time="9:30"', '<div style="…">screen content</div>')
  },
  'macos_window.jsx': {
    file: 'macos-window.js',
    source: macosWindow,
    usage: elementUsage('macos-window', 'title="Notes" width="900" height="600"', '<div style="…">window content</div>')
  },
  'browser_window.jsx': {
    file: 'browser-window.js',
    source: browserWindow,
    usage: elementUsage('browser-window', 'url="https://example.com" tab-title="Example" width="1280" height="800"', '<div style="…">page content</div>')
  },
  'image_slot.js': {
    file: 'image-slot.js',
    source: imageSlot,
    usage: (from) =>
      `Load it once in <helmet>: <script src="${from}"></script>, then place <image-slot id="hero" shape="rounded" placeholder="What goes here"></image-slot> anywhere in the template (it fills its container; give each slot a distinct id).`
  },
  'doc_page.js': {
    file: 'doc-page.js',
    source: docPage,
    usage: (from) =>
      `Mount it with <x-import component-from-global-scope="doc-page" from="${from}" size="letter" hint-size="100%,100%">…</x-import>. For a flowing document write the content inside as normal HTML; for explicit pages use one <section class="page"> child per page. size="a4" for metric paper, orientation="landscape" for landscape, width/height only for an explicit user-given size.`
  },
  'tweaks_panel.jsx':
    'The tweaks panel is not available here. Declare tweakable values as props in d_props_json (or with dc_set_props) and read them with this.props.x ?? fallback.',
  'animations_v3.jsx': {
    file: 'motion-stage.js',
    source: motionStage,
    usage: (from) =>
      [
        `The animation engine is the <motion-stage> web component. Load it and declare the scene list (a JSON string literal) in <helmet> for a Design Component, or in <head> for a plain .html page:`,
        `<script src="${from}"></script>`,
        `<script>window.MOTION_SCENES = '[{"name":"Intro","duration":3},{"name":"Reveal","duration":4},{"name":"Outro","duration":2}]'</script>`,
        `Then the piece, as a direct tag (children absolutely positioned with left/top; the engine owns their transform):`,
        `<motion-stage width="1920" height="1080" fps="30" background="#101010">`,
        `  <h1 style="position:absolute;left:160px;top:380px;margin:0" data-in="fade-up" data-in-at="Intro+0.3" data-out="fade" data-out-at="Intro.end-0.4">Title</h1>`,
        `  <div style="position:absolute;left:160px;top:560px" data-motion="t:Reveal; x:-200; opacity:0 | t:Reveal+0.8; x:0; opacity:1; ease:outExpo | t:Outro; scale:1 | t:Outro+1; scale:1.2">Moves across scenes</div>`,
        `</motion-stage>`,
        `Read the animated-video skill (read_skill_prompt "animated-video") for every property, preset, time form and easing. It gives the user a timeline scrubber in the preview, and export_video records the piece to MP4/WebM/GIF with the stage's own size, frame rate and length.`
      ].join('\n')
  },
  'three_d_stage.js': 'The 3D stage is not available here.'
}

const STARTER_KINDS = [
  'ios_frame.jsx',
  'android_frame.jsx',
  'macos_window.jsx',
  'browser_window.jsx',
  'animations_v3.jsx',
  'tweaks_panel.jsx',
  'deck_stage.js',
  'doc_page.js',
  'image_slot.js',
  'three_d_stage.js'
] as const

const filenameSchema = z.string().describe('Project-relative path ending in .dc.html, for example "Dashboard.dc.html".')
const findSchema = {
  a_filename: z.string().describe('Path of the .dc.html to edit.'),
  b_multi: z.boolean().optional().describe('Replace every occurrence of c_find (default false: c_find must be unique).'),
  c_find: z.string().describe('Exact current text to replace. An empty string appends d_replace at the end.'),
  d_replace: z.string().describe('Replacement text.'),
  e_success_message: z.string().optional().describe('Optional short confirmation for the user when this edit is the whole answer.')
}

export function designComponentTools(ctx: ToolContext) {
  const dcPath = (filename: string): string => {
    if (!/\.dc\.html$/i.test(filename.trim())) throw new Error('A Design Component file name must end in .dc.html.')
    return resolveInside(ctx.root, filename.trim())
  }

  const readDc = async (filename: string): Promise<{ abs: string; text: string }> => {
    const abs = dcPath(filename)
    if (!existsSync(abs)) throw new Error(`${filename} does not exist. Create it with dc_write.`)
    return { abs, text: await readFile(abs, 'utf8') }
  }

  const save = async (abs: string, text: string) => {
    if (Buffer.byteLength(text, 'utf8') > MAX_DESIGN_HTML_BYTES) throw new Error('The file would be larger than 5 MB.')
    return writeTracked(ctx, abs, text)
  }

  const editRegion = async (
    kind: 'template' | 'logic',
    input: { a_filename: string; b_multi?: boolean; c_find: string; d_replace: string; e_success_message?: string }
  ) => {
    const { abs, text } = await readDc(input.a_filename)
    const region = locate(text)[kind]
    const current = text.slice(region.start, region.end)
    const { text: updated, count } = replaceIn(current, input.c_find, input.d_replace, input.b_multi ?? false)
    if (kind === 'template') checkTemplate(updated)
    else checkLogic(updated)
    const result = await save(abs, text.slice(0, region.start) + updated + text.slice(region.end))
    const warnings = kind === 'template' ? lintTemplate(updated) : []
    return {
      path: result.path,
      replacements: count,
      ...(warnings.length ? { warnings } : {}),
      ...(input.e_success_message ? { message: input.e_success_message } : {})
    }
  }

  return {
    dc_write: tool({
      description:
        'Create or wholly rewrite a Design Component (.dc.html). Give the template markup, the logic class source, and optionally the data-props JSON; the file around them is assembled for you. For small changes prefer dc_html_str_replace or dc_js_str_replace.',
      inputSchema: z.object({
        a_filename: filenameSchema,
        b_dc_html: z.string().describe('The template: the markup between <x-dc> and </x-dc>, without those tags, a document wrapper or <script> blocks outside <helmet>.'),
        c_dc_js: z.string().describe('The logic class source (class Component extends DCLogic { … }) without a <script> tag; "" for template-only components.'),
        d_props_json: z.string().optional().describe('Optional data-props JSON: {"$preview":{…}, "<propName>":{editor, default, tsType, …}}.')
      }),
      execute: async ({ a_filename, b_dc_html, c_dc_js, d_props_json = '' }) => {
        const abs = dcPath(a_filename)
        checkTemplate(b_dc_html)
        checkLogic(c_dc_js)
        checkProps(d_props_json)
        const text = buildDcFile({
          title: basename(abs).replace(/\.dc\.html$/i, ''),
          template: b_dc_html.replace(/^\r?\n|\r?\n$/g, ''),
          logic: c_dc_js.replace(/^\r?\n|\r?\n$/g, ''),
          propsJson: d_props_json
        })
        const result = await save(abs, text)
        const warnings = lintTemplate(b_dc_html)
        return { ...result, bytes: Buffer.byteLength(text), ...(warnings.length ? { warnings } : {}) }
      }
    }),

    dc_html_str_replace: tool({
      description:
        "Edit a Design Component's template by exact string replacement. Only the template (between <x-dc> and </x-dc>) is searched. For the logic class use dc_js_str_replace.",
      inputSchema: z.object(findSchema),
      execute: (input) => editRegion('template', input)
    }),

    dc_js_str_replace: tool({
      description:
        "Edit a Design Component's logic class by exact string replacement. Only the logic source is searched. For the template use dc_html_str_replace.",
      inputSchema: z.object(findSchema),
      execute: (input) => editRegion('logic', input)
    }),

    dc_set_props: tool({
      description:
        "Replace a Design Component's data-props JSON (its prop and Tweaks metadata). An empty string removes it.",
      inputSchema: z.object({
        a_filename: z.string().describe('Path of the .dc.html to edit.'),
        b_props_json: z.string().describe('The full data-props JSON; replaces the existing value. "" clears it.')
      }),
      execute: async ({ a_filename, b_props_json }) => {
        checkProps(b_props_json)
        const { abs, text } = await readDc(a_filename)
        const { logicTag } = locate(text)
        const tag = text
          .slice(logicTag.start, logicTag.end)
          .replace(/\s+data-props\s*=\s*(?:'[^']*'|"[^"]*")/i, '')
          .replace(/>$/, b_props_json.trim() ? ` data-props='${escapeAttr(b_props_json.trim())}'>` : '>')
        const result = await save(abs, text.slice(0, logicTag.start) + tag + text.slice(logicTag.end))
        return { path: result.path, props: b_props_json.trim() ? 'set' : 'cleared' }
      }
    }),

    copy_starter_component: tool({
      description:
        'Copy a ready-made starter component (slide deck shell, the animation/video timeline engine, device and window frames, image slot, document pages) into the design folder. Returns the file path and how to mount it in a Design Component. Copying again overwrites the earlier copy.',
      inputSchema: z.object({
        kind: z.enum(STARTER_KINDS).describe('Which starter to copy, with its extension exactly as listed.'),
        directory: z.string().optional().describe('Optional subfolder to copy into, for example "frames/". Defaults to the project root.')
      }),
      execute: async ({ kind, directory }) => {
        const starter = STARTERS[kind]
        if (typeof starter === 'string') throw new Error(starter)
        const folder = (directory ?? '').trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')
        const relative = folder ? `${folder}/${starter.file}` : starter.file
        const result = await writeTracked(ctx, resolveInside(ctx.root, relative), starter.source)
        return { path: result.path, created: result.created, usage: starter.usage(`./${result.path}`) }
      }
    }),

    show_to_user: tool({
      description: "Open a file from the design folder in the user's preview pane, to direct their attention to it.",
      inputSchema: z.object({ path: z.string().describe('File path relative to the project folder.') }),
      execute: async ({ path }) => {
        const abs = resolveInside(ctx.root, path)
        let isFile = false
        try {
          isFile = (await stat(abs)).isFile()
        } catch {
          isFile = false
        }
        if (!isFile) throw new Error(`${path} is not a file in this design.`)
        const relative = toProjectRelative(ctx.root, abs)
        if (!ctx.showInPreview) return { shown: false, path: relative, note: 'There is no preview to show it in.' }
        ctx.showInPreview(relative)
        noteUserView(ctx.projectId, relative)
        return { shown: true, path: relative }
      }
    })
  }
}
