import { CONTEXT_FILE_MAX_BYTES } from '@shared/contextLibrary'
import { NOTEBOOK_IMPORT_DEPTH_MAX } from '@shared/notebook'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import type { NotebookDroppedFile } from './notebookStore'

/**
 * Files and folders dropped on the Notes tree (notes redesign phase 1, slice 1), read with the
 * folders each sits in, so a dropped folder becomes a folder of pages. The entries must be taken
 * from the drop event at once (`webkitGetAsEntry` answers nothing after the handler returns);
 * reading them is asynchronous. Without entries (a test, a browser without them) the plain file
 * list is used, every file at the top. A file over 25 MB is named in a toast and left out.
 */

/** A dropped file before it is read: the file and the folders it was in. */
interface PendingFile {
  file: File
  folders: string[]
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

/** Every entry of a directory (`readEntries` answers in batches until an empty one). */
async function entriesOf(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader()
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    )
    if (batch.length === 0) return all
    all.push(...batch)
  }
}

const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile
const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory

async function walk(entry: FileSystemEntry, folders: string[], out: PendingFile[]): Promise<void> {
  if (isFile(entry)) {
    out.push({ file: await fileOf(entry), folders })
    return
  }
  if (!isDirectory(entry)) return
  // Deeper than the limit, files land in the deepest folder kept.
  const inside = folders.length < NOTEBOOK_IMPORT_DEPTH_MAX ? [...folders, entry.name] : folders
  for (const child of await entriesOf(entry)) await walk(child, inside, out)
}

/** What `takeDropped` reads of a drop's `DataTransfer`. */
export interface DroppedTransfer {
  items: ArrayLike<{ webkitGetAsEntry?: () => FileSystemEntry | null }>
  files: ArrayLike<File>
}

/** Takes the drop's entries now (synchronously) and answers a reader of their files. */
export function takeDropped(transfer: DroppedTransfer): () => Promise<NotebookDroppedFile[]> {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(transfer.items)) {
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry !== null) entries.push(entry)
  }
  const files = Array.from(transfer.files)
  return async () => {
    const pending: PendingFile[] = []
    if (entries.length > 0) {
      for (const entry of entries) await walk(entry, [], pending)
    } else {
      for (const file of files) pending.push({ file, folders: [] })
    }
    return readPending(pending)
  }
}

async function readPending(pending: readonly PendingFile[]): Promise<NotebookDroppedFile[]> {
  const read: NotebookDroppedFile[] = []
  for (const { file, folders } of pending) {
    if (file.size > CONTEXT_FILE_MAX_BYTES) {
      toast.warning(`${file.name}: The file is larger than 25 MB.`)
      continue
    }
    read.push({ name: file.name, folders, data: new Uint8Array(await file.arrayBuffer()) })
  }
  return read
}
