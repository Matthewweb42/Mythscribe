import { UploadReviewPanel } from '@renderer/features/library/ContextUploadDialog'
import { OrganisePanel } from '@renderer/features/organise/OrganisePanel'
import { SideWorkPlaceContext, useShownSideWork } from './sideWork'

/**
 * The big review dialog (F-7.12): Organise's plan or the upload's review on the full-size deck
 * in the middle of the window, opened by a drop notification's Open. The same screens as in
 * the assistant column (`AssistantBody`), framed as a window by `SideWorkFrame`; it shows over
 * focus mode too, and hiding it returns to writing. Mounted once with the project screen.
 */
export function SideWorkDialog(): React.JSX.Element | null {
  const work = useShownSideWork('dialog')
  if (work === null) return null
  return (
    <SideWorkPlaceContext.Provider value="dialog">
      {work === 'organise' ? <OrganisePanel /> : <UploadReviewPanel />}
    </SideWorkPlaceContext.Provider>
  )
}
