import '../assets/LoadingSkeleton.css'

interface LoadingSkeletonProps {
  status: string
  retryCount: number
}

// Cold-load placeholder in the shape of the kimi.ai greeting (light page,
// centered logo, input card, agent chips) — a static skeleton instead of a
// black screen, with an honest status line. No user data anywhere near it.
// Keeps the .loading-overlay root class: e2e waits on it.
export default function LoadingSkeleton({
  status,
  retryCount
}: LoadingSkeletonProps): React.JSX.Element {
  return (
    <div className="loading-overlay skeleton-overlay" role="status" aria-label={status}>
      <div className="skel-sidebar-toggle" />
      <div className="skel-center">
        <div className="skel-logo" />
        <div className="skel-input" />
        <div className="skel-chips">
          <div className="skel-chip" />
          <div className="skel-chip" />
          <div className="skel-chip" />
          <div className="skel-chip" />
          <div className="skel-chip" />
          <div className="skel-chip" />
        </div>
      </div>
      <div className="skel-status">
        <span className="skel-spinner" aria-hidden="true" />
        <span>
          {status}
          {retryCount > 0 ? ` — attempt ${retryCount + 1}` : ''}
        </span>
      </div>
    </div>
  )
}
