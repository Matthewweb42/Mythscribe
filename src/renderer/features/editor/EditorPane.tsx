import type { NovelFormat } from '@shared/ipc/contract'
import { DocumentEditor } from './DocumentEditor'

/** The main pane for one selected document (F-3.1): a `DocumentEditor` with its own toolbar. */
export function EditorPane({ id, format }: { id: string; format: NovelFormat }): React.JSX.Element {
  return <DocumentEditor id={id} format={format} />
}
