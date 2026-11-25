/*
 * Unit tests for the online-transition decision core.
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideOnlineTransition } from '../.tmp/unit-build/renderer/src/utils/transition.js'

test('failed load with a live webview: re-drive it, spinner up', () => {
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: true,
      loadedOnce: false,
      loadError: 'ERR_CONNECTION_REFUSED',
      retryPending: false
    }),
    { isLoading: true, reload: true }
  )
  // A failed POST-load navigation re-drives too.
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: true,
      loadedOnce: true,
      loadError: 'ERR_CONNECTION_RESET',
      retryPending: false
    }),
    { isLoading: true, reload: true }
  )
})

test('first load still to come: spinner up, no reload', () => {
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: false,
      loadedOnce: false,
      loadError: null,
      retryPending: false
    }),
    { isLoading: true, reload: false }
  )
})

test('loaded SPA, no error: instant transition, nothing spins', () => {
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: true,
      loadedOnce: true,
      loadError: null,
      retryPending: false
    }),
    { isLoading: false, reload: false }
  )
})

test('auto-retry in flight: leave the loading state alone', () => {
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: true,
      loadedOnce: false,
      loadError: null,
      retryPending: true
    }),
    { isLoading: null, reload: false }
  )
})

test('error without a webview element: no reload possible, spinner follows first-load state', () => {
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: false,
      loadedOnce: false,
      loadError: 'ERR_NAME_NOT_RESOLVED',
      retryPending: false
    }),
    { isLoading: true, reload: false }
  )
})

test('error dominates a pending retry: reload wins', () => {
  // did-fail-load sets both loadError and the retry timer; the wedged
  // error must still be re-driven, not deferred to the retry.
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: true,
      loadedOnce: false,
      loadError: 'ERR_CONNECTION_REFUSED',
      retryPending: true
    }),
    { isLoading: true, reload: true }
  )
})
