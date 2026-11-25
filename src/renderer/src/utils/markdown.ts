import MarkdownIt from 'markdown-it'
import katexPlugin from '@traptitech/markdown-it-katex'
import type { MouseEvent } from 'react'

// html: false — raw HTML in the source is escaped, so rendered output needs
// no sanitizer dependency (the XSS surface is closed at the renderer).
// KaTeX keeps its default trust: false; throwOnError renders a broken
// formula as red source text instead of failing the whole message.
export const md = new MarkdownIt({ html: false, linkify: true })
md.use(katexPlugin, { throwOnError: false })

// Rendered links open in the system browser (routed by the main window's
// window.open handler), never inside the app window.
export function handleMarkdownLinkClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement).closest('a')
  if (anchor) {
    event.preventDefault()
    const href = anchor.getAttribute('href')
    if (href && /^https?:\/\//.test(href)) window.open(href)
  }
}
