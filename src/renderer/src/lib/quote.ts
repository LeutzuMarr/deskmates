/** The window event the message box listens for: quote this text in the next message. */
export const QUOTE_EVENT = 'deskmates:quote'

/** The selected text as a Markdown quote, ready to put above the user's reply. */
export function quoted(text: string): string {
  return `${text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`.trimEnd())
    .join('\n')}\n\n`
}
