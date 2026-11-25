import { useEffect } from 'react'
import '../assets/HelpModal.css'

interface HelpModalProps {
  isOpen: boolean
  onClose: () => void
}

const SHORTCUTS: Array<{ keys: string; action: string }> = [
  { keys: 'Ctrl+,', action: 'Open Settings' },
  { keys: 'Ctrl+Shift+S', action: 'Toggle the conversations sidebar' },
  { keys: 'Ctrl+S', action: 'Save the current file (artifact editor)' },
  { keys: 'Ctrl+F5', action: 'Run the current file (artifact editor)' },
  { keys: 'Ctrl+Tab', action: 'Next artifact (artifact editor)' },
  { keys: 'Ctrl+Shift+Tab', action: 'Previous artifact (artifact editor)' },
  { keys: 'Ctrl+K S', action: 'Save all drafts of this chat (artifact editor)' },
  { keys: 'Ctrl+Shift+V', action: 'Markdown: toggle edit / preview' },
  { keys: 'Ctrl+K V', action: 'Markdown: open the split view' },
  { keys: 'F1', action: 'Open this help' },
  { keys: 'Esc', action: 'Close this help' }
]

// Keyboard shortcuts and the buttons whose meaning is not obvious from the
// glyph. Opened from the title-bar "?" or F1.
export default function HelpModal({ isOpen, onClose }: HelpModalProps): React.JSX.Element | null {
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-modal" onClick={(event) => event.stopPropagation()}>
        <div className="help-header">
          <h2>Keyboard shortcuts</h2>
          <button className="help-close" onClick={onClose} aria-label="Close help">
            ×
          </button>
        </div>
        <table className="help-table">
          <tbody>
            {SHORTCUTS.map((row) => (
              <tr key={row.keys}>
                <td className="help-keys">{row.keys}</td>
                <td>{row.action}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Buttons worth knowing</h2>
        <p>
          <strong>AI: run.json</strong> (run console) — arms the run.json assistant: while armed,
          your offline-chat messages carry the run.json authoring instructions, so the AI can write
          or fix this chat&apos;s run.json. The chat header shows the armed chip; click either to
          disarm.
        </p>
        <p>
          <strong>⧉</strong> (next to an assistant answer) — copies the answer&apos;s raw markdown
          source to the clipboard.
        </p>
      </div>
    </div>
  )
}
