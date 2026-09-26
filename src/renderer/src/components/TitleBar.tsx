import type { CSSProperties } from 'react'
import { BrandMark } from './Mascot'
import { TabSwitch } from './TabSwitch'

export function TitleBar() {
  const style = { WebkitAppRegion: 'drag' } as CSSProperties
  return (
    <header className="drag-region flex h-10 shrink-0 items-center gap-3 px-3" style={style}>
      <BrandMark size={16} />
      <span className="text-[13px] font-semibold tracking-tight text-ink">Deskmates</span>
      <TabSwitch />
      <div className="no-drag ml-auto h-full w-[140px] shrink-0" />
    </header>
  )
}