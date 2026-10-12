import { useEffect, useState } from 'react'

/** The time now, renewed every `everyMs` while the calling view is shown ("Read 3 min ago"). */
export function useNow(everyMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}
