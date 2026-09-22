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

  it('multiplies the column and the font by the document zoom (F-7.10), leaving the rest', () => {
    // Line height is unitless and the spacings are em, so they follow the font by themselves.
    expect(editorStyle(defaultEditorSettings('novel'), 1.25)).toEqual({
      '--ms-editor-max-width': '875px',
      '--ms-editor-font-size': '20px',
      '--ms-editor-line-height': '2',
      '--ms-editor-paragraph-spacing': '0em',
      '--ms-editor-paragraph-indent': '1.5em'
    })
    expect(editorStyle({ ...defaultEditorSettings('novel'), fontSize: 18 }, 0.9)).toMatchObject({
      '--ms-editor-max-width': '630px',
      '--ms-editor-font-size': '16.2px'
    })
  })

  it('leaves the settings untouched at 100 %, which is what chrome passes', () => {
    const settings = defaultEditorSettings('novel')
    expect(editorStyle(settings, 1)).toEqual(editorStyle(settings))
  })
})
