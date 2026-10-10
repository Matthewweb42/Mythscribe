import { z } from 'zod'

/**
 * The assistant's name (F-7.12, requested by the author 2026-10-10): "Ms Scribe", a play on
 * Myth/Ms, renamable in Settings › AI. It is app-wide (one name in app-state.json, like the
 * theme), so the native menu, which main builds before any project is open, can show it too.
 * Only what the author reads changes: code identifiers, feature ids, IPC channels, test ids,
 * stored keys, and prompt text keep saying "assistant".
 */
export const DEFAULT_ASSISTANT_NAME = 'Ms Scribe'

/** Long enough for a name and a title ("Professor Quill"), short enough for a panel heading. */
export const ASSISTANT_NAME_MAX = 24

/** The stored name: a blank, too long, or unreadable value opens as the default. */
export const StoredAssistantName = z
  .string()
  .trim()
  .min(1)
  .max(ASSISTANT_NAME_MAX)
  .default(DEFAULT_ASSISTANT_NAME)
  .catch(DEFAULT_ASSISTANT_NAME)

/** What the Settings field sends: blank is allowed and means "back to the default". */
export const AssistantNameInput = z.string().max(ASSISTANT_NAME_MAX * 4)

/**
 * The name to store for what the author typed: runs of whitespace become one space, the ends
 * are trimmed, a longer name is cut at the limit, and a blank one is the default.
 */
export function normalizeAssistantName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, ASSISTANT_NAME_MAX).trim()
  return name === '' ? DEFAULT_ASSISTANT_NAME : name
}

/**
 * A UI string with the assistant named: the shared labels and help texts say "AI assistant",
 * "the assistant", or "Assistant" (the cost registry and main's messages read them as they
 * are), and the renderer shows them through this. "the assistant panel" keeps its article
 * ("the Ms Scribe panel"); otherwise the name stands alone ("Ms Scribe looks things up").
 */
export function nameAssistant(text: string, name: string): string {
  return text
    .replace(/\bAI assistant\b/g, name)
    .replace(/\b([Tt]he) assistant (panel|column|window)\b/g, `$1 ${name} $2`)
    .replace(/\b[Tt]he assistant\b/g, name)
    .replace(/\bAssistant\b/g, name)
}
