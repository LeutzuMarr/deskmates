/**
 * What an agent is doing, in words: "Reading src/app.ts" while a step runs, "Read src/app.ts" once
 * it's done. Every agent in the app — the Work tab, Design, bots, Duo, OpenCode, agy and Freebuff —
 * reports its steps as tool items; this turns any of them into the line the user watches live.
 */
import type { TimelineItem, ToolItem } from '../../../shared/protocol'

export interface StepWords {
  /** Present tense, shown while the step runs: "Analyzing example.com". */
  live: string
  /** Past tense, shown once it's done: "Analyzed example.com". */
  done: string
}

type Input = Record<string, unknown>

const str = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value))

function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** "https://www.example.com/pricing?x=1" → "example.com/pricing". Falls back to the text itself. */
export function shortUrl(raw: unknown): string {
  const text = str(raw).trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    const host = url.hostname.replace(/^www\./, '')
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
    return clip(`${host}${path}`, 60)
  } catch {
    return clip(text, 60)
  }
}

/** The first path-like field a tool's input carries, across our tools and the CLIs' own. */
function pathOf(input: Input): string {
  return str(input.path ?? input.filePath ?? input.file_path ?? input.file ?? input.target ?? input.name ?? '')
}

function words(live: string, done: string, subject = ''): StepWords {
  const tail = subject ? ` ${subject}` : ''
  return { live: `${live}${tail}`, done: `${done}${tail}` }
}

/** Turns `browser_open_page` or `screen.click` into "Browser open page", the fallback for unknown tools. */
function humanize(toolName: string): string {
  const parts = toolName.split(/[_.\-\s]+/).filter(Boolean)
  if (parts.length === 0) return toolName
  return parts.map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part.toLowerCase())).join(' ')
}

/** The words for one step. */
export function stepWords(toolName: string, rawInput: unknown): StepWords {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Input
  const name = toolName.toLowerCase()
  const path = pathOf(input)
  const url = shortUrl(input.url ?? input.href)
  const query = clip(str(input.query ?? input.q ?? input.pattern ?? input.regex), 60)

  // Freebuff reports the line of work it is on rather than a tool call.
  if (name === 'freebuff') {
    const activity = clip(str(input.activity).replace(/^[•·*\-\s]+/, ''), 100)
    return { live: activity || 'Working', done: activity || 'Worked' }
  }

  // A sentence the agent said on its way, between steps.
  if (name === 'narration') {
    const said = clip(str(input.text), 160)
    return { live: said, done: said }
  }

  if (name.startsWith('create_')) {
    const kind = name.slice('create_'.length).replace(/_/g, ' ')
    return words('Creating', 'Created', path || `a ${kind}`)
  }

  switch (name) {
    // Files
    case 'write_file':
    case 'write':
    case 'dc_write':
    case 'write_pc_file':
      return words('Writing', 'Wrote', path)
    case 'edit_file':
    case 'edit':
    case 'str_replace_edit':
    case 'dc_html_str_replace':
    case 'dc_js_str_replace':
    case 'multiedit':
    case 'patch':
      return words('Editing', 'Edited', path)
    case 'read_file':
    case 'read':
    case 'read_pc_file':
    case 'local_read':
    case 'fig_read':
    case 'read_document':
      return words('Reading', 'Read', path)
    case 'read_skill_file':
      return words('Reading', 'Read', `${path} from the ${str(input.name)} skill`)
    case 'load_skill':
    case 'read_skill_prompt':
      return words('Loading', 'Loaded', `the ${str(input.name) || 'skill'} skill`)
    case 'list_files':
    case 'list':
    case 'ls':
    case 'local_ls':
    case 'fig_ls':
    case 'list_pc_files':
      return words('Looking through', 'Looked through', path || 'the folder')
    case 'search_files':
    case 'grep':
    case 'local_grep':
    case 'fig_grep':
    case 'glob':
      return words('Searching for', 'Searched for', query ? `"${query}"` : 'files')
    case 'move_path':
      return words('Moving', 'Moved', `${str(input.from)} → ${str(input.to)}`)
    case 'delete_path':
    case 'delete_file':
      return words('Deleting', 'Deleted', path)
    case 'copy_files':
    case 'fig_copy_files':
    case 'local_copy_to_project':
      return words('Copying', 'Copied', 'files')

    // Commands
    case 'run_command':
    case 'bash':
    case 'shell':
    case 'run_shell_command':
    case 'run_script': {
      const command = clip(str(input.command ?? input.cmd ?? input.script), 70)
      return words('Running', 'Ran', command || 'a command')
    }

    // The web
    case 'web_search':
    case 'websearch':
    case 'google_web_search':
      return words('Searching the web for', 'Searched the web for', query ? `"${query}"` : '')
    case 'web_fetch':
    case 'webfetch':
    case 'fetch':
      return words('Analyzing', 'Analyzed', url || 'a website')
    case 'browser_open':
    case 'open_page':
    case 'navigate':
      return words('Opening', 'Opened', url || 'a page')
    case 'browser_read':
    case 'read_page':
      return words('Reading', 'Read', url || 'the page')
    case 'browser_click':
    case 'click':
    case 'screen_click':
      return words('Clicking', 'Clicked', clip(str(input.text ?? input.label ?? input.selector ?? input.target), 50) || 'on the page')
    case 'browser_type':
    case 'type_text':
    case 'screen_type':
      return words('Typing', 'Typed', 'into the page')
    case 'browser_key':
    case 'screen_key':
      return words('Pressing', 'Pressed', str(input.key ?? input.keys) || 'a key')
    case 'browser_scroll':
    case 'screen_scroll':
      return words('Scrolling', 'Scrolled', 'the page')
    case 'browser_back':
      return words('Going back', 'Went back', '')
    case 'browser_wait':
    case 'sleep':
      return words('Waiting', 'Waited', 'for the page')
    case 'browser_tabs':
    case 'tabs':
      return words('Checking', 'Checked', 'the open tabs')
    case 'browser_screenshot':
    case 'screenshot':
    case 'screen_screenshot':
    case 'save_screenshot':
    case 'multi_screenshot':
    case 'fig_screenshot':
    case 'screenshot_user_view':
      return words('Taking', 'Took', 'a screenshot')
    case 'screen_look':
      return words('Looking at', 'Looked at', 'the screen')
    case 'screen_act':
      return words('Using', 'Used', 'the screen')
    case 'eval_js':
    case 'eval_js_user_view':
      return words('Checking', 'Checked', 'the page')
    case 'view_image':
      return words('Looking at', 'Looked at', path || 'an image')

    // GitHub
    case 'github_read_files':
      return words('Reading', 'Read', 'files on GitHub')
    case 'github_search_code':
      return words('Searching GitHub for', 'Searched GitHub for', query ? `"${query}"` : 'code')
    case 'github_get_tree':
    case 'github_list_repos':
      return words('Browsing', 'Browsed', 'GitHub')

    // Planning and memory
    case 'update_plan':
    case 'update_todos':
    case 'todowrite':
      return { live: 'Updating the plan', done: 'Updated the plan' }
    case 'remember':
      return { live: 'Saving a memory', done: 'Saved a memory' }
    case 'forget':
      return { live: 'Forgetting a memory', done: 'Forgot a memory' }
    case 'notify_user':
      return { live: 'Sending a notification', done: 'Sent a notification' }
    case 'delegate':
    case 'task':
      return words('Handing off', 'Handed off', clip(str(input.description ?? input.task), 60) || 'a subtask')
    case 'read_prompt_section':
      return words('Reading', 'Read', 'its instructions')

    // Design and documents
    case 'export_video':
      return { live: 'Exporting the video', done: 'Exported the video' }
    case 'gen_pptx':
      return { live: 'Building the presentation', done: 'Built the presentation' }
    case 'show_html':
    case 'show_to_user':
      return { live: 'Showing you the result', done: 'Showed you the result' }
    case 'snip':
    case 'snapshot_element':
      return { live: 'Capturing part of the design', done: 'Captured part of the design' }

    // Duo
    case 'duo_profile':
      return { live: 'Reading your profile', done: 'Read your profile' }
    case 'duo_playbook':
      return { live: 'Reading the playbook', done: 'Read the playbook' }
    case 'duo_outbox_add':
      return words('Drafting', 'Drafted', str(input.company) ? `a message to ${str(input.company)}` : 'a message')
    case 'duo_outbox_list':
      return { live: 'Checking the Outbox', done: 'Checked the Outbox' }
    case 'duo_send_next':
      return { live: 'Sending the next approved message', done: 'Sent the next approved message' }
    case 'duo_mark_sent':
      return { live: 'Marking a message sent', done: 'Marked a message sent' }
    case 'duo_mark_failed':
      return { live: 'Marking a message failed', done: 'Marked a message failed' }
    case 'duo_mark_with_user':
      return { live: 'Handing a message to you', done: 'Handed a message to you' }
    case 'duo_record':
      return { live: 'Recording what was sent', done: 'Recorded what was sent' }
    case 'duo_todo_add':
      return words('Adding a to-do:', 'Added a to-do:', clip(str(input.text), 60))
    case 'duo_todo_done':
      return { live: 'Ticking off a to-do', done: 'Ticked off a to-do' }
    case 'duo_todo_list':
      return { live: 'Checking the to-do list', done: 'Checked the to-do list' }

    // Bots
    case 'whatsapp_send':
      return { live: 'Sending a WhatsApp message', done: 'Sent a WhatsApp message' }
    case 'handoff':
      return { live: 'Handing over to you', done: 'Handed over to you' }
    case 'schedule_create':
      return { live: 'Scheduling a task', done: 'Scheduled a task' }
  }

  if (name.includes('screenshot')) return { live: 'Taking a screenshot', done: 'Took a screenshot' }
  if (name.includes('search')) return words('Searching for', 'Searched for', query ? `"${query}"` : '')
  if (url) return words('Analyzing', 'Analyzed', url)
  const plain = humanize(toolName)
  return { live: plain, done: plain }
}

/** The words for a tool item, in the tense its state calls for. */
export function stepLabel(item: Pick<ToolItem, 'toolName' | 'input' | 'state'>): string {
  const w = stepWords(item.toolName, item.input)
  return item.state === 'running' || item.state === 'awaiting-approval' ? w.live : w.done
}

/** What the agent is doing right now, for the live "working" line: the step that is running, or
 *  "Thinking" while it reasons, or "Writing the reply" while the answer streams. Null when there is
 *  nothing more specific to say than "working". */
export function currentActivity(timeline: TimelineItem[]): string | null {
  for (let k = timeline.length - 1; k >= 0; k--) {
    const item = timeline[k]
    if (item.kind === 'user') return null
    if (item.kind === 'tool') {
      if (item.state === 'running') return `${stepWords(item.toolName, item.input).live}…`
      if (item.state === 'awaiting-approval') return 'Waiting for your approval…'
      // The step before it finished: the agent is deciding what to do next.
      return 'Thinking about the next step…'
    }
    if (item.kind === 'thinking') return 'Thinking…'
    if (item.kind === 'assistant') return k === timeline.length - 1 ? 'Writing the reply…' : null
  }
  return null
}
