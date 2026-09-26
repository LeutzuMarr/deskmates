import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function AssistantText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
    </div>
  )
}