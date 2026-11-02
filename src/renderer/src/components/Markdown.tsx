import { isValidElement, useRef } from 'react'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyButton } from './CopyButton'

/** The language a fenced block was tagged with (```ts → "ts"), if any. */
function languageOf(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(children)) return null
  const match = /language-([\w+#.-]+)/.exec(children.props.className ?? '')
  return match ? match[1] : null
}

function CodeBlock({ children, ...rest }: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null)
  const language = languageOf(children)
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{language ?? 'text'}</span>
        <CopyButton text={() => ref.current?.textContent ?? ''} label="Copy code" />
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  )
}

const components: Components = {
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  // Links leave the app for the default browser (main process opens http(s) targets externally).
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
}

export function AssistantText({ text }: { text: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
