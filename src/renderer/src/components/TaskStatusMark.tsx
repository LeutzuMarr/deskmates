import type { TaskStatus } from '../../../shared/protocol'
import { StatusMark, taskMark } from './StatusMark'

export function TaskStatusMark({ status, unread, quietIdle }: { status: TaskStatus; unread?: boolean; quietIdle?: boolean }) {
  return <StatusMark kind={taskMark(status, unread)} quietIdle={quietIdle} />
}
