/**
 * Per-tool redaction of what a bot run's *display log* shows for a tool call's arguments —
 * `runner.ts` applies this to a `ToolItem.input` at the moment it's built, before that item is
 * written to `<dataDir>/runs/<runId>/log.jsonl` and emitted as a `run.item` bus event (the two
 * places a tool call's raw input would otherwise be persisted or broadcast). It never touches the
 * actual tool call the model made or the arguments `execute` receives — those still get the real
 * number and message, exactly as before; only the record kept for the human-facing log changes.
 *
 * This exists because the plan's global rule for this stage is explicit: "Secrets (the agent
 * token, the WhatsApp number) are never logged" (docs/superpowers/plans/2026-09-20-stage-2-bots.md).
 * `whatsapp.ts` itself never logs anything (see its own doc comment), but `runner.ts`'s tool-call
 * logging is generic across every bot tool and previously wrote `whatsapp_send`'s raw `to`/
 * `message` straight to disk — this is what closes that gap. Every tool other than the ones listed
 * below is unaffected: its `ToolItem.input` is logged exactly as the model called it, including
 * `type_text`'s attempted text on a blocked password field (see bot-runner.test.ts test 6) — that
 * one is a deliberate audit trail of what was attempted, not a secret, and redacting it would be a
 * regression, not a fix.
 */

/** How many trailing digits of a masked phone number stay visible — enough to sanity-check "yes, that's my number" without showing the whole thing. */
const PHONE_DIGITS_KEPT = 4

/** Keeps the last few digits and a leading "+" (if present) for recognizability; everything else becomes bullets. Never throws on garbage input — worst case it's fully masked. */
function maskPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 0) return '[redacted]'
  const kept = digits.slice(-PHONE_DIGITS_KEPT)
  const hiddenCount = Math.max(digits.length - kept.length, 0)
  const plus = raw.trim().startsWith('+') ? '+' : ''
  return `${plus}${'•'.repeat(hiddenCount)}${kept}`
}

/** Replaces a message body with proof one existed, never its content. */
function redactMessageBody(raw: string): string {
  return `[redacted, ${raw.length} chars]`
}

/**
 * Redacts a `whatsapp_send` call's `to`/`message` for the log; every other tool's input passes
 * through untouched. Safe to call with any tool name and any input shape — a tool whose input
 * isn't a plain object, or whose fields aren't strings, is returned as-is rather than throwing,
 * since a logging helper should never be why a run fails.
 */
export function redactToolInputForLog(toolName: string, input: unknown): unknown {
  if (toolName !== 'whatsapp_send') return input
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input

  const { to, message, ...rest } = input as Record<string, unknown>
  return {
    ...rest,
    ...(typeof to === 'string' ? { to: maskPhoneNumber(to) } : {}),
    ...(typeof message === 'string' ? { message: redactMessageBody(message) } : {})
  }
}
