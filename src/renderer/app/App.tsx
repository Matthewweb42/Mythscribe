import { useEffect, useState } from 'react'
import { FolderOpen, FilePlus2, PanelLeft, Settings2 } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { formatLabel, levelLabel, sectionLabel } from '@shared/labels'
import { LAYOUT_LIMITS } from '@shared/layout'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { resizePanelBy, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { Logo } from '@renderer/features/shell/Logo'
import { ResizeHandle } from '@renderer/features/shell/ResizeHandle'
import { SettingsDialog } from '@renderer/features/shell/SettingsDialog'
import { SidebarTabs } from '@renderer/features/shell/SidebarTabs'
import { EditorPane } from '@renderer/features/editor/EditorPane'
import { NotesPanel } from '@renderer/features/editor/NotesPanel'
import { StackedEditor } from '@renderer/features/editor/StackedEditor'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { useEditorSettingsStore } from '@renderer/features/editor/settingsStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { CreateProjectWizard } from '@renderer/features/project/CreateProjectWizard'
import { RecentProjects } from '@renderer/features/project/RecentProjects'
import { useProjectStore } from '@renderer/features/project/projectStore'
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
    return ipc().on('window:close-requested', () => {
      const store = useProjectStore.getState()
      if (store.busy) return // a flush is already in flight; the first request will close the window
      store.closeWindow().catch((err: unknown) => toast.error(describeError(err)))
    })
  }, [])

  // F-1.5: the OS window title follows the open project.
  useEffect(() => {
    document.title = current ? `${current.name} — MythScribe` : 'MythScribe'
  }, [current])

  // F-2.1: the document tree follows the open project. App owns when it loads and clears, keyed
  // on the project id so a refreshed `ProjectInfo` for the same project does not reload it.
  // F-3.1: the loaded document goes with it. F-3.6: so do the formatting settings. F-3.7: and
  // the loaded notes (the panel layout is app-wide, F-7.2, so it stays).
  useEffect(() => {
    const tree = useTreeStore.getState()
    if (projectId === null) {
      tree.clear()
      useDocumentStore.getState().clear()
      useNotesStore.getState().clear()
      useEditorSettingsStore.getState().clear()
      return
    }
    tree.load().catch((err: unknown) => toast.error(describeError(err)))
    useEditorSettingsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [projectId])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center gap-2 border-b border-line bg-surface px-4 text-sm">
        {current ? <SidebarToggleButton /> : null}
        <Logo size={16} />
        <span className="font-semibold">MythScribe</span>
        {current ? (
          <span className="text-fg-muted">
            / <span data-testid="project-name">{current.name}</span> · {formatLabel(current.format)}
          </span>
        ) : null}
        {current ? (
          <div className="ml-auto flex items-center gap-2">
            <SettingsButton format={current.format} />
            <CloseProjectButton />
          </div>
        ) : null}
      </header>
      <main
        className={
          current
            ? 'flex min-h-0 flex-1 overflow-hidden'
            : 'flex flex-1 items-center justify-center overflow-auto'
        }
      >
        {!ready ? null : current ? <ProjectScreen format={current.format} /> : <WelcomeScreen />}
      </main>
      <DialogHost />
    </div>
  )
}

function WelcomeScreen(): React.JSX.Element {
  const busy = useProjectStore((s) => s.busy)
  const create = useProjectStore((s) => s.create)
  const open = useProjectStore((s) => s.open)
  const recents = useProjectStore((s) => s.recents)
  const loadRecents = useProjectStore((s) => s.loadRecents)
  const removeRecent = useProjectStore((s) => s.removeRecent)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    loadRecents().catch((err: unknown) => toast.error(describeError(err)))
  }, [loadRecents])

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

/** Header action: confirms, then closes the open project (everything is already saved). */
function CloseProjectButton(): React.JSX.Element {
  const busy = useProjectStore((s) => s.busy)
  const close = useProjectStore((s) => s.close)

  const onClose = async (): Promise<void> => {
    const ok = await dialogs.confirm({
      title: 'Close project',
      message: 'Everything is saved automatically. Close it now?',
      confirmLabel: 'Close'
    })
    if (!ok) return
    try {
      await close()
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void onClose()}
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

/**
 * Header action (F-7.5): opens the Settings dialog, as does Ctrl+, (Cmd+, on macOS). Settings
 * are per project, so the button, its shortcut listener, and the dialog exist only while a
 * project is open: this component is the one owner of all three and is mounted only then.
 */
function SettingsButton({ format }: { format: NovelFormat }): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key === ',') {
        event.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <button
        type="button"
        aria-label="Settings"
        title="Settings (Ctrl+,)"
        onClick={() => setOpen(true)}
        className="rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
      >
        <Settings2 size={16} aria-hidden="true" />
      </button>
      {open ? <SettingsDialog format={format} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/**
 * F-7.3: the tabbed sidebar beside the main pane; its Manuscript tab holds the document tree
 * (F-2.1) with the create buttons (F-2.2) pinned under it. The editor (F-3.1) takes the main
 * pane for the selected document, or every document of the selected folder stacked (F-2.5,
 * F-3.8), with the notes panel (F-3.7) beside it when open. F-7.2: the sidebar's open state
 * and width come from the layout store; the width is a fraction of the window rendered in
 * `vw`, resized by the handle on its right edge.
 */
function ProjectScreen({ format }: { format: NovelFormat }): React.JSX.Element {
  const sidebar = useLayoutStore((s) => s.layout.sidebar)
  return (
    <>
      {sidebar.open ? (
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
    </>
  )
}

function MainPane({ format }: { format: NovelFormat }): React.JSX.Element {
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
        <NotesPanel id={node.id} />
      </div>
    </>
  )
}
