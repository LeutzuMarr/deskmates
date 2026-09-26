import { APICallError } from 'ai'

/**
 * A 429 from an account whose limit is zero (Mistral sends `x-ratelimit-limit-req-minute: 0` when no
 * plan is active on the key's workspace). No amount of waiting helps, so it must not be retried.
 */
export function hasNoQuota(error: unknown): boolean {
  if (!APICallError.isInstance(error) || error.statusCode !== 429) return false
  const headers = error.responseHeaders ?? {}
  return Object.entries(headers).some(([name, value]) => /ratelimit-limit/i.test(name) && String(value).trim() === '0')
}

export const NO_QUOTA_MESSAGE =
  "This account's limit at the provider is 0 requests, so every request is refused and waiting won't help. Its plan isn't active yet: for Mistral, open console.mistral.ai, choose the free Experiment plan (it asks to verify your phone) in the same workspace as the key, then try again."
