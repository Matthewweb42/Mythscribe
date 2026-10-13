import { useRecordStore } from '@renderer/features/records/recordStore'
import type { NameOf } from './knowsView'

/** A record's name as the who-knows-what lines read it (F-16.22), or a stand-in once it is gone. */
export function useNameOf(): NameOf {
  const byId = useRecordStore((s) => s.byId)
  return (id) => (id === null ? 'Someone' : (byId[id]?.name ?? 'someone'))
}
