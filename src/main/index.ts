import { app, BrowserWindow, dialog, net, protocol, safeStorage, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cloudApiUrl } from '@shared/account'
import { ASSET_SCHEME } from '@shared/focus'
import { licensePublicKey } from '@shared/license'
import { AccountService } from './account/accountService'
import { createCloudAuthClient } from './account/cloudAuthClient'
import { AiKeyStore } from './ai/keyStore'
import { buildCloudProvider } from './ai/providers/cloud'
import { AiProviderRegistry } from './ai/registry'
import type { Provider } from './ai/providers/types'
import { AppStateStore } from './appState/appStateStore'
import { createDialogs } from './dialogs'
import { installCrashHandlers, processGoneError } from './diagnostics/crashHandlers'
import { createDiagnosticsSend } from './diagnostics/diagnosticsClient'
import { DiagnosticsService, type DiagnosticsSend } from './diagnostics/diagnosticsService'
import { registerHandlers } from './ipc/handlers'
import { emit } from './ipc/registry'
import { installSingleInstance } from './lifecycle'
import { installApplicationMenu } from './menu'
import { assetPathFor } from './project/assetUrl'
import { ProjectManager } from './project/manager'
import { loadAutoUpdater } from './updates/autoUpdater'
import { UpdateService } from './updates/updateService'

const isDev = !app.isPackaged
const manager = new ProjectManager()
/** F-15.2: built once the app is ready (it reads userData); its poll timer is dropped on quit. */
let account: AccountService | null = null
/** F-15.7: built once the app is ready; its check timer is dropped on quit. */
let updates: UpdateService | null = null
/** F-15.8: built once the app is ready; off until the author turns it on. */
let diagnostics: DiagnosticsService | null = null

/**
 * Why this build cannot update itself, or null when it can (F-15.7). Only a packaged build has
 * an installer to replace, the e2e harness must never reach GitHub, and on Linux only the
 * AppImage updates itself — a .deb or .rpm belongs to the package manager.
 */
function unsupportedUpdateReason(): string | null {
  if (!app.isPackaged || process.env.NODE_ENV === 'test') {
    return 'This is a development build; updates are installed by the released app.'
  }
  if (process.platform === 'linux' && process.env.APPIMAGE === undefined) {
    return 'This Linux package is updated by reinstalling; the AppImage updates itself.'
  }
  return null
}

/**
 * Where diagnostics reports go, or null when nothing may leave this machine (F-15.8). The e2e
 * harness is the one caller that has to be sure: it runs with `NODE_ENV=test`, and only a URL
 * override — its own fake Worker on loopback — lets a report be posted at all.
 */
function diagnosticsSender(baseUrl: string): DiagnosticsSend | null {
  const override = process.env.MYTHSCRIBE_CLOUD_API_URL?.trim() ?? ''
  if (process.env.NODE_ENV === 'test' && override === '') return null
  return createDiagnosticsSend({
    baseUrl,
    fetch: (input, init) => globalThis.fetch(input, init)
  })
}

/**
 * F-15.8: a failure in the main process is reported (scrubbed, and only while diagnostics are
 * on) and then shown exactly as Electron shows it by default. Installed at load, so a crash
 * before the app is ready still raises the box; `diagnostics` is null until then, and a report
 * from before the author's consent is read would be one nobody agreed to anyway.
 */
installCrashHandlers({
  process,
  report: (kind, error) => diagnostics?.reportError(kind, error),
  showErrorBox: (title, content) => dialog.showErrorBox(title, content)
})

// A helper process that died says only what the event says: a reason, a type, and an exit code.
app.on('child-process-gone', (_event, details) => {
  diagnostics?.reportError('processGone', processGoneError('child', details))
})

/** Lets e2e tests isolate app-wide state (recents) from the developer's own. */
if (process.env.MYTHSCRIBE_USER_DATA) app.setPath('userData', process.env.MYTHSCRIBE_USER_DATA)

/**
 * F-5.1: without a keyring Linux has no safe storage at all; this opts into Electron's
 * obfuscating fallback so a key can still be saved. `ai:getStatus` reports it as `plain` and
 * the AI tab warns. The method exists only on Linux.
 */
if (process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true)

/**
 * F-6.2: project assets (focus-mode backgrounds) reach the sandboxed renderer through a custom
 * scheme, `mythscribe-asset://backgrounds/<file>`, answered from the open project's folder by
 * the handler installed once the app is ready. Electron only accepts the registration before
 * `ready`; `standard` and `secure` let CSS `url()` and `<img>` load it like https.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

/** The lock lives in userData, so it must be requested after the override above. */
const primaryInstance = installSingleInstance(app, () => BrowserWindow.getAllWindows()[0] ?? null)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    // macOS takes the icon from the bundle; Windows and Linux windows need it here.
    ...(process.platform === 'darwin' ? {} : { icon }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  // Under the e2e harness the window must not steal the desktop's keyboard focus: on WSLg a
  // shown window takes focus, and anything typed on the machine lands in the test's inputs.
  win.once('ready-to-show', () => {
    if (process.env.NODE_ENV === 'test') win.showInactive()
    else win.show()
  })

  // F-1.4: with a project open, the renderer flushes pending saves first and then invokes
  // `window:close`, which closes the project so this guard lets the second close through.
  win.on('close', (e) => {
    if (!manager.current()) return
    e.preventDefault()
    emit([win], 'window:close-requested', null)
  })
  // A dead renderer can never flush, so do not let it wedge the window.
  win.webContents.on('render-process-gone', (_event, details) => {
    diagnostics?.reportError('processGone', processGoneError('renderer', details))
    manager.close()
  })
  // F-6.1: focus mode mirrors the window's real fullscreen state, whoever changed it.
  win.on('enter-full-screen', () => {
    // F-15.8: fullscreen is how focus mode is entered, however it was asked for.
    diagnostics?.count('focus.enter')
    emit([win], 'window:fullScreenChanged', { on: true })
  })
  win.on('leave-full-screen', () => emit([win], 'window:fullScreenChanged', { on: false }))

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        win.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (isDev && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

if (!primaryInstance) {
  app.quit()
} else {
  void app.whenReady().then(() => {
    // F-7.1: the native menu from the shared definition; on Windows and Linux the window's
    // `autoHideMenuBar` keeps it behind Alt, the in-app bar being the visible one.
    installApplicationMenu({
      manager,
      platform: process.platform,
      target: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    })
    // No project open, a URL outside the backgrounds folder, or a file that is gone: 404.
    protocol.handle(ASSET_SCHEME, (request) => {
      const folder = manager.current()?.path
      const file = folder === undefined ? null : assetPathFor(folder, request.url)
      if (file === null || !existsSync(file)) return new Response(null, { status: 404 })
      return net.fetch(pathToFileURL(file).toString())
    })
    const appState = new AppStateStore(join(app.getPath('userData'), 'app-state.json'))
    const keyStore = new AiKeyStore(join(app.getPath('userData'), 'ai-keys.json'), safeStorage)
    // F-15.2: the account is constructed here, not in the handlers, because it pushes
    // `account:changed` by itself when a sign-in link is opened or its attempt expires.
    const cloudBaseUrl = cloudApiUrl(process.env)
    const cloudClient = createCloudAuthClient({
      baseUrl: cloudBaseUrl,
      fetch: (input, init) => globalThis.fetch(input, init)
    })
    account = new AccountService({
      client: cloudClient,
      keyStore,
      // F-15.9: the Supporter license rides along with the account — the cached token and the
      // accent live in app-state.json, and the key it is verified against comes from the shared
      // constant (`MYTHSCRIBE_LICENSE_PUBLIC_KEY` overrides it for dev and the e2e).
      appState,
      licensePublicKey: licensePublicKey(process.env),
      onChange: (status) => emit(BrowserWindow.getAllWindows(), 'account:changed', status),
      onSupporterChange: (status) =>
        emit(BrowserWindow.getAllWindows(), 'account:supporterChanged', status)
    })
    // F-15.4: the Cloud adapter reads the session live through the account service, so it is
    // built once here and never rebuilt; a 401 from the proxy ends the session the same way a
    // refresh does. `credits` comes from the one auth client, so there is one piece of wire code.
    const signedInAccount = account
    const cloud = (): Provider =>
      buildCloudProvider({
        baseUrl: cloudBaseUrl,
        fetch: (input, init) => globalThis.fetch(input, init),
        token: () => signedInAccount.sessionToken(),
        onSessionEnded: () => signedInAccount.sessionEnded(),
        resolveModel: (tier) => appState.get().models.cloud[tier],
        credits: (token) => cloudClient.credits(token),
        // F-15.5: every answered request carries the balance it left behind, so the usage meter
        // and the low-credit notice follow a charge without asking `/credits` again.
        onBalance: (balanceMicros) =>
          emit(BrowserWindow.getAllWindows(), 'account:balanceChanged', { balanceMicros })
      })
    // F-15.7: the updater is built here for the same reason as the account — it pushes
    // `updates:changed` by itself from the background check and the download — and is left out
    // entirely (a plain reason instead) wherever this build cannot replace itself.
    const updateReason = unsupportedUpdateReason()
    updates = new UpdateService({
      updater: updateReason === null ? loadAutoUpdater() : null,
      unsupportedReason: updateReason,
      appState,
      currentVersion: app.getVersion(),
      onChange: (state) => emit(BrowserWindow.getAllWindows(), 'updates:changed', state)
    })
    // F-15.8: opt-in diagnostics. Built for every run so the Settings tab has something to
    // read, but off until the author says otherwise, and it records nothing while it is off.
    // The stack scrubber keeps only frames inside the app bundle, so `getAppPath` is the root.
    diagnostics = new DiagnosticsService({
      appState,
      environment: {
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron
      },
      appRoots: [app.getAppPath()],
      send: diagnosticsSender(cloudBaseUrl),
      onChange: (state) => emit(BrowserWindow.getAllWindows(), 'diagnostics:changed', state)
    })
    // The first counted event of the run; a no-op unless the author turned diagnostics on.
    diagnostics.count('app.launch')
    registerHandlers({
      manager,
      appState,
      keyStore,
      ai: new AiProviderRegistry(keyStore, () => appState.get().models, undefined, cloud),
      account,
      updates,
      diagnostics,
      dialogs: createDialogs(
        () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      ),
      windows: () => BrowserWindow.getAllWindows(),
      focusedWindow: () => BrowserWindow.getFocusedWindow(),
      openExternal: (url) => shell.openExternal(url),
      onCloseCancelled: () => {
        quitRequested = false
      }
    })
    createWindow()
    // The first check waits for the window: nothing about an update is urgent (F-15.7).
    updates.start()
    // Same for the first diagnostics flush (F-15.8), which is also a no-op while it is off.
    diagnostics.start()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// A prevented window close (project open, renderer still flushing) cancels the in-flight quit.
// Remember that a quit was asked for so macOS exits once the flushed window finally closes;
// `window:close-cancelled` (flush failed, author kept working) forgets it again, so a later
// plain window close does not quit the app.
let quitRequested = false
app.on('before-quit', () => {
  quitRequested = true
})

/** `will-quit`, not `before-quit`: the renderer must flush before the DB closes. */
app.on('will-quit', () => {
  account?.dispose()
  updates?.dispose()
  diagnostics?.dispose()
  manager.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || quitRequested) app.quit()
})
