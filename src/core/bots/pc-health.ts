import type { PcEndpoints } from './host'
import { TOKEN_HEADER } from './tools/agent-client'

/** Whether a PC's services answer right now. Never throws. */
export type PcProbe = (endpoints: PcEndpoints) => Promise<boolean>

const PROBE_TIMEOUT_MS = 3_000
const POLL_INTERVAL_MS = 500

/**
 * True when both services the bot tools use answer: the agent's `/health` (with its token) and
 * Chromium's DevTools `/json/version` (through `cdp-fwd.py`). A container can be "running" for
 * several seconds before either is listening, so "running" alone isn't "usable".
 */
export async function probePcServices(endpoints: PcEndpoints, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const get = async (url: string, headers?: Record<string, string>): Promise<boolean> => {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
      await res.arrayBuffer()
      return res.ok
    } catch {
      return false
    }
  }
  const [agent, cdp] = await Promise.all([
    get(`${endpoints.agent}/health`, { [TOKEN_HEADER]: endpoints.token }),
    get(`${endpoints.cdp}/json/version`)
  ])
  return agent && cdp
}

/** Polls `probe` until it answers true or `timeoutMs` passes. Always probes at least once. */
export async function waitForPcServices(endpoints: PcEndpoints, probe: PcProbe, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await probe(endpoints)) return true
    const left = deadline - Date.now()
    if (left <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, left)))
  }
}
