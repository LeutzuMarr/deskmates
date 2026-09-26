import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChangeKind, FileChange } from '../../shared/protocol'
import type { ChangeRecord, ChangesRepo } from '../store/repos'
import { toProjectRelative } from './safe-path'

/** Records file changes before they happen, keeping a copy of the old content so each one can be undone. */
export class ChangeLog {
  constructor(
    private readonly repo: ChangesRepo,
    private readonly snapshotDir: string
  ) {}

  record(taskId: string, root: string, absPath: string, kind: ChangeKind, movedToAbs?: string): FileChange {
    const id = randomUUID()
    let backup: string | null = null
    if ((kind === 'modify' || kind === 'delete') && existsSync(absPath) && statSync(absPath).isFile()) {
      const dir = join(this.snapshotDir, taskId)
      mkdirSync(dir, { recursive: true })
      backup = join(dir, `${id}.bak`)
      copyFileSync(absPath, backup)
    }
    const record = this.repo.insert({
      id,
      taskId,
      path: toProjectRelative(root, absPath),
      absPath,
      kind,
      backup,
      movedTo: movedToAbs ? toProjectRelative(root, movedToAbs) : null,
      movedToAbs: movedToAbs ?? null
    })
    return {
      id: record.id,
      taskId: record.taskId,
      path: record.path,
      kind: record.kind,
      movedTo: record.movedTo,
      undone: record.undone,
      createdAt: record.createdAt
    }
  }

  undo(id: string): ChangeRecord {
    const change = this.repo.require(id)
    if (change.undone) return change
    switch (change.kind) {
      case 'create':
        rmSync(change.absPath, { force: true })
        break
      case 'modify':
        if (change.backup) this.restore(change.backup, change.absPath)
        break
      case 'delete':
        if (change.backup) this.restore(change.backup, change.absPath)
        else mkdirSync(change.absPath, { recursive: true })
        break
      case 'move':
        if (change.movedToAbs && existsSync(change.movedToAbs)) {
          mkdirSync(dirname(change.absPath), { recursive: true })
          renameSync(change.movedToAbs, change.absPath)
        }
        break
    }
    this.repo.markUndone(id)
    return this.repo.require(id)
  }

  undoAll(taskId: string): void {
    for (const change of this.repo.listRecords(taskId).reverse()) {
      if (!change.undone) this.undo(change.id)
    }
  }

  /** Removes the saved copies for a deleted task. */
  discard(taskId: string): void {
    rmSync(join(this.snapshotDir, taskId), { recursive: true, force: true })
  }

  private restore(backup: string, target: string): void {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(backup, target)
  }
}
