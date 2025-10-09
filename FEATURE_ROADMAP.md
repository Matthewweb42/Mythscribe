# MythScribe Feature Roadmap

This document outlines all planned features for MythScribe, organized by priority and implementation phase.

---

## 🎯 **Phase 1: Core UI/UX Improvements** (CURRENT)

### 1.1 Menu Bar System
- [ ] Top menu bar (File, Edit, Insert, View, Tools, Help)
- [ ] File menu: New, Open, Save, Export, Import
- [ ] Edit menu: Undo, Redo, Cut, Copy, Paste, Find
- [ ] Insert menu: Scene, Chapter, Part, Character, Setting, etc.
- [ ] View menu: Toggle panels, Focus mode, Themes
- [ ] Tools menu: Word count, Statistics, AI Settings
- [ ] Help menu: Documentation, About

### 1.2 Resizable Panel System
- [ ] Implement drag handles between all panels
- [ ] Minimum/maximum size constraints
- [ ] Save panel sizes per project
- [ ] Reset to default layout option

### 1.3 Enhanced Sidebar Organization
**Tabbed Navigation:** Manuscript | Characters | Settings | World Building | Outline | Timeline

**Within each tab - Collapsible sections:**
- **Manuscript Tab:**
  - Novel hierarchy (Parts → Chapters → Scenes)
  - Word count per item

- **Characters Tab:**
  - Character list/grid view
  - Quick add button
  - Search/filter

- **Settings Tab:**
  - Location list/grid view
  - Quick add button
  - Search/filter

- **World Building Tab:**
  - Custom categories
  - Quick add button
  - Search/filter

- **Outline Tab:** (Placeholder for Phase 3)
  - Cork board view prep
  - Outline tree prep

- **Timeline Tab:** (Placeholder for Phase 4)
  - Timeline view prep
  - Event list prep

### 1.4 Docked AI Assistant Panel
- [ ] Bottom-right docked panel (toggleable)
- [ ] Collapsible/expandable
- [ ] Multiple AI modes:
  - **Chat**: General conversation and questions
  - **Generate**: Directed story generation (current)
  - **Edit**: Writing augmentation and improvements
  - **Ask**: Names, ideas, thesaurus, readability stats
- [ ] Mode switcher tabs
- [ ] Persistent across sessions

---

## 📝 **Phase 2: Writing Experience Enhancements**

### 2.1 Novel-Style Formatting (Default)
- [ ] No gaps between paragraphs
- [ ] First-line indent (0.5in / 1.27cm)
- [ ] Double-spacing option (1.5x or 2x line height)
- [ ] Serif font default (Georgia/Garamond)
- [ ] Justified text option
- [ ] Configurable in settings (per-project defaults)

### 2.2 Document Compilation & Templates
- [ ] **Auto Chapter Titles**: Chapter name → header on compile
- [ ] **Scene Compile View**: Show single scene with metadata:
  - Location field
  - Time field
  - POV field
  - Tags (clickable/editable)
- [ ] **Chapter Compile View**: All scenes combined with chapter header
- [ ] **Document Templates**:
  - Front matter: Title Page, Copyright, Dedication
  - Back matter: Acknowledgments, About the Author
  - Scene template with metadata fields
  - Chapter template with auto-numbering

### 2.3 Focus Mode Enhancements
- [ ] **Custom Background Upload**:
  - File picker dialog
  - Per-project storage
  - Image preview
  - Multiple backgrounds per project
  - Optional rotation between backgrounds
- [ ] **Adjustable Overlay Window**:
  - Black overlay with adjustable opacity (0-100%)
  - Adjustable width (40%-100% of screen)
  - Centered writing area
  - Drag to reposition window
- [ ] Background management UI in Focus mode

---

## 🎨 **Phase 3: Organization & Productivity**

### 3.1 Tagging System
- [ ] Tag creation and management
- [ ] Central tag library/manager
- [ ] Tag colors/categories
- [ ] Apply tags to:
  - Scenes
  - Characters
  - Settings
  - World building items
- [ ] Filter by tags
- [ ] Tag-based search
- [ ] Bulk tag operations
- [ ] Tag statistics (usage count)

### 3.2 Search & Find System
- [ ] **Global Search**:
  - Search across all documents
  - Search in character notes
  - Search in settings/world building
  - Search by tags
- [ ] **Find & Replace**:
  - Current document
  - Selected documents
  - All documents
  - Regex support
  - Case sensitive option
- [ ] **Quick Find**:
  - Find character mentions
  - Find location usage
  - Find tag occurrences

### 3.3 Goals & Targets
- [ ] **Project Goals**:
  - Total word count target
  - Completion date goal
  - Progress visualization (bar/percentage)
- [ ] **Daily Goals**:
  - Daily word count target
  - Writing streak tracking
  - Daily stats popup
- [ ] **Chapter/Scene Targets**:
  - Individual scene word targets
  - Chapter word targets
  - Progress indicators in sidebar
- [ ] **Session Tracking**:
  - Words written this session (already done)
  - Time writing today
  - Average words per hour

### 3.4 Quick Reference Panel
- [ ] Pinnable notes/references
- [ ] Quick-access sidebar
- [ ] Character sheet quick view
- [ ] Setting/location quick view
- [ ] Image attachments:
  - Character portraits
  - Location maps
  - Inspiration images
- [ ] Drag to reorder pinned items

---

## 📦 **Phase 4: Advanced Features**

### 4.1 Character/Setting/World Building Templates
**Each item can use:**
- **Pre-made Templates** (structured fields):
  - **Character Template**:
    - Name, Age, Gender
    - Physical Appearance
    - Personality Traits
    - Background/History
    - Goals/Motivations
    - Relationships
    - Notes
    - Image upload

  - **Setting Template**:
    - Name, Type (city, building, etc.)
    - Description
    - Atmosphere/Mood
    - Important Features
    - Associated Characters
    - Notes
    - Image upload

  - **World Building Template**:
    - Category (Magic System, Culture, Technology, etc.)
    - Name
    - Description
    - Rules/Laws
    - Impact on Story
    - Notes

- **Blank Page** (custom freeform notes)

### 4.2 Version Control & Snapshots
- [ ] **Draft System**:
  - Multiple draft versions (Draft 1, Draft 2, Final, etc.)
  - Switch between drafts
  - All drafts stored in same project file
  - Visual diff between drafts
  - Revert to previous draft
  - Draft-specific metadata
- [ ] **Snapshots**:
  - Manual snapshot creation
  - Auto-snapshots on milestones
  - Snapshot comparison (diff view)
  - Restore from snapshot
  - Snapshot notes/descriptions

### 4.3 Export System
- [ ] **Export Formats**:
  - PDF (formatted for printing)
  - DOCX (Word format for agents/publishers)
  - EPUB (e-reader format)
  - Markdown (plain text backup)
- [ ] **Export Options**:
  - Export entire manuscript
  - Export selected chapters
  - Export single document
  - Custom formatting during export
  - Include/exclude front/back matter
- [ ] **Import System**:
  - Import DOCX
  - Import Markdown
  - Import plain text
  - Smart chapter/scene detection

### 4.4 Character/Setting/World Building Export
- [ ] Export character database to JSON/CSV
- [ ] Export settings database
- [ ] Export world building database
- [ ] Import from other projects
- [ ] Merge character databases
- [ ] Reusable character library across projects

---

## 🎨 **Phase 5: Polish & Enhancement**

### 5.1 Theme System
- [ ] Dark theme (current/default)
- [ ] Light theme
- [ ] High contrast theme
- [ ] Sepia/e-reader theme
- [ ] Custom color schemes
- [ ] Per-panel theme override
- [ ] Easy CSS switching system

### 5.2 Outlining System (Detailed)
- [ ] Cork board/index card view
- [ ] Drag & drop cards
- [ ] Card colors by status
- [ ] Synopsis per scene card
- [ ] Outline tree view
- [ ] Hierarchical bullet points
- [ ] Plot thread tracking
- [ ] Act/beat structure templates

### 5.3 Timeline & Continuity
- [ ] Visual timeline of story events
- [ ] Character age tracker
- [ ] Date/time tracking
- [ ] Season tracker
- [ ] Event placement
- [ ] Continuity checker
- [ ] Character appearance log
- [ ] Location usage log

---

## 📊 **Phase 6: Analytics & Future**

### 6.1 Statistics Dashboard (Later)
- [ ] Writing heatmap (calendar view)
- [ ] Words per day graph
- [ ] Most productive times
- [ ] Project timeline
- [ ] Character appearance frequency
- [ ] Scene length distribution
- [ ] POV distribution

### 6.2 Backup System (Later)
- [ ] Auto-backup to folder
- [ ] Configurable backup frequency
- [ ] Backup location selection
- [ ] Backup retention policy
- [ ] Cloud sync option (Dropbox, Google Drive)
- [ ] Encrypted backups
- [ ] Backup reminders

### 6.3 Collaboration Features (Later)
- [ ] Comments/annotations
- [ ] Track changes
- [ ] Share scenes with beta readers
- [ ] Export with comments
- [ ] Revision suggestions

### 6.4 Mobile Companion (Later)
- [ ] Quick notes on phone
- [ ] Sync to desktop app
- [ ] Voice notes with transcription
- [ ] Mobile reading mode

---

## 🔧 **Technical Improvements**

### Database Schema Updates
- [ ] Add `tags` table
- [ ] Add `drafts` table
- [ ] Add `snapshots` table
- [ ] Add `templates` table
- [ ] Add `timeline_events` table
- [ ] Add `goals` table
- [ ] Add `character_fields` table
- [ ] Add `setting_fields` table
- [ ] Add `world_building_fields` table
- [ ] Migration system for schema updates

### Performance Optimizations
- [ ] Lazy loading for large documents
- [ ] Virtual scrolling for long lists
- [ ] Debounced auto-save (already done)
- [ ] Indexed database queries
- [ ] Caching frequently accessed data

### Code Quality
- [ ] Component refactoring
- [ ] Shared style system
- [ ] Reusable UI components
- [ ] Better error handling
- [ ] Loading states
- [ ] User feedback (toasts/notifications)

---

## 📋 **Implementation Notes**

### Current Status
✅ Completed in Initial Build:
- Database schema (Novel → Part → Chapter → Scene)
- Hierarchical navigation sidebar
- Rich text editor with formatting
- Word/character count tracking
- Notes system with split view
- Full-screen focus mode
- AI writing assistant
- Auto-save functionality

### Priority Order
1. **Phase 1**: Foundation (Menu bar, Resizable panels, Enhanced sidebar, Docked AI)
2. **Phase 2**: Core writing experience (Formatting, Templates, Focus mode upgrades)
3. **Phase 3**: Organization (Tags, Search, Goals, Reference panel)
4. **Phase 4**: Advanced features (Templates, Versions, Export, Import)
5. **Phase 5**: Polish (Themes, Outlining, Timeline)
6. **Phase 6**: Future enhancements (Analytics, Backups, Collaboration)

### Dependencies
- Phase 2 depends on Phase 1 (need menu bar and proper layout)
- Phase 3 can run parallel to Phase 2
- Phase 4 depends on Phase 1 & 2 (export needs proper formatting)
- Phase 5 can be implemented incrementally
- Phase 6 is long-term roadmap

---

## 🎯 **Success Metrics**

### User Experience
- Can create and organize novel structure in < 5 minutes
- Can format manuscript to industry standards automatically
- Can find any scene/character/note in < 10 seconds
- Can export print-ready manuscript in < 30 seconds
- Can switch between drafts without data loss

### Performance
- App starts in < 3 seconds
- Document loads in < 500ms
- Auto-save doesn't interrupt typing
- Search returns results in < 1 second
- Supports novels up to 200,000 words smoothly

### Reliability
- No data loss (auto-save + backups)
- Graceful error handling
- Database corruption prevention
- Version migration without breaking changes

---

**Last Updated:** 2025-01-09
**Version:** 1.0 (Initial Roadmap)
