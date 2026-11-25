import { useMemo } from 'react'
import { md, handleMarkdownLinkClick } from '../utils/markdown'
import 'katex/dist/katex.min.css'

// Assistant messages render as markdown + TeX; the plain-text .message-text
// styling (pre-wrap) is reset in the .message-markdown CSS block.
export default function ChatMarkdown({ content }: { content: string }): React.JSX.Element {
  const html = useMemo(() => md.render(content), [content])
  return (
    <div
      className="message-text message-markdown"
      onClick={handleMarkdownLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
