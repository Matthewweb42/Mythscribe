# MythScribe Implementation Plan

**Strategic build order to avoid conflicts and ensure smooth development**

**Last Updated:** October 2025
**Current Phase:** Phase 2 - Writing Experience (~40% complete)

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

### Chunk 2.3: Document Compilation View ⏱️ 4-5 hours ⬅️ **NEXT**
**Why third:** Show compiled chapter/scene views with metadata

**Features:**
- [ ] Create CompileView component
- [ ] Chapter/Part compile: Show all child scenes with metadata headers
- [ ] Scene compile: Show scene with metadata header
- [ ] Separate notes for chapters/parts vs scenes
- [ ] Add "Compile View" toggle button
- [ ] Style compiled output like a manuscript
- [ ] Scene breaks between compiled scenes (use user's configured style)
- [ ] Collapsible metadata headers in compile view

**Chapter/Part Notes:**
- [ ] When folder (chapter/part) selected + notes open → show folder notes
- [ ] When scene selected + notes open → show scene notes
- [ ] Notes are independent for each document level
- [ ] Notes panel already supports this (uses document.notes field)

**Compile View Structure:**
```
─────────────────────────────
Scene: [Scene Name]
Location: [Location tag]
POV: [POV character]
Timeline: [Position]
─────────────────────────────
[Scene content...]

* * *  (scene break)

─────────────────────────────
Scene: [Next Scene Name]
...
```

**Testing:**
- [ ] Chapter view shows all child scenes with headers
- [ ] Scene view shows metadata
- [ ] Formatting looks professional
- [ ] Notes panel shows correct notes for document level
- [ ] Can toggle between compile view and edit mode
- [ ] Scene breaks render with user's configured style

**Files to Create/Modify:**
- `src/renderer/src/components/Editor/CompileView.tsx` (new)
- `src/renderer/src/components/Editor/Editor.tsx` (add compile mode)
- `src/renderer/src/components/Sidebar/ManuscriptTab.tsx` (detect folder selection)

---

### Chunk 2.4: Document Templates ⏱️ 3-4 hours
**Why fourth:** Quick document creation

- [ ] Create template system
- [ ] Add template selection to document creation
- [ ] Templates:
  - Title Page (front matter)
  - Copyright Page (front matter)
  - Dedication (front matter)
  - Acknowledgments (back matter)
  - About the Author (back matter)
  - Scene (with metadata fields)
  - Chapter (with auto-numbering)

**Testing:**
- Can create documents from templates
- Templates populate correctly
- Chapter numbering works

**Files to Create/Modify:**
- `src/renderer/src/templates/documentTemplates.ts` (new)
- `src/renderer/src/components/Sidebar/ManuscriptTab.tsx` (add template picker)

---

### Chunk 2.5: Focus Mode Enhancements ⏱️ 5-6 hours
**Why last in phase:** Builds on existing focus mode

- [ ] Add background image upload
- [ ] Store images per-project (in project folder or database)
- [ ] Create adjustable overlay window
  - Opacity slider (0-100%)
  - Width slider (40%-100%)
  - Drag to reposition
- [ ] Add background rotation option
- [ ] Create background management UI

**Testing:**
- Can upload custom backgrounds
- Backgrounds save per-project
- Overlay window adjustable
- Can rotate through backgrounds

**Database Changes:**
- Add `project_assets` table for images
- Add `focus_settings` columns to project metadata

**Files to Modify:**
- `src/renderer/src/components/Editor/Editor.tsx` (focus mode upgrades)
- `src/main/database.ts` (add assets table)
- `src/main/ipcHandlers.ts` (add file upload handler)

---

**PHASE 2 CHECKPOINT:** ✅
- Novel formatting works
- Scene metadata functional
- Compile view operational
- Templates available
- Focus mode enhanced
- **Test entire app before moving on**

---

## 🎯 **PHASE 3: Organization** (Week 3)

### Chunk 3.1: Tagging System Foundation ⏱️ 4-5 hours
**Why first:** Tags used by multiple features

- [ ] Create tags database table
- [ ] Add tag CRUD operations
- [ ] Create TagManager component
- [ ] Add tag input to scenes
- [ ] Create tag badge UI
- [ ] Tag autocomplete

**Testing:**
- Can create/edit/delete tags
- Can apply tags to scenes
- Tags display properly

**Database Changes:**
- Add `tags` table (id, name, color, category)
- Add `document_tags` junction table

**Files to Create/Modify:**
- `src/main/database.ts` (tags schema)
- `src/renderer/src/components/Tags/TagManager.tsx` (new)
- `src/renderer/src/components/Tags/TagInput.tsx` (new)
- `src/renderer/src/components/Editor/SceneMetadata.tsx` (integrate tags)

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
- **Phase 2:** ~8 of 23 hours complete (2 of 5 chunks done)
- **Phase 3:** Not started (16-20 hours estimated)
- **Phase 4:** Not started (12-16 hours estimated)
- **Phase 5:** Not started (24-31 hours estimated)
- **Phase 6:** Not started (7-10 hours estimated)

**Completed:** ~23 hours
**Remaining:** ~65-92 hours

---

## 📍 **Current Status & Next Steps**

**✅ Completed:**
- Phase 1: Complete layout foundation with resizable panels, tabs, AI dock
- Phase 2 (partial): Novel formatting, width constraints, scene breaks
- Bonus: Popup/modal system overhaul, notification system

**⬅️ Next Up: Phase 2, Chunk 2.2 - Scene Metadata Fields**

**Recommended approach:**
1. Add database columns for location, time, POV
2. Create SceneMetadata component (collapsible bar above editor)
3. Integrate with Editor component (show only for scenes)
4. Test with existing scenes

**Estimated time:** 3-4 hours

---

**Last Updated:** October 2025 | **Progress:** ~20% complete overall
