// src/main/templates/matterTemplates.ts
// Template content for Front Matter and End Matter documents
// All templates use Slate JSON format with industry-standard formatting

export interface MatterTemplate {
  type: string;
  displayName: string;
  section: 'front-matter' | 'end-matter';
  content: any[]; // Slate JSON content
  description: string;
}

// ============= FRONT MATTER TEMPLATES =============

export const titlePageTemplate: MatterTemplate = {
  type: 'title-page',
  displayName: 'Title Page',
  section: 'front-matter',
  description: 'Standard title page with book title, subtitle, and author name',
  content: [
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'center',
      children: [
        { text: 'YOUR BOOK TITLE', bold: true, fontSize: '28px' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'center',
      children: [
        { text: 'A Subtitle if Applicable', italic: true, fontSize: '18px' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'center',
      children: [
        { text: 'by', fontSize: '14px' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'center',
      children: [
        { text: 'Your Name', fontSize: '20px' }
      ]
    }
  ]
};

export const copyrightPageTemplate: MatterTemplate = {
  type: 'copyright-page',
  displayName: 'Copyright Page',
  section: 'front-matter',
  description: 'Standard copyright information and publication details',
  content: [
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: 'Copyright © [Year] by [Author Name]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: 'All rights reserved. No part of this book may be reproduced in any form or by any electronic or mechanical means, including information storage and retrieval systems, without written permission from the author, except for the use of brief quotations in a book review.' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: 'This is a work of fiction. Names, characters, places, and incidents either are the product of the author\'s imagination or are used fictitiously. Any resemblance to actual persons, living or dead, events, or locales is entirely coincidental.' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: 'First Edition: [Month Year]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: 'ISBN: [Your ISBN]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: 'Cover design by [Designer Name]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: 'Published by [Publisher Name]' }
      ]
    },
    {
      type: 'paragraph',
      align: 'left',
      children: [
        { text: '[Publisher Address]' }
      ]
    }
  ]
};

export const dedicationTemplate: MatterTemplate = {
  type: 'dedication',
  displayName: 'Dedication',
  section: 'front-matter',
  description: 'Short dedication to a person or group',
  content: [
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'center',
      children: [
        { text: 'For [Name]', italic: true }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'center',
      children: [
        { text: '[Optional dedication message]', italic: true }
      ]
    }
  ]
};

export const epigraphTemplate: MatterTemplate = {
  type: 'epigraph',
  displayName: 'Epigraph',
  section: 'front-matter',
  description: 'Opening quote or passage that sets the tone',
  content: [
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'right',
      children: [
        { text: '"[Your quote or passage here]"', italic: true }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'right',
      children: [
        { text: '— [Author or Source]' }
      ]
    }
  ]
};

export const forewordTemplate: MatterTemplate = {
  type: 'foreword',
  displayName: 'Foreword',
  section: 'front-matter',
  description: 'Introduction written by someone other than the author',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Foreword' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[The foreword is typically written by someone other than the author—an expert, celebrity, or respected figure in the field. It provides context, endorsement, or personal connection to the work.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Begin your foreword here...]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      align: 'right',
      children: [
        { text: '— [Foreword Author Name]' }
      ]
    },
    {
      type: 'paragraph',
      align: 'right',
      children: [
        { text: '[Date]' }
      ]
    }
  ]
};

export const prefaceTemplate: MatterTemplate = {
  type: 'preface',
  displayName: 'Preface',
  section: 'front-matter',
  description: 'Author\'s introduction explaining the book\'s purpose or background',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Preface' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[The preface is written by the author and typically explains why the book was written, its scope, and any relevant background information. It may also acknowledge sources or explain the author\'s approach.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Begin your preface here...]' }
      ]
    }
  ]
};

export const tableOfContentsTemplate: MatterTemplate = {
  type: 'table-of-contents',
  displayName: 'Table of Contents',
  section: 'front-matter',
  description: 'Chapter listing with page numbers (auto-generated recommended)',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Contents' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Note: Table of contents is typically auto-generated during compilation. This template provides a placeholder.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Part One' }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Chapter 1 ........................ 1' }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Chapter 2 ........................ 15' }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Chapter 3 ........................ 28' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Part Two' }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Chapter 4 ........................ 42' }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Chapter 5 ........................ 57' }
      ]
    }
  ]
};

// ============= END MATTER TEMPLATES =============

export const acknowledgmentsTemplate: MatterTemplate = {
  type: 'acknowledgments',
  displayName: 'Acknowledgments',
  section: 'end-matter',
  description: 'Thank you to people who helped with the book',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Acknowledgments' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[This is where you thank the people who helped make this book possible—editors, beta readers, family, friends, mentors, and anyone else who contributed to your writing journey.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'First and foremost, I would like to thank...' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'I am deeply grateful to...' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Special thanks to...' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Finally, I want to thank my readers...' }
      ]
    }
  ]
};

export const aboutTheAuthorTemplate: MatterTemplate = {
  type: 'about-the-author',
  displayName: 'About the Author',
  section: 'end-matter',
  description: 'Author biography and background',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'About the Author' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Your name] is [a brief description of who you are, what you write, and any relevant background or credentials.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Add information about previous publications, awards, or experience. Keep it professional but personable.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[You can also mention where you live, hobbies related to your writing, or what you\'re currently working on.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Connect with [Author Name]:' }
      ]
    },
    {
      type: 'paragraph',
      children: [
        { text: 'Website: [your-website.com]' }
      ]
    },
    {
      type: 'paragraph',
      children: [
        { text: 'Email: [your-email@example.com]' }
      ]
    },
    {
      type: 'paragraph',
      children: [
        { text: 'Social media: [handles]' }
      ]
    }
  ]
};

export const authorsNoteTemplate: MatterTemplate = {
  type: 'authors-note',
  displayName: "Author's Note",
  section: 'end-matter',
  description: 'Personal message from the author about the story',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: "Author's Note" }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[An author\'s note is a personal message to readers. You might discuss the inspiration behind the story, explain creative choices, address historical accuracy in historical fiction, or share interesting research findings.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Dear Reader,' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Begin your author\'s note here...]' }
      ]
    }
  ]
};

export const afterwordTemplate: MatterTemplate = {
  type: 'afterword',
  displayName: 'Afterword',
  section: 'end-matter',
  description: 'Concluding remarks or commentary after the story',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Afterword' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[An afterword provides closing thoughts about the book. It might discuss themes, the writing process, or what inspired the work. Unlike an author\'s note, it typically assumes the reader has finished the story.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Begin your afterword here...]' }
      ]
    }
  ]
};

export const appendixTemplate: MatterTemplate = {
  type: 'appendix',
  displayName: 'Appendix',
  section: 'end-matter',
  description: 'Supplementary material (maps, timelines, character lists, etc.)',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Appendix' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[The appendix contains supplementary material that enhances the reading experience but isn\'t essential to the main narrative. This might include:]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '• Character lists or family trees' }
      ]
    },
    {
      type: 'paragraph',
      children: [
        { text: '• Maps and world-building details' }
      ]
    },
    {
      type: 'paragraph',
      children: [
        { text: '• Timelines of events' }
      ]
    },
    {
      type: 'paragraph',
      children: [
        { text: '• Historical notes or context' }
      ]
    },
    {
      type: 'paragraph',
      children: [
        { text: '• Deleted scenes or alternate endings' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Add your supplementary content here...]' }
      ]
    }
  ]
};

export const glossaryTemplate: MatterTemplate = {
  type: 'glossary',
  displayName: 'Glossary',
  section: 'end-matter',
  description: 'Definitions of specialized terms used in the book',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Glossary' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[A glossary defines specialized terms, made-up words, or jargon used in your book. This is especially useful for fantasy, sci-fi, or technical fiction. Arrange terms alphabetically.]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Term 1', bold: true }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Definition or explanation of Term 1.' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Term 2', bold: true }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Definition or explanation of Term 2.' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Term 3', bold: true }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Definition or explanation of Term 3.' }
      ]
    }
  ]
};

export const bibliographyTemplate: MatterTemplate = {
  type: 'bibliography',
  displayName: 'Bibliography',
  section: 'end-matter',
  description: 'List of sources and references used',
  content: [
    {
      type: 'heading-one',
      children: [
        { text: 'Bibliography' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[A bibliography lists sources you consulted while writing the book. This is particularly important for historical fiction, biographical works, or any story requiring significant research. Format according to your preferred citation style (Chicago, MLA, etc.).]' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Author Last Name, First Name. ', italic: false }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Title of Book', italic: true },
        { text: '. Publisher, Year.' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: 'Author Last Name, First Name. "Title of Article." ' }
      ]
    },
    {
      type: 'paragraph',
      indent: 1,
      children: [
        { text: 'Title of Journal', italic: true },
        { text: ', vol. X, no. Y, Year, pp. 1-10.' }
      ]
    },
    { type: 'paragraph', children: [{ text: '' }] },
    {
      type: 'paragraph',
      children: [
        { text: '[Add your sources here, arranged alphabetically by author last name...]' }
      ]
    }
  ]
};

// ============= TEMPLATE REGISTRY =============

export const allMatterTemplates: MatterTemplate[] = [
  // Front Matter (7 templates)
  titlePageTemplate,
  copyrightPageTemplate,
  dedicationTemplate,
  epigraphTemplate,
  forewordTemplate,
  prefaceTemplate,
  tableOfContentsTemplate,

  // End Matter (7 templates)
  acknowledgmentsTemplate,
  aboutTheAuthorTemplate,
  authorsNoteTemplate,
  afterwordTemplate,
  appendixTemplate,
  glossaryTemplate,
  bibliographyTemplate
];

export const frontMatterTemplates = allMatterTemplates.filter(t => t.section === 'front-matter');
export const endMatterTemplates = allMatterTemplates.filter(t => t.section === 'end-matter');

// Helper function to get template by type
export function getTemplateByType(type: string): MatterTemplate | undefined {
  return allMatterTemplates.find(t => t.type === type);
}

// Helper function to get templates by section
export function getTemplatesBySection(section: 'front-matter' | 'end-matter'): MatterTemplate[] {
  return allMatterTemplates.filter(t => t.section === section);
}
