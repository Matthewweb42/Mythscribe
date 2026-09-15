import { beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../ipc/errors'
import {
  cancelInflight,
  inflightCount,
  regenRequestId,
  registerInflight,
  releaseInflight,
  resetInflight
} from './inflight'

beforeEach(() => resetInflight())

describe('inflight registry (F-5.10)', () => {
  it('registers an id with a fresh controller and counts it until released', () => {
    const controller = registerInflight('req-1')
    expect(controller.signal.aborted).toBe(false)
    expect(inflightCount()).toBe(1)
    releaseInflight('req-1')
    expect(inflightCount()).toBe(0)
  })

  it('refuses a duplicate id with VALIDATION while the first is in flight, and accepts it again after release', () => {
    registerInflight('req-1')
    expect(() => registerInflight('req-1')).toThrowError(AppError)
    try {
      registerInflight('req-1')
    } catch (err) {
      expect(err).toMatchObject({ code: 'VALIDATION', details: { requestId: 'req-1' } })
    }
    expect(inflightCount()).toBe(1)
    releaseInflight('req-1')
    expect(registerInflight('req-1').signal.aborted).toBe(false)
  })

  it('cancel aborts the registered controller and says so; an unknown id is false', () => {
    const controller = registerInflight('req-1')
    expect(cancelInflight('req-1')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    // Cancel does not release: the owner does, once the aborted call settles.
    expect(inflightCount()).toBe(1)
    expect(cancelInflight('req-1')).toBe(true)
    releaseInflight('req-1')
    expect(cancelInflight('req-1')).toBe(false)
    expect(cancelInflight('never')).toBe(false)
  })

  it('releasing an unknown id is a no-op, and reset forgets everything', () => {
    releaseInflight('nope')
    registerInflight('a')
    registerInflight('b')
    expect(inflightCount()).toBe(2)
    resetInflight()
    expect(inflightCount()).toBe(0)
    expect(cancelInflight('a')).toBe(false)
  })

  it('derives the fidelity regenerate id with a fixed suffix', () => {
    expect(regenRequestId('req-1')).toBe('req-1:regen')
  })
})
