import mark from '@renderer/assets/logo-mark.png'

/**
 * The MythScribe mark: the brand tile (open book and star) from `art/Small-Logo.png`, cropped and
 * scaled to 256px in `src/renderer/assets/logo-mark.png`. The wordmark lives in
 * `resources/logo-full.png`; it has a navy "Myth" and is for light surfaces only.
 */
export function Logo({
  size = 80,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <img
      src={mark}
      alt="MythScribe"
      width={size}
      height={size}
      draggable={false}
      className={className}
    />
  )
}
