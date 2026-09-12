import { Editor } from '@tiptap/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildExtensions } from './extensions'
import { Toolbar } from './Toolbar'

let host: HTMLDivElement
let editor: Editor

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  editor = new Editor({
    element: host,
    extensions: buildExtensions({ sceneBreak: '* * *', onSave: () => {} }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
    }
  })
})
afterEach(() => {
  editor.destroy()
  host.remove()
})

const button = (name: string): HTMLElement => screen.getByRole('button', { name })

describe('Toolbar', () => {
  it('disables every button when there is no editor', () => {
    render(<Toolbar editor={null} />)
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(16)
    for (const b of buttons) expect(b).toBeDisabled()
    expect(button('Bold')).toHaveAttribute('aria-pressed', 'false')
    expect(button('Undo')).not.toHaveAttribute('aria-pressed')
  })

  it('labels each button with its shortcut', () => {
    render(<Toolbar editor={editor} />)
    expect(button('Bold')).toHaveAttribute('title', 'Bold (Ctrl+B)')
    expect(button('Italic')).toHaveAttribute('title', 'Italic (Ctrl+I)')
    expect(button('Underline')).toHaveAttribute('title', 'Underline (Ctrl+U)')
    expect(button('Undo')).toHaveAttribute('title', 'Undo (Ctrl+Z)')
    expect(button('Scene break')).toHaveAttribute('title', 'Scene break')
  })

  it('inserts a scene break with the configured text and keeps the caret in a paragraph', async () => {
    render(<Toolbar editor={editor} />)
    editor.commands.focus('end')
    await userEvent.click(button('Scene break'))
    await waitFor(() => expect(host.querySelector('[data-scene-break]')).toHaveTextContent('* * *'))
    expect(editor.getJSON().content?.map((n) => n.type)).toEqual([
      'paragraph',
      'sceneBreak',
      'paragraph'
    ])
    expect(editor.isActive('paragraph')).toBe(true)
    expect(button('Scene break')).not.toHaveAttribute('aria-pressed')
  })

  it('toggles a mark on the selection and reflects it as pressed', async () => {
    render(<Toolbar editor={editor} />)
    editor.commands.selectAll()
    await userEvent.click(button('Bold'))
    await waitFor(() => expect(button('Bold')).toHaveAttribute('aria-pressed', 'true'))
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }])
    expect(button('Italic')).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(button('Bold'))
    await waitFor(() => expect(button('Bold')).toHaveAttribute('aria-pressed', 'false'))
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined()
  })

  it('follows shortcuts applied in the editor', async () => {
    render(<Toolbar editor={editor} />)
    editor.commands.selectAll()
    editor.commands.toggleUnderline()
    await waitFor(() => expect(button('Underline')).toHaveAttribute('aria-pressed', 'true'))
  })

  it('toggles italic and underline from real Ctrl+I / Ctrl+U keystrokes, not just clicks', async () => {
    render(<Toolbar editor={editor} />)
    const box = host.querySelector('[contenteditable="true"]')
    if (!box) throw new Error('no contenteditable')
    await userEvent.click(box)
    await userEvent.keyboard('{Control>}a{/Control}')

    await userEvent.keyboard('{Control>}i{/Control}')
    await waitFor(() => expect(button('Italic')).toHaveAttribute('aria-pressed', 'true'))
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'italic' }])

    await userEvent.keyboard('{Control>}u{/Control}')
    await waitFor(() => expect(button('Underline')).toHaveAttribute('aria-pressed', 'true'))
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual(
      expect.arrayContaining([{ type: 'italic' }, { type: 'underline' }])
    )

    // Pressing again toggles both back off.
    await userEvent.keyboard('{Control>}i{/Control}')
    await userEvent.keyboard('{Control>}u{/Control}')
    await waitFor(() => expect(button('Italic')).toHaveAttribute('aria-pressed', 'false'))
    expect(button('Underline')).toHaveAttribute('aria-pressed', 'false')
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined()
  })

  it('toggles inline code from the toolbar button', async () => {
    render(<Toolbar editor={editor} />)
    editor.commands.selectAll()
    await userEvent.click(button('Inline code'))
    await waitFor(() => expect(button('Inline code')).toHaveAttribute('aria-pressed', 'true'))
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'code' }])

    await userEvent.click(button('Inline code'))
    await waitFor(() => expect(button('Inline code')).toHaveAttribute('aria-pressed', 'false'))
    expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined()
  })

  // Regression: with StarterKit's trailing node on, applying a heading to a select-all selection
  // appended an empty paragraph that the mapped selection then spanned, so the button read inactive.
  it('keeps Heading 2 pressed after select-all applies the heading', async () => {
    render(<Toolbar editor={editor} />)
    editor.commands.selectAll()
    await userEvent.click(button('Heading 2'))
    expect(editor.getJSON().content).toHaveLength(1)
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    await waitFor(() => expect(button('Heading 2')).toHaveAttribute('aria-pressed', 'true'))
  })

  it('switches between heading levels and back to a paragraph', async () => {
    render(<Toolbar editor={editor} />)
    await userEvent.click(button('Heading 2'))
    await waitFor(() => expect(button('Heading 2')).toHaveAttribute('aria-pressed', 'true'))
    expect(button('Heading 1')).toHaveAttribute('aria-pressed', 'false')
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })

    await userEvent.click(button('Heading 2'))
    await waitFor(() => expect(button('Heading 2')).toHaveAttribute('aria-pressed', 'false'))
    expect(editor.getJSON().content?.[0]?.type).toBe('paragraph')
  })

  it('wraps in a block quote and aligns the paragraph', async () => {
    render(<Toolbar editor={editor} />)
    expect(button('Align left')).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button('Align center'))
    await waitFor(() => expect(button('Align center')).toHaveAttribute('aria-pressed', 'true'))
    expect(button('Align left')).toHaveAttribute('aria-pressed', 'false')
    expect(editor.getJSON().content?.[0]?.attrs).toEqual({ textAlign: 'center' })

    await userEvent.click(button('Block quote'))
    await waitFor(() => expect(button('Block quote')).toHaveAttribute('aria-pressed', 'true'))
    expect(editor.getJSON().content?.[0]?.type).toBe('blockquote')
  })

  it('aligns a heading, not only paragraphs', async () => {
    render(<Toolbar editor={editor} />)
    await userEvent.click(button('Heading 2'))
    await waitFor(() => expect(button('Heading 2')).toHaveAttribute('aria-pressed', 'true'))
    expect(button('Align left')).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(button('Align right'))
    await waitFor(() => expect(button('Align right')).toHaveAttribute('aria-pressed', 'true'))
    expect(button('Align left')).toHaveAttribute('aria-pressed', 'false')
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 2, textAlign: 'right' }
    })
  })

  it('enables undo after a change and redo after an undo', async () => {
    render(<Toolbar editor={editor} />)
    expect(button('Undo')).toBeDisabled()
    expect(button('Redo')).toBeDisabled()
    editor.chain().focus('end').insertContent(' world').run()
    await waitFor(() => expect(button('Undo')).toBeEnabled())
    expect(editor.getText()).toBe('Hello world')

    await userEvent.click(button('Undo'))
    await waitFor(() => expect(button('Redo')).toBeEnabled())
    expect(editor.getText()).toBe('Hello')

    await userEvent.click(button('Redo'))
    await waitFor(() => expect(button('Redo')).toBeDisabled())
    expect(editor.getText()).toBe('Hello world')
  })
})
