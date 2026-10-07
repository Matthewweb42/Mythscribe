import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { CSSProperties } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import { TAG_RANGE_MARK } from '@shared/tagRanges'
import type { NovelFormat } from '@shared/ipc/contract'
import { EMPTY_DOC, type TiptapNodeT } from '@shared/tiptap'
import { useCanWrite } from '@renderer/features/account/appAccessStore'
import { ContextMenu } from '@renderer/features/manuscript/ContextMenu'
import type { MenuItem } from '@renderer/features/manuscript/contextMenuItems'
import { useBackgroundStore, useCurrentBackground } from '@renderer/features/focus/backgroundStore'
import { OVERLAY_WIDTH } from '@shared/focus'
import { escapeFocusMode, useFocusStore } from '@renderer/features/focus/focusStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useSessionStore } from '@renderer/features/project/sessionStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useEditorZoom, usePageEdges } from '@renderer/features/shell/viewStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { describeError } from '@renderer/lib/errors'
import { rewriteReason } from '@renderer/features/ai/aiActions'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import type { AiSettings } from '@shared/aiSettings'
import { useSceneLocked } from '@renderer/features/editPass/editPassStore'
import { TrackedChangesBar } from '@renderer/features/editPass/TrackedChangesBar'
import { useTrackedChanges } from '@renderer/features/editPass/useTrackedChanges'
import { useActiveEditorStore } from './activeEditorStore'
import { columnClass, deskClass, editorStyle } from './column'
import { useDocumentStore } from './documentStore'
import { buildExtensions, EDITOR_CORE_OPTIONS } from './extensions'
import { useGhostTextController } from './ghostTextController'
import { INLINE_TAG_SELECTOR, resyncInlineTags, tokenTag } from './InlineTag'
import { useLiveDocStats } from './liveDocStats'
import { useBetaReaderStore } from './betaReaderStore'
import { useProofreadStore } from './proofreadStore'
import { useCritiqueStore } from './critiqueStore'
import { NotesToggleButton } from './NotesPanel'
import { captureRewriteText } from './rewriteTarget'
import { useRewriteStore } from './rewriteStore'
import { useScrollMemory } from './scrollMemory'
import { SelectionBubble } from './SelectionBubble'
import { askAboutSelection, rewriteSelection, selectionOffer } from './selectionActions'
import { FocusModeButton } from './FocusModeButton'
import { useEditorSettings } from './settingsStore'
import { StatusBar } from './StatusBar'
import { TagPicker } from './TagPicker'
import { TAG_RANGE_SELECTOR } from './TagRange'
import { Toolbar } from './Toolbar'
import { VibeWriteToggle } from './VibeWriteToggle'

export interface DocumentEditorProps {
  id: string
  format: NovelFormat
  /**
   * Own toolbar, scroll container, and status bar (the single-document pane, F-3.1, F-3.3), or
   * bare content for a region in a stack whose toolbar, scrolling, and status belong to the
   * stack (F-3.8).
   */
  toolbar?: boolean
  /** Fires when the editor gains focus, so a stack can point its shared toolbar at this region. */
  onFocus?: (editor: Editor) => void
}

/**
 * The writing surface for one document: loads it through `useDocumentStore` on mount (and again
 * when `id` changes) and unloads it on unmount, which saves any pending edit under its own id.
 * Every document gets its own editor instance, created with the loaded content, so the undo
 * history holds only the author's edits to that document: loading never lands on the stack and
 * undo can never walk into another document. While the load is in flight a read-only, empty
 * editor keeps the layout and the toolbar is disabled. Every edit goes to the store, which
 * autosaves it (F-3.2); Ctrl+S saves everything pending at once.
 */
export function DocumentEditor({
  id,
  format,
  toolbar = true,
  onFocus
}: DocumentEditorProps): React.JSX.Element {
  const content = useDocumentStore((s) => s.docs[id]?.content ?? null)
  const load = useDocumentStore((s) => s.load)
  const unload = useDocumentStore((s) => s.unload)

  useEffect(() => {
    load(id).catch((err: unknown) => toast.error(describeError(err)))
    return () => unload(id)
  }, [id, load, unload])

  return (
    <RegionEditor
      key={`${id}:${content === null ? 'loading' : 'ready'}`}
      id={id}
      content={content}
      format={format}
      toolbar={toolbar}
      onFocus={onFocus}
    />
  )
}

/** A right-click on an inline tag token (F-4.6): where the menu opens, the node's position, and its tag. */
interface TokenMenu {
  x: number
  y: number
  pos: number
  tagId: string
}

const TOKEN_MENU_ITEMS: MenuItem[] = [
  { id: 'remove', label: 'Remove' },
  { id: 'open-in-tag-manager', label: 'Open in Tag Manager' }
]

/**
 * A right-click over a selection or a tag range (F-4.8): where the menu opens and the text it
 * acts on, `from < to` for a selection; `at` is the clicked range's position when there was none.
 */
interface RangeMenu {
  x: number
  y: number
  from: number
  to: number
  at: number | null
}

/** The tag picker for a selection (F-4.8): where it opens and the text it tags, captured on open. */
interface RangePicker {
  x: number
  y: number
  from: number
  to: number
}

/** The range picker's width (`w-64`) plus a margin, to keep it inside the window. */
const RANGE_PICKER_WIDTH = 272
const NO_EXCLUSIONS: string[] = []

/**
 * The menu over a selection; Clear is shown but not choosable when no range lies in it. Rewrite
 * and Ask AI (2026-10-06, the selection bubble's two) follow while the dial allows them; Rewrite
 * is disabled with the reason while the selection is out of its bounds or a rewrite runs.
 */
function rangeMenuItems(editor: Editor, menu: RangeMenu, settings: AiSettings | null): MenuItem[] {
  if (menu.at !== null) return [{ id: 'clear-tags-here', label: 'Clear tags here' }]
  const type = editor.schema.marks[TAG_RANGE_MARK]
  const tagged = type !== undefined && editor.state.doc.rangeHasMark(menu.from, menu.to, type)
  const items: MenuItem[] = [
    { id: 'tag-selection', label: 'Tag selection…' },
    { id: 'clear-tags', label: 'Clear tags in selection', disabled: !tagged }
  ]
  const offer = selectionOffer(settings)
  if (offer.rewrite) {
    const reason = rewriteReason(settings, captureRewriteText(editor).text.length)
    items.push({
      id: 'rewrite',
      label: 'Rewrite',
      disabled: reason !== null,
      title: reason ?? 'Rewrite the selection in your voice'
    })
  }
  if (offer.ask) items.push({ id: 'ask-ai', label: 'Ask AI' })
  return items
}

/** The picker for the editor's selection, opened under its end (Mod+Alt+T). */
function pickerAtSelection(editor: Editor): RangePicker {
  const { from, to } = editor.state.selection
  const coords = editor.view.coordsAtPos(to)
  return { x: coords.left, y: coords.bottom, from, to }
}

/**
 * One editor instance for one loaded document; `content === null` is the read-only loading
 * state. The formatting settings (F-3.6) apply live: five of them are custom properties on the
 * pane (no remount); the scene-break text is an extension option, so changing it rebuilds the
 * editor instance. `content` is the store's latest text (every edit lands there), and
 * `useEditor` reads it only when it constructs an instance, so the rebuild starts from the
 * author's unsaved typing and a keystroke never resets the editor. Inline tag tokens (F-4.6)
 * are repainted from the bank whenever it changes (the resync pass; the `#` suggestion lives in
 * the extension), and a right-click on one opens the Remove / Open in Tag Manager menu. Remove
 * deletes the token only: links are the author's explicit choice and stay. A right-click over a
 * selection, or over a tag range (F-4.8), opens Tag selection… / Clear tags in selection (or
 * Clear tags here); Tag selection… and Mod+Alt+T open the tag picker for the selected text, and
 * the picked tag is linked to the document as an inline tag's is. Clearing ranges leaves links.
 * VibeWrite (F-5.3) runs only in the single-document view: the controller arms itself there and
 * the toggle sits in the toolbar's right slot, so a stacked region never shows ghost text. It is
 * the toolbar's only AI control since 2026-10-06: Editor's notes, Beta reader, Rewrite, and the
 * voice exemplar button left it; their features start from the assistant panel (its actions menu
 * and the chat), and a selection gets the bubble (`SelectionBubble`: Rewrite, Ask AI), which the
 * right-click menu repeats. Their results show in the assistant panel (`AiResults`); a rewrite,
 * critique, proofread, or beta read of this document is dismissed when the instance goes
 * (unmount, switch, or rebuild).
 * Once ready, the instance registers as the active editor (F-5.4; again on focus, so the
 * last-focused region of a stack wins) and releases itself on unmount, which is how the
 * assistant panel reaches the caret. Focus mode (F-6.1) drops the toolbar; the status bar
 * stays. F-1.7: the single-document view records its caret and scroll in the session and puts
 * both back when the document opens again (and takes the focus for the document restored with
 * the project), so the author is where they left it.
 */
function RegionEditor({
  id,
  content,
  format,
  toolbar,
  onFocus
}: {
  id: string
  content: TiptapNodeT | null
  format: NovelFormat
  toolbar: boolean
  onFocus: ((editor: Editor) => void) | undefined
}): React.JSX.Element {
  const edit = useDocumentStore((s) => s.edit)
  const [picker, setPicker] = useState<RangePicker | null>(null)
  const settings = useEditorSettings(format)
  const { sceneBreak } = settings
  const extensions = useMemo(
    () =>
      buildExtensions({
        sceneBreak,
        onSave: () => void useDocumentStore.getState().saveNow(),
        onEscape: escapeFocusMode,
        inlineTagNodeId: id,
        onTagSelection: (editor) => setPicker(pickerAtSelection(editor))
      }),
    [sceneBreak, id]
  )
  const ready = content !== null
  const tagsById = useTagStore((s) => s.byId)
  const tagAliases = useTagStore((s) => s.aliases)
  const focus = useFocusStore((s) => s.active)
  // F-3.9 / F-6.7: typewriter scrolling follows the setting, and focus mode turns it on.
  const typewriter = focus || settings.typewriter
  // F-6.2: over a background image the column gets a translucent panel so the text stays legible.
  const background = useCurrentBackground()
  const focusWidth = useBackgroundStore((s) => s.settings?.overlay.width ?? OVERLAY_WIDTH.default)
  // F-7.10: the app-wide document zoom multiplies the project's column and font.
  const zoom = useEditorZoom()
  // F-7.11: the sheet is for the ordinary view; focus mode has its own width and scrim (F-6.4).
  const sheet = usePageEdges() && !focus
  const surface = focus && background !== null
  const [menu, setMenu] = useState<TokenMenu | null>(null)
  const [rangeMenu, setRangeMenu] = useState<RangeMenu | null>(null)
  const closePicker = useCallback(() => setPicker(null), [])
  const aiSettings = useAiSettingsStore((s) => s.settings)

  const editor = useEditor(
    {
      extensions,
      coreExtensionOptions: EDITOR_CORE_OPTIONS,
      content: content ?? EMPTY_DOC,
      editable: ready,
      editorProps: {
        attributes: {
          class: toolbar ? 'ms-editor' : 'ms-editor ms-editor-region',
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': 'Document'
        }
      },
      onUpdate: ({ editor }) => edit(id, editor.getJSON()),
      // F-1.7: where the caret is, for the session; a stacked region has no caret of its own.
      onSelectionUpdate: ({ editor }) => {
        if (!toolbar || !ready) return
        const { anchor, head } = editor.state.selection
        useSessionStore.getState().recordSelection(id, { anchor, head })
      },
      // `useEditor` reads the latest `onFocus` on every call, so a changed callback is honoured.
      onFocus: ({ editor }) => {
        useActiveEditorStore.getState().set(id, editor)
        onFocus?.(editor)
      }
    },
    [extensions]
  )

  // F-14.15: a scene in a running edit pass is read-only until the pass ends; its tracked
  // changes show (and accept inline) once it is free.
  const locked = useSceneLocked(id) !== null
  useTrackedChanges(editor, id, ready, locked)
  // AI-BILLING-SPEC M1: after the trial without the license the whole project is read-only.
  const writable = useCanWrite()
  useEffect(() => {
    // No update event: a lock is not an edit, so it must not mark the document dirty.
    const editable = ready && !locked && writable
    if (!editor.isDestroyed && editor.isEditable !== editable) editor.setEditable(editable, false)
  }, [editor, ready, locked, writable])

  useEffect(() => {
    if (!ready) return
    const store = useActiveEditorStore.getState()
    store.set(id, editor)
    return () => store.release(editor)
  }, [editor, id, ready])

  // F-1.7: the caret as the session last saw it, and the focus for the document the project
  // reopened on; the scroll follows in `useScrollMemory`, after the focus, so it wins.
  // `sessionLive` is a dependency so a session that arrives after the document still restores.
  const sessionLive = useSessionStore((s) => s.live)
  useEffect(() => {
    if (!ready || !toolbar || !sessionLive) return
    const session = useSessionStore.getState()
    const selection = session.positionOf(id)?.selection ?? null
    const place = (): void => {
      if (selection !== null)
        editor.commands.setTextSelection({ from: selection.anchor, to: selection.head })
    }
    place()
    if (!session.takeCaretFocus(id)) return
    editor.commands.focus(null, { scrollIntoView: false })
    if (selection === null) return
    // Taking the focus can put the caret back at the start (ProseMirror reads the DOM selection
    // shortly after focus), so the caret is placed again once that has settled, unless the
    // author has already typed or moved it.
    const doc = editor.state.doc
    const settled = window.setTimeout(() => {
      if (editor.isDestroyed || editor.state.doc !== doc) return
      const { anchor, head } = editor.state.selection
      if (anchor !== selection.anchor || head !== selection.head) place()
    }, 50)
    return () => window.clearTimeout(settled)
  }, [editor, id, ready, toolbar, sessionLive])

  const scroller = useRef<HTMLDivElement>(null)
  useScrollMemory(scroller, id, ready && toolbar)

  useEffect(() => {
    resyncInlineTags(editor.view.dom, tagsById, tagAliases)
  }, [editor, tagsById, tagAliases])

  useEffect(() => () => useRewriteStore.getState().dismissFor(id), [editor, id])

  useEffect(() => () => useCritiqueStore.getState().dismissFor(id), [editor, id])

  useEffect(() => () => useProofreadStore.getState().dismissFor(id), [editor, id])

  useEffect(() => () => useBetaReaderStore.getState().dismissFor(id), [editor, id])

  useEffect(() => {
    editor?.commands.setTypewriter(typewriter)
  }, [editor, typewriter])

  const { error: ghostError } = useGhostTextController({
    editor,
    nodeId: id,
    active: toolbar && ready
  })

  useEffect(() => {
    const dom = editor.view.dom
    // F-4.8: the selection as it was before the right button went down. The browser may select
    // the misspelled word under the pointer before `contextmenu` fires; that word is main's
    // spelling menu (F-3.11), not a selection the author made.
    let before: { from: number; to: number } | null = null
    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 2) return
      const { from, to } = editor.state.selection
      before = { from, to }
    }
    const onContextMenu = (event: MouseEvent): void => {
      const selection = before ?? editor.state.selection
      before = null
      const target = event.target instanceof Element ? event.target : null
      const token = target?.closest<HTMLElement>(INLINE_TAG_SELECTOR) ?? null
      if (token) {
        event.preventDefault()
        setMenu({
          x: event.clientX,
          y: event.clientY,
          pos: editor.view.posAtDOM(token, 0),
          tagId: token.dataset.id ?? ''
        })
        return
      }
      if (!editor.isEditable) return
      const { from, to } = selection
      const range = target?.closest<HTMLElement>(TAG_RANGE_SELECTOR) ?? null
      if (from === to && !range) return
      event.preventDefault()
      setRangeMenu({
        x: event.clientX,
        y: event.clientY,
        from,
        to,
        at: from === to && range ? editor.view.posAtDOM(range, 0) : null
      })
    }
    dom.addEventListener('mousedown', onMouseDown, true)
    dom.addEventListener('contextmenu', onContextMenu)
    return () => {
      dom.removeEventListener('mousedown', onMouseDown, true)
      dom.removeEventListener('contextmenu', onContextMenu)
    }
  }, [editor])

  const onMenuSelect = (itemId: string): void => {
    if (!menu) return
    setMenu(null)
    if (itemId === 'remove') {
      const node = editor.state.doc.nodeAt(menu.pos)
      if (node?.type.name !== INLINE_TAG_NODE_TYPE) return
      editor
        .chain()
        .focus()
        .deleteRange({ from: menu.pos, to: menu.pos + node.nodeSize })
        .run()
    } else if (itemId === 'open-in-tag-manager') {
      const layout = useLayoutStore.getState()
      if (!layout.layout.sidebar.open) layout.toggle('sidebar')
      layout.setSidebarTab('tags')
      // A token of a merged tag (F-4.9) opens the tag it was merged into.
      const bank = useTagStore.getState()
      bank.requestSelection(tokenTag(menu.tagId, bank.byId, bank.aliases)?.id ?? menu.tagId)
    }
  }

  const onRangeMenuSelect = (itemId: string): void => {
    if (!rangeMenu) return
    setRangeMenu(null)
    const { from, to, at } = rangeMenu
    if (Math.max(to, at ?? 0) > editor.state.doc.content.size) return
    if (itemId === 'tag-selection') {
      const x = Math.max(0, Math.min(rangeMenu.x, window.innerWidth - RANGE_PICKER_WIDTH))
      setPicker({ x, y: rangeMenu.y, from, to })
    } else if (itemId === 'clear-tags') {
      editor.chain().focus().setTextSelection({ from, to }).clearTagRanges().run()
    } else if (itemId === 'clear-tags-here' && at !== null) {
      editor.chain().focus().clearTagRangesAt(at).run()
    } else if (itemId === 'rewrite' || itemId === 'ask-ai') {
      // The selection as it was when the menu opened (the click may have moved it).
      editor.chain().focus().setTextSelection({ from, to }).run()
      if (itemId === 'rewrite') rewriteSelection(id, editor)
      else askAboutSelection(editor)
    }
  }

  // F-4.8: the picked tag goes on the text captured when the picker opened (the search box has
  // the focus meanwhile) and is linked to the document, as inserting an inline tag does.
  const onRangePick = (tagId: string): void => {
    if (!picker) return
    setPicker(null)
    const { from, to } = picker
    if (to > editor.state.doc.content.size) return
    editor.chain().focus().setTextSelection({ from, to }).setTagRange(tagId).run()
    useDocumentTagStore
      .getState()
      .add(id, tagId)
      .catch((err: unknown) => toast.error(describeError(err)))
  }

  const tokenMenu = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={TOKEN_MENU_ITEMS}
      onSelect={onMenuSelect}
      onClose={() => setMenu(null)}
    />
  ) : null

  const popups = (
    <>
      {tokenMenu}
      {ready ? <SelectionBubble editor={editor} nodeId={id} /> : null}
      {rangeMenu ? (
        <ContextMenu
          x={rangeMenu.x}
          y={rangeMenu.y}
          items={rangeMenuItems(editor, rangeMenu, aiSettings)}
          onSelect={onRangeMenuSelect}
          onClose={() => setRangeMenu(null)}
        />
      ) : null}
      {picker ? (
        <div className="fixed z-40 w-64" style={{ left: picker.x, top: picker.y }}>
          <TagPicker
            excludeIds={NO_EXCLUSIONS}
            label="Tag selection"
            listLabel="Tags"
            onPick={onRangePick}
            onClose={closePicker}
          />
        </div>
      ) : null}
    </>
  )

  // A region of a stack (F-3.8): the stack owns the column (and the sheet, F-7.11), so the
  // region is only its vertical padding.
  if (!toolbar)
    return (
      <>
        <TrackedChangesBar nodeId={id} />
        <EditorContent editor={editor} className="py-6" />
        {popups}
      </>
    )
  // The column and the surface inside it are flex items, so an empty document still fills the
  // scroll container (click anywhere to write) without a viewport-relative minimum height.
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      // F-6.4: in focus mode the column is a share of the pane instead of the settings' pixels,
      // so F-7.10's zoom scales the text inside it and leaves the share alone.
      style={
        focus
          ? ({
              ...editorStyle(settings, zoom),
              '--ms-editor-max-width': `${focusWidth}%`
            } as CSSProperties)
          : editorStyle(settings, zoom)
      }
    >
      {focus ? null : (
        <Toolbar
          editor={ready ? editor : null}
          right={
            <>
              <VibeWriteToggle error={ghostError} />
              <NotesToggleButton />
              <FocusModeButton />
            </>
          }
        />
      )}
      <TrackedChangesBar nodeId={id} />
      <div
        ref={scroller}
        className={`flex min-h-0 flex-1 flex-col overflow-y-auto ${deskClass(sheet)}`}
      >
        <EditorContent
          editor={editor}
          className={`${columnClass(sheet)} flex flex-1 flex-col py-6 ${typewriter ? 'pb-[50vh]' : ''} ${surface ? 'focus-surface' : ''}`}
        />
      </div>
      <DocumentStatusBar id={id} editor={ready ? editor : null} />
      {popups}
    </div>
  )
}

/**
 * The status bar of a single document (F-3.3): counts the editor's current content live, with
 * the same `countWords` main caches on save, so the figure never waits for the autosave. While
 * the document is still loading the tree's saved count stands in. The session delta is measured
 * from the tree's baseline, so a document created this session counts as all new. The AI share
 * (F-14.6) comes from the same live count and shows only once the document is loaded.
 */
function DocumentStatusBar({
  id,
  editor
}: {
  id: string
  editor: Editor | null
}): React.JSX.Element {
  const saved = useTreeStore((s) => s.wordCountRollup[id] ?? 0)
  const baseline = useTreeStore((s) => s.sessionBaseline[id] ?? 0)
  const live = useLiveDocStats(editor)
  const words = live?.words ?? saved
  return <StatusBar words={words} delta={words - baseline} aiPercent={live?.aiPercent} />
}
