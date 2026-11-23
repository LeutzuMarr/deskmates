import { useEffect, useState } from 'react'
import { getAsset } from '../db'

/** A notebook cover: a colour with a spine and a label, or the user's own picture. */
export function Cover({ cover, title, whiteboard }: { cover: string; title: string; whiteboard?: boolean }) {
  const [picture, setPicture] = useState<string | null>(null)
  useEffect(() => {
    if (!cover.startsWith('asset:')) {
      setPicture(null)
      return
    }
    let url: string | null = null
    void getAsset(cover.slice(6)).then((asset) => {
      if (!asset) return
      url = URL.createObjectURL(asset.blob)
      setPicture(url)
    })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [cover])
  if (whiteboard)
    return (
      <div className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,.12),0_8px_22px_rgba(0,0,0,.12)]">
        <div className="absolute inset-0 bg-[radial-gradient(circle,var(--rule)_1px,transparent_1.5px)] [background-size:12px_12px]" />
        <span className="relative rounded-md bg-card/90 px-2 py-1 font-serif text-[13px]">{title}</span>
      </div>
    )
  return (
    <div
      className="relative aspect-[3/4] w-full overflow-hidden rounded-l-md rounded-r-2xl shadow-[0_1px_2px_rgba(0,0,0,.12),0_8px_22px_rgba(0,0,0,.12)]"
      style={{ containerType: 'inline-size', background: picture ? `center / cover no-repeat url(${picture})` : `var(--cover-${cover}, var(--cover-clay))` }}
    >
      <div className="absolute inset-y-0 left-0 w-[9%] bg-black/15" />
      <div className="absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,.18),transparent_45%)]" />
      {title && (
        // The label scales with the cover (container units) and stops cleanly at three lines.
        <div className="absolute inset-x-[14%] top-[14%] rounded-md bg-white/85 px-[6%] py-[5%] text-center font-serif leading-tight text-[#141413]" style={{ fontSize: 'clamp(9px, 11cqw, 15px)' }}>
          <span className="line-clamp-3 [overflow-wrap:anywhere]">{title}</span>
        </div>
      )}
    </div>
  )
}
