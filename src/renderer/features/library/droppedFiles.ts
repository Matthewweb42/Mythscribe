import { CONTEXT_FILE_MAX_BYTES } from '@shared/contextLibrary'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'

/** A dropped file as `library:addData` and `research:addData` carry it. */
export interface DroppedFile {
  name: string
  data: Uint8Array<ArrayBuffer>
}

/**
 * The bytes of files dropped on the window (F-9.8, F-16.8), read once for whichever store takes
 * them. A file over the size cap is named in a toast and left out.
 */
export async function readDropped(dropped: readonly File[]): Promise<DroppedFile[]> {
  const files: DroppedFile[] = []
  for (const file of dropped) {
    if (file.size > CONTEXT_FILE_MAX_BYTES) {
      toast.warning(`${file.name}: The file is larger than 25 MB.`)
      continue
    }
    files.push({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })
  }
  return files
}
