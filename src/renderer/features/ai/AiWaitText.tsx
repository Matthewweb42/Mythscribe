import { useEffect, useState } from 'react'
import { prefersReducedMotion } from '@renderer/lib/motion'

/** How long each phrase stays before the next one fades in. */
export const AI_WAIT_ROTATE_MS = 2500

/**
 * The line an AI wait shows (2026-10-08): muted jade, italic, with a faint shimmer, moving
 * through `phrases` (a set from `AI_WAIT_PHRASES`) every `AI_WAIT_ROTATE_MS` with a cross-fade.
 * Every phrase sits in the same grid cell, so the line is as wide and tall as its longest phrase
 * and never jumps as they change. Only the first phrase is in the accessibility tree: the status
 * announces it once and the rotation stays visual. With reduced motion the phrases change
 * without the fade and the shimmer stops. Starts at the first phrase on every mount.
 */
export function AiWaitText({
  phrases,
  testId,
  className = '',
  announce = true
}: {
  phrases: readonly string[]
  testId?: string
  className?: string
  /** False inside a container that is already the status, so screen readers hear it once. */
  announce?: boolean
}): React.JSX.Element {
  const [reduced] = useState(prefersReducedMotion)
  const key = phrases.join('\n')
  const count = phrases.length
  const [at, setAt] = useState({ key, index: 0 })
  const index = at.key === key ? at.index : 0

  useEffect(() => {
    if (count < 2) return
    const timer = setInterval(() => {
      setAt((s) => ({ key, index: ((s.key === key ? s.index : 0) + 1) % count }))
    }, AI_WAIT_ROTATE_MS)
    return () => clearInterval(timer)
  }, [key, count])

  return (
    <span
      role={announce ? 'status' : undefined}
      data-testid={testId}
      data-motion={reduced ? 'reduce' : undefined}
      className={`ai-wait-text ${className}`}
    >
      {phrases.map((phrase, i) => (
        <span
          key={i}
          aria-hidden={i === 0 ? undefined : true}
          data-current={i === index}
          className="ai-wait ai-wait-phrase"
        >
          {phrase}
        </span>
      ))}
    </span>
  )
}
