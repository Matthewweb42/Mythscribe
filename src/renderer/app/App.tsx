import { useEffect } from 'react'
import { FileInput, FolderOpen, FilePlus2, PanelLeft, Settings2 } from 'lucide-react'
import type { AiSource, AiSwitch } from '@shared/aiSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { formatLabel, type HierarchyLevel } from '@shared/labels'
import type { DockPanelId } from '@shared/dock'
import { DEFAULT_THEME, THEME_TOKENS, THEME_TOKEN_VARS, resolveTheme } from '@shared/themes'
import { useAccountStore } from '@renderer/features/account/accountStore'
import { useAppAccessStore } from '@renderer/features/account/appAccessStore'
import { TrialBanner } from '@renderer/features/account/TrialBanner'
import { useBackupStore } from '@renderer/features/backups/backupStore'
import { useCloudSyncStore } from '@renderer/features/project/cloudSyncStore'
import { useDiagnosticsStore } from '@renderer/features/diagnostics/diagnosticsStore'
import { DEVTOOLS_CHORD } from '@shared/devtools'
import { DevToolsPanel } from '@renderer/features/devtools/DevToolsPanel'
import { useDevToolsStore } from '@renderer/features/devtools/devToolsStore'
import { AboutDialog } from '@renderer/features/shell/AboutDialog'
import { DialogHost } from '@renderer/features/shell/dialogs/DialogHost'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { DockColumn, DockPanelControls, DockSlot } from '@renderer/features/shell/Dock'
import { isColumnShown, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { Logo } from '@renderer/features/shell/Logo'
import { MenuBar } from '@renderer/features/shell/MenuBar'
import {
  closeProjectWithConfirm,
  insertLevel,
  openFindInDocument,
  runMenuAction
} from '@renderer/features/shell/menuActions'
import { SettingsDialog } from '@renderer/features/shell/SettingsDialog'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { ShortcutsDialog } from '@renderer/features/shell/ShortcutsDialog'
import { APP_SHORTCUTS, matchesShortcut, type Chord } from '@renderer/features/shell/shortcuts'
import { SidebarSections } from '@renderer/features/shell/SidebarSections'
import { useViewStore } from '@renderer/features/shell/viewStore'
import { BookDetailsDialog } from '@renderer/features/compile/BookDetailsDialog'
import { useBookDetailsStore } from '@renderer/features/compile/bookDetailsStore'
import { CompileDialog } from '@renderer/features/compile/CompileDialog'
import { CompileWindow } from '@renderer/features/compile/CompileWindow'
import { useCompileWindowStore } from '@renderer/features/compile/compileWindowStore'
import { DraftsDialog } from '@renderer/features/drafts/DraftsDialog'
import { useDraftStore } from '@renderer/features/drafts/draftStore'
import { SnapshotsDialog } from '@renderer/features/snapshots/SnapshotsDialog'
import { useSnapshotStore } from '@renderer/features/snapshots/snapshotStore'
import { StatsDialog } from '@renderer/features/stats/StatsDialog'
import { WordCountDialog } from '@renderer/features/stats/WordCountDialog'
import { wheelZoomStepFor, zoomStepFor } from '@renderer/features/shell/zoom'
import { EditorPane } from '@renderer/features/editor/EditorPane'
import { FindBar } from '@renderer/features/editor/FindBar'
import { resetFindStore } from '@renderer/features/editor/findStore'
import { NotesPanel } from '@renderer/features/editor/NotesPanel'
import { TagsColumn, TagsToggleButton } from '@renderer/features/editor/TagsPanel'
import { StackedEditor } from '@renderer/features/editor/StackedEditor'
import { CorkBoard } from '@renderer/features/outline/CorkBoard'
import { SelectionCrumb } from '@renderer/features/shell/SelectionCrumb'
import { useOutlineViewStore } from '@renderer/features/outline/outlineViewStore'
import { useStructureStore } from '@renderer/features/outline/structureStore'
import { usePlanLinksStore } from '@renderer/features/outline/planLinksStore'
import { useTimelineStore } from '@renderer/features/timeline/timelineStore'
import { SpellcheckMenu } from '@renderer/features/editor/SpellcheckMenu'
import { useDictionaryStore } from '@renderer/features/editor/dictionaryStore'
import { useDocumentStore } from '@renderer/features/editor/documentStore'
import { useNotesStore } from '@renderer/features/editor/notesStore'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { useSummaryStore } from '@renderer/features/editor/summaryStore'
import { AiActivityIndicator } from '@renderer/features/ai/AiActivityIndicator'
import { IndexingIndicator } from '@renderer/features/ai/IndexingIndicator'
import { useIndexingStore } from '@renderer/features/ai/indexingStore'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useAuthorRulesStore } from '@renderer/features/ai/authorRulesStore'
import { AssistantPanel, AssistantToggleButton } from '@renderer/features/ai/AssistantPanel'
import { useContinuityStore } from '@renderer/features/ai/continuityStore'
import { useAssistantStore } from '@renderer/features/ai/assistantStore'
import { usePresetsStore } from '@renderer/features/ai/presetsStore'
import { useProvenanceStore } from '@renderer/features/ai/provenanceStore'
import { useVoiceStore } from '@renderer/features/ai/voiceStore'
import { useEditorSettingsStore } from '@renderer/features/editor/settingsStore'
import { FocusBackdrop } from '@renderer/features/focus/FocusBackdrop'
import { FocusControlBar } from '@renderer/features/focus/FocusControlBar'
import { FocusFloatingPanels } from '@renderer/features/focus/FocusFloatingPanels'
import { BackgroundRotation } from '@renderer/features/focus/rotation'
import { OVERLAY_DARKNESS } from '@shared/focus'
import { useBackgroundStore, useCurrentBackground } from '@renderer/features/focus/backgroundStore'
import { escapeFocusMode, useFocusStore } from '@renderer/features/focus/focusStore'
import { ImportDialog } from '@renderer/features/import/ImportDialog'
import { useImportStore } from '@renderer/features/import/importStore'
import { EntityCreateDialog } from '@renderer/features/entities/EntityCreateDialog'
import { CategoryCreateDialog } from '@renderer/features/entities/CategoryCreateDialog'
import { useCategoryStore } from '@renderer/features/entities/categoryStore'
import { EntityImportDialog } from '@renderer/features/entities/EntityImportDialog'
import { ContextUploadDialog } from '@renderer/features/library/ContextUploadDialog'
import { OrganiseDialog } from '@renderer/features/organise/OrganiseDialog'
import { useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { DropOverlay } from '@renderer/features/library/DropOverlay'
import { useLibraryStore } from '@renderer/features/library/libraryStore'
import { EntityEditor } from '@renderer/features/entities/EntityEditor'
import { EditPassReport } from '@renderer/features/editPass/EditPassReport'
import { useEditPassStore } from '@renderer/features/editPass/editPassStore'
import { useEditPassViewStore } from '@renderer/features/editPass/editPassViewStore'
import { EditPassWorkspace } from '@renderer/features/editPass/EditPassWorkspace'
import { useEntityStore } from '@renderer/features/entities/entityStore'
import { useFactStore } from '@renderer/features/entities/factStore'
import { useChangesStore } from '@renderer/features/changes/changesStore'
import {
  ReferencePanel,
  ReferencesToggleButton
} from '@renderer/features/references/ReferencePanel'
import { useReferenceStore } from '@renderer/features/references/referenceStore'
import { GoalsDialog } from '@renderer/features/goals/GoalsDialog'
import { useGoalsStore } from '@renderer/features/goals/goalsStore'
import { ReplaceDialog } from '@renderer/features/search/ReplaceDialog'
import { useReplaceStore } from '@renderer/features/search/replaceStore'
import { SearchButton, SearchDialog } from '@renderer/features/search/SearchDialog'
import { useSearchStore } from '@renderer/features/search/searchStore'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDocumentTagStore } from '@renderer/features/tags/documentTagStore'
import { useMentionStore } from '@renderer/features/tags/mentionStore'
import { useKeptSpellingStore } from '@renderer/features/tags/keptSpellingStore'
import { useProposedTagStore } from '@renderer/features/tags/proposedTagStore'
import { useTagStore } from '@renderer/features/tags/tagStore'
import { UpdateNotice } from '@renderer/features/updates/UpdateNotice'
import { useUpdateStore } from '@renderer/features/updates/updateStore'
import { CreateProjectWizard } from '@renderer/features/project/CreateProjectWizard'
import { RecentProjects } from '@renderer/features/project/RecentProjects'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { installSaveOnBlur } from '@renderer/features/project/saveOnBlur'
import { useSessionStore } from '@renderer/features/project/sessionStore'
import { useWelcomeStore } from '@renderer/features/project/welcomeStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

export function App(): React.JSX.Element {
  const ready = useProjectStore((s) => s.ready)
  const current = useProjectStore((s) => s.current)
  const projectId = current?.id ?? null

  useEffect(() => {
    useProjectStore
      .getState()
      .init()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-7.2: the panel layout is app-wide; it loads once here, before any project opens.
    useLayoutStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-1.4: the OS close button flushes pending saves first; a failed flush keeps the window
    // open with the error visible so no words are lost.
    const offClose = ipc().on('window:close-requested', () => {
      const store = useProjectStore.getState()
      if (store.busy) return // a flush is already in flight; the first request will close the window
      store.closeWindow().catch((err: unknown) => toast.error(describeError(err)))
    })
    // F-6.1: focus mode follows the window's real fullscreen state.
    const offFocus = useFocusStore.getState().subscribe()
    // F-7.1: a native menu click or accelerator runs the same action as the in-app bar.
    const offMenu = ipc().on('menu:action', ({ id }) => {
      void runMenuAction(id)
    })
    // F-15.2: the MythScribe account is app-wide, not per project, and main pushes the status
    // when a pending sign-in link is opened or expires, so the subscription is opened once here
    // rather than by the Settings tab, which is only mounted while the dialog is open.
    const offAccount = useAccountStore.getState().subscribe()
    void useAccountStore.getState().load()
    // F-15.9: the Supporter license is a local cache, so it is read at start whether anyone is
    // signed in or not; main pushes it again after a background refresh, a sign-in, or a sign-out.
    void useAccountStore.getState().loadSupporter()
    // AI-BILLING-SPEC M1: the trial or the license, app-wide; main pushes it when the trial ends
    // or a license is verified or dropped.
    const offAccess = useAppAccessStore.getState().subscribe()
    useAppAccessStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-7.10: the document zoom is app-wide and the editor multiplies the project's formatting by
    // it, so it is read here — before any project opens, which is before an editor mounts — and
    // the writing surface is at the author's level on its first paint. (The interface size is
    // already on the window: main applied it before the first frame.)
    useViewStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-15.7: updates are app-wide too, and main pushes the state from the background check and
    // the download, so the subscription is opened here once rather than by the Settings tab.
    const offUpdates = useUpdateStore.getState().subscribe()
    // F-15.8: diagnostics are app-wide as well, and main pushes the state after a report is sent,
    // so the subscription is opened here once rather than by the Settings tab.
    const offDiagnostics = useDiagnosticsStore.getState().subscribe()
    // Developer tools (2026-10-07): app-wide too; main pushes the switch, new log entries, and
    // AI request rows, so the subscription is opened here once.
    const offDevTools = useDevToolsStore.getState().subscribe()
    // F-8.4: backups are app-wide, and main pushes the state after a scheduled or on-close
    // backup (a failure is toasted once), so the subscription is opened here once as well.
    const offBackups = useBackupStore.getState().subscribe()
    // 2026-10-08: the working copy of a project in a cloud-synced folder; main pushes each copy.
    const offCloudSync = useCloudSyncStore.getState().subscribe()
    // F-8.3: leaving the window writes every pending save at once, not after the debounce.
    const offBlur = installSaveOnBlur()
    return () => {
      offBlur()
      offClose()
      offFocus()
      offMenu()
      offAccount()
      offAccess()
      offUpdates()
      offDiagnostics()
      offDevTools()
      offBackups()
      offCloudSync()
    }
  }, [])

  // F-1.5: the OS window title names the app once and then the open project's file, as
  // Scrivener does, so the in-app header carries neither the logo nor the app name.
  useEffect(() => {
    document.title = current ? `MythScribe — ${current.path}` : 'MythScribe'
  }, [current])

  // F-15.9: the Supporter accent is app-wide, so it rides on <html> and `tokens.css` swaps the
  // three accent variables from there. The default is the stock green already in `:root`, so it
  // is the absence of the attribute rather than a value of its own.
  const accent = useAccountStore((s) => s.supporter?.accent ?? 'default')
  useEffect(() => {
    if (accent === 'default') delete document.documentElement.dataset.accent
    else document.documentElement.dataset.accent = accent
  }, [accent])

  // F-7.8: the theme is app-wide too. The built-in block is picked by `data-theme` (Dark is
  // `:root` itself, so the attribute's absence), `data-scheme` picks the accent shades that read
  // on it, and a custom theme's eight colours go on as inline variables over its base. A locked
  // or deleted choice resolves to Dark here while main keeps it stored.
  const theme = useViewStore((s) => s.theme)
  const customThemes = useViewStore((s) => s.customThemes)
  const supporterLicensed = useAccountStore((s) => s.supporter?.licensed === true)
  useEffect(() => {
    const resolved = resolveTheme({ theme, customThemes }, supporterLicensed)
    const root = document.documentElement
    if (resolved.base.id === DEFAULT_THEME) delete root.dataset.theme
    else root.dataset.theme = resolved.base.id
    root.dataset.scheme = resolved.base.scheme
    root.style.colorScheme = resolved.base.scheme
    for (const token of THEME_TOKENS) {
      const name = THEME_TOKEN_VARS[token]
      if (resolved.overrides) root.style.setProperty(name, resolved.overrides[token])
      else root.style.removeProperty(name)
    }
  }, [theme, customThemes, supporterLicensed])

  // F-2.1: the document tree follows the open project. App owns when it loads and clears, keyed
  // on the project id so a refreshed `ProjectInfo` for the same project does not reload it.
  // F-3.1: the loaded document goes with it. F-3.6: so do the formatting settings. F-3.7: and
  // the loaded notes (the panel layout is app-wide, F-7.2, so it stays). F-4.2: and the tag
  // bank, whose failure toasts on its own and never blocks the tree. F-4.4: and the document
  // tag links, loaded per document by the tag bar. F-4.12: and the recorded mentions, loaded by
  // the tag bar and the tag detail and refreshed from main's `mention:changed`. F-4.5: and the scene metadata, loaded per
  // node by the metadata pane. F-14.4: and the AI dial and toggles. F-5.2: and the writing
  // presets. F-14.2: and the author rules. F-14.1: and the voice exemplars (the toolbar button needs the count). F-14.6: the
  // provenance report is loaded by its section on demand and only cleared here. F-5.4: and the
  // assistant conversations. F-5.13: and the background index queue's status, which the header
  // indicator shows. F-6.1: a project closed in focus mode leaves it, so the welcome
  // screen is windowed. F-6.2: and the focus-mode backgrounds. F-9.6: and the reference pins.
  // F-1.7: the session restores once the tree, the story bible, and the tag bank are in; on
  // close it stops recording first, so leaving focus mode and emptying the tree are not moves.
  useEffect(() => {
    const tree = useTreeStore.getState()
    if (projectId === null) {
      useSessionStore.getState().clear()
      const focus = useFocusStore.getState()
      if (focus.active) void focus.exit()
      tree.clear()
      useDocumentStore.getState().clear()
      useNotesStore.getState().clear()
      useSceneMetaStore.getState().clear()
      useSummaryStore.getState().clear()
      useIndexingStore.getState().clear()
      useEditorSettingsStore.getState().clear()
      useAiSettingsStore.getState().clear()
      useAuthorRulesStore.getState().clear()
      usePresetsStore.getState().clear()
      // F-11.1b: and the structure template.
      useStructureStore.getState().clear()
      // F-11.2: and the timeline events.
      useTimelineStore.getState().clear()
      // F-11.1d: and the plan-link suggestions the Outline tab loaded.
      usePlanLinksStore.getState().clear()
      useVoiceStore.getState().clear()
      useProvenanceStore.getState().clear()
      useAssistantStore.getState().clear()
      useContinuityStore.getState().clear()
      // F-14.15: the edit passes, their reports, and the workspace belong to the project that closed.
      useEditPassStore.getState().clear()
      // F-7.1: a shell dialog left open over the closing project must not reappear over the next one.
      useShellDialogStore.getState().close()
      // F-12.2: a draft under review belongs to the project it would be written into.
      useImportStore.getState().cancel()
      useTagStore.getState().clear()
      useOrganiseStore.getState().clear()
      useEntityStore.getState().clear()
      // F-9.11: the project's categories go with its sheets.
      useCategoryStore.getState().clear()
      // F-9.8: the Library and any upload under review belong to the project that closed.
      useLibraryStore.getState().clear()
      useFactStore.getState().clear()
      // F-9.13: the Changes log belongs to the project that closed.
      useChangesStore.getState().clear()
      useReferenceStore.getState().clear()
      // F-10.3: the goals, and the dialog if it was open.
      useGoalsStore.getState().clear()
      // F-10.1: the search dialog and its last answer belong to the project that closed.
      useSearchStore.getState().reset()
      // F-10.2: and so do the replace dialog, its preview, and the offer to undo.
      useReplaceStore.getState().reset()
      useDocumentTagStore.getState().clear()
      useMentionStore.getState().clear()
      useProposedTagStore.getState().clear()
      // F-4.14: the kept spellings belong to the project that closed.
      useKeptSpellingStore.getState().clear()
      useBackgroundStore.getState().clear()
      useDictionaryStore.getState().clear()
      // F-8.5: the drafts belong to the project that closed.
      useDraftStore.getState().clear()
      // F-8.6: and so do the snapshots.
      useSnapshotStore.getState().clear()
      // F-12.4: and so do the compile choices, the shown format, any run in flight, and the
      // Book details.
      useCompileWindowStore.getState().clear()
      useBookDetailsStore.getState().clear()
      // F-3.10: the find bar and what was typed in it.
      resetFindStore()
      return
    }
    // F-4.12: main scans in the background and says which documents changed; the mention lists
    // are fetched by the views that show them, so only the subscription is opened here.
    useMentionStore.getState().subscribe()
    // F-4.13: the background job links and unlinks tags on its own; main says which nodes moved.
    useDocumentTagStore.getState().subscribe()
    // F-4.12b: the proposed names are one app-wide list main pushes on when a scan, a tag, or a
    // dismissal moves it; the tag bar shows the ones its own document carries.
    useProposedTagStore.getState().subscribe()
    // F-9.4: an entity write may create or rename a tag; the bank hears about it here rather than
    // reloading the list.
    useTagStore.getState().subscribe()
    // F-5.16: the story-bible job creates entities and logs facts in the background; the tabs and
    // the open page hear about both here.
    useEntityStore.getState().subscribe()
    useFactStore.getState().subscribe()
    // F-9.13: the background reading logs what it applied; the Changes section lists it.
    useChangesStore.getState().subscribe()
    useChangesStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useProposedTagStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    const treeLoaded = tree.load()
    treeLoaded.catch((err: unknown) => toast.error(describeError(err)))
    // F-12.4: the "Include in compile" ticks, which the binder's right-click menu shows.
    useCompileWindowStore
      .getState()
      .ensureState()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-9.8: the Library tab's files.
    useLibraryStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useEditorSettingsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useAiSettingsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useAuthorRulesStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    usePresetsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-11.1b: the structure template the Outline tab and the metadata pane read.
    useStructureStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-11.2: the timeline events the Timeline tab and the metadata pane's picker read.
    useTimelineStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useVoiceStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useAssistantStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useIndexingStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-13.4: the open continuity findings, for the quiet count on the assistant panel; main
    // says when a background or on-demand check changed them.
    useContinuityStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-14.15: the edit passes (the Edit reports list) and main's pass events.
    useEditPassStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    const tagsLoaded = useTagStore.getState().load()
    tagsLoaded.catch((err: unknown) => toast.error(describeError(err)))
    // F-9.2: the story bible loads beside the tag bank; the entity tabs read it, and the session
    // (F-1.7) checks a restored entity page against it.
    const entitiesLoaded = useEntityStore.getState().load()
    entitiesLoaded.catch((err: unknown) => toast.error(describeError(err)))
    // F-9.11: the story-bible categories, which the section picker and every sheet read.
    useCategoryStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    void useSessionStore.getState().load(Promise.all([treeLoaded, tagsLoaded, entitiesLoaded]))
    // F-9.6: the pins of the quick reference panel; the cards read the stores above.
    useReferenceStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    useBackgroundStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-10.3: the goals and today's words, for the status strip and the tree's targets.
    useGoalsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-3.11: the project's spelling dictionary, for the Settings list; main already synced the
    // spellchecker itself when the project opened.
    useDictionaryStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-8.5: the drafts, for the status bar's label; a project that never used drafts gets its
    // first one on this call.
    useDraftStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
    // F-8.6: the snapshots, so the dialog opens on a list.
    useSnapshotStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [projectId])

  // F-6.1: focus mode hides the header with the rest of the chrome; the header's shortcut
  // listeners (Ctrl+, / Ctrl+K / Insert) go with it, `FocusShortcuts` stays so F11 and Escape
  // are always a way out.
  const focus = useFocusStore((s) => s.active) && current !== null
  // F-6.2: the current background sits behind the editor in focus mode; `isolate` keeps the
  // fixed layer under the main pane's content.
  const background = useCurrentBackground()
  const darkness = useBackgroundStore(
    (s) => s.settings?.overlay.darkness ?? OVERLAY_DARKNESS.default
  )

  return (
    <div className="flex h-full flex-col">
      {focus ? null : (
        // The welcome screen's bar is only Settings (and an update notice) at the right; the
        // menus live in the native menu (Alt) until a project is open.
        <header
          className={`flex h-11 items-center gap-2 px-4 text-sm ${current ? 'border-b border-line bg-surface' : ''}`}
        >
          {current ? (
            <>
              <SidebarToggleButton />
              <MenuBar />
              <span className="text-fg-muted">
                <span data-testid="project-name">{current.name}</span> ·{' '}
                {formatLabel(current.format)}
              </span>
              <SelectionCrumb format={current.format} />
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {current ? (
              <>
                <AiActivityIndicator />
                <IndexingIndicator />
                <SearchButton />
                <ReferencesToggleButton />
                <TagsToggleButton />
                <AssistantToggleButton />
              </>
            ) : null}
            <UpdateNotice />
            <SettingsButton />
            {current ? <CloseProjectButton /> : null}
          </div>
        </header>
      )}
      {/* M1: the trial's last week, and the read-only state after it. */}
      {focus ? null : <TrialBanner />}
      {current ? <FocusShortcuts /> : null}
      <SettingsShortcut />
      <DevToolsShortcut />
      <ZoomShortcuts />
      {current ? <InsertShortcuts format={current.format} /> : null}
      {current ? <SearchShortcut /> : null}
      {current ? <FindShortcuts /> : null}
      <main
        className={
          current
            ? 'isolate flex min-h-0 flex-1 overflow-hidden'
            : 'flex flex-1 items-center justify-center overflow-auto'
        }
      >
        {focus && background ? <FocusBackdrop url={background.url} darkness={darkness} /> : null}
        {focus ? <BackgroundRotation /> : null}
        {!ready ? null : current ? <ProjectScreen format={current.format} /> : <WelcomeScreen />}
        {focus ? <FocusControlBar /> : null}
      </main>
      {/* F-12.2: the import review, which is open only while a draft is under review. */}
      <ImportDialog />
      {/* The dialog service last, so a confirm from inside a shell dialog stacks above it. */}
      <ShellDialogs format={current?.format ?? null} />
      <DialogHost />
      {/* F-3.11: the spelling menu, after the dialogs so it opens above their text fields too. */}
      {current ? <SpellcheckMenu /> : null}
      {/* Developer tools: a drawer over the bottom of the window, only while the switch is on. */}
      <DevToolsPanel />
    </div>
  )
}

/**
 * The app-level dialogs (F-7.1): Settings (F-7.5; without a project only its app-wide tabs,
 * F-15.2), the shortcuts reference (F-7.7), About, the word count (F-10.4), the statistics
 * (F-10.5), the compiled preview (F-3.12), the drafts (F-8.5), the snapshots (F-8.6), and the
 * compile window and Book details (F-12.4), one at a time
 * from the shell dialog store, which the header button, Ctrl+, the in-app bar, and the native
 * menu all open through.
 */
function ShellDialogs({ format }: { format: NovelFormat | null }): React.JSX.Element | null {
  const open = useShellDialogStore((s) => s.open)
  const close = useShellDialogStore((s) => s.close)
  // F-15.5: an opener may name the tab (the low-credit notice opens Account).
  const settingsTab = useShellDialogStore((s) => s.settingsTab)
  switch (open) {
    case 'settings':
      return <SettingsDialog format={format} onClose={close} initialTab={settingsTab} />
    case 'shortcuts':
      return <ShortcutsDialog onClose={close} />
    case 'about':
      return <AboutDialog onClose={close} />
    case 'wordCount':
      // F-10.4: counts the open project, so it shows only while one is open.
      return format ? <WordCountDialog format={format} onClose={close} /> : null
    case 'statistics':
      // F-10.5: reads the open project, so it shows only while one is open.
      return format ? <StatsDialog onClose={close} /> : null
    case 'compile':
      // F-3.12: reads the open project, so it shows only while one is open.
      return format ? <CompileDialog format={format} onClose={close} /> : null
    case 'drafts':
      // F-8.5: the open project's drafts, so it shows only while one is open.
      return format ? <DraftsDialog onClose={close} /> : null
    case 'snapshots':
      // F-8.6: the open project's snapshots, so it shows only while one is open.
      return format ? <SnapshotsDialog onClose={close} /> : null
    case 'compileWindow':
      // F-12.4: compiles the open project, so it shows only while one is open.
      return format ? <CompileWindow onClose={close} /> : null
    case 'bookDetails':
      return format ? <BookDetailsDialog onClose={close} /> : null
    case null:
      return null
  }
}

function WelcomeScreen(): React.JSX.Element {
  const busy = useProjectStore((s) => s.busy)
  const create = useProjectStore((s) => s.create)
  const open = useProjectStore((s) => s.open)
  const recents = useProjectStore((s) => s.recents)
  const loadRecents = useProjectStore((s) => s.loadRecents)
  const removeRecent = useProjectStore((s) => s.removeRecent)
  // F-7.1: File › New project opens the wizard through the store; a reopened welcome screen
  // starts on the buttons again.
  const creating = useWelcomeStore((s) => s.creating)
  const setCreating = useWelcomeStore((s) => s.setCreating)
  // F-15.11: the wizard's Cloud option says who is signed in; the account is app-wide.
  const account = useAccountStore((s) => s.status)
  const importing = useImportStore((s) => s.busy)

  useEffect(() => {
    loadRecents().catch((err: unknown) => toast.error(describeError(err)))
  }, [loadRecents])
  useEffect(() => () => setCreating(false), [setCreating])

  /** Failures propagate: the wizard shows them inline where the author is looking. */
  const onCreate = async (
    name: string,
    format: NovelFormat,
    aiSource: AiSource,
    aiSwitch: AiSwitch,
    contextPaths: string[]
  ): Promise<void> => {
    const info = await create(name, format, undefined, aiSource, aiSwitch)
    if (!info) return
    toast.success(`Created "${info.name}"`)
    // F-9.8: the wizard's worldbuilding files go into the new project's Library, and from there
    // to the estimate and the review, as if they had been added from the Library tab.
    if (contextPaths.length > 0) {
      useLibraryStore
        .getState()
        .add(contextPaths)
        .catch((err: unknown) => toast.error(describeError(err)))
    }
    // F-5.18: a project created with AI on arrives in the assisted workflow, the assistant panel
    // open (the chat in the project's mode, Ask for a new project). Only a new
    // project does this; opening an existing one leaves the layout as the author left it.
    const layout = useLayoutStore.getState()
    if (aiSwitch !== 'off' && !layout.layout.assistant.open) {
      layout.toggle('assistant')
    }
  }

  /** Opens via the native dialog, or a recent project when `path` is given. */
  const onOpen = async (path?: string): Promise<void> => {
    try {
      const info = await open(path)
      if (info) toast.success(`Opened "${info.name}"`)
    } catch (err) {
      toast.error(describeError(err))
      // A vanished folder gets re-marked "Not found" on refresh.
      loadRecents().catch((e: unknown) => toast.error(describeError(e)))
    }
  }

  const onRemoveRecent = async (path: string): Promise<void> => {
    try {
      await removeRecent(path)
    } catch (err) {
      toast.error(describeError(err))
    }
  }

  return (
    <div
      className={`flex flex-col items-center gap-6 text-center ${creating ? 'w-[520px]' : 'w-[440px]'}`}
    >
      <div className="flex flex-col items-center">
        <Logo />
        <h1 className="m-0 mt-3 text-3xl font-semibold tracking-tight">MythScribe</h1>
        <p className="mt-2 mb-0 text-sm text-fg-muted">Your book, your voice, on your machine.</p>
      </div>
      {creating ? (
        <CreateProjectWizard
          busy={busy}
          signedInEmail={account?.state === 'signedIn' ? account.email : null}
          onCancel={() => setCreating(false)}
          onCreate={onCreate}
        />
      ) : (
        <div className="flex w-full flex-col gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setCreating(true)}
            className="flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-60"
          >
            <FilePlus2 size={16} /> New project
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onOpen()}
            className="flex items-center justify-center gap-2 rounded-md border border-line bg-surface px-4 py-2.5 hover:bg-surface-raised disabled:opacity-60"
          >
            <FolderOpen size={16} /> Open project
          </button>
          {/* F-12.2: import to start — the review dialog names the project, Import creates it. */}
          <button
            type="button"
            disabled={busy || importing}
            onClick={() => void useImportStore.getState().open()}
            className="flex items-center justify-center gap-2 rounded-md border border-line bg-surface px-4 py-2.5 hover:bg-surface-raised disabled:opacity-60"
          >
            <FileInput size={16} /> Import manuscript…
          </button>
          <RecentProjects
            recents={recents}
            busy={busy}
            onOpen={(path) => void onOpen(path)}
            onRemove={(path) => void onRemoveRecent(path)}
          />
        </div>
      )}
    </div>
  )
}

/** Header action: confirms, then closes the open project (everything is already saved); File › Close project does the same. */
function CloseProjectButton(): React.JSX.Element {
  const busy = useProjectStore((s) => s.busy)

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void closeProjectWithConfirm()}
      className="rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface-raised disabled:opacity-60"
    >
      Close project
    </button>
  )
}

/** Header action (F-7.2): shows or hides the sidebar; `aria-pressed` reflects whether it is open. */
function SidebarToggleButton(): React.JSX.Element {
  const open = useLayoutStore((s) => s.layout.sidebar.open)
  const toggle = useLayoutStore((s) => s.toggle)
  return (
    <button
      type="button"
      aria-label="Sidebar"
      title="Sidebar"
      aria-pressed={open}
      onClick={() => toggle('sidebar')}
      className="-ml-1.5 rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:text-fg"
    >
      <PanelLeft size={16} aria-hidden="true" />
    </button>
  )
}

const INSERT_CHORDS: [Chord, HierarchyLevel][] = [
  [APP_SHORTCUTS.insertScene.chord, 'scene'],
  [APP_SHORTCUTS.insertChapter.chord, 'chapter'],
  [APP_SHORTCUTS.insertPart.chord, 'part']
]

/**
 * Insert shortcuts (F-2.7): Ctrl+Shift+S / C / P create a scene, chapter, or part relative to
 * the current selection through `insertLevel`, which the Insert menu (F-7.1) shares. The
 * listener runs in the capture phase and stops the event, so the editor never sees the chord
 * (its own Mod-Shift-S is strikethrough). Mounted only while a project is open; renders
 * nothing.
 */
function InsertShortcuts({ format }: { format: NovelFormat }): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const hit = INSERT_CHORDS.find(([chord]) => matchesShortcut(event, chord))
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      insertLevel(hit[1], format)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [format])
  return null
}

/**
 * Ctrl+Shift+F opens the project search (F-10.1) and Ctrl+Shift+H find and replace (F-10.2). Like `InsertShortcuts` the listener runs in
 * the capture phase and stops the event, so the chord works with the caret in the editor and
 * nothing inside the page handles it a second time; `preventDefault` also keeps the native
 * accelerator (Edit › Search project…) from firing for the same key press, and opening is
 * idempotent in any case. Mounted while a project is open, outside the header, so it works in
 * focus mode; renders nothing.
 */
function SearchShortcut(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const search = matchesShortcut(event, APP_SHORTCUTS.search.chord)
      if (!search && !matchesShortcut(event, APP_SHORTCUTS.replaceProject.chord)) return
      event.preventDefault()
      event.stopPropagation()
      // One of the two at a time: each is a modal over the same screen.
      if (search) {
        useReplaceStore.getState().close()
        useSearchStore.getState().openSearch()
      } else {
        useSearchStore.getState().close()
        useReplaceStore.getState().openReplace()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return null
}

/**
 * Ctrl+F opens find in document and Ctrl+H find and replace in document (F-3.10), through the
 * same `openFindInDocument` as Edit › Find… / Replace…. Capture phase and stopped, like
 * `SearchShortcut`, so the editor never sees the chord and `preventDefault` keeps the native
 * accelerator from firing a second time. Mounted while a project is open, focus mode included;
 * renders nothing.
 */
function FindShortcuts(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const find = matchesShortcut(event, APP_SHORTCUTS.find.chord)
      if (!find && !matchesShortcut(event, APP_SHORTCUTS.replace.chord)) return
      event.preventDefault()
      event.stopPropagation()
      openFindInDocument(!find)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])
  return null
}

/**
 * Focus mode shortcuts (F-6.1): F11 toggles it; Escape leaves it, but only when nothing closer
 * to the keystroke claimed the key (the dialogs and popups handle their own Escape and prevent
 * default), so the listener runs in the bubble phase. Inside the editor ProseMirror prevents
 * default on every Escape, so there the editor's own `EscapeShortcut` hands a bare Escape to
 * `escapeFocusMode` and this listener sees it as claimed: one exit either way. Mounted only
 * while a project is open, outside the header, so it survives the chrome being hidden;
 * renders nothing.
 */
function FocusShortcuts(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchesShortcut(event, APP_SHORTCUTS.focusMode.chord)) {
        event.preventDefault()
        void useFocusStore.getState().toggle()
      } else if (event.key === 'Escape' && !event.defaultPrevented) {
        escapeFocusMode()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return null
}

/**
 * Ctrl+, (Cmd+, on macOS) opens the Settings dialog (F-7.5), on the welcome screen too (F-15.2:
 * the Account tab is app-wide); it sits beside `FocusShortcuts`, outside the header, so it works
 * in focus mode too (F-7.1). Renders nothing.
 */
function SettingsShortcut(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (matchesShortcut(event, APP_SHORTCUTS.settings.chord)) {
        event.preventDefault()
        useShellDialogStore.getState().show('settings')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return null
}

/**
 * Ctrl+Shift+D (Cmd+Shift+D on macOS) opens or closes the developer panel while developer tools
 * are on (2026-10-07); while they are off the chord is left alone. Renders nothing.
 */
function DevToolsShortcut(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!matchesShortcut(event, DEVTOOLS_CHORD)) return
      const store = useDevToolsStore.getState()
      if (!store.enabled) return
      event.preventDefault()
      store.togglePanel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
  return null
}

/**
 * Document zoom input (F-7.10): Ctrl+= / Ctrl+- / Ctrl+0 and Ctrl+wheel scale the writing
 * surface through the same `zoomDocument` the View menu runs. Both listeners run in the capture
 * phase and stop the event, so nothing inside the page sees the chord or scrolls under the
 * wheel, and `preventDefault` is also what keeps the native accelerator — the menu's fallback
 * for a key the page ignored — from stepping a second time, and Chromium's own Ctrl+wheel page
 * zoom from running in parallel. The wheel needs `{ passive: false }` for that. One wheel notch
 * is one step: `wheelZoomStepFor` drops the deltas that follow a step, because a notch (and a
 * trackpad pinch, which arrives as Ctrl+wheel) emits several. Mounted always, beside
 * `SettingsShortcut`, so the welcome screen and focus mode zoom too; renders nothing.
 */
function ZoomShortcuts(): null {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const step = zoomStepFor(event)
      if (!step) return
      event.preventDefault()
      event.stopPropagation()
      void useViewStore.getState().zoomDocument(step)
    }
    let lastWheelAt: number | null = null
    const onWheel = (event: WheelEvent): void => {
      // Every Ctrl+wheel is the zoom's, even the ones inside a burst: the page must not scroll
      // and the browser must not zoom itself while the author is stepping the document.
      if (!event.ctrlKey || event.altKey || event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      const now = Date.now()
      const step = wheelZoomStepFor(event, now, lastWheelAt)
      if (!step) return
      lastWheelAt = now
      void useViewStore.getState().zoomDocument(step)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('wheel', onWheel, true)
    }
  }, [])
  return null
}

/** Header action (F-7.5): opens the Settings dialog, which `ShellDialogs` renders. */
function SettingsButton(): React.JSX.Element {
  const show = useShellDialogStore((s) => s.show)
  return (
    <button
      type="button"
      aria-label="Settings"
      title="Settings (Ctrl+,)"
      onClick={() => show('settings')}
      className="rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg"
    >
      <Settings2 size={16} aria-hidden="true" />
    </button>
  )
}

/**
 * The project screen as dockable columns (layout 3c, author request 2026-10-06): the layout
 * store's `dock` lists the columns left to right, each holding the sidebar (F-7.3: the tabbed
 * sidebar whose Manuscript tab holds the document tree), the editor (the main pane: the selected
 * document, a folder's stack or cork board, or an entity page), the notes (F-3.7), the tags, the
 * references (F-9.6), or the assistant (F-5.4), or several side panels stacked. A column whose
 * panels are all closed is not rendered; a side column is as wide as its first open panel and
 * resizes from the edge facing the editor (`DockColumn`); the editor column takes the rest. Every
 * panel's grip and menu move it (`DockPanelControls`). F-6.1: focus mode hides every column but
 * the editor without touching the layout store, so they come back as they were on exit. F-6.5 /
 * F-6.6: in focus mode the notes and the assistant follow the focus store's own flags (the
 * control bar toggles them; both close on exit) and float as windows over the editor instead.
 */
function ProjectScreen({ format }: { format: NovelFormat }): React.JSX.Element {
  const layout = useLayoutStore((s) => s.layout)
  const focus = useFocusStore((s) => s.active)
  const nodeId = useMainNodeId()
  // Every non-root node carries tags; a section root is never selectable, but the guard keeps a
  // stray id from asking main for links it refuses.
  const taggable = useTreeStore((s) =>
    nodeId === null ? false : (s.byId[nodeId]?.parentId ?? null) !== null
  )
  const render = (id: DockPanelId): React.ReactNode => {
    switch (id) {
      case 'sidebar':
        return <SidebarPanel format={format} />
      case 'notes':
        return <NotesPanel id={nodeId} />
      case 'tags':
        return <TagsColumn id={taggable ? nodeId : null} />
      case 'references':
        return <ReferencePanel />
      case 'assistant':
        return <AssistantPanel />
      case 'editor':
        return null
    }
  }
  // One keyed list in and out of focus mode, so the editor column is never remounted by it.
  const shown = focus
    ? [['editor' as const]]
    : layout.dock.columns.filter((column) => isColumnShown(layout, column))
  const editorAt = shown.findIndex((column) => column.includes('editor'))
  return (
    <>
      {shown.map((column, index) =>
        column.includes('editor') ? (
          <EditorColumn key="editor" format={format} />
        ) : (
          <DockColumn
            key={column.join(' ')}
            column={column}
            side={index < editorAt ? 'right' : 'left'}
            render={render}
          />
        )
      )}
      {focus ? <FocusFloatingPanels /> : null}
      {/* F-9.3: the entity creation dialog, open while a kind is being created. */}
      <EntityCreateDialog />
      <CategoryCreateDialog />
      {/* F-9.5: the entity import review, open only while a plan is under review. */}
      <EntityImportDialog />
      {/* F-9.8: the context library's estimate, progress, and review, open while it sorts. */}
      <ContextUploadDialog />
      <OrganiseDialog />
      {/* F-9.8: files dropped anywhere on the window go to the Library. */}
      <DropOverlay />
      {/* F-10.1: the project search, open while the search store says so. */}
      <SearchDialog />
      {/* F-10.2: find and replace across documents, open while the replace store says so. */}
      <ReplaceDialog />
      {/* F-10.3: the Goals dialog, open while the goals store says so. */}
      <GoalsDialog />
    </>
  )
}

/**
 * The sidebar as a dock panel (F-7.3): a slim row with its grip and menu above the tabs, so it
 * moves like any panel without a title taking room from the tree.
 */
function SidebarPanel({ format }: { format: NovelFormat }): React.JSX.Element {
  return (
    <aside className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="flex shrink-0 items-center justify-end px-1 pt-1">
        <DockPanelControls id="sidebar" />
      </div>
      <SidebarSections format={format} />
    </aside>
  )
}

/**
 * The editor's column: the main pane with the dock grip and menu (layout 3c) floating in a 12 px
 * strip over its top-left corner, inside the toolbar's own left padding, so the editor moves like
 * the panels without giving up a pixel of width or a row above the text. Focus mode drops them.
 */
function EditorColumn({ format }: { format: NovelFormat }): React.JSX.Element {
  const focus = useFocusStore((s) => s.active)
  return (
    <section className="flex min-w-0 flex-1 overflow-hidden">
      <DockSlot id="editor" first>
        {focus ? null : (
          <div className="absolute top-1.5 left-0 z-20 flex w-3 flex-col items-center">
            <DockPanelControls id="editor" vertical />
          </div>
        )}
        <MainPane format={format} />
      </DockSlot>
    </section>
  )
}

/**
 * The node the manuscript shows in the main pane, which the notes and tags columns follow: the
 * selected document or folder, or null while an entity page (F-9.3) or nothing is selected.
 */
function useMainNodeId(): string | null {
  const entityId = useEntityStore((s) => s.selectedId)
  // F-14.15: the Edits workspace or a report takes the pane like an entity page does.
  const editView = useEditPassViewStore((s) => s.view)
  return useTreeStore((s) =>
    entityId === null &&
    editView === null &&
    s.selectedId !== null &&
    s.byId[s.selectedId] !== undefined
      ? s.selectedId
      : null
  )
}

function MainPane({ format }: { format: NovelFormat }): React.JSX.Element {
  const focus = useFocusStore((s) => s.active)
  // F-9.3: an entity picked in a tab takes the whole pane; selecting a document closes it again
  // (`treeStore.select`), so the manuscript comes back exactly where it was.
  const entityId = useEntityStore((s) => s.selectedId)
  const node = useTreeStore((s) => (s.selectedId === null ? undefined : s.byId[s.selectedId]))
  const folderView = useOutlineViewStore((s) => s.folderView)
  // F-14.15: the Edits workspace or a pass's report; picking a document or an entity closes it.
  const editView = useEditPassViewStore((s) => s.view)
  if (editView?.kind === 'workspace') return <EditPassWorkspace />
  if (editView?.kind === 'report')
    return <EditPassReport key={editView.passId} passId={editView.passId} />
  if (entityId !== null) return <EntityEditor key={entityId} id={entityId} />
  if (!node) {
    // F-3.5: the empty state, centered in the pane.
    return (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="empty-state">
        <p className="m-0 text-sm text-fg-muted">Select a document to start writing.</p>
      </div>
    )
  }
  // F-11.1: a folder shows as a stack of its documents or as a cork board of its children; focus
  // mode is for writing, so it always gets the stack and hides the switch.
  const folder = node.kind === 'folder'
  const cork = folder && folderView === 'cork' && !focus
  return (
    // F-3.10: the find bar docks above the editor's toolbar, so it hides no control and never
    // spans the columns beside it.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <FindBar />
      <div className="flex min-h-0 min-w-0 flex-1">
        {!folder ? (
          <EditorPane id={node.id} format={format} />
        ) : cork ? (
          <CorkBoard folderId={node.id} format={format} />
        ) : (
          <StackedEditor folderId={node.id} format={format} />
        )}
      </div>
    </div>
  )
}
