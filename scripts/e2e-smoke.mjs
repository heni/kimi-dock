/*
 * E2E smoke test for Kimi Dock using Playwright's Electron API.
 * Verifies: window loads, title bar renders, OAuth session is picked up,
 * webview points at kimi.ai. Screenshots land in /tmp/kimi-desktop-e2e/.
 *
 * With a working AppArmor userns profile this runs WITH the Chromium
 * sandbox enabled; pass --no-sandbox to opt out.
 */
import { _electron as electron } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const SHOTS = '/tmp/kimi-desktop-e2e'
fs.mkdirSync(SHOTS, { recursive: true })

const noSandbox = process.argv.includes('--no-sandbox')
const app = await electron.launch({
  args: ['.'],
  chromiumSandbox: !noSandbox
})

// Live-profile safety: the run presets forceOfflineMode=false when the
// profile was saved forced (the webview steps need it), and step 8 presets
// forceOfflineMode=true for the offline-boot relaunch. The original
// settings file bytes are restored in the outermost finally, whatever
// fails in between — a mid-run crash must not leave the profile altered.
let app1Closed = false
let settingsFile = null
let originalSettingsRaw = null

try {
  const window = await app.firstWindow()

  // 1) App shell renders
  await window.waitForSelector('.titlebar', { timeout: 15000 })
  const title = await window.textContent('.title .version')
  console.log('[e2e] Window OK, version badge:', title?.trim() || '(none)')

  const userDataPath = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  settingsFile = path.join(userDataPath, 'settings.json')
  originalSettingsRaw = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf-8') : null
  const savedSettings = originalSettingsRaw ? JSON.parse(originalSettingsRaw) : {}

  // Steps 2+ expect the webview surface: leave forced-offline mode if the
  // profile was saved with it (restored by the outer finally).
  if (savedSettings.forceOfflineMode) {
    await window.evaluate(
      (s) => window.api.saveSettings({ ...s, forceOfflineMode: false }),
      savedSettings
    )
    await window.waitForSelector('webview.kimi-webview', { timeout: 15000 })
    console.log('[e2e] Profile had forceOfflineMode=true — preset to false for the run')
  }

  // 2) OAuth session from userData (migrated from upstream ~/.config/kimi-desktop)
  const oauth = await window.evaluate(() => window.api.oauthStatus())
  console.log('[e2e] OAuth loggedIn:', oauth.loggedIn)
  console.log('[e2e] Models:', oauth.models.length, '| selected:', oauth.selectedModel)
  if (!oauth.loggedIn) throw new Error('Expected an active OAuth session')

  // 3) WebView is present and targets kimi.ai
  const webviewSrc = await window.evaluate(() =>
    document.querySelector('webview')?.getAttribute('src')
  )
  console.log('[e2e] WebView src:', webviewSrc)
  if (webviewSrc !== 'https://www.kimi.ai') throw new Error(`Unexpected webview src: ${webviewSrc}`)

  await window.screenshot({ path: `${SHOTS}/01-main.png` })

  // 4) Open Settings → Kimi Account tab
  await window.keyboard.press('Control+,')
  await window.waitForSelector('.settings-modal', { timeout: 5000 })
  await window.click('text=Kimi Account')
  await window.waitForSelector('text=Connected', { timeout: 5000 })
  const modelSelect = await window.isVisible('select.endpoint-select')
  console.log('[e2e] Settings → Kimi Account: Connected, model selector visible:', modelSelect)
  await window.screenshot({ path: `${SHOTS}/02-kimi-account.png` })

  // 5) Clipboard bridge roundtrip: write + read back text, image and rich-text.
  // Side effect: clobbers the user's clipboard — snapshot and restore what
  // the API can represent (text/image data URLs). Electron's clipboard.write
  // replaces the whole clipboard per call, and the bridge has no combined
  // write, so when the original clipboard held both text and image, the
  // image restore wins and the text layer is lost. Other formats (files,
  // RTF without an HTML layer) are lost outright.
  const prevText = await window.evaluate(() => window.api.clipboardRead('text'))
  const prevImage = await window.evaluate(() => window.api.clipboardRead('image'))
  try {
    const clipTextWrite = await window.evaluate(() =>
      window.api.clipboardWrite('text', 'kimi-dock-clipboard-e2e')
    )
    const clipTextRead = await window.evaluate(() => window.api.clipboardRead('text'))
    if (!clipTextWrite?.success || clipTextRead?.value !== 'kimi-dock-clipboard-e2e') {
      throw new Error(
        `Clipboard text roundtrip failed: ${JSON.stringify({ clipTextWrite, clipTextRead })}`
      )
    }
    const PIXEL_PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    await window.evaluate((dataUrl) => window.api.clipboardWrite('image', dataUrl), PIXEL_PNG)
    const clipImageRead = await window.evaluate(() => window.api.clipboardRead('image'))
    if (!clipImageRead?.value || !clipImageRead.value.startsWith('data:image/')) {
      throw new Error(`Clipboard image roundtrip failed: ${JSON.stringify(clipImageRead)}`)
    }
    await window.evaluate(() =>
      window.api.clipboardWrite('html', '<p>rich <strong>text</strong></p>')
    )
    const clipRichRead = await window.evaluate(() => window.api.clipboardRead('rich-text'))
    if (!clipRichRead?.value || !clipRichRead.value.includes('rich')) {
      throw new Error(`Clipboard rich-text read failed: ${JSON.stringify(clipRichRead)}`)
    }
    console.log('[e2e] Clipboard roundtrip OK (text + image + rich-text)')
  } finally {
    if (typeof prevText?.value === 'string') {
      await window.evaluate((t) => window.api.clipboardWrite('text', t), prevText.value)
    }
    if (typeof prevImage?.value === 'string') {
      await window.evaluate((d) => window.api.clipboardWrite('image', d), prevImage.value)
    }
  }

  // 6) Force-offline toggle: the real title-bar button is the primary action.
  // The app runs against real userData and a partial payload makes main fill
  // absent keys from defaults — snapshot first and restore the snapshot
  // verbatim in the finally block.
  const prevSettings = await window.evaluate(() => window.api.getSettings())
  let restoreError = null
  try {
    // Step 4 left the Settings modal open; its overlay would intercept the
    // title-bar click.
    await window.click('.settings-modal .close-btn')
    await window.waitForSelector('.settings-modal', { state: 'detached', timeout: 5000 })

    // Force a known starting state: on a machine where the developer
    // actually uses the toggle, the first click below must turn it ON, not
    // OFF. The finally restores the untouched prevSettings snapshot.
    const preset = await window.evaluate((prev) => {
      return window.api.saveSettings({ ...prev, forceOfflineMode: false })
    }, prevSettings)
    if (!preset?.success) {
      throw new Error(`Failed to preset forceOfflineMode=false: ${JSON.stringify(preset)}`)
    }

    await window.click('.force-offline-toggle')
    await window.waitForSelector('.offline-chat-view', { timeout: 5000 })
    const forcedBadge = await window.isVisible('.offline-indicator.forced')
    const reconnectVisible = await window.isVisible('text=Try Reconnecting')
    console.log(
      '[e2e] Force offline: offline view shown, forced badge:',
      forcedBadge,
      '| reconnect button visible:',
      reconnectVisible
    )
    if (!forcedBadge) throw new Error('Forced Offline badge not shown')
    if (reconnectVisible) throw new Error('Try Reconnecting must be hidden in forced mode')
    await window.screenshot({ path: `${SHOTS}/03-forced-offline.png` })

    await window.click('.force-offline-toggle')
    await window.waitForSelector('webview.kimi-webview', { timeout: 5000 })
    console.log('[e2e] Force offline: webview restored after clicking the toggle again')
  } finally {
    const restore = await window.evaluate((s) => window.api.saveSettings(s), prevSettings)
    if (!restore?.success) {
      restoreError = new Error(
        `Failed to restore settings after force-offline test: ${JSON.stringify(restore)}`
      )
    }
  }
  if (restoreError) throw restoreError

  // 7) Artifact editor surface: the title-bar toggle swaps the main area to
  // the editor and back; the webview stays mounted (CSS-hidden), and after
  // the first open the editor does too (unsaved buffers survive). Depending
  // on whether a workspace folder is configured, the editor shows the
  // choose-folder prompt, the chat picker, or the artifact list.
  await window.click('.editor-toggle')
  await window.waitForSelector('.editor-view', { timeout: 5000 })
  const editorState = await window.evaluate(() => {
    if (document.querySelector('.editor-sidebar')) return 'artifacts'
    if (document.querySelector('.chat-dir-list')) return 'picker'
    return 'unset-prompt'
  })
  console.log('[e2e] Editor surface shown:', editorState)
  await window.screenshot({ path: `${SHOTS}/04-editor.png` })

  // The profile's workspace and its first real directory — step 7b reads
  // the same values.
  const settingsForWs = await window.evaluate(() => window.api.getSettings())
  const workspaceRoot = settingsForWs?.workspaceRoot
  const firstChatDir = workspaceRoot
    ? fs
        .readdirSync(workspaceRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))[0]
    : undefined

  // 7a) The picker lists CONVERSATIONS, not directories (3.9.3): a chat
  // without an artifact directory appears as "no artifacts yet" and is
  // selectable — its first created file mkdirs the directory on demand.
  // The probe is self-cleaning (file + directory removed in the finally,
  // or a leftover would pollute the workspace and flip the picker's
  // hasDir label).
  if (editorState === 'picker' && workspaceRoot) {
    const dirlessId = await window.evaluate(() => {
      for (const el of document.querySelectorAll('.chat-dir-item')) {
        if (el.textContent?.includes('no artifacts yet')) return el.getAttribute('data-chat-id')
      }
      return null
    })
    if (dirlessId) {
      const probeDir = path.join(workspaceRoot, dirlessId)
      const probeFile = path.join(probeDir, 'e2e-picker-probe.md')
      try {
        await window.click(`[data-chat-id="${dirlessId}"]`)
        await window.waitForSelector('.artifact-empty', { timeout: 5000 })
        await window.click('button[title="New file"]')
        await window.fill('.new-file-row input', 'e2e-picker-probe.md')
        await window.keyboard.press('Enter')
        await window.waitForFunction(
          () =>
            [...document.querySelectorAll('.artifact-item')].some((el) =>
              el.textContent?.includes('e2e-picker-probe')
            ),
          { timeout: 5000 }
        )
        if (!fs.existsSync(probeFile)) throw new Error('the probe file is not on disk')
        console.log('[e2e] Picker: dir-less chat selectable, first file created its directory')
      } finally {
        try {
          if (fs.existsSync(probeFile)) fs.rmSync(probeFile)
          if (fs.existsSync(probeDir)) fs.rmdirSync(probeDir)
        } catch {
          // best-effort cleanup
        }
      }
      // Back to the picker for the artifact checks below.
      await window.click('.editor-sidebar-chat')
      await window.waitForSelector('.chat-dir-list', { timeout: 5000 })
    } else {
      console.log('[e2e] Picker dir-less check skipped: none in this profile')
    }
  }

  // The ✨ Ask AI button lives in the run panel, which renders once a chat
  // is selected: pick the first chat WITH a directory when the picker
  // offers one (dir-less conversations may sort first), then require the
  // button (3.8.0). The wait is on the picker item itself: classifying
  // the editor state first races EditorView's loading fall-through.
  const dirItem = firstChatDir ? await window.$(`[data-chat-id="${firstChatDir.name}"]`) : null
  const pickItem = dirItem ?? (await window.$('.chat-dir-item'))
  if (pickItem) {
    await pickItem.click()
    await window.waitForSelector('.run-ask-btn', { timeout: 5000 })
    console.log('[e2e] Ask AI button present in the run panel')
  } else {
    const askBtn = await window.$('.run-ask-btn')
    console.log(
      askBtn
        ? '[e2e] Ask AI button present in the run panel'
        : '[e2e] Ask AI button check skipped: no chat dirs and no active run panel'
    )
  }

  // 7b) External-change invalidation (3.9.1) + save-time guard (3.9.2):
  // with a file open, an outside write to it must show up in the editor
  // after leaving and re-entering the surface (activation revalidation);
  // the draft-conflict lifecycle (banner → Keep → suppression re-arm →
  // Load) rides the same setup, and a Ctrl+S with a pending divergence
  // must ask (native dialog, driven by a main-process patch) instead of
  // silently overwriting. The harness writes the file bytes directly —
  // bypassing the app's FS gateway, a genuinely external change — and
  // restores them in the finally. The first picker item is the first
  // non-hidden directory of the workspace root (the gateway sorts
  // directories first by name).
  let invalidationDone = false
  const artifactItem = await window
    .waitForSelector('.artifact-item', { timeout: 5000 })
    .catch(() => null)
  if (workspaceRoot && artifactItem) {
    const relPath = await artifactItem.getAttribute('title')
    const absPath =
      firstChatDir && relPath ? path.join(workspaceRoot, firstChatDir.name, relPath) : null
    if (absPath && fs.existsSync(absPath)) {
      const originalBytes = fs.readFileSync(absPath)
      try {
        await artifactItem.click()
        const opened = await window
          .waitForSelector('.cm-content', { timeout: 5000 })
          .catch(() => null)
        if (!opened) {
          console.log('[e2e] External-invalidation check skipped: artifact did not open')
        } else {
          const marker = `external-invalidation-marker-${Date.now()}`
          fs.writeFileSync(absPath, Buffer.concat([originalBytes, Buffer.from(`\n${marker}\n`)]))
          await window.click('.editor-toggle')
          await window.waitForSelector('.editor-view', { state: 'hidden', timeout: 5000 })
          await window.click('.editor-toggle')
          await window.waitForSelector('.editor-view', { timeout: 5000 })
          // CodeMirror virtualizes long files: .cm-content's textContent
          // holds only the viewport lines and the marker sits at EOF — poll
          // WITH a scroll to the bottom (a reload landing after a one-shot
          // scroll could leave the marker just past the scroll position).
          const scrollAndHas = (expected) =>
            window.waitForFunction(
              (text) => {
                const scroller = document.querySelector('.cm-scroller')
                if (scroller) scroller.scrollTop = scroller.scrollHeight
                return document.querySelector('.cm-content')?.textContent?.includes(text)
              },
              expected,
              { timeout: 5000 }
            )
          await scrollAndHas(marker)
          console.log('[e2e] External file change picked up after surface re-entry')
          invalidationDone = true

          // Draft-conflict lifecycle: a draft plus a newer external write
          // raises the banner; "Keep my draft" suppresses exactly that disk
          // version; a THIRD write re-arms the question; "Load disk
          // version" takes a fresh read and drops the draft. The typed text
          // goes to EOF (Ctrl+End) so the bottom-scrolled viewport renders
          // it; post-toggle assertions reuse scrollAndHas because the
          // scroller resets to the top while display:none.
          const toggleSurface = async () => {
            await window.click('.editor-toggle')
            await window.waitForSelector('.editor-view', { state: 'hidden', timeout: 5000 })
            await window.click('.editor-toggle')
            await window.waitForSelector('.editor-view', { timeout: 5000 })
          }
          const typedMarker = `typed-${Date.now()}`
          await window.click('.cm-line >> nth=-1')
          await window.keyboard.press('Control+End')
          await window.keyboard.type(typedMarker)
          fs.appendFileSync(absPath, `\nexternal-invalidation-marker-2-${Date.now()}\n`)
          await toggleSurface()
          await window.waitForSelector('.disk-conflict', { timeout: 5000 })
          console.log('[e2e] Draft + external write raised the conflict banner')
          await window.click('.disk-conflict-actions button:last-child') // Keep my draft
          await window.waitForSelector('.disk-conflict', { state: 'hidden', timeout: 5000 })
          await scrollAndHas(typedMarker)
          const marker3 = `external-invalidation-marker-3-${Date.now()}`
          fs.appendFileSync(absPath, `\n${marker3}\n`)
          await toggleSurface()
          await window.waitForSelector('.disk-conflict', { timeout: 5000 })
          console.log('[e2e] A newer external write re-armed the conflict banner')
          await window.click('.disk-conflict-actions button:first-child') // Load disk version
          // The load re-reads the file asynchronously; the poll tolerates
          // the IPC round-trip and scrolls the fresh EOF marker into view.
          await scrollAndHas(marker3)
          const typedGone = await window.evaluate(
            (expected) => !document.querySelector('.cm-content')?.textContent?.includes(expected),
            typedMarker
          )
          if (!typedGone) throw new Error('Load disk version kept the draft text')
          console.log('[e2e] Conflict lifecycle OK (raise → keep → re-arm → load)')

          // Save-time guard (3.9.2): Ctrl+S with a pending divergence must
          // not silently overwrite the newer disk version — the native
          // question decides (Cancel keeps the disk, Overwrite lands the
          // draft, Load drops the draft for a fresh read); a clean stale
          // buffer reloads silently. The dialog is driven by patching
          // dialog.showMessageBox in the main process (restored in the
          // inner finally, so the exit dialog keeps working afterwards).
          const dialogPatched = await app.evaluate(({ dialog }) => {
            const g = globalThis
            g.__origShowMessageBox = dialog.showMessageBox
            g.__dialogResponses = []
            g.__dialogCalls = []
            const mock = async (opts) => {
              const resp = g.__dialogResponses.shift() ?? 2
              g.__dialogCalls.push({ m: opts?.message ?? '?', t: Date.now(), resp })
              return { response: resp, checkboxChecked: false }
            }
            dialog.showMessageBox = mock
            // A silently failed assignment (non-writable property) would
            // surface as a real native dialog and a hung run — verify.
            return dialog.showMessageBox === mock
          })
          if (!dialogPatched) {
            throw new Error('could not patch dialog.showMessageBox in the main process')
          }
          const pushDialogResponse = (response) =>
            // electronApp.evaluate passes (electron, arg) — the response
            // is the SECOND parameter.
            app.evaluate((_electron, r) => globalThis.__dialogResponses.push(r), response)
          const dialogCallCount = () => app.evaluate(() => globalThis.__dialogCalls.length)
          const diskHas = async (text, want, timeoutMs = 5000) => {
            const deadline = Date.now() + timeoutMs
            for (;;) {
              const has = fs.readFileSync(absPath, 'utf8').includes(text)
              if (has === want) return true
              if (Date.now() > deadline) return false
              await new Promise((r) => setTimeout(r, 100))
            }
          }
          try {
            const guardMarker = `guard-${Date.now()}`
            await window.click('.cm-line >> nth=-1')
            await window.keyboard.press('Control+End')
            await window.keyboard.type(guardMarker)
            fs.appendFileSync(absPath, `\nexternal-guard-marker-${Date.now()}\n`)
            // Key delivery log for the failure dumps below.
            await window.evaluate(() => {
              const w = window
              w.__keyLog = []
              w.addEventListener(
                'keydown',
                (e) => w.__keyLog.push(`${e.key}:ctrl=${e.ctrlKey}:dp=${e.defaultPrevented}`),
                true
              )
            })
            // Cancel: the draft must NOT reach the disk.
            await pushDialogResponse(2)
            await window.keyboard.press('Control+s')
            const cancelDeadline = Date.now() + 5000
            while ((await dialogCallCount()) < 1) {
              if (Date.now() > cancelDeadline) {
                throw new Error('save-time guard did not ask on Ctrl+S')
              }
              await new Promise((r) => setTimeout(r, 100))
            }
            if (fs.readFileSync(absPath, 'utf8').includes(guardMarker)) {
              throw new Error('Cancel still wrote the draft to disk')
            }
            console.log('[e2e] Save-time guard: Cancel kept the disk version untouched')
            // Overwrite: the draft lands, the editor goes clean.
            await pushDialogResponse(0)
            await window.keyboard.press('Control+s')
            if (!(await diskHas(guardMarker, true))) {
              const debug = {
                dialogCalls: await app.evaluate(() => globalThis.__dialogCalls ?? []),
                queueLeft: await app.evaluate(() => (globalThis.__dialogResponses ?? []).length),
                keyLog: await window.evaluate(() => window.__keyLog ?? null),
                editorError: await window.evaluate(
                  () => document.querySelector('.editor-error')?.textContent ?? null
                ),
                saveDisabled: await window.evaluate(() => {
                  const save = document.querySelector('.editor-save')
                  return save instanceof HTMLButtonElement ? save.disabled : null
                }),
                bannerVisible: await window.isVisible('.disk-conflict'),
                bufferHasMarker: await window.evaluate(
                  (expected) =>
                    document.querySelector('.cm-content')?.textContent?.includes(expected) ?? null,
                  guardMarker
                ),
                diskTail: fs.readFileSync(absPath, 'utf8').slice(-160)
              }
              console.log('[e2e] Overwrite debug:', JSON.stringify(debug))
              throw new Error('Overwrite did not write the draft')
            }
            await window.waitForSelector('.editor-save:disabled', { timeout: 5000 })
            console.log('[e2e] Save-time guard: Overwrite wrote the draft')

            // Load (answer 1): the draft is dropped, the buffer takes a
            // fresh disk read, nothing is written.
            const loadMarker = `load-${Date.now()}`
            await window.click('.cm-line >> nth=-1')
            await window.keyboard.press('Control+End')
            await window.keyboard.type(loadMarker)
            const extBeforeLoad = `external-load-marker-${Date.now()}`
            fs.appendFileSync(absPath, `\n${extBeforeLoad}\n`)
            await pushDialogResponse(1)
            await window.keyboard.press('Control+s')
            await scrollAndHas(extBeforeLoad) // buffer took the fresh read
            const loadDropped = await window.evaluate(
              (expected) => !document.querySelector('.cm-content')?.textContent?.includes(expected),
              loadMarker
            )
            if (!loadDropped) throw new Error('Load kept the draft text in the buffer')
            if (fs.readFileSync(absPath, 'utf8').includes(loadMarker)) {
              throw new Error('Load wrote the draft to disk')
            }
            console.log('[e2e] Save-time guard: Load dropped the draft, took the disk')

            // Clean-stale reload: no draft, the disk moves, Ctrl+S asks
            // nothing and writes nothing — a wrong write here would
            // clobber the just-appended marker.
            const callsBefore = await dialogCallCount()
            const staleMarker = `external-stale-marker-${Date.now()}`
            fs.appendFileSync(absPath, `\n${staleMarker}\n`)
            await window.keyboard.press('Control+s')
            await scrollAndHas(staleMarker)
            if ((await dialogCallCount()) !== callsBefore) {
              throw new Error('Clean-stale save asked the conflict question')
            }
            if (!fs.readFileSync(absPath, 'utf8').includes(staleMarker)) {
              throw new Error('Clean-stale save clobbered the newer disk version')
            }
            await window.waitForSelector('.editor-save:disabled', { timeout: 5000 })
            console.log('[e2e] Save-time guard: clean-stale save reloaded silently')
          } finally {
            await app.evaluate(({ dialog }) => {
              const g = globalThis
              if (g.__origShowMessageBox) {
                dialog.showMessageBox = g.__origShowMessageBox
                delete g.__origShowMessageBox
                delete g.__dialogResponses
                delete g.__dialogCalls
              }
            })
          }
        }
      } finally {
        // Best-effort: leave no draft or open conflict behind — a dirty
        // draft pops the exit dialog and blocks app.close() below. Cleanup
        // must never mask the step's real result, so every probe is caught.
        try {
          // The probes only see the visible surface: a failure mid-toggle
          // leaves the editor hidden — re-activate it first.
          if (!(await window.isVisible('.editor-view'))) {
            await window.click('.editor-toggle', { timeout: 3000 })
            await window.waitForSelector('.editor-view', { timeout: 3000 })
          }
          // Force a revalidation (hide + show): a conflict pending WITHOUT
          // a visible banner (no trigger fired since the external write)
          // must surface now — clicking Save over it would pop the native
          // save-time dialog and wedge the cleanup.
          await window.click('.editor-toggle', { timeout: 3000 })
          await window.waitForSelector('.editor-view', { state: 'hidden', timeout: 3000 })
          await window.click('.editor-toggle', { timeout: 3000 })
          await window.waitForSelector('.editor-view', { timeout: 3000 })
          await window.waitForSelector('.disk-conflict', { timeout: 2000 }).catch(() => null)
          if (await window.isVisible('.disk-conflict')) {
            await window.click('.disk-conflict-actions button:first-child', { timeout: 3000 })
            await window
              .waitForSelector('.disk-conflict', { state: 'hidden', timeout: 3000 })
              .catch(() => {})
          } else if (
            await window.evaluate(() => {
              const save = document.querySelector('.editor-save')
              return save instanceof HTMLButtonElement && !save.disabled
            })
          ) {
            await window.click('.editor-save', { timeout: 3000 })
            await window.waitForSelector('.editor-save:disabled', { timeout: 3000 }).catch(() => {})
          }
        } catch {
          // best-effort cleanup
        }
        fs.writeFileSync(absPath, originalBytes)
      }
    }
  }
  if (!invalidationDone) {
    console.log('[e2e] External-invalidation check skipped: no openable artifact in the profile')
  }

  await window.click('.editor-toggle')
  await window.waitForSelector('webview.kimi-webview', { timeout: 5000 })
  // Keep-mounted editor: it leaves the visible surface but stays in the DOM.
  await window.waitForSelector('.editor-view', { state: 'hidden', timeout: 5000 })
  console.log('[e2e] Editor surface hidden, webview restored')

  await app.close()
  app1Closed = true

  // 8) Offline boot → online transition. Relaunch with forceOfflineMode
  // preset in the settings file, flip the title-bar toggle, and require the
  // loading overlay to DETACH — regression for the transition hanging on
  // the spinner when the webview first mounts after an offline boot (its
  // load listeners never attached, so did-finish-load never cleared
  // isLoading). The preset lives inside the outer try: whatever fails from
  // here on, the finally restores the original settings bytes.
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ ...savedSettings, forceOfflineMode: true }, null, 2)
  )
  const app2 = await electron.launch({ args: ['.'], chromiumSandbox: !noSandbox })
  try {
    const window2 = await app2.firstWindow()
    await window2.waitForSelector('.offline-chat-view', { timeout: 15000 })
    console.log('[e2e] Offline boot: offline chat view shown')
    // Lazy mount (3.5.7): a forced-offline boot must render NO webview —
    // the forced flag arrives async, and an early mount would waste a load.
    const webviewCountBefore = await window2.evaluate(
      () => document.querySelectorAll('webview').length
    )
    if (webviewCountBefore !== 0) {
      throw new Error(`Expected no webview before the transition, found ${webviewCountBefore}`)
    }
    await window2.click('.force-offline-toggle')
    await window2.waitForSelector('webview.kimi-webview', { timeout: 15000 })
    await window2.waitForSelector('.loading-overlay', { state: 'detached', timeout: 30000 })
    console.log('[e2e] Offline boot → online: webview loaded, loading overlay detached')
  } finally {
    await app2.close()
  }

  console.log('[e2e] PASS')
} finally {
  if (!app1Closed) await app.close()
  if (settingsFile) {
    if (originalSettingsRaw !== null) {
      fs.writeFileSync(settingsFile, originalSettingsRaw)
    } else {
      // No settings.json existed before the run: step 8 created one — remove
      // it rather than leave a forced-offline file the profile never had.
      fs.rmSync(settingsFile, { force: true })
    }
  }
}
