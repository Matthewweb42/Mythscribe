import { describe, expect, it } from 'vitest'
import {
  ASSISTANT_NAME_MAX,
  DEFAULT_ASSISTANT_NAME,
  StoredAssistantName,
  nameAssistant,
  normalizeAssistantName
} from './assistantName'
import { USE_AI_MEANING } from './aiSettings'
import { MENU, menuItemLabel, menuItems } from './menu'
import { APP_SHORTCUTS } from './shortcuts'

describe('assistant name (F-7.13)', () => {
  it('is Ms Scribe by default, and for a blank, overlong, or unreadable stored value', () => {
    expect(DEFAULT_ASSISTANT_NAME).toBe('Ms Scribe')
    expect(StoredAssistantName.parse(undefined)).toBe('Ms Scribe')
    expect(StoredAssistantName.parse('  ')).toBe('Ms Scribe')
    expect(StoredAssistantName.parse('x'.repeat(ASSISTANT_NAME_MAX + 1))).toBe('Ms Scribe')
    expect(StoredAssistantName.parse(3)).toBe('Ms Scribe')
    expect(StoredAssistantName.parse(' Quill ')).toBe('Quill')
  })

  it('normalizes what the author typed: spaces collapsed, ends trimmed, cut at the limit, blank is the default', () => {
    expect(normalizeAssistantName('  Professor   Quill ')).toBe('Professor Quill')
    expect(normalizeAssistantName('')).toBe('Ms Scribe')
    expect(normalizeAssistantName(' \t ')).toBe('Ms Scribe')
    const long = normalizeAssistantName('a'.repeat(ASSISTANT_NAME_MAX + 10))
    expect(long).toHaveLength(ASSISTANT_NAME_MAX)
    expect(StoredAssistantName.parse(long)).toBe(long)
  })

  it('names the assistant in the shared help texts and labels', () => {
    expect(nameAssistant('AI assistant', 'Quill')).toBe('Quill')
    expect(nameAssistant('Assistant chat', 'Quill')).toBe('Quill chat')
    expect(nameAssistant('so the assistant can pick', 'Quill')).toBe('so Quill can pick')
    expect(nameAssistant('The assistant panel opens', 'Quill')).toBe('The Quill panel opens')
    expect(nameAssistant(USE_AI_MEANING.on, 'Ms Scribe')).toBe(
      'AI features on. Ms Scribe works in the mode picked under the chat box.'
    )
    // "AI" in general stays.
    expect(nameAssistant('Use AI', 'Quill')).toBe('Use AI')
    expect(nameAssistant(USE_AI_MEANING.off, 'Quill')).toBe(USE_AI_MEANING.off)
  })

  it("puts the name on View's assistant item and the shortcut row, and nowhere else", () => {
    const items = menuItems(MENU)
    const assistant = items.find((i) => i.id === 'toggleAssistant')
    expect(assistant && menuItemLabel(assistant, null)).toBe('Ms Scribe')
    expect(assistant && menuItemLabel(assistant, 'novel', 'Quill')).toBe('Quill')
    for (const item of items.filter((i) => i.id !== 'toggleAssistant')) {
      expect(menuItemLabel(item, null, 'Quill')).not.toContain('Quill')
    }
    expect(nameAssistant(APP_SHORTCUTS.assistant.label, 'Quill')).toBe('Quill')
  })
})
