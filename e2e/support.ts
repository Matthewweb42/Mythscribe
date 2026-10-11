import { expect, type Locator } from '@playwright/test'

/**
 * Helpers shared by the e2e specs (`smoke.spec.ts`, `memory.spec.ts`). The caret helpers carry the
 * ProseMirror focus-timer fix (ARCHITECTURE "Known gotchas"): never press keys or set a DOM
 * selection right after `editor.click()`.
 */

/**
 * Clicks into an editor and waits out ProseMirror's focus timer before any key is pressed.
 * On gaining focus, prosemirror-view (`handlers.focus`) schedules a 20 ms timer that writes its
 * own selection back into the DOM unless it has already read the DOM's, so an End or
 * Control+End pressed in between is undone and the caret falls back to where the click put it.
 * The typed text then lands mid-paragraph (the F-14.6 disclosure count off by one, the
 * typewriter lines at the top of the scene, a ghost suggestion asked for in the wrong place:
 * the e2e caret flakes up to 2026-10-08). A page timer of the same 20 ms set after the click
 * fires after ProseMirror's, so this waits for that timer itself, not for a guessed delay.
 */
export async function clickIntoEditor(target: Locator): Promise<void> {
  await target.click()
  await expect(target).toBeFocused()
  await target.page().evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
}

/** Whether the DOM caret is collapsed at the very end of `target`'s text. */
export function caretAtEnd(target: Locator): Promise<boolean> {
  return target.evaluate((root) => {
    const selection = document.getSelection()
    if (!selection?.focusNode || !root.lastChild || !root.contains(selection.focusNode)) {
      return false
    }
    const rest = document.createRange()
    rest.setStart(selection.focusNode, selection.focusOffset)
    rest.setEndAfter(root.lastChild)
    return selection.isCollapsed && rest.toString() === ''
  })
}

/** Clicks into `target` and puts the caret at the end of the document, checked, ready to type. */
export async function caretToEnd(target: Locator): Promise<void> {
  await clickIntoEditor(target)
  await target.page().keyboard.press('Control+End')
  await expect.poll(() => caretAtEnd(target)).toBe(true)
}
