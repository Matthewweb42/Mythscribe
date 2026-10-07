import { Extension, textInputRule } from '@tiptap/core'

/**
 * Typing shortcuts (2026-10-07, the author's request): two hyphens become an em dash, three dots
 * an ellipsis, and straight quotes curly ones. Ctrl+Z right after a conversion puts back what
 * was typed; any other Ctrl+Z is the usual undo.
 */

/** What may stand right before an opening quote: the start, a space, a bracket, or another quote. */
const OPENING = String.raw`(?:^|[\s{[(<'"‘“—])`

export const SmartTypography = Extension.create({
  name: 'smartTypography',

  // Ahead of the history keymap, so the first Ctrl+Z after a conversion undoes only the conversion.
  priority: 1000,

  addInputRules() {
    return [
      textInputRule({ find: /--$/, replace: '—' }),
      textInputRule({ find: /\.\.\.$/, replace: '…' }),
      textInputRule({ find: new RegExp(`${OPENING}(")$`), replace: '“' }),
      textInputRule({ find: /"$/, replace: '”' }),
      textInputRule({ find: new RegExp(`${OPENING}(')$`), replace: '‘' }),
      textInputRule({ find: /'$/, replace: '’' })
    ]
  },

  addKeyboardShortcuts() {
    return { 'Mod-z': () => this.editor.commands.undoInputRule() }
  }
})
