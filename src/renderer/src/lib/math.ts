/**
 * Math as Claude writes it: $$…$$ (and \[…\] on its own lines) as a block, \(…\) inline. A single
 * $ stays a dollar sign, so prices aren't read as math. Code is left alone.
 */
export function withMath(text: string): string {
  if (!/\\\(|\\\[|\$\$/.test(text)) return text
  return text
    .split(/(```[\s\S]*?```|`[^`\n]+`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body: string) => `$$${body.trim()}$$`)
    )
    .join('')
}
