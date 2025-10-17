# Inline Tag Editor Implementation Guide

**Status**: InlineTagAutocomplete component created, needs integration into Editor.tsx

## 📋 What's Already Done:

1. ✅ InlineTagAutocomplete component created at `src/renderer/src/components/Editor/InlineTagAutocomplete.tsx`
   - Beautiful dropdown with tag list
   - Arrow navigation support
   - Color indicators and category badges
   - Keyboard hints (↑↓, Enter, Esc)

2. ✅ Component imported into Editor.tsx (line 17)

## 🔨 What Still Needs to Be Done:

### Step 1: Add State Variables to Editor.tsx

Add these state variables after the existing state declarations (around line 198):

```typescript
// Inline tag autocomplete state
const [showTagAutocomplete, setShowTagAutocomplete] = useState(false);
const [tagSearchQuery, setTagSearchQuery] = useState('');
const [tagAutocompletePosition, setTagAutocompletePosition] = useState({ top: 0, left: 0 });
const [tagSelectedIndex, setTagSelectedIndex] = useState(0);
const [allTags, setAllTags] = useState<any[]>([]);
const [hashStartPosition, setHashStartPosition] = useState<{ path: number[]; offset: number } | null>(null);
```

### Step 2: Load All Tags on Component Mount

Add this useEffect after the existing useEffects (around line 350):

```typescript
// Load all tags for autocomplete
useEffect(() => {
  const loadTags = async () => {
    try {
      const tags = await (window.api as any).tag.getAll();
      setAllTags(tags);
    } catch (error) {
      console.error('Error loading tags:', error);
    }
  };

  if (activeDocumentId) {
    loadTags();
  }
}, [activeDocumentId]);
```

### Step 3: Add onKeyDown Handler to Editable Component

Find the `<Editable>` component (around line 1230) and add `onKeyDown` handler:

```typescript
<Editable
  renderLeaf={Leaf}
  renderElement={Element}
  placeholder={mode === 'vibewrite' ? 'Start writing and let AI guide you...' : 'Write your story...'}
  spellCheck
  autoFocus
  onKeyDown={(event) => handleKeyDown(event)}
  style={{
    // ... existing styles
  }}
/>
```

### Step 4: Create handleKeyDown Function

Add this function before the return statement (around line 1150):

```typescript
const handleKeyDown = (event: React.KeyboardEvent) => {
  // Handle tag autocomplete navigation
  if (showTagAutocomplete) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const filteredTags = allTags.filter(tag =>
        tag.name.toLowerCase().includes(tagSearchQuery.toLowerCase())
      );
      setTagSelectedIndex(prev => (prev + 1) % filteredTags.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const filteredTags = allTags.filter(tag =>
        tag.name.toLowerCase().includes(tagSearchQuery.toLowerCase())
      );
      setTagSelectedIndex(prev => (prev - 1 + filteredTags.length) % filteredTags.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const filteredTags = allTags.filter(tag =>
        tag.name.toLowerCase().includes(tagSearchQuery.toLowerCase())
      );
      if (filteredTags[tagSelectedIndex]) {
        handleSelectTag(filteredTags[tagSelectedIndex]);
      } else if (tagSearchQuery.trim()) {
        // Create new tag if no match
        handleCreateAndInsertTag(tagSearchQuery);
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeTagAutocomplete();
      return;
    }
  }

  // Detect # keypress to start tag autocomplete
  if (event.key === '#') {
    const { selection } = editor;
    if (selection) {
      // Store the position where # was typed
      setHashStartPosition({
        path: selection.anchor.path,
        offset: selection.anchor.offset
      });
      setTagSearchQuery('');
      setTagSelectedIndex(0);

      // Calculate position for autocomplete dropdown
      const domSelection = window.getSelection();
      if (domSelection && domSelection.rangeCount > 0) {
        const range = domSelection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        setTagAutocompletePosition({
          top: rect.bottom + window.scrollY + 5,
          left: rect.left + window.scrollX
        });
      }

      setShowTagAutocomplete(true);
    }
  }

  // Handle accepting ghost text (Tab key)
  if (event.key === 'Tab' && (ghostText || aiAssistantGhostText)) {
    event.preventDefault();
    const textToInsert = ghostText || aiAssistantGhostText;
    insertText(textToInsert);
    setGhostText('');
    setAiAssistantGhostText('');
  }
};
```

### Step 5: Create Tag Selection and Insertion Functions

Add these functions after handleKeyDown:

```typescript
const closeTagAutocomplete = () => {
  setShowTagAutocomplete(false);
  setTagSearchQuery('');
  setTagSelectedIndex(0);
  setHashStartPosition(null);
};

const handleSelectTag = async (tag: any) => {
  if (!hashStartPosition || !activeDocumentId) {
    closeTagAutocomplete();
    return;
  }

  try {
    // Remove the # and search query text
    const { selection } = editor;
    if (selection) {
      Transforms.delete(editor, {
        at: {
          anchor: hashStartPosition,
          focus: selection.anchor
        }
      });

      // Insert the tag as a special node with background color
      Transforms.insertText(editor, `#${tag.name}`, {
        at: hashStartPosition
      });

      // Apply tag formatting (background color)
      Transforms.setNodes(
        editor,
        { backgroundColor: tag.color } as any,
        {
          at: {
            anchor: hashStartPosition,
            focus: {
              path: hashStartPosition.path,
              offset: hashStartPosition.offset + tag.name.length + 1
            }
          },
          match: Text.isText,
          split: true
        }
      );

      // Add tag to document in database
      await (window.api as any).documentTag.add(activeDocumentId, tag.id, null, null);
    }

    closeTagAutocomplete();
  } catch (error) {
    console.error('Error inserting tag:', error);
    closeTagAutocomplete();
  }
};

const handleCreateAndInsertTag = async (tagName: string) => {
  if (!hashStartPosition || !activeDocumentId) {
    closeTagAutocomplete();
    return;
  }

  try {
    // Create new tag with default color
    const newTagId = await (window.api as any).tag.create(
      tagName,
      'custom',
      '#888888',
      null
    );

    // Get the created tag
    const newTag = await (window.api as any).tag.get(newTagId);

    // Insert it
    await handleSelectTag(newTag);
  } catch (error) {
    console.error('Error creating tag:', error);
    closeTagAutocomplete();
  }
};
```

### Step 6: Update onChange Handler to Track Search Query

Find the `onChange` handler for the main editor (around line 600) and add this logic at the beginning:

```typescript
const handleEditorChange = (newValue: Descendant[]) => {
  // Track tag search query while autocomplete is open
  if (showTagAutocomplete && hashStartPosition) {
    const { selection } = editor;
    if (selection) {
      // Extract text after the # symbol
      try {
        const textAfterHash = SlateEditor.string(editor, {
          anchor: {
            path: hashStartPosition.path,
            offset: hashStartPosition.offset + 1
          },
          focus: selection.anchor
        });
        setTagSearchQuery(textAfterHash);
      } catch (e) {
        // If extraction fails, close autocomplete
        closeTagAutocomplete();
      }
    }
  }

  // ... rest of existing onChange logic
  setValue(newValue);
  // ... etc
};
```

Then update the Slate component to use this handler:

```typescript
<Slate editor={editor} initialValue={value} onChange={handleEditorChange}>
```

### Step 7: Render InlineTagAutocomplete Component

Add this right before the closing `</div>` of the main editor container (around line 1450):

```typescript
{/* Inline Tag Autocomplete */}
{showTagAutocomplete && (
  <InlineTagAutocomplete
    tags={allTags}
    searchQuery={tagSearchQuery}
    selectedIndex={tagSelectedIndex}
    position={tagAutocompletePosition}
    onSelect={handleSelectTag}
    onClose={closeTagAutocomplete}
  />
)}
```

### Step 8: Update Leaf Component to Show Tag Backgrounds

The Leaf component (around line 69) already supports `backgroundColor`, so tags with background colors will automatically render correctly.

## 🧪 Testing Checklist:

After implementation, test:

- [ ] Type `#` and autocomplete appears
- [ ] Type characters after `#` to filter tags
- [ ] Arrow keys (↑↓) navigate through suggestions
- [ ] Enter key selects highlighted tag
- [ ] Escape key closes autocomplete
- [ ] Selected tag appears with colored background
- [ ] Tag is added to document in database
- [ ] Creating new tag works when typing unknown tag name
- [ ] Autocomplete closes when clicking outside
- [ ] Build succeeds with no TypeScript errors

## 📁 Files Modified:

1. `src/renderer/src/components/Editor/Editor.tsx` - Main implementation
2. `src/renderer/src/components/Editor/InlineTagAutocomplete.tsx` - Already created

## 🎯 Next Steps After Inline Tags Work:

1. Add right-click context menu on tags (Edit, Delete, Jump to Manager)
2. Improve tag rendering (maybe use Slate custom elements instead of just background color)
3. Consider hierarchical tags display
4. Add tag sidebar panel (optional - DocumentTagBox might be sufficient)

---

**Estimated Time**: 2-3 hours for implementation and testing
**Complexity**: Medium (Slate.js text manipulation is tricky)
