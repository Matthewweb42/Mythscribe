/**
 * The focus-mode background (F-6.2): a fixed layer behind the editor showing the current image
 * cover-fitted and centred, with a dark scrim over it so the text stays readable. Purely
 * decorative, so it is hidden from assistive technology; the image URL is the one dynamic
 * value, so it is the one inline style. F-6.4 makes the darkness and the column width
 * adjustable.
 */
export function FocusBackdrop({ url }: { url: string }): React.JSX.Element {
  return (
    <div
      data-testid="focus-backdrop"
      aria-hidden="true"
      className="focus-backdrop"
      style={{ backgroundImage: `url("${url}")` }}
    />
  )
}
