import { useState } from 'react'
import { useStore } from '../lib/store'
import { BrandMark } from '../components/Mascot'
import { concentricVars } from '../lib/design'
import { pcStateLabel } from '../lib/bots'
import { SetupWizard } from '../components/SetupWizard'
import { PcModeSwitch } from '../components/PcModeSwitch'
import { PcStatusMark } from '../components/PcStatusMark'
import { CreateBotDialog } from '../components/CreateBotDialog'
import { HandoffsPanel } from '../components/HandoffsPanel'

export function BotsHomeView() {
  const bots = useStore((s) => s.bots)
  const botPcs = useStore((s) => s.botPcs)
  const engineStatus = useStore((s) => s.engineStatus)
  const navigate = useStore((s) => s.navigate)
  const [createOpen, setCreateOpen] = useState(false)
  const [skippedWizard, setSkippedWizard] = useState(false)

  // The wizard covers engine setup AND the first bot (its own last screen), so it's shown whenever
  // either is outstanding. It replaces the PC-mode switch and the bots grid while active — those
  // aren't useful yet (bots can't run without the engine, and there's nothing in the grid before the
  // first bot exists) and would just compete with a screen meant to be a focused, one-thing-at-a-time
  // flow. "Skip for now" (inside the wizard) backs out to the plain view below for this visit.
  const showWizard = engineStatus !== null && (!engineStatus.ready || bots.length === 0) && !skippedWizard
  // Clay is reserved for the one most consequential action on a screen: while the wizard is showing,
  // that's its own primary button, not bot creation here.
  const createIsPrimary = !showWizard

  return (
    <main className="scroll-area h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-8 py-10">
        <h1 className="font-serif text-[44px] leading-[1.1]">Bots</h1>
        <p className="mt-2 text-[14px] text-ink-muted">
          Each bot works on its own PC and checks in only when something needs you.
        </p>

        {showWizard ? (
          <div className="mt-12">
            <SetupWizard onSkip={() => setSkippedWizard(true)} />
          </div>
        ) : (
          <>
            <div className="mt-8">
              <h2 className="caption">Bot PC mode</h2>
              <div className="mt-3 rounded-3xl border border-rule bg-card p-4">
                <PcModeSwitch />
              </div>
            </div>

            <div className="mt-8 flex items-center justify-between">
              <h2 className="caption">Your bots</h2>
              {bots.length > 0 && (
                <button type="button" className="btn btn-outline" onClick={() => setCreateOpen(true)}>
                  New bot
                </button>
              )}
            </div>

            {bots.length === 0 ? (
              <div className="mt-3 rounded-3xl border border-rule bg-card p-10 text-center">
                <div className="flex justify-center">
                  <BrandMark size={40} />
                </div>
                <h3 className="mt-4 font-serif text-[20px] leading-snug">Create your first bot</h3>
                <p className="mx-auto mt-2 max-w-[360px] text-[14px] text-ink-muted">
                  Give it a name, then tell it what to do, which model to use, and what it may do without asking.
                </p>
                <button
                  type="button"
                  className={`r-concentric mt-6 ${createIsPrimary ? 'btn btn-clay' : 'btn btn-ivory'}`}
                  style={concentricVars(24)}
                  onClick={() => setCreateOpen(true)}
                >
                  Create your first bot
                </button>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-3">
                {bots.map((bot) => {
                  const state = botPcs[bot.id]?.state ?? 'absent'
                  return (
                    <button
                      type="button"
                      key={bot.id}
                      className="rounded-3xl border border-rule bg-card p-5 text-left hover:bg-oat"
                      onClick={() => navigate({ name: 'bot', botId: bot.id })}
                    >
                      <div className="flex items-center gap-2">
                        <PcStatusMark state={state} />
                        <span className="truncate font-serif text-[17px]">{bot.name}</span>
                      </div>
                      <div className="mt-1 text-[12px] text-ink-faint">{pcStateLabel(state)}</div>
                    </button>
                  )
                })}
              </div>
            )}

            <div className="mt-8">
              <HandoffsPanel />
            </div>
          </>
        )}
      </div>
      <CreateBotDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </main>
  )
}
