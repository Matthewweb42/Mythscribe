import { z } from 'zod'
import type { SectionType } from './labels'
import type { TiptapMarkT, TiptapNodeT } from './tiptap'

/**
 * Front and end matter templates (F-2.6): the 14 documents an author can add from the Front
 * Matter and End Matter context menus, pre-filled with conventionally formatted content. One
 * owner for ids, titles, and content; main writes the content into the new row and stamps
 * `matter_type` with the id, the renderer builds the menu from the same list.
 *
 * Content uses only the editor schema (`buildExtensions`): paragraphs and headings with
 * `textAlign`, block quotes, and the bold/italic/underline/strike/code marks. Placeholders the
 * author replaces are written in brackets, like `[Author Name]`.
 */

export const MATTER_TEMPLATE_IDS = [
  'title-page',
  'copyright-page',
  'dedication',
  'epigraph',
  'foreword',
  'preface',
  'table-of-contents',
  'acknowledgments',
  'about-the-author',
  'authors-note',
  'afterword',
  'appendix',
  'glossary',
  'bibliography'
] as const
export const MatterTemplateId = z.enum(MATTER_TEMPLATE_IDS)
export type MatterTemplateId = z.infer<typeof MatterTemplateId>

/** The sections that take templates; the manuscript never does. */
export type MatterSection = Extract<SectionType, 'front' | 'end'>

export interface MatterTemplate {
  id: MatterTemplateId
  section: MatterSection
  /** The new document's title, and the menu label after "New". */
  title: string
  content: TiptapNodeT
}

type Align = 'center' | 'right'

const text = (value: string, ...marks: TiptapMarkT['type'][]): TiptapNodeT =>
  marks.length > 0
    ? { type: 'text', text: value, marks: marks.map((type) => ({ type })) }
    : { type: 'text', text: value }

/** A paragraph; empty (no `content`) when given no runs, since ProseMirror refuses empty text nodes. */
const paragraph = (runs: TiptapNodeT[] = [], align?: Align): TiptapNodeT => ({
  type: 'paragraph',
  ...(align ? { attrs: { textAlign: align } } : {}),
  ...(runs.length > 0 ? { content: runs } : {})
})

const p = (value: string, align?: Align): TiptapNodeT => paragraph([text(value)], align)
const italic = (value: string, align?: Align): TiptapNodeT =>
  paragraph([text(value, 'italic')], align)
const blank = (): TiptapNodeT => paragraph()
const blanks = (n: number): TiptapNodeT[] => Array.from({ length: n }, blank)

const heading = (value: string, align?: Align): TiptapNodeT => ({
  type: 'heading',
  attrs: { level: 1, ...(align ? { textAlign: align } : {}) },
  content: [text(value)]
})

const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })

const RIGHTS =
  'All rights reserved. No part of this book may be reproduced in any form or by any electronic or mechanical means, including information storage and retrieval systems, without written permission from the author, except for the use of brief quotations in a book review.'

const FICTION_DISCLAIMER =
  "This is a work of fiction. Names, characters, places, and incidents either are the product of the author's imagination or are used fictitiously. Any resemblance to actual persons, living or dead, events, or locales is entirely coincidental."

/** A glossary entry: bold term, em dash, definition. */
const glossaryEntry = (): TiptapNodeT =>
  paragraph([text('[Term]', 'bold'), text(' — [Definition]')])

/** A bibliography entry in Chicago style: author, italic title, publisher, year. */
const bibliographyEntry = (): TiptapNodeT =>
  paragraph([
    text('[Author Last Name, First Name]. '),
    text('[Title]', 'italic'),
    text('. [Publisher], [Year].')
  ])

const front = (id: MatterTemplateId, title: string, content: TiptapNodeT): MatterTemplate => ({
  id,
  section: 'front',
  title,
  content
})
const end = (id: MatterTemplateId, title: string, content: TiptapNodeT): MatterTemplate => ({
  id,
  section: 'end',
  title,
  content
})

/** The 14 templates in spec order: the seven front-matter ones, then the seven end-matter ones. */
export const MATTER_TEMPLATES: readonly MatterTemplate[] = [
  front(
    'title-page',
    'Title Page',
    doc(
      ...blanks(4),
      heading('[Book Title]', 'center'),
      italic('[Subtitle]', 'center'),
      ...blanks(2),
      p('by', 'center'),
      blank(),
      p('[Author Name]', 'center')
    )
  ),
  front(
    'copyright-page',
    'Copyright Page',
    doc(
      p('Copyright © [Year] by [Author Name]'),
      blank(),
      p(RIGHTS),
      blank(),
      p(FICTION_DISCLAIMER),
      blank(),
      p('First Edition: [Month Year]'),
      p('ISBN: [ISBN]'),
      blank(),
      p('Cover design by [Designer Name]'),
      p('Published by [Publisher Name]')
    )
  ),
  front(
    'dedication',
    'Dedication',
    doc(
      ...blanks(4),
      italic('For [Name]', 'center'),
      blank(),
      italic('[Optional dedication message]', 'center')
    )
  ),
  front(
    'epigraph',
    'Epigraph',
    doc(
      ...blanks(3),
      { type: 'blockquote', content: [italic('[Quote]')] },
      p('— [Attribution]', 'right')
    )
  ),
  front(
    'foreword',
    'Foreword',
    doc(
      heading('Foreword'),
      p(
        '[A foreword is written by someone other than the author: an expert, a colleague, or a respected voice in the field. It sets the book in context, vouches for it, or describes a personal connection to the work.]'
      ),
      blank(),
      p('[Begin the foreword here.]'),
      ...blanks(2),
      p('— [Foreword Author]', 'right'),
      p('[Place, Date]', 'right')
    )
  ),
  front(
    'preface',
    'Preface',
    doc(
      heading('Preface'),
      p(
        "[A preface is the author's own introduction. It explains why the book was written, what it covers, and any background the reader should have before starting.]"
      ),
      blank(),
      p('[Begin the preface here.]')
    )
  ),
  front(
    'table-of-contents',
    'Table of Contents',
    doc(
      heading('Contents'),
      p(
        '[The table of contents is generated from the manuscript structure when the book is compiled. Use this page for a hand-written contents list or notes about what to include.]'
      )
    )
  ),
  end(
    'acknowledgments',
    'Acknowledgments',
    doc(
      heading('Acknowledgments'),
      p(
        '[Thank the people who helped make this book possible: editors, early readers, family, friends, mentors, and anyone else who supported the work.]'
      ),
      blank(),
      p('[Begin the acknowledgments here.]')
    )
  ),
  end(
    'about-the-author',
    'About the Author',
    doc(
      heading('About the Author'),
      p(
        '[Author Name] is [a short description: what they write, where they live, and any relevant background].'
      ),
      blank(),
      p('[Mention previous books, awards, or experience. Keep it brief and in the third person.]'),
      blank(),
      p('[Website, newsletter, or social media, if any.]')
    )
  ),
  end(
    'authors-note',
    "Author's Note",
    doc(
      heading("Author's Note"),
      p(
        "[An author's note speaks directly to the reader: the inspiration behind the story, the research that shaped it, liberties taken with history or fact, or what the book means to you.]"
      ),
      blank(),
      p('Dear Reader,'),
      blank(),
      p('[Begin the note here.]')
    )
  ),
  end(
    'afterword',
    'Afterword',
    doc(
      heading('Afterword'),
      p(
        "[An afterword offers closing thoughts once the story is done: its themes, how it came to be written, or what happened after. Unlike an author's note, it assumes the reader has finished the book.]"
      ),
      blank(),
      p('[Begin the afterword here.]')
    )
  ),
  end(
    'appendix',
    'Appendix',
    doc(
      heading('Appendix'),
      p(
        '[An appendix holds material that enriches the book without belonging in the narrative: character lists, family trees, maps, timelines, historical notes, or deleted scenes.]'
      ),
      blank(),
      p('[Add the supplementary material here.]')
    )
  ),
  end(
    'glossary',
    'Glossary',
    doc(
      heading('Glossary'),
      p(
        '[A glossary defines the invented words, specialised terms, and names a reader may need help with. List the entries alphabetically.]'
      ),
      blank(),
      glossaryEntry(),
      glossaryEntry(),
      glossaryEntry()
    )
  ),
  end(
    'bibliography',
    'Bibliography',
    doc(
      heading('Bibliography'),
      p(
        '[A bibliography lists the sources consulted while writing the book. Arrange the entries alphabetically by author and follow one citation style throughout.]'
      ),
      blank(),
      bibliographyEntry(),
      bibliographyEntry()
    )
  )
]

const byId: ReadonlyMap<MatterTemplateId, MatterTemplate> = new Map(
  MATTER_TEMPLATES.map((template) => [template.id, template])
)

/** The template behind an id. Every id in `MATTER_TEMPLATE_IDS` has one. */
export function matterTemplate(id: MatterTemplateId): MatterTemplate {
  const template = byId.get(id)
  if (!template) throw new Error(`No matter template with id ${id}`)
  return template
}

/** The templates a section's context menu offers, in spec order. */
export function matterTemplatesFor(section: MatterSection): MatterTemplate[] {
  return MATTER_TEMPLATES.filter((template) => template.section === section)
}
