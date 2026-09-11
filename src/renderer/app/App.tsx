import { useEffect, useState } from 'react'
import { BookOpen, FolderOpen, FilePlus2 } from 'lucide-react'
import type { NovelFormat } from '@shared/ipc/contract'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
import { Logo } from '@renderer/features/shell/Logo'
import { CreateProjectWizard } from '@renderer/features/project/CreateProjectWizard'
import { RecentProjects } from '@renderer/features/project/RecentProjects'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { IpcRequestError } from '@renderer/lib/ipc'

function describeError(err: unknown): string {
  if (err instanceof IpcRequestError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

export function App(): React.JSX.Element {
  const ready = useProjectStore((s) => s.ready)
  const current = useProjectStore((s) => s.current)

  useEffect(() => {
    useProjectStore
      .getState()
      .init()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 items-center gap-2 border-b border-line bg-surface px-4 text-sm">
        <BookOpen size={16} className="text-accent" />
        <span className="font-semibold">MythScribe</span>
        {current ? <span className="text-fg-muted">/ {current.name}</span> : null}
      </header>
      <main className="flex flex-1 items-center justify-center overflow-auto">
        {!ready ? null : current ? <ProjectScreen /> : <WelcomeScreen />}
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

  const onCreate = async (name: string, format: NovelFormat): Promise<void> => {
    try {
      const info = await create(name, format)
      if (info) toast.success(`Created "${info.name}"`)
    } catch (err) {
      toast.error(describeError(err))
    }
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
        <Logo className="text-accent" />
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

function ProjectScreen(): React.JSX.Element {
  const current = useProjectStore((s) => s.current)
  const busy = useProjectStore((s) => s.busy)
  const close = useProjectStore((s) => s.close)
  if (!current) return <></>

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
    <div className="w-[520px] rounded-lg border border-line bg-surface p-6">
      <h1 className="m-0 text-2xl font-semibold" data-testid="project-name">
        {current.name}
      </h1>
      <dl className="mt-4 grid grid-cols-[120px_1fr] gap-y-2 text-sm">
        <dt className="text-fg-muted">Format</dt>
        <dd className="m-0">{current.format}</dd>
        <dt className="text-fg-muted">Location</dt>
        <dd className="m-0 break-all font-mono text-xs">{current.path}</dd>
        <dt className="text-fg-muted">Schema</dt>
        <dd className="m-0">v{current.schemaVersion}</dd>
      </dl>
      <p className="mt-4 mb-0 text-sm text-fg-muted">
        The manuscript editor arrives in milestone M1. This screen proves the project lives on disk.
      </p>
      <div className="mt-5 flex justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onClose()}
          className="rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface-raised disabled:opacity-60"
        >
          Close project
        </button>
      </div>
    </div>
  )
}
