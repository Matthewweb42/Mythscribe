/**
 * What every AI wait says while it runs (2026-10-08, the author's request): per task, 4–6 true
 * phrases with a storyteller's touch, shown in turn by `AiWaitText`. The first is the plain line
 * the wait always showed; it is the one screen readers hear. Each phrase still says what is
 * really happening. Waits whose line carries live numbers ("Indexing 3 of 12 scenes") keep that
 * line and only take the `AI_WAIT_CLASS` look.
 */
export const AI_WAIT_PHRASES = {
  organise: [
    'Reading your tags, sheets, notes, and outline…',
    'Gathering the names of every soul in the tale…',
    'Looking for twins among your tags…',
    'Weighing which sheets tell the same story…',
    'Drawing up the plan…'
  ],
  chat: [
    'Thinking…',
    'Turning the question over…',
    'Leafing through your pages…',
    'Gathering the words…'
  ],
  query: [
    'Thinking…',
    'Searching the scenes for an answer…',
    'Leafing through your sheets and notes…',
    'Following the thread through the chapters…',
    'Weighing what the pages say…'
  ],
  whatNext: [
    'Thinking…',
    'Reading where the tale stands…',
    'Following the threads left loose…',
    'Looking down the roads ahead…',
    'Choosing the paths worth taking…'
  ],
  agentInsert: [
    'Writing into the editor…',
    'Listening for your voice…',
    'Setting down the words…',
    'Matching the rhythm of your lines…'
  ],
  agentReplace: [
    'Writing the new text…',
    'Listening for your voice…',
    'Reworking the passage…',
    'Matching the rhythm of your lines…'
  ],
  rewrite: [
    'Drafting…',
    'Listening for your voice…',
    'Reworking the passage line by line…',
    'Keeping what the scene must say…'
  ],
  brief: [
    'Drafting the brief…',
    'Reading the scene from the start…',
    'Naming who stands in it…',
    'Finding what is at stake…',
    'Writing down what the scene must do…'
  ],
  tags: [
    'Asking for tag suggestions…',
    'Reading the scene for names and places…',
    'Checking your tag bank for old friends…',
    'Choosing the marks that fit…'
  ],
  synopsis: [
    'Suggesting a synopsis…',
    'Reading the scene…',
    'Finding its turning point…',
    'Telling the tale short…'
  ],
  notes: [
    'Suggesting notes…',
    'Reading the scene…',
    'Marking what is worth remembering…',
    'Writing it down in the margins…'
  ],
  critique: [
    'Your editor is making notes.',
    'Reading the scene closely…',
    'Marking where it sings and where it stumbles…',
    'Finding a passage for every note…',
    'Setting the notes in order…'
  ],
  betaReader: [
    'Your beta reader is reading up to here.',
    'Turning the pages as a reader would…',
    'Noticing where the tale grips…',
    'Noticing where it drifts…',
    'Writing down first impressions…'
  ],
  continuity: [
    'Reading the scene against the story bible…',
    'Checking names, ages, and places…',
    'Comparing it with what came before…',
    'Looking for cracks in the tale…'
  ],
  proofread: [
    'Checking spelling, typos, grammar, and punctuation.',
    'Reading every line…',
    'Hunting for stray letters…',
    'Minding the commas and the quotes…'
  ],
  editPass: [
    'Reading the scenes one by one…',
    'Marking changes in the margins…',
    'Keeping to your voice…',
    'Leaving every change for you to judge…'
  ],
  contextSort: [
    'Reading your documents…',
    'Sorting the people from the places…',
    'Gathering names for new sheets…',
    'Laying out what goes where…'
  ]
} as const satisfies Record<string, readonly [string, ...string[]]>

export type AiWaitTask = keyof typeof AI_WAIT_PHRASES

/** The jade, italic look of an AI wait, for lines that keep their live numbers instead of rotating. */
export const AI_WAIT_CLASS = 'ai-wait'
