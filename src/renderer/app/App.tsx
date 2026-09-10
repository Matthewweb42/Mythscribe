import { useEffect } from 'react'
import { BookOpen, FolderOpen, FilePlus2 } from 'lucide-react'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { dialogs, toast } from '@renderer/features/shell/dialogs/dialogStore'
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

  const onNew = async (): Promise<void> => {
    const name = await dialogs.prompt({
      title: 'New project',
      message: 'Name your novel. You can rename it later.',
      placeholder: 'My Epic Novel',
      confirmLabel: 'Create',
      validate: (v) => (v.trim().length > 0 ? null : 'A name is required')
    })
    if (name === null) return
    try {
      const info = await create(name, 'novel')
      if (info) toast.success(`Created "${info.name}"`)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  const onOpen = async (): Promise<void> => {
    try {
      const info = await open()
      if (info) toast.success(`Opened "${info.name}"`)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  return (
    <div className="flex w-[360px] flex-col items-center gap-6 text-center">
      <div>
        <h1 className="m-0 text-3xl font-semibold tracking-tight">MythScribe</h1>
        <p className="mt-2 mb-0 text-sm text-fg-muted">Your book, your voice, on your machine.</p>
      </div>
      <div className="flex w-full flex-col gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void onNew()}
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
      </div>
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
