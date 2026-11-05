/**
 * Screen control for the Work and Design agents: look at the user's screen and use the mouse and
 * keyboard, so an agent can open what it built (an app, a page, a document) and check it works the
 * way a person would, then fix what it finds.
 *
 * `screen_look` only looks. `screen_act` is on the approval list (see `engine/approvals.ts`): the
 * user says yes before an agent first touches their mouse and keyboard in a task. While it acts, the
 * "Deskmates is controlling this computer" bar shows with its Stop button and hotkey. Typing into a
 * password box is refused, as Windows reports it.
 */
import { tool, type ToolResultPart } from 'ai'
import { z } from 'zod'
import { perform, type ComputerActionInput } from '../computer/service'
import type { Desktop, Screenshot } from '../computer/desktop'
import { describeElements, focusedIsPassword, listElements, type ScreenElement } from '../computer/elements'

type ToolResultOutput = ToolResultPart['output']

const SHOT_WIDTH = 1280
/** The controlling bar stays up this long after the last action. */
const ACTIVE_LINGER_MS = 20_000

/** Shared by every run: one desktop helper, the controlling bar, and the user's Stop. */
export class ScreenControl {
  private desktop: Desktop | null = null
  private activeTimer: ReturnType<typeof setTimeout> | null = null
  private stoppedAt = 0

  constructor(private readonly options: { createDesktop: () => Desktop; onActiveChange: (active: boolean) => void }) {}

  get(): Desktop {
    this.desktop ??= this.options.createDesktop()
    return this.desktop
  }

  /** Shows the controlling bar while agents act, and hides it a little after they stop. */
  touch(): void {
    if (!this.activeTimer) this.options.onActiveChange(true)
    else clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => {
      this.activeTimer = null
      this.options.onActiveChange(false)
    }, ACTIVE_LINGER_MS)
    this.activeTimer.unref?.()
  }

  /** The user pressed Stop (the bar or the hotkey): actions after this are refused for a minute. */
  stop(): void {
    this.stoppedAt = Date.now()
    if (this.activeTimer) clearTimeout(this.activeTimer)
    this.activeTimer = null
    this.options.onActiveChange(false)
  }

  stoppedRecently(): boolean {
    return Date.now() - this.stoppedAt < 60_000
  }

  dispose(): void {
    if (this.activeTimer) clearTimeout(this.activeTimer)
    this.desktop?.close()
    this.desktop = null
  }
}

interface Look {
  shot: Screenshot
  elements: Array<ScreenElement & { password?: boolean }>
}

interface LookOutput {
  text: string
  image?: string
}

function lookOutput(output: LookOutput, withImages: boolean): ToolResultOutput {
  if (!withImages || !output.image) {
    return { type: 'text', value: output.image ? `${output.text}\n(This model can't receive images; use the element list.)` : output.text }
  }
  return {
    type: 'content',
    value: [
      { type: 'text', text: output.text },
      { type: 'file', mediaType: 'image/jpeg', data: { type: 'data', data: output.image } }
    ]
  }
}

export interface ScreenToolDeps {
  control: ScreenControl
  /** Whether this model's provider accepts images in tool results. */
  withImages: boolean
  sleep?: (ms: number) => Promise<void>
}

export function screenControlTools(deps: ScreenToolDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let last: Look | null = null

  const look = async (): Promise<LookOutput> => {
    const desktop = deps.control.get()
    const [shot, elements] = await Promise.all([desktop.screenshot(SHOT_WIDTH), listElements()])
    last = { shot, elements }
    const scale = shot.width > 0 ? shot.screenWidth / shot.width : 1
    return {
      text: `Screenshot ${shot.width}x${shot.height} (screen ${shot.screenWidth}x${shot.screenHeight}). Coordinates are pixels of this screenshot.\n${describeElements(elements, scale)}`,
      image: shot.data
    }
  }

  return {
    screen_look: tool({
      description:
        "See the user's whole screen: a screenshot plus a numbered list of the buttons, links and fields in the focused window. Use it to check something you built or changed actually works (open the app or page, look, click through it), the way a tester would.",
      inputSchema: z.object({}),
      execute: async () => look(),
      toModelOutput: ({ output }) => lookOutput(output, deps.withImages)
    }),

    screen_act: tool({
      description:
        "Use the user's mouse and keyboard: open an app or web address, click (by element number from screen_look, or x/y in its screenshot), double or right click, drag, scroll, type, press keys, or wait. Returns a fresh look afterwards. The user approves this before you first use it in a task. Never type passwords or codes, never close or delete the user's things, and never send, buy or post unless the task clearly asks for exactly that.",
      inputSchema: z.object({
        action: z.enum(['open', 'click', 'double_click', 'right_click', 'move', 'drag', 'scroll', 'type', 'key', 'wait']),
        element: z.number().int().positive().optional().describe('An element number from the last screen_look (click, double_click, right_click, move)'),
        x: z.number().optional().describe('X in the last screenshot'),
        y: z.number().optional().describe('Y in the last screenshot'),
        toX: z.number().optional().describe('Drag end X'),
        toY: z.number().optional().describe('Drag end Y'),
        text: z.string().optional().describe('For type; a newline presses Enter'),
        keys: z.string().optional().describe('For key: "enter", "ctrl+s", "alt+tab", "f5"…'),
        amount: z.number().optional().describe('For scroll: notches, positive is down'),
        seconds: z.number().optional().describe('For wait, at most 10'),
        target: z.string().optional().describe('For open: an app name ("Notepad") or a web address')
      }),
      execute: async (input) => {
        if (deps.control.stoppedRecently()) throw new Error('The user pressed Stop on screen control. Don’t use the mouse or keyboard again unless they ask.')
        if (!last) await look()
        const current = last!
        let x = input.x
        let y = input.y
        if (input.element !== undefined) {
          const el = current.elements[input.element - 1]
          if (!el) throw new Error(`There is no element ${input.element} in the last screen_look. Look again.`)
          const scale = current.shot.width > 0 ? current.shot.screenWidth / current.shot.width : 1
          x = (el.x + el.w / 2) / scale
          y = (el.y + el.h / 2) / scale
        }
        if (input.action === 'type' && (await focusedIsPassword())) {
          throw new Error('The focused field is a password box. Only the user types passwords: ask them to do this step.')
        }
        deps.control.touch()
        const action: ComputerActionInput = { ...input, x, y }
        const done = await perform(deps.control.get(), action, current.shot, sleep)
        await sleep(600)
        const after = await look()
        return { text: `Did: ${done}.\n${after.text}`, image: after.image }
      },
      toModelOutput: ({ output }) => lookOutput(output, deps.withImages)
    })
  }
}
