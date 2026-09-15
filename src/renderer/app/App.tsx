import { useEffect } from 'react'
import { FolderOpen, FilePlus2, PanelLeft, Settings2 } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { formatLabel, levelLabel, sectionLabel, type HierarchyLevel } from '@shared/labels'
import { LAYOUT_LIMITS } from '@shared/layout'
import { AboutDialog } from '@renderer/features/shell/AboutDialog'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { resizePanelBy, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { Logo } from '@renderer/features/shell/Logo'
import { MenuBar } from '@renderer/features/shell/MenuBar'
import {
  closeProjectWithConfirm,
  insertLevel,
  runMenuAction
} from '@renderer/features/shell/menuActions'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { SettingsDialog } from '@renderer/features/shell/SettingsDialog'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { ShortcutsDialog } from '@renderer/features/shell/ShortcutsDialog'
import { APP_SHORTCUTS, matchesShortcut, type Chord } from '@renderer/features/shell/shortcuts'
import { SidebarTabs } from '@renderer/features/shell/SidebarTabs'
import { EditorPane } from '@renderer/features/editor/EditorPane'
import { NotesPanel } from '@renderer/features/editor/NotesPanel'
import { StackedEditor } from '@renderer/features/editor/StackedEditor'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { AiActivityIndicator } from '@renderer/features/ai/AiActivityIndicator'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { AssistantPanel, AssistantToggleButton } from '@renderer/features/ai/AssistantPanel'
import { useAssistantStore } from '@renderer/features/ai/assistantStore'
import { usePresetsStore } from '@renderer/features/ai/presetsStore'
import { useProvenanceStore } from '@renderer/features/ai/provenanceStore'
import { useVoiceStore } from '@renderer/features/ai/voiceStore'
import { useEditorSettingsStore } from '@renderer/features/editor/settingsStore'
import { FocusBackdrop } from '@renderer/features/focus/FocusBackdrop'
import { FocusControlBar } from '@renderer/features/focus/FocusControlBar'
import { FocusFloatingPanels } from '@renderer/features/focus/FocusFloatingPanels'
import { BackgroundRotation } from '@renderer/features/focus/rotation'
import { OVERLAY_DARKNESS } from '@shared/focus'
import { useBackgroundStore, useCurrentBackground } from '@renderer/features/focus/backgroundStore'
import { escapeFocusMode, useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { CreateProjectWizard } from '@renderer/features/project/CreateProjectWizard'
import { RecentProjects } from '@renderer/features/project/RecentProjects'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { useWelcomeStore } from '@renderer/features/project/welcomeStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

export function App(): React.JSX.Element {
  const ready = useProjectStore((s) => s.ready)
  const current = useProjectStore((s) => s.current)
  const projectId = current?.id ?? null

  useEffect(() => {
    useProjectStore
      .getState()
      .init()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-7.2: the panel layout is app-wide; it loads once here, before any project opens.
    useLayoutStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-1.4: the OS close button flushes pending saves first; a failed flush keeps the window
    // open with the error visible so no words are lost.
    const offClose = ipc().on('window:close-requested', () => {
      const store = useProjectStore.getState()
      if (store.busy) return // a flush is already in flight; the first request will close the window
      store.closeWindow().catch((err: unknown) => toast.error(describeError(err)))
    })
    // F-6.1: focus mode follows the window's real fullscreen state.
    const offFocus = useFocusStore.getState().subscribe()
    // F-7.1: a native menu click or accelerator runs the same action as the in-app bar.
    const offMenu = ipc().on('menu:action', ({ id }) => {
      void runMenuAction(id)
    })
    return () => {
      offClose()
      offFocus()
      offMenu()
    }
  }, [])

  // F-1.5: the OS window title follows the open project.
  useEffect(() => {
    document.title = current ? `${current.name} — MythScribe` : 'MythScribe'
  }, [current])

  // F-2.1: the document tree follows the open project. App owns when it loads and clears, keyed
  // on the project id so a refreshed `ProjectInfo` for the same project does not reload it.
  // F-3.1: the loaded document goes with it. F-3.6: so do the formatting settings. F-3.7: and
  // the loaded notes (the panel layout is app-wide, F-7.2, so it stays). F-4.2: and the tag
  // bank, whose failure toasts on its own and never blocks the tree. F-4.4: and the document
  // tag links, loaded per document by the tag bar. F-4.5: and the scene metadata, loaded per
  // node by the metadata pane. F-14.4: and the AI dial and toggles. F-5.2: and the writing
  // presets. F-14.1: and the voice exemplars (the toolbar button needs the count). F-14.6: the
  // provenance report is loaded by its section on demand and only cleared here. F-5.4: and the
  // assistant conversations. F-6.1: a project closed in focus mode leaves it, so the welcome
  // screen is windowed. F-6.2: and the focus-mode backgrounds.
  useEffect(() => {
    const tree = useTreeStore.getState()
    if (projectId === null) {
      const focus = useFocusStore.getState()
      if (focus.active) void focus.exit()
      tree.clear()
      useDocumentStore.getState().clear()
      useNotesStore.getState().clear()
      useSceneMetaStore.getState().clear()
      useEditorSettingsStore.getState().clear()
      useAiSettingsStore.getState().clear()
      usePresetsStore.getState().clear()
      useVoiceStore.getState().clear()
      useProvenanceStore.getState().clear()
      useAssistantStore.getState().clear()
      // F-7.1: a shell dialog left open over the closing project must not reappear over the next one.
      useShellDialogStore.getState().close()
      useTagStore.getState().clear()
      useDocumentTagStore.getState().clear()
      useBackgroundStore.getState().clear()
      return
    }
    tree.load().catch((err: unknown) => toast.error(describeError(err)))
    useEditorSettingsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useAiSettingsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    usePresetsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useVoiceStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useAssistantStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useTagStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useBackgroundStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [projectId])

  // F-6.1: focus mode hides the header with the rest of the chrome; the header's shortcut
  // listeners (Ctrl+, / Ctrl+K / Insert) go with it, `FocusShortcuts` stays so F11 and Escape
  // are always a way out.
  const focus = useFocusStore((s) => s.active) && current !== null
  // F-6.2: the current background sits behind the editor in focus mode; `isolate` keeps the
  // fixed layer under the main pane's content.
  const background = useCurrentBackground()
  const darkness = useBackgroundStore(
    (s) => s.settings?.overlay.darkness ?? OVERLAY_DARKNESS.default
  )

  return (
    <div className="flex h-full flex-col">
      {focus ? null : (
        <header className="flex h-11 items-center gap-2 border-b border-line bg-surface px-4 text-sm">
          {current ? <SidebarToggleButton /> : null}
          <Logo size={16} />
          <span className="font-semibold">MythScribe</span>
          <MenuBar />
          {current ? (
            <span className="text-fg-muted">
              / <span data-testid="project-name">{current.name}</span> ·{' '}
              {formatLabel(current.format)}
            </span>
          ) : null}
          {current ? (
            <div className="ml-auto flex items-center gap-2">
              <AiActivityIndicator />
              <AssistantToggleButton />
              <SettingsButton />
              <CloseProjectButton />
            </div>
          ) : null}
        </header>
      )}
      {current ? <FocusShortcuts /> : null}
      {current ? <SettingsShortcut /> : null}
      {current ? <InsertShortcuts format={current.format} /> : null}
      <main
        className={
          current
            ? 'isolate flex min-h-0 flex-1 overflow-hidden'
            : 'flex flex-1 items-center justify-center overflow-auto'
        }
      >
        {focus && background ? <FocusBackdrop url={background.url} darkness={darkness} /> : null}
        {focus ? <BackgroundRotation /> : null}
        {!ready ? null : current ? <ProjectScreen format={current.format} /> : <WelcomeScreen />}
        {focus ? <FocusControlBar /> : null}
      </main>
      {/* The dialog service last, so a confirm from inside a shell dialog stacks above it. */}
      <ShellDialogs format={current?.format ?? null} />
      <DialogHost />
    </div>
  )
}

/**
 * The app-level dialogs (F-7.1): Settings (F-7.5, a project's settings, so only with one open),
 * the shortcuts reference (F-7.7), and About, one at a time from the shell dialog store, which
 * the header button, Ctrl+, the in-app bar, and the native menu all open through.
 */
function ShellDialogs({ format }: { format: NovelFormat | null }): React.JSX.Element | null {
  const open = useShellDialogStore((s) => s.open)
  const close = useShellDialogStore((s) => s.close)
  switch (open) {
    case 'settings':
      return format ? <SettingsDialog format={format} onClose={close} /> : null
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />
    case 'about':
      return <AboutDialog onClose={close} />
    case null:
      return null
  }
}

function WelcomeScreen(): React.JSX.Element {
  const busy = useProjectStore((s) => s.busy)
  const create = useProjectStore((s) => s.create)
  const open = useProjectStore((s) => s.open)
  const recents = useProjectStore((s) => s.recents)
  const loadRecents = useProjectStore((s) => s.loadRecents)
  const removeRecent = useProjectStore((s) => s.removeRecent)
  // F-7.1: File › New project opens the wizard through the store; a reopened welcome screen
  // starts on the buttons again.
  const creating = useWelcomeStore((s) => s.creating)
  const setCreating = useWelcomeStore((s) => s.setCreating)

  useEffect(() => {
    loadRecents().catch((err: unknown) => toast.error(describeError(err)))
  }, [loadRecents])
  useEffect(() => () => setCreating(false), [setCreating])

  /** Failures propagate: the wizard shows them inline where the author is looking. */
  const onCreate = async (name: string, format: NovelFormat): Promise<void> => {
    const info = await create(name, format)
    if (info) toast.success(`Created "${info.name}"`)
  }

  /** Opens via the native dialog, or a recent project when `path` is given. */
  const onOpen = async (path?: string): Promise<void> => {
    try {
      const info = await open(path)
      if (info) toast.success(`Opened "${info.name}"`)
    } catch (err) {
      toast.error(describeError(err))
      // A vanished folder gets re-marked "Not found" on refresh.
      loadRecents().catch((e: unknown) => toast.error(describeError(e)))
    }
  }

  const onRemoveRecent = async (path: string): Promise<void> => {
    try {
      await removeRecent(path)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  return (
    <div
      className={`flex flex-col items-center gap-6 text-center ${creating ? 'w-[520px]' : 'w-[440px]'}`}
    >
      <div className="flex flex-col items-center">
        <Logo />
        <h1 className="m-0 mt-3 text-3xl font-semibold tracking-tight">MythScribe</h1>
        <p className="mt-2 mb-0 text-sm text-fg-muted">Your book, your voice, on your machine.</p>
      </div>
      {creating ? (
        <CreateProjectWizard busy={busy} onCancel={() => setCreating(false)} onCreate={onCreate} />
      ) : (
        <div className="flex w-full flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setCreating(true)}
            className="flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            <FilePlus2 size={16} /> New project
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onOpen()}
            className="flex items-center justify-center gap-2 rounded-md border border-line bg-surface px-4 py-2.5 hover:bg-surface-raised disabled:opacity-60"
          >
            <FolderOpen size={16} /> Open project
          </button>
          <RecentProjects
            recents={recents}
            busy={busy}
            onOpen={(path) => void onOpen(path)}
            onRemove={(path) => void onRemoveRecent(path)}
          />
        </div>
      )}
    </div>
  )
}

/** Header action: confirms, then closes the open project (everything is already saved); File › Close project does the same. */
function CloseProjectButton(): React.JSX.Element {
  const busy = useProjectStore((s) => s.busy)

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void closeProjectWithConfirm()}
      className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface-raised disabled:opacity-60"
    >
      Close project
    </button>
  )
}

/** Header action (F-7.2): shows or hides the sidebar; `aria-pressed` reflects whether it is open. */
function SidebarToggleButton(): React.JSX.Element {
  const open = useLayoutStore((s) => s.layout.sidebar.open)
  const toggle = useLayoutStore((s) => s.toggle)
  return (
    <button
      type="button"
      aria-label="Sidebar"
      title="Sidebar"
      aria-pressed={open}
      onClick={() => toggle('sidebar')}
      className="-ml-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:text-fg"
    >
      <PanelLeft size={16} aria-hidden="true" />
    </button>
  )
}

const INSERT_CHORDS: [Chord, HierarchyLevel][] = [
  [APP_SHORTCUTS.insertScene.chord, 'scene'],
  [APP_SHORTCUTS.insertChapter.chord, 'chapter'],
  [APP_SHORTCUTS.insertPart.chord, 'part']
]

/**
 * Insert shortcuts (F-2.7): Ctrl+Shift+S / C / P create a scene, chapter, or part relative to
 * the current selection through `insertLevel`, which the Insert menu (F-7.1) shares. The
 * listener runs in the capture phase and stops the event, so the editor never sees the chord
 * (its own Mod-Shift-S is strikethrough). Mounted only while a project is open; renders
 * nothing.
 */
function InsertShortcuts({ format }: { format: NovelFormat }): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const hit = INSERT_CHORDS.find(([chord]) => matchesShortcut(event, chord))
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      insertLevel(hit[1], format)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [format])
  return null
}

/**
 * Focus mode shortcuts (F-6.1): F11 toggles it; Escape leaves it, but only when nothing closer
 * to the keystroke claimed the key (the dialogs and popups handle their own Escape and prevent
 * default), so the listener runs in the bubble phase. Inside the editor ProseMirror prevents
 * default on every Escape, so there the editor's own `EscapeShortcut` hands a bare Escape to
 * `escapeFocusMode` and this listener sees it as claimed: one exit either way. Mounted only
 * while a project is open, outside the header, so it survives the chrome being hidden;
 * renders nothing.
 */
function FocusShortcuts(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchesShortcut(event, APP_SHORTCUTS.focusMode.chord)) {
        event.preventDefault()
        void useFocusStore.getState().toggle()
      } else if (event.key === 'Escape' && !event.defaultPrevented) {
        escapeFocusMode()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return null
}

/**
 * Ctrl+, (Cmd+, on macOS) opens the Settings dialog (F-7.5). Settings are per project, so the
 * listener is mounted only while one is open; it sits beside `FocusShortcuts`, outside the
 * header, so it works in focus mode too (F-7.1). Renders nothing.
 */
function SettingsShortcut(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchesShortcut(event, APP_SHORTCUTS.settings.chord)) {
        event.preventDefault()
        useShellDialogStore.getState().show('settings')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return null
}

/** Header action (F-7.5): opens the Settings dialog, which `ShellDialogs` renders. */
function SettingsButton(): React.JSX.Element {
  const show = useShellDialogStore((s) => s.show)
  return (
    <button
      type="button"
      aria-label="Settings"
      title="Settings (Ctrl+,)"
      onClick={() => show('settings')}
      className="rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
    >
      <Settings2 size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * F-7.3: the tabbed sidebar beside the main pane; its Manuscript tab holds the document tree
 * (F-2.1) with the create buttons (F-2.2) pinned under it. The editor (F-3.1) takes the main
 * pane for the selected document, or every document of the selected folder stacked (F-2.5,
 * F-3.8), with the notes panel (F-3.7) beside it when open. F-7.2: the sidebar's open state
 * and width come from the layout store; the width is a fraction of the window rendered in
 * `vw`, resized by the handle on its right edge. F-5.4: the assistant panel docks at the right
 * edge, full height, whatever is selected (Plan mode works without a scene). F-6.1: focus mode
 * hides the sidebar and both side panels without touching the layout store, so they come back
 * as they were on exit. F-6.5 / F-6.6: in focus mode the notes and the assistant follow the
 * focus store's own flags (the control bar toggles them; both close on exit) and float as
 * windows over the editor instead of docking.
 */
function ProjectScreen({ format }: { format: NovelFormat }): React.JSX.Element {
  const sidebar = useLayoutStore((s) => s.layout.sidebar)
  const focus = useFocusStore((s) => s.active)
  return (
    <>
      {sidebar.open && !focus ? (
        <aside
          className="relative flex shrink-0 flex-col border-r border-line bg-surface"
          style={{ width: `${sidebar.size * 100}vw` }}
        >
          <SidebarTabs format={format} />
          <ResizeHandle
            side="right"
            value={sidebar.size}
            min={LAYOUT_LIMITS.sidebar[0]}
            max={LAYOUT_LIMITS.sidebar[1]}
            ariaLabel="Resize sidebar"
            onChange={(deltaPx) => resizePanelBy('sidebar', deltaPx)}
          />
        </aside>
      ) : null}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <MainPane format={format} />
      </section>
      {focus ? <FocusFloatingPanels /> : <AssistantPanel />}
    </>
  )
}

function MainPane({ format }: { format: NovelFormat }): React.JSX.Element {
  const focus = useFocusStore((s) => s.active)
  const node = useTreeStore((s) => (s.selectedId === null ? undefined : s.byId[s.selectedId]))
  const section = useTreeStore((s) =>
    s.selectedId === null ? undefined : s.sectionOf[s.selectedId]
  )
  if (!node) {
    // F-3.5: the empty state, centered in the pane.
    return (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="empty-state">
        <p className="m-0 text-sm text-fg-muted">Select a document to start writing.</p>
      </div>
    )
  }
  const kind =
    node.hierarchyLevel !== null
      ? levelLabel(format, node.hierarchyLevel)
      : node.kind === 'folder'
        ? 'Folder'
        : 'Document'
  return (
    <>
      <div className="shrink-0 px-6 pt-6 pb-4">
        <h1 className="m-0 text-2xl font-semibold" data-testid="selected-title">
          {node.title}
        </h1>
        <p className="mt-1 mb-0 text-sm text-fg-muted">
          {kind}
          {section ? ` · ${sectionLabel(format, section)}` : ''}
        </p>
      </div>
      <div className="flex min-h-0 flex-1">
        {node.kind === 'document' ? (
          <EditorPane id={node.id} format={format} />
        ) : (
          <StackedEditor folderId={node.id} format={format} />
        )}
        {focus ? null : <NotesPanel id={node.id} />}
      </div>
    </>
  )
}
