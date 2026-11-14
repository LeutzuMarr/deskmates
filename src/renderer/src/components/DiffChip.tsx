import type { ChangeStats } from '../../../shared/protocol'

/** Lines added and removed, the way a diff summary shows them: +12 −3. Nothing when there is nothing to count. */
export function DiffChip({ stats }: { stats: ChangeStats }) {
  if (stats.added === 0 && stats.removed === 0) return null
  const files = `${stats.files} ${stats.files === 1 ? 'file' : 'files'}`
  return (
    <span
      className="diff-chip"
      role="img"
      aria-label={`${stats.added} lines added, ${stats.removed} removed, in ${files}`}
      title={`${stats.added} lines added, ${stats.removed} removed, in ${files}`}
    >
      <span className="diff-added">+{stats.added.toLocaleString()}</span>
      <span className="diff-removed">−{stats.removed.toLocaleString()}</span>
    </span>
  )
}
