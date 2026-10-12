import { describe, expect, it } from 'vitest'
import { parsePlanLinkKey, planLinkKey } from './planLinks'

describe('parsePlanLinkKey (F-11.1d, read back by the switch-over F-16.15)', () => {
  it('reads back a scene link and a beat link', () => {
    const scene = { plan: { kind: 'scene' as const, nodeId: 'p-1' }, sceneId: 's-1' }
    const beat = {
      plan: { kind: 'beat' as const, template: 'saveTheCat' as const, beatId: 'catalyst' },
      sceneId: 's-2'
    }
    expect(parsePlanLinkKey(planLinkKey(scene))).toEqual(scene)
    expect(parsePlanLinkKey(planLinkKey(beat))).toEqual(beat)
  })

  it('answers null for a key that does not read', () => {
    expect(parsePlanLinkKey('scene:p-1')).toBeNull()
    expect(parsePlanLinkKey('>s-1')).toBeNull()
    expect(parsePlanLinkKey('beat:nope:catalyst>s-1')).toBeNull()
    expect(parsePlanLinkKey('chapter:c-1>s-1')).toBeNull()
    expect(parsePlanLinkKey('scene:p-1>')).toBeNull()
  })
})
