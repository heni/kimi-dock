// The online-transition decision core, extracted from KimiWebView's
// goOnline for testability. Pure: the caller owns the side effects.

export interface TransitionState {
  hasWebview: boolean
  loadedOnce: boolean
  loadError: string | null
  retryPending: boolean // an auto-retry reload is scheduled right now
}

export interface TransitionDecision {
  // null = leave the current loading state unchanged (a reload is already
  // in flight and owns the spinner).
  isLoading: boolean | null
  // Re-drive a failed load: the auto-retry only runs while the network is
  // up, so a wedged error never recovers without this.
  reload: boolean
}

export function decideOnlineTransition(state: TransitionState): TransitionDecision {
  if (state.loadError && state.hasWebview) {
    return { isLoading: true, reload: true }
  }
  if (state.retryPending) {
    return { isLoading: null, reload: false }
  }
  // No reload in flight: spin only while a first load is still to come; a
  // loaded SPA self-heals reconnects, so repeat transitions are instant.
  return { isLoading: !state.loadedOnce, reload: false }
}
