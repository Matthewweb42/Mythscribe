import {
  SWITCHOVER_RECORD_KEY,
  SwitchoverRecord,
  type SwitchoverRecord as SwitchoverRecordT
} from '@shared/memory/switchover'
import type { TreeDb } from '../../tree/treeStore'
import { readRow, writeRow } from '../reading/readerRows'

/**
 * The switch-over record (F-16.31, decision SW-D7): one project `settings` row, written in the
 * conversion's transaction (`convertSwitchover`), so the backup's place, the dated copy and how to
 * go back outlive the dialog. Lenient on read: a missing or broken row reads as none, which is how
 * every project made v2 another way (the development override, the test book) reads.
 */

export function getSwitchoverRecord(db: TreeDb): SwitchoverRecordT | null {
  return readRow(db, SWITCHOVER_RECORD_KEY, SwitchoverRecord.nullable(), null)
}

export function setSwitchoverRecord(db: TreeDb, value: SwitchoverRecordT): SwitchoverRecordT {
  const stored = SwitchoverRecord.parse(value)
  writeRow(db, SWITCHOVER_RECORD_KEY, stored)
  return stored
}

/**
 * The first *Rebuild memory* after the switch has started (slice 2): the record says so once,
 * with when. Nothing without a record, and nothing on a second start. Answers the record.
 */
export function markRebuildStarted(db: TreeDb, now: Date): SwitchoverRecordT | null {
  const current = getSwitchoverRecord(db)
  if (current === null || current.rebuild === 'started') return current
  return setSwitchoverRecord(db, {
    ...current,
    rebuild: 'started',
    rebuildStartedAt: now.toISOString()
  })
}
