import type { CSSProperties } from 'react'
import type { AppToEditor, EditorToApp } from '../../../shared/design-bridge'
import { APP_SOURCE } from '../../../shared/design-bridge'
import type { DesignFile, DeviceSize, Project, Task } from '../../../shared/protocol'
import { DEVICE_WIDTHS } from '../../../shared/protocol'

/**
 * Custom properties for the `.r-concentric` / `.btn.r-concentric` CSS (see styles.css): inner radius =
 * max(--r-min, --r-outer - --inset). `outerPx` only matters when the surrounding container isn't --r-card (24px).
 */
export function concentricVars(insetPx: number, outerPx?: number): CSSProperties {
  const vars: Record<string, string> = { '--inset': `${insetPx}px` }
  if (outerPx !== undefined) vars['--r-outer'] = `${outerPx}px`
  return vars as CSSProperties
}

/** The `select` message payload, kept as-is so a panel can always reflect the editor's latest snapshot. */
export type Selection = Extract<EditorToApp, { type: 'select' }>

/** Applies `Omit` to each member of a union separately, instead of collapsing to their common keys. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/** An app-to-editor message without `source`: `postToIframe` fills that in. */
export type OutgoingEditorMessage = DistributiveOmit<AppToEditor, 'source'>

/** Posts one message to the preview iframe's editor, the one place that stamps `source: 'deskmates-app'`. */
export function postToIframe(iframe: HTMLIFrameElement | null, msg: OutgoingEditorMessage): void {
  iframe?.contentWindow?.postMessage({ ...msg, source: APP_SOURCE } as AppToEditor, '*')
}

export const DEVICE_ORDER: readonly DeviceSize[] = ['desktop', 'tablet', 'phone']

export const DEVICE_LABELS: Record<DeviceSize, string> = {
  desktop: `Desktop ${DEVICE_WIDTHS.desktop}`,
  tablet: `Tablet ${DEVICE_WIDTHS.tablet}`,
  phone: `Phone ${DEVICE_WIDTHS.phone}`
}

export type Zoom = 'fit' | 0.5 | 0.75 | 1

export const ZOOM_OPTIONS: ReadonlyArray<{ value: Zoom; label: string }> = [
  { value: 'fit', label: 'Fit' },
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' }
]

/** The exact block the assistant's instructions expect ahead of the user's own text. */
export function decorateWithSelection(selection: Pick<Selection, 'id' | 'tag' | 'html'>, userText: string): string {
  return `Selected element (data-dm-id="${selection.id}", <${selection.tag}>):\n\`\`\`html\n${selection.html}\n\`\`\`\n\n${userText}`
}

/** The most recently updated task, or undefined when there are none. */
export function latestTask(tasks: Task[]): Task | undefined {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

export function lastActivity(project: Project, tasksByProject: Record<string, Task[]>): number {
  const tasks = tasksByProject[project.id] ?? []
  return tasks.length === 0 ? project.createdAt : Math.max(project.createdAt, ...tasks.map((t) => t.updatedAt))
}

/** Design projects (`kind === 'design'`), most recently active first. */
export function designsByActivity(projects: Project[], tasksByProject: Record<string, Task[]>): Project[] {
  return projects
    .filter((p) => p.kind === 'design')
    .sort((a, b) => lastActivity(b, tasksByProject) - lastActivity(a, tasksByProject))
}

/** Runs `fn` at most once per animation frame, using only the most recent call's arguments. */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let scheduled = false
  let lastArgs: A | null = null
  return (...args: A) => {
    lastArgs = args
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const toRun = lastArgs
      lastArgs = null
      if (toRun) fn(...toRun)
    })
  }
}

/** Debounces `fn`; every call resets the timer. `cancel()` drops a pending call (for unmount). */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number
): ((...args: A) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = (...args: A): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return debounced
}

export function clamp(value: number, min?: number, max?: number): number {
  let v = value
  if (min !== undefined) v = Math.max(min, v)
  if (max !== undefined) v = Math.min(max, v)
  return v
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim())
}

/** Lenient check for the line-height / letter-spacing text fields: a bare number, a number with a CSS unit, or 'normal'. */
const CSS_SCALAR_RE = /^-?\d+(\.\d+)?(px|em|rem|%)?$/
export function isValidCssScalar(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === 'normal' || CSS_SCALAR_RE.test(trimmed)
}

/** The page a design shows until one is picked: index.html, else the newest component, else the newest page. */
export function defaultDesignFile(files: DesignFile[]): string {
  if (files.some((f) => f.path === 'index.html')) return 'index.html'
  const newest = [...files].sort((a, b) => b.updatedAt - a.updatedAt)
  return (newest.find((f) => f.kind === 'dc') ?? newest[0])?.path ?? 'index.html'
}
