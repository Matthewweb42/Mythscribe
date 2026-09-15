/**
 * The focus-mode background (F-6.2): a fixed layer behind the editor showing the current image
 * cover-fitted and centred, with a dark scrim over it so the text stays readable. Purely
 * decorative, so it is hidden from assistive technology; the image URL is the one dynamic
 * value plus the darkness, so they are the one inline style. F-6.4 makes the darkness and the column width
 * adjustable; the darkness rides along as a custom property the scrim reads.
 */
import type { CSSProperties } from 'react'

export function FocusBackdrop({
  url,
  darkness
}: {
  url: string
  /** F-6.4: the scrim's opacity in percent (0 shows the image bare, 100 hides it). */
  darkness: number
}): React.JSX.Element {
  return (
    <div
      data-testid="focus-backdrop"
      aria-hidden="true"
      className="focus-backdrop"
      style={
        { backgroundImage: `url("${url}")`, '--ms-focus-darkness': darkness / 100 } as CSSProperties
      }
    />
  )
}
