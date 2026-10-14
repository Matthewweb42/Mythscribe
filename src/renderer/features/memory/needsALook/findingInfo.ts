import { useId, useState } from 'react'

/** ⓘ on a finding (F-16.27): whether its lines show, and the id they carry. */
export interface FindingInfoState {
  open: boolean
  id: string
  toggle: () => void
}

/** ⓘ's state, closed at first. */
export function useFindingInfo(): FindingInfoState {
  const [open, setOpen] = useState(false)
  const id = useId()
  return { open, id, toggle: () => setOpen((was) => !was) }
}
