# MythScribe Implementation Plan

**Strategic build order to avoid conflicts and ensure smooth development**

**Last Updated:** January 2025
**Current Phase:** Phase 3 - Organization (Ready to start)

---

## 🎉 **Recent Improvements** (Not in Original Plan)

### Popup/Modal System Overhaul ✅ COMPLETE
- Replaced all native browser dialogs (alert/prompt/confirm) with themed components
- Created Toast notification system for non-blocking feedback (success, error, warning, info)
- Built professional InputModal component for text input
- Fixed app-breaking popup issues
- Consistent dark theme styling across all popups

**Files Created:**
- `Toast.tsx` - Toast notification component
- `NotificationContext.tsx` - Global toast management
- `InputModal.tsx` - Professional input dialogs

### Editor Width Constraint ✅ COMPLETE
- Book-like reading experience with max 700px text width (configurable 500-1000px)
- Centered content column with minimum padding
- Responsive layout that adapts to window size

### Customizable Scene Breaks ✅ COMPLETE
- Multiple preset styles (*, #, ~, ---)
- Custom text support
- Format-specific defaults (Novel/Epic vs Web-novel)
- Saved in settings with live preview

---

## 🏗️ **Build Strategy**

### Principles
1. **Foundation First**: Build core UI structure before adding features
2. **Progressive Enhancement**: Each phase builds on previous work
3. **Test as We Go**: Verify each chunk works before moving on
4. **Data Safety**: Never risk existing data with new features

---

## 📦 **PHASE 1: Layout Foundation** ✅ COMPLETE

*Goal: Restructure UI to support all future features*

### Chunk 1.1: Menu Bar System ✅ COMPLETE
**Why first:** Everything else depends on proper navigation

- [x] Create MenuBar component
- [x] Add Electron menu integration
- [x] Implement menu items (File, Edit, Insert, View, Tools, Help)
- [x] All menu actions trigger properly

**Files Created:**
- `MenuBar.tsx`
- Updated `MainLayout.tsx`
- `menu.ts` (native Electron menu)

---

### Chunk 1.2: Resizable Panel System ✅ COMPLETE
**Why second:** Need adjustable layout before adding more panels

- [x] Installed `react-resizable-panels`
- [x] Implemented ResizableLayout in MainLayout
- [x] Drag handles with hover effects
- [x] Min/max constraints on all panels
- [x] Sizes persist via `autoSaveId`

**Testing Passed:**
- ✅ Can drag panels to resize
- ✅ Sizes persist on reload
- ✅ Min/max limits work correctly

---

### Chunk 1.3: Enhanced Sidebar - Tab System ✅ COMPLETE
**Why third:** Reorganize existing sidebar before adding new sections

- [x] Created tabbed sidebar component
- [x] Tabs: Manuscript | Characters | Settings | World | Outline | Timeline | Tags
- [x] Manuscript tree functional
- [x] Placeholder tabs created
- [x] Tab switching works smoothly

**Files Created:**
- `TabbedSidebar.tsx`
- `ManuscriptTab.tsx`
- Placeholder tabs for other sections

---

### Chunk 1.4: Docked AI Panel ✅ COMPLETE
**Why fourth:** Reorganize existing AI panel

- [x] AI panel integrated into resizable layout
- [x] Toggleable via button and keyboard
- [x] Mode switcher (Chat | Generate | Edit | Ask)
- [x] Professional docked appearance

**Testing Passed:**
- ✅ AI panel docks properly
- ✅ Toggle visibility works
- ✅ Mode switcher functional

---

**PHASE 1 CHECKPOINT:** ✅ PASSED
- ✅ Menu bar functional
- ✅ All panels resizable
- ✅ Sidebar has tabs
- ✅ AI panel docked
- ✅ App tested and stable

---

## 📝 **PHASE 2: Writing Experience** (~40% Complete)

### Chunk 2.1: Novel-Style Formatting ✅ COMPLETE
**Why first:** Core writing experience improvement

- [x] Created formatting configuration system
- [x] Implemented first-line indent (0-3.0em configurable)
- [x] Paragraph spacing control (0-2.0em)
- [x] Line-height options (1.0-2.5)
- [x] Font size control (12-24px)
- [x] Format-specific defaults (Novel/Epic vs Web-novel)
- [x] Settings UI with live preview

**Testing Passed:**
- ✅ Novel/Epic defaults: No spacing, 1.5em indent, 2.0 line-height
- ✅ Web-novel defaults: 1.0em spacing, no indent, 1.6 line-height
- ✅ Formatting persists across sessions
- ✅ Settings UI shows live preview

**Files Created/Modified:**
- `SettingsModal.tsx` - Tabbed interface with Editor section
- `Editor.tsx` - Dynamic formatting based on settings
- `database.ts` - Editor formatting settings in DB

---

### Chunk 2.1b: Editor Width Constraint & Scene Breaks ✅ COMPLETE
**Added to plan:** Essential writing experience improvements

- [x] Maximum text width (700px default, 500-1000px configurable)
- [x] Centered text column for book-like reading
- [x] Minimum padding (40px) for responsive layout
- [x] Customizable scene break styles (*, #, ~, custom)
- [x] Format-specific scene break defaults
- [x] Settings integration with preview

**Testing Passed:**
- ✅ Text width constraint works across all window sizes
- ✅ Scene breaks render centered and styled
- ✅ Settings save and apply correctly

**Files Modified:**
- `Editor.tsx` - Width constraint wrapper, scene break rendering
- `database.ts` - Scene break style settings
- `SettingsModal.tsx` - Scene break customization UI

---

### Chunk 2.2: Scene Metadata Fields ⏱️ 3-4 hours ✅ COMPLETE
**Why second:** Foundation for scene compile view

- [x] Add metadata fields to database (location, timeline_position, pov, scene_metadata)
- [x] Integrate metadata into DocumentTagBox component (not separate component)
- [x] Add metadata fields with autocomplete from tags
- [x] Display metadata in collapsible section
- [x] Tags integration - location uses setting tags, POV uses character tags

**Testing Checklist:**
- [x] Can add location, time, POV to scenes
- [x] Metadata saves properly (debounced 500ms)
- [x] Metadata displays nicely in DocumentTagBox
- [x] Metadata is collapsible/expandable (expanded by default)
- [x] Shows for scene, chapter, and part documents

**Database Changes:**
- Added columns to `documents` table:
  - `location TEXT` - stores tag name or free text
  - `timeline_position TEXT` - free text for now, timeline picker in Phase 3
  - `pov TEXT` - stores character tag name or free text
  - `scene_metadata TEXT` - JSON for future extensibility

**Files Modified:**
- `src/main/database.ts` - schema update + migrations + CRUD methods
- `src/renderer/src/components/DocumentTagBox.tsx` - integrated metadata section
- `src/renderer/src/components/Editor/Editor.tsx` - pass currentDocument prop
- `src/main/ipcHandlers.ts` - metadata update/get handlers
- `src/renderer/types/window.d.ts` - DocumentRow interface + API types

---

### Chunk 2.3: Stacked Scene Editing for Chapters/Parts ✅ COMPLETE
**Why third:** Edit multiple scenes in one view with compiled display

**Implementation Details:**
- [x] Click Chapter → view/edit all child scenes stacked vertically
- [x] Click Part → view/edit all scenes from all chapters stacked vertically
- [x] Each scene editable with independent Slate editor instance
- [x] Scene break separators between scenes (read-only, uses configured style)
- [x] Individual save logic for each scene (debounced 1s)
- [x] Combined word count across all scenes
- [x] Metadata displays for current document (chapter/part metadata at top)
- [x] Fixed scene content mixing issue (ID-based editor mapping, not index-based)
- [x] Proper data persistence (fresh DB fetches prevent stale data)

**Key Architecture:**
- Created `StackedSceneEditor` component with Map-based editor tracking
- Each scene has unique editor keyed by scene ID (not array index)
- Prevents content swapping when scenes have same names across chapters
- Content forced to remount when loaded from database
- No infinite loops from document reloading

**Testing Passed:**
- ✅ Chapter view shows all child scenes stacked with editable editors
- ✅ Part view shows all scenes from all chapters
- ✅ Scene breaks render with user's configured style between scenes
- ✅ Each scene saves independently
- ✅ Switching between views preserves all edits
- ✅ Scenes with identical names don't mix content
- ✅ Combined word count accurate

**Files Created/Modified:**
- `src/renderer/src/components/Editor/StackedSceneEditor.tsx` (new) - Stacked editor component
- `src/renderer/src/components/Editor/Editor.tsx` - Folder detection, stacked view integration
- `src/renderer/src/components/Sidebar/ManuscriptTab.tsx` - Allow folder selection

---

### Chunk 2.3b: UI/UX Improvements ✅ COMPLETE
**Added to plan:** Major UI restructuring and improvements

**Document Tags/Metadata Bar Restructure:**
- [x] Swapped panel positions: Metadata left (40%), Document Tags right (60%)
- [x] Made entire bar collapsible with single minimize button
- [x] Removed individual section collapse toggles (always expanded when visible)
- [x] Added vertical resizing with drag handle at bottom
  - Min height: 100px, Max height: 60vh
  - Height persists to localStorage
- [x] Horizontal drag divider still works (resize left/right panels)
- [x] Removed metadata panel hide functionality (X button)
- [x] Moved Inline Tags to separate section below Document Tags

**Editor Status Bar:**
- [x] Created EditorStatusBar component at bottom of editor
- [x] Displays: Word Count | Session Count (centered)
- [x] Removed character count
- [x] Removed word/char/session counts from top formatting toolbar
- [x] Clean, minimal design
- [x] Always visible (not toggleable)

**Testing Passed:**
- ✅ Bar expands/collapses smoothly with minimize button
- ✅ Vertical resize works with min/max constraints
- ✅ Horizontal resize still functional
- ✅ All preferences persist to localStorage
- ✅ Status bar shows accurate counts
- ✅ Top toolbar has no word/char counts

**Files Created/Modified:**
- `src/renderer/src/components/DocumentTagBox.tsx` - Complete restructure
- `src/renderer/src/components/Editor/EditorStatusBar.tsx` (new) - Bottom status bar
- `src/renderer/src/components/Editor/Editor.tsx` - Integrated status bar

**localStorage Keys Added:**
- `tagMetadataBarCollapsed` - Bar expanded/collapsed state
- `tagMetadataSplitRatio` - Horizontal split ratio (0.3-0.7)
- `tagMetadataBarHeight` - Vertical height in pixels

---

### Chunk 2.4: Front Matter & End Matter System ✅ COMPLETE
**Why fourth:** Professional manuscript structure with industry-standard templates

- [x] Three-section manuscript structure (Front Matter, Manuscript, End Matter)
- [x] Database schema updates (section, matter_type, formatting_preset columns)
- [x] Migration system for existing projects
- [x] Created 14 professional templates with industry-standard formatting
- [x] Context-aware right-click menus (section-specific document creation)
- [x] Drag & drop restrictions (can reorder within sections, not between)
- [x] Root folder protection (cannot delete/rename Front Matter/End Matter/Manuscript)

**Front Matter Templates (7):**
- Title Page, Copyright Page, Dedication, Epigraph, Foreword, Preface, Table of Contents

**End Matter Templates (7):**
- Acknowledgments, About the Author, Author's Note, Afterword, Appendix, Glossary, Bibliography

**UI/UX Enhancements:**
- [x] Matter documents display with golden FileText icon (vs teal for regular scenes)
- [x] Matter documents function as scene-level documents (hierarchy_level: 'scene')
- [x] Stacked editing for Front/End Matter folders (click folder to view all children)
- [x] Gray page breaks between stacked matter documents (thin 1px line)
- [x] Traditional scene breaks for manuscript scenes (customizable text)

**Testing Passed:**
- ✅ Database migrations work for existing projects
- ✅ New projects create three-section structure automatically
- ✅ Context menus show correct options based on section
- ✅ Templates load with proper formatting
- ✅ Drag & drop respects section boundaries
- ✅ Root folders protected from deletion/renaming
- ✅ Matter documents show golden icons in sidebar
- ✅ Stacked editing works for Front/End Matter folders
- ✅ Gray page breaks display between matter documents
- ✅ Scene breaks still work for manuscript scenes
- ✅ TypeScript compilation successful

**Files Created:**
- `src/main/templates/matterTemplates.ts` (all 14 templates)
- `src/renderer/src/components/Sidebar/MatterTemplateMenu.tsx` (submenu component)

**Files Modified:**
- `src/main/database.ts` - Schema updates, migration logic, createMatterDocument() with hierarchy_level: 'scene'
- `src/main/ipcHandlers.ts` - Added document:createMatter handler
- `src/preload/index.ts` - Exposed createMatter API
- `src/renderer/types/window.d.ts` - Updated DocumentRow interface
- `src/renderer/src/components/Sidebar/ManuscriptTab.tsx` - Section-aware context menus, drag restrictions
- `src/renderer/src/components/Sidebar/TreeNodeComponent.tsx` - Golden icon for matter documents
- `src/renderer/src/components/Editor/Editor.tsx` - Stacked editing for Front/End Matter folders
- `src/renderer/src/components/Editor/StackedSceneEditor.tsx` - Gray page breaks for matter documents

---

### Chunk 2.5: Focus Mode Enhancements ✅ COMPLETE
**Why last in phase:** Builds on existing focus mode

- [x] Add background image upload
- [x] Store images as base64 data URLs in database (simplified from file-based system)
- [x] Create adjustable overlay window
  - [x] Opacity slider (0-100%, labeled "Background Darkness")
  - [x] Width slider (35%-100%, default 50%)
  - [x] Removed drag-to-reposition (kept centered)
- [x] Add background rotation option (automatic timer-based)
- [x] Create background management UI (modal with thumbnails)
- [x] Implemented typewriter mode scrolling
  - [x] Cursor stays at vertical center (50%) while typing
  - [x] Initial scroll position matches normal editor view
  - [x] Smooth scroll behavior everywhere in document
  - [x] Works when editing beginning, middle, or end

**Testing Passed:**
- ✅ Can upload custom backgrounds (converts to base64)
- ✅ Backgrounds save per-project in database
- ✅ Overlay opacity adjustable (0-100%)
- ✅ Width adjustable (35-100%)
- ✅ Can rotate through backgrounds manually or automatically
- ✅ Typewriter mode keeps cursor centered while typing
- ✅ Smooth scrolling experience

**Implementation Notes:**
- Switched from custom protocol (`mythscribe-asset://`) to base64 data URLs to avoid Electron bundling issues
- Background images stored directly in `project_assets` table as base64 strings
- Typewriter mode uses Slate's `ReactEditor.toDOMRange()` to track cursor position
- Auto-scroll triggers on every change in focus mode to maintain centered cursor
- Large bottom padding (400px) creates visual dark gap below text

**Database Changes:**
- ✅ Added `project_assets` table for images (stores base64 data)
- ✅ Added focus mode settings columns to project metadata:
  - `focus_background_asset_id` - Currently selected background
  - `focus_overlay_opacity` - Darkness level (0-100)
  - `focus_window_width` - Text width percentage (35-100, default 50)
  - `focus_rotation_enabled` - Auto-rotation toggle
  - `focus_rotation_interval` - Rotation interval in minutes

**Files Created:**
- `src/renderer/src/components/Editor/BackgroundManager.tsx` - Background upload/management modal
- `src/renderer/src/components/Editor/FocusModePanel.tsx` - Control panel with sliders

**Files Modified:**
- `src/renderer/src/components/Editor/Editor.tsx` - Typewriter mode implementation, background display, focus mode controls
- `src/main/database.ts` - Assets table, focus settings schema
- `src/main/ipcHandlers.ts` - Background upload (base64 conversion), getBackgrounds, deleteBackground
- `src/main/index.ts` - Removed custom protocol code (simplified architecture)

---

**PHASE 2 CHECKPOINT:** ✅ COMPLETE
- ✅ Novel formatting works
- ✅ Scene metadata functional
- ✅ Stacked scene editing operational
- ✅ UI/UX improvements complete (resizable bar, status bar, swapped panels)
- ✅ Front Matter & End Matter system with 14 templates (Chunk 2.4)
- ✅ Focus mode enhanced with backgrounds and typewriter scrolling (Chunk 2.5)
- **Ready to move to Phase 3: Organization**

---

## 🎯 **PHASE 3: Organization** (Week 3)

### Chunk 3.1: Tagging System Foundation ✅ COMPLETE
**Why first:** Tags used by multiple features

- [x] Create tags database table
- [x] Add tag CRUD operations
- [x] Create TagManager component
- [x] Add tag input to scenes
- [x] Create tag badge UI
- [x] Tag autocomplete (inline #tag syntax)

**Testing Passed:**
- ✅ Can create/edit/delete tags
- ✅ Can apply tags to scenes
- ✅ Tags display properly with colors
- ✅ Category filtering works (character, setting, worldBuilding, tone, content, plot-thread, custom)
- ✅ Tag templates system functional
- ✅ Inline tag autocomplete in editor
- ✅ AI tag suggestions working

**Database Implementation:**
- ✅ `tags` table (id, name, color, category, parent_tag_id, usage_count, created, modified)
- ✅ `document_tags` junction table with position tracking
- ✅ Indexes for performance optimization

**Files Created:**
- `src/renderer/src/components/TagManagerPanel.tsx` - Full tag management UI with categories, search, templates
- `src/renderer/src/components/Editor/InlineTagAutocomplete.tsx` - Autocomplete for #tags in editor

**Files Modified:**
- `src/main/database.ts` - Tags schema, CRUD operations
- `src/main/ipcHandlers.ts` - Tag IPC handlers (create, get, update, delete, add to document)
- `src/renderer/src/components/DocumentTagBox.tsx` - Tag display and document integration
- `src/renderer/src/components/Sidebar/TabbedSidebar.tsx` - Tags tab with TagManagerPanel

---

### Chunk 3.2: Global Search System ⏱️ 5-6 hours
**Why second:** High-value feature

- [ ] Create SearchPanel component
- [ ] Implement full-text search across documents
- [ ] Add search filters (by type, tags, etc.)
- [ ] Search in character/setting/world notes (when ready)
- [ ] Highlight search results
- [ ] Jump to search result

**Testing:**
- Can search across all documents
- Results accurate and fast
- Can navigate to results

**Files to Create/Modify:**
- `src/renderer/src/components/Search/SearchPanel.tsx` (new)
- `src/renderer/src/components/Search/SearchResults.tsx` (new)
- `src/main/database.ts` (add search helper methods)
- Add to View menu

---

### Chunk 3.3: Goals & Progress Tracking ⏱️ 4-5 hours
**Why third:** Motivational feature

- [ ] Create goals database table
- [ ] Create GoalsPanel component
- [ ] Project word count goal
- [ ] Daily word count goal
- [ ] Progress visualization
- [ ] Writing streak tracking
- [ ] Session time tracking

**Testing:**
- Can set goals
- Progress updates in real-time
- Streak tracking accurate

**Database Changes:**
- Add `goals` table
- Add `writing_sessions` table for analytics

**Files to Create/Modify:**
- `src/main/database.ts` (goals schema)
- `src/renderer/src/components/Goals/GoalsPanel.tsx` (new)
- `src/renderer/src/components/Goals/ProgressBar.tsx` (new)
- Add to Tools menu or sidebar

---

### Chunk 3.4: Quick Reference Panel ⏱️ 3-4 hours
**Why fourth:** Nice-to-have productivity boost

- [ ] Create QuickReferencePanel component
- [ ] Pin/unpin functionality
- [ ] Character sheet quick view
- [ ] Setting quick view
- [ ] Reorderable pinned items
- [ ] Image attachment support (prep for Phase 4)

**Testing:**
- Can pin/unpin items
- Quick views load properly
- Reordering works

**Files to Create/Modify:**
- `src/renderer/src/components/QuickReference/QuickReferencePanel.tsx` (new)
- `src/main/database.ts` (add pinned_items table)

---

**PHASE 3 CHECKPOINT:** ✅
- Tagging system works
- Search functional
- Goals tracking active
- Quick reference available
- **Test entire app before moving on**

---

## 📚 **PHASE 4: Characters/Settings/World** (Week 4)

### Chunk 4.1: Database Schema for Entities ⏱️ 2-3 hours
**Why first:** Foundation for all entity types

- [ ] Update database schema
- [ ] Add character fields table
- [ ] Add setting fields table
- [ ] Add world building fields table
- [ ] Template system for structured data

**Database Changes:**
- Expand `reference_docs` table or create separate tables
- Add `entity_fields` table for custom/template fields
- Add `entity_images` table for attachments

**Files to Modify:**
- `src/main/database.ts` (major schema update)
- `src/main/ipcHandlers.ts` (new CRUD operations)

---

### Chunk 4.2: Character Creation System ⏱️ 4-5 hours
**Why second:** Most commonly used entity type

- [ ] Create CharacterCreationModal
- [ ] Template selection (Structured vs Blank)
- [ ] Structured template fields:
  - Name, Age, Gender
  - Physical Appearance
  - Personality
  - Background
  - Goals/Motivations
  - Relationships
  - Notes
  - Image upload
- [ ] Blank page option (freeform notes)
- [ ] Character card view in sidebar

**Testing:**
- Can create characters with template
- Can create blank characters
- Fields save properly
- Characters appear in sidebar

**Files to Create/Modify:**
- `src/renderer/src/components/Characters/CharacterCreationModal.tsx` (new)
- `src/renderer/src/components/Characters/CharacterCard.tsx` (new)
- `src/renderer/src/components/Sidebar/CharactersTab.tsx` (implement)

---

### Chunk 4.3: Settings & World Building ⏱️ 3-4 hours
**Why third:** Similar to characters, reuse components

- [ ] Create SettingCreationModal (similar to Character)
- [ ] Create WorldBuildingCreationModal
- [ ] Implement tabs in sidebar
- [ ] Card/list views

**Testing:**
- Can create settings/world items
- Templates work
- Sidebar display correct

**Files to Create/Modify:**
- `src/renderer/src/components/Settings/SettingCreationModal.tsx` (new)
- `src/renderer/src/components/WorldBuilding/WorldBuildingModal.tsx` (new)
- Sidebar tabs (implement)

---

### Chunk 4.4: Entity Export/Import ⏱️ 3-4 hours
**Why fourth:** Protect user data across projects

- [ ] Export characters to JSON
- [ ] Export settings to JSON
- [ ] Export world building to JSON
- [ ] Import from JSON
- [ ] Merge with existing data
- [ ] Add to File menu

**Testing:**
- Export creates valid JSON
- Import loads data correctly
- No data loss on merge

**Files to Create/Modify:**
- `src/main/ipcHandlers.ts` (export/import methods)
- Add to File menu

---

**PHASE 4 CHECKPOINT:** ✅
- Can create/edit characters
- Can create/edit settings
- Can create/edit world building
- Can export/import entities
- **Test entire app before moving on**

---

## 📄 **PHASE 5: Export & Versions** (Week 5)

### Chunk 5.1: Draft System ⏱️ 5-6 hours
**Why first:** Data structure for versions

- [ ] Add drafts table to database
- [ ] Create draft management UI
- [ ] Switch between drafts
- [ ] Copy draft (duplicate)
- [ ] Compare drafts (basic diff)
- [ ] Revert to draft

**Database Changes:**
- Add `drafts` table (id, name, created, active)
- Add `draft_id` to documents table
- Copy all document data when creating new draft

**Testing:**
- Can create multiple drafts
- Can switch between drafts
- Data stays separate
- Can revert

**Files to Create/Modify:**
- `src/main/database.ts` (drafts schema)
- `src/renderer/src/components/Drafts/DraftManager.tsx` (new)
- Add to File or Tools menu

---

### Chunk 5.2: Snapshot System ⏱️ 3-4 hours
**Why second:** Complement drafts

- [ ] Add snapshots table
- [ ] Manual snapshot creation
- [ ] Snapshot comparison
- [ ] Restore from snapshot
- [ ] Auto-snapshot option (on major milestones)

**Testing:**
- Can create snapshots
- Can compare versions
- Can restore

**Files to Create/Modify:**
- `src/main/database.ts` (snapshots table)
- `src/renderer/src/components/Snapshots/SnapshotManager.tsx` (new)

---

### Chunk 5.3: Export System - PDF ⏱️ 6-8 hours
**Why third:** Most requested format

- [ ] Install `pdfkit` or `jspdf`
- [ ] Create PDF export pipeline
- [ ] Format manuscript for print
- [ ] Include front/back matter
- [ ] Custom export options
- [ ] Progress indicator for large exports

**Testing:**
- PDF exports correctly
- Formatting looks professional
- Large documents export without issues

**Dependencies:**
```bash
npm install pdfkit
npm install @types/pdfkit --save-dev
```

**Files to Create:**
- `src/main/exporters/pdfExporter.ts` (new)
- `src/renderer/src/components/Export/ExportDialog.tsx` (new)

---

### Chunk 5.4: Export System - DOCX & EPUB ⏱️ 6-8 hours
**Why fourth:** Publisher formats

- [ ] Install `docx` library for Word format
- [ ] Install `epub-gen` for EPUB
- [ ] Implement DOCX export
- [ ] Implement EPUB export
- [ ] Add to Export dialog

**Testing:**
- DOCX opens in Word correctly
- EPUB opens in e-readers
- Formatting preserved

**Dependencies:**
```bash
npm install docx
npm install epub-gen
```

**Files to Create:**
- `src/main/exporters/docxExporter.ts` (new)
- `src/main/exporters/epubExporter.ts` (new)

---

### Chunk 5.5: Import System ⏱️ 4-5 hours
**Why last:** Less critical than export

- [ ] Import DOCX
- [ ] Import Markdown
- [ ] Import plain text
- [ ] Smart chapter detection
- [ ] Scene splitting options
- [ ] Add to File menu

**Testing:**
- Can import various formats
- Chapter detection works
- Data imports correctly

**Files to Create:**
- `src/main/importers/docxImporter.ts` (new)
- `src/main/importers/markdownImporter.ts` (new)

---

**PHASE 5 CHECKPOINT:** ✅
- Draft system functional
- Snapshots work
- Can export PDF, DOCX, EPUB
- Can import documents
- **Test entire app before moving on**

---

## 🎨 **PHASE 6: Polish** (Week 6)

### Chunk 6.1: Light Theme ⏱️ 3-4 hours
**Why first:** UI improvement

- [ ] Create light theme CSS
- [ ] Theme switcher in View menu
- [ ] Save theme preference
- [ ] Test all components in light mode

**Files to Create/Modify:**
- `src/renderer/src/styles/themes.css` (new)
- Add theme toggle

---

### Chunk 6.2: Outline System Prep ⏱️ 2-3 hours
**Why second:** Placeholder for future

- [ ] Create Outline tab UI
- [ ] Basic data structure
- [ ] "Coming soon" message
- [ ] Prepare for future cork board implementation

**Files to Create:**
- `src/renderer/src/components/Sidebar/OutlineTab.tsx` (placeholder)

---

### Chunk 6.3: Timeline Prep ⏱️ 2-3 hours
**Why third:** Placeholder for future

- [ ] Create Timeline tab UI
- [ ] Basic data structure
- [ ] "Coming soon" message

**Timeline Integration with Scene Metadata (Future Enhancement):**
- [ ] Replace free-text timeline field in DocumentTagBox with timeline picker
- [ ] Allow selecting position on visual timeline
- [ ] Auto-populate from timeline data
- [ ] Sync timeline position back to scene metadata
- [ ] NOTE: Currently using `timeline_position` TEXT field for free text (e.g., "Day 3, Morning")

**Files to Create:**
- `src/renderer/src/components/Sidebar/TimelineTab.tsx` (placeholder)

---

### Chunk 6.4: Bug Fixes & Optimization ⏱️ Variable
**Why last:** Polish everything

- [ ] Fix any reported bugs
- [ ] Performance optimization
- [ ] User feedback implementation
- [ ] Documentation updates

---

## 🎯 **Success Criteria Per Phase**

**Phase 1:** Can navigate app with menu bar, resize all panels, switch tabs, use docked AI
**Phase 2:** Writing feels like a professional novel editor
**Phase 3:** Can find anything quickly, track progress toward goals
**Phase 4:** Can manage characters/settings/world with templates or freeform
**Phase 5:** Can export polished manuscript, switch between drafts
**Phase 6:** App looks polished, ready for real-world use

---

## ⚠️ **Risk Mitigation**

### Database Migrations
- Always backup before schema changes
- Test migrations on sample data first
- Provide rollback capability

### Large Refactors
- Create feature branches
- Test thoroughly before merging
- Keep old code until new code proven

### Performance
- Profile before optimizing
- Test with large documents (100k+ words)
- Monitor memory usage

---

## 📅 **Timeline Estimates**

### Original Estimate:
- **Total:** ~88-115 hours (3-4 weeks full-time, 6-8 weeks part-time)

### Revised Based on Actual Progress:
- **Phase 1:** ✅ COMPLETE (~15 hours)
- **Phase 2:** ~18 of 23 hours complete (3.5 of 5 chunks done - stacked editing + UI/UX improvements added significant work)
- **Phase 3:** Not started (16-20 hours estimated)
- **Phase 4:** Not started (12-16 hours estimated)
- **Phase 5:** Not started (24-31 hours estimated)
- **Phase 6:** Not started (7-10 hours estimated)

**Completed:** ~33 hours
**Remaining:** ~55-82 hours

---

## 📍 **Current Status & Next Steps**

**✅ Completed:**
- ✅ Phase 1: Complete layout foundation with resizable panels, tabs, AI dock
- ✅ Phase 2: Complete writing experience (ALL chunks done!)
  - ✅ Chunk 2.1: Novel formatting, width constraints, scene breaks
  - ✅ Chunk 2.2: Scene metadata fields with tag integration
  - ✅ Chunk 2.3: Stacked scene editing for chapters/parts
  - ✅ Chunk 2.3b: Major UI/UX improvements (resizable bar, status bar, panel swap)
  - ✅ Chunk 2.4: Front Matter & End Matter system with 14 professional templates
  - ✅ Chunk 2.5: Focus Mode with backgrounds, typewriter scrolling, and controls
- ✅ Phase 3 (Started):
  - ✅ Chunk 3.1: Tagging System Foundation (complete with categories, autocomplete, templates)
- ✅ Bonus: Popup/modal system overhaul, notification system

**⬅️ Next Up: Phase 3, Chunk 3.2 - Global Search System**

**Recommended approach:**
1. Create SearchPanel component with modern UI
2. Implement full-text search across all documents (manuscript, front/end matter)
3. Add search filters (by document type, tags, hierarchy level)
4. Add result highlighting and preview
5. Implement jump-to-result navigation
6. Add keyboard shortcuts (Cmd/Ctrl+F for global search)

**Estimated time:** 5-6 hours

---

**Last Updated:** January 2025 | **Progress:** ~38% complete overall (Phase 1 & 2 complete, Phase 3 started!)
