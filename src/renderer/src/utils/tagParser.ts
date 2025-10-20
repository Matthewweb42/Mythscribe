// src/renderer/src/utils/tagParser.ts
import { Descendant, Text, Node } from 'slate';

export interface InlineTag {
  id: string;
  name: string;
  color: string;
  count: number;
}

/**
 * Extracts all inline tags from Slate document nodes
 * Returns a map of tagId -> {id, name, color, count}
 */
export function extractInlineTags(nodes: Descendant[]): Map<string, InlineTag> {
  const tagMap = new Map<string, InlineTag>();

  // Recursively walk through all nodes
  const walkNodes = (node: Node) => {
    if (Text.isText(node)) {
      // Check if this text node is a tag
      if (node.isTag && node.tagId && node.tagName) {
        const existing = tagMap.get(node.tagId);
        if (existing) {
          // Increment count
          existing.count++;
        } else {
          // Add new tag
          tagMap.set(node.tagId, {
            id: node.tagId,
            name: node.tagName,
            color: node.backgroundColor || '#888888',
            count: 1
          });
        }
      }
    } else if ('children' in node && Array.isArray(node.children)) {
      // Recursively process children
      for (const child of node.children) {
        walkNodes(child);
      }
    }
  };

  // Walk through all top-level nodes
  for (const node of nodes) {
    walkNodes(node);
  }

  return tagMap;
}

/**
 * Converts the tag map to a sorted array (by count, descending)
 */
export function inlineTagsToArray(tagMap: Map<string, InlineTag>): InlineTag[] {
  return Array.from(tagMap.values()).sort((a, b) => b.count - a.count);
}
