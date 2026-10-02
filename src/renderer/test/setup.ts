import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { resetActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'

// The workers are reused across files without isolation (`vitest.config.ts`), so what one test
// leaves pending lands in whichever file the worker runs next. Any component can reach these
// three, whatever the test file imports: a debounced `layout:set`, a jump waiting for its editor
// (`editorFor`), a toast still showing. Registered first, so it runs after the file's own hooks.
afterEach(() => {
  cleanup()
  resetLayoutStore()
  resetActiveEditorStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

// ProseMirror measures ranges and hit-tests the document while it renders and tracks the
// selection; jsdom has no layout, so these report empty geometry. Only what mounting the
// editor (F-3.1) needs, installed once for the renderer project.
const emptyRect = (): DOMRect => ({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  toJSON: () => ({})
})
const emptyRectList = (): DOMRectList => ({
  length: 0,
  item: () => null,
  [Symbol.iterator]: () => [][Symbol.iterator]()
})
if (typeof Range.prototype.getBoundingClientRect !== 'function') {
  Range.prototype.getBoundingClientRect = emptyRect
}
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = emptyRectList
}
if (typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null
}

// Pointer capture (F-6.6 floating windows): jsdom dispatches pointer events but does not
// implement capture, so the calls are no-ops here; the tests fire the moves at the element.
if (typeof Element.prototype.setPointerCapture !== 'function') {
  Element.prototype.setPointerCapture = () => undefined
}
if (typeof Element.prototype.releasePointerCapture !== 'function') {
  Element.prototype.releasePointerCapture = () => undefined
}
if (typeof Element.prototype.hasPointerCapture !== 'function') {
  Element.prototype.hasPointerCapture = () => false
}
