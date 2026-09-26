import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runPowerShell, shellTools } from '../../src/core/tools/shell'
import { makeTestContext, runTool, type TestContext } from './helpers'

let t: TestContext
let tools: ReturnType<typeof shellTools>

beforeEach(() => {
  t = makeTestContext()
  tools = shellTools(t.ctx)
})
afterEach(() => t.cleanup())

describe('runPowerShell', () => {
  it('runs a command and decodes UTF-8 output', async () => {
    const result = await runPowerShell('Write-Output "héllo ✓"', t.root, 10_000)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('héllo ✓')
    expect(result.timedOut).toBe(false)
  })

  it('reports a non-zero exit code', async () => {
    const result = await runPowerShell('exit 3', t.root, 10_000)
    expect(result.exitCode).toBe(3)
  })

  it('kills a runaway process on timeout, well before the timeout test budget', async () => {
    const start = Date.now()
    const result = await runPowerShell('Start-Sleep -Seconds 30', t.root, 1000)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(10_000)
  }, 15_000)

  it('resolves immediately without running the command when the signal is already aborted', async () => {
    const marker = join(t.root, 'marker.txt')
    const controller = new AbortController()
    controller.abort()

    const start = Date.now()
    const result = await runPowerShell(
      `New-Item -Path "${marker}" -ItemType File | Out-Null`,
      t.root,
      10_000,
      controller.signal
    )
    expect(Date.now() - start).toBeLessThan(1000)
    expect(result).toEqual({
      exitCode: null,
      stdout: '',
      stderr: 'Stopped before the command started.',
      timedOut: false
    })
    expect(existsSync(marker)).toBe(false)
  })
})

describe('run_command', () => {
  it('starts in a subfolder of the project when cwd is given', async () => {
    mkdirSync(join(t.root, 'sub'))
    const result = await runTool(tools.run_command, { command: '(Get-Location).Path', cwd: 'sub' })
    expect(result.stdout.trim().endsWith('sub')).toBe(true)
  })

  it('rejects a cwd outside the project folder', async () => {
    await expect(runTool(tools.run_command, { command: 'Write-Output hi', cwd: '..' })).rejects.toThrow(
      /outside the project/
    )
  })
})
