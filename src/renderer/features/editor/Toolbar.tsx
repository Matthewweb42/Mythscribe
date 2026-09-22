import { useCallback } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Redo2,
  SeparatorHorizontal,
  Strikethrough,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  TextQuote,
  Underline,
  Undo2,
  type LucideIcon
} from 'lucide-react'
import { ALIGNMENTS, HEADING_LEVELS, type Alignment, type HeadingLevel } from './extensions'

interface Tool {
  id: string
  label: string
  /** Shown in the tooltip after the label; omitted for tools without a key binding. */
  shortcut?: string
  icon: LucideIcon
  /** Toggles report `aria-pressed`; actions (undo, redo) do not. */
  toggle: boolean
  active: (editor: Editor) => boolean
  enabled: (editor: Editor) => boolean
  run: (editor: Editor) => void
}

interface ToolState {
  active: boolean
  enabled: boolean
}

const HEADING_ICONS: Record<HeadingLevel, LucideIcon> = { 1: Heading1, 2: Heading2, 3: Heading3 }
const ALIGN_ICONS: Record<Alignment, LucideIcon> = {
  left: TextAlignStart,
  center: TextAlignCenter,
  right: TextAlignEnd,
  justify: TextAlignJustify
}
const ALIGN_LABELS: Record<Alignment, string> = {
  left: 'Align left',
  center: 'Align center',
  right: 'Align right',
  justify: 'Justify'
}
const ALIGN_SHORTCUTS: Record<Alignment, string> = {
  left: 'Ctrl+Shift+L',
  center: 'Ctrl+Shift+E',
  right: 'Ctrl+Shift+R',
  justify: 'Ctrl+Shift+J'
}

/**
 * Blocks store no `textAlign` until the author picks one (so default paragraphs stay lean in the
 * database), which means "left" is active whenever no other alignment is.
 */
function isAligned(editor: Editor, alignment: Alignment): boolean {
  if (alignment !== 'left') return editor.isActive({ textAlign: alignment })
  return !ALIGNMENTS.some((other) => other !== 'left' && editor.isActive({ textAlign: other }))
}

/** The toolbar's groups in order (F-3.1): marks, blocks (headings, quote, scene break), alignment, history. */
const GROUPS: Tool[][] = [
  [
    {
      id: 'bold',
      label: 'Bold',
      shortcut: 'Ctrl+B',
      icon: Bold,
      toggle: true,
      active: (e) => e.isActive('bold'),
      enabled: (e) => e.can().toggleBold(),
      run: (e) => e.chain().focus().toggleBold().run()
    },
    {
      id: 'italic',
      label: 'Italic',
      shortcut: 'Ctrl+I',
      icon: Italic,
      toggle: true,
      active: (e) => e.isActive('italic'),
      enabled: (e) => e.can().toggleItalic(),
      run: (e) => e.chain().focus().toggleItalic().run()
    },
    {
      id: 'underline',
      label: 'Underline',
      shortcut: 'Ctrl+U',
      icon: Underline,
      toggle: true,
      active: (e) => e.isActive('underline'),
      enabled: (e) => e.can().toggleUnderline(),
      run: (e) => e.chain().focus().toggleUnderline().run()
    },
    {
      id: 'strike',
      label: 'Strikethrough',
      shortcut: 'Ctrl+Shift+S',
      icon: Strikethrough,
      toggle: true,
      active: (e) => e.isActive('strike'),
      enabled: (e) => e.can().toggleStrike(),
      run: (e) => e.chain().focus().toggleStrike().run()
    },
    {
      id: 'code',
      label: 'Inline code',
      shortcut: 'Ctrl+E',
      icon: Code,
      toggle: true,
      active: (e) => e.isActive('code'),
      enabled: (e) => e.can().toggleCode(),
      run: (e) => e.chain().focus().toggleCode().run()
    }
  ],
  [
    ...HEADING_LEVELS.map((level): Tool => ({
      id: `heading-${level}`,
      label: `Heading ${level}`,
      shortcut: `Ctrl+Alt+${level}`,
      icon: HEADING_ICONS[level],
      toggle: true,
      active: (e) => e.isActive('heading', { level }),
      enabled: (e) => e.can().toggleHeading({ level }),
      run: (e) => e.chain().focus().toggleHeading({ level }).run()
    })),
    {
      id: 'blockquote',
      label: 'Block quote',
      shortcut: 'Ctrl+Shift+B',
      icon: TextQuote,
      toggle: true,
      active: (e) => e.isActive('blockquote'),
      enabled: (e) => e.can().toggleBlockquote(),
      run: (e) => e.chain().focus().toggleBlockquote().run()
    },
    {
      id: 'scene-break',
      label: 'Scene break',
      icon: SeparatorHorizontal,
      toggle: false,
      active: () => false,
      enabled: (e) => e.can().insertSceneBreak(),
      run: (e) => e.chain().focus().insertSceneBreak().run()
    }
  ],
  ALIGNMENTS.map((alignment): Tool => ({
    id: `align-${alignment}`,
    label: ALIGN_LABELS[alignment],
    shortcut: ALIGN_SHORTCUTS[alignment],
    icon: ALIGN_ICONS[alignment],
    toggle: true,
    active: (e) => isAligned(e, alignment),
    enabled: (e) => e.can().setTextAlign(alignment),
    run: (e) => e.chain().focus().setTextAlign(alignment).run()
  })),
  [
    {
      id: 'undo',
      label: 'Undo',
      shortcut: 'Ctrl+Z',
      icon: Undo2,
      toggle: false,
      active: () => false,
      enabled: (e) => e.can().undo(),
      run: (e) => e.chain().focus().undo().run()
    },
    {
      id: 'redo',
      label: 'Redo',
      shortcut: 'Ctrl+Y',
      icon: Redo2,
      toggle: false,
      active: () => false,
      enabled: (e) => e.can().redo(),
      run: (e) => e.chain().focus().redo().run()
    }
  ]
]

const BUTTON =
  'rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted aria-pressed:bg-surface-raised aria-pressed:text-accent'

/** Every tool's state from one editor snapshot; `useEditorState` re-renders only when it changes. */
function snapshot(editor: Editor | null): Record<string, ToolState> {
  const states: Record<string, ToolState> = {}
  for (const group of GROUPS) {
    for (const tool of group) {
      states[tool.id] = editor
        ? { active: tool.active(editor), enabled: tool.enabled(editor) }
        : { active: false, enabled: false }
    }
  }
  return states
}

/**
 * The formatting toolbar (F-3.1). Buttons mirror the editor's keyboard shortcuts, show their
 * active state via `aria-pressed`, and disable when the command cannot run (or with no editor).
 * Mouse-down is swallowed so the editor keeps its selection while the command applies. `right`
 * is rendered at the far end, for controls that are not editor commands (the formatting
 * settings, F-3.6).
 */
export function Toolbar({
  editor,
  right
}: {
  editor: Editor | null
  right?: React.ReactNode
}): React.JSX.Element {
  // Snapshot the editor from the prop, not from the hook's context: `useEditorState` only
  // refreshes its context on a transaction, so a toolbar handed a different editor (the stacked
  // view, F-3.8) would otherwise show the previous editor's state until the author types.
  const selector = useCallback(() => snapshot(editor), [editor])
  const states = useEditorState({ editor, selector })
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-line bg-surface px-3 py-1"
    >
      {GROUPS.map((group, index) => (
        <div key={index} className="flex items-center gap-0.5">
          {index > 0 ? (
            <span
              role="separator"
              aria-orientation="vertical"
              className="mx-1.5 h-4 w-px bg-line"
            />
          ) : null}
          {group.map((tool) => {
            const state = states?.[tool.id] ?? { active: false, enabled: false }
            return (
              <button
                key={tool.id}
                type="button"
                aria-label={tool.label}
                title={tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label}
                aria-pressed={tool.toggle ? state.active : undefined}
                disabled={!editor || !state.enabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  if (editor) tool.run(editor)
                }}
                className={BUTTON}
              >
                <tool.icon size={16} aria-hidden="true" />
              </button>
            )
          })}
        </div>
      ))}
      {/*
       * The right cluster wraps inside itself as well (F-7.10): its buttons carry labels and
       * never break them, so a narrow window (Large in 1280 x 720) has to take a second row
       * rather than push the last ones past the edge.
       */}
      {right !== undefined ? (
        <div className="ml-auto flex flex-wrap items-center justify-end">{right}</div>
      ) : null}
    </div>
  )
}
