/*
 * Unit tests for the online-transition decision core (extracted in 3.5.11;
 * the 3.5.7 loop's F01 wedge and F09 spinner-stomp live here).
 * Run: npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideOnlineTransition } from '../.tmp/unit-build/renderer/src/utils/transition.js'

test('failed load with a live webview: re-drive it, spinner up (the F01 wedge)', () => {
  assert.deepEqual(
    decideOnlineTransition({
      hasWebview: true,
      loadedOnce: false,
      loadError: 'ERR_CONNECTION_REFUSED',
      retryPending: false
    }),
    { isLoading: true, reload: true }
  )
  // A failed POST-load navigation re-drives too (the F07 case).
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

test('auto-retry in flight: leave the loading state alone (the F09 stomp)', () => {
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
