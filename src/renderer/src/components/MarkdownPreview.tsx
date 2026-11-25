import { useMemo } from 'react'
import { md, handleMarkdownLinkClick } from '../utils/markdown'

interface MarkdownPreviewProps {
  source: string
  containerRef: React.RefObject<HTMLDivElement | null>
}

export default function MarkdownPreview({
  source,
  containerRef
}: MarkdownPreviewProps): React.JSX.Element {
  const html = useMemo(() => md.render(source), [source])

  return (
    <div
      ref={containerRef}
      className="markdown-preview"
      onClick={handleMarkdownLinkClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
