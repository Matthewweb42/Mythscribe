import { describe, expect, it } from 'vitest'
import { defaultEditorSettings } from '@shared/editorSettings'
import { editorStyle } from './column'

describe('editorStyle', () => {
  it('emits the five custom properties with their units', () => {
    expect(editorStyle(defaultEditorSettings('novel'))).toEqual({
      '--ms-editor-max-width': '700px',
      '--ms-editor-font-size': '16px',
      '--ms-editor-line-height': '2',
      '--ms-editor-paragraph-spacing': '0em',
      '--ms-editor-paragraph-indent': '1.5em'
    })
    expect(editorStyle(defaultEditorSettings('webnovel'))).toEqual({
      '--ms-editor-max-width': '700px',
      '--ms-editor-font-size': '16px',
      '--ms-editor-line-height': '1.6',
      '--ms-editor-paragraph-spacing': '1em',
      '--ms-editor-paragraph-indent': '0em'
    })
  })
})
