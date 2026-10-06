import { CUSTOM_TAG_TEMPLATE_NAME_MAX } from '@shared/tagTemplates'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'

/**
 * Asks for a template name (F-4.11); null when the author cancels. Shared by the bank's "Save…"
 * and the bulk bar's "Save as template…" so both refuse the same names.
 */
export function promptTemplateName(
  initialValue = '',
  title = 'Save as tag template'
): Promise<string | null> {
  return dialogs.prompt({
    title,
    message: 'Any project can load it from the template list.',
    placeholder: 'Template name',
    initialValue,
    confirmLabel: initialValue === '' ? 'Save' : 'Rename',
    validate: (value) => {
      const name = value.trim()
      if (name === '') return 'Give the template a name.'
      if (name.length > CUSTOM_TAG_TEMPLATE_NAME_MAX) {
        return `Keep the name under ${CUSTOM_TAG_TEMPLATE_NAME_MAX} characters.`
      }
      return null
    }
  })
}
