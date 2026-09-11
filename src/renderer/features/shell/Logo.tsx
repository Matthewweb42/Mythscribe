/**
 * The MythScribe mark: an open book with a quill and sparkles, drawn in `currentColor` so it
 * follows the theme. Replace the paths when a transparent brand asset lands in `resources/`.
 */
export function Logo({
  size = 80,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      role="img"
      aria-label="MythScribe"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* Open book */}
      <path d="M8 46V22c0-1 1-2 2-2 8 0 14 2 22 6v24c-8-4-14-6-22-6-1 0-2-1-2-2Z" />
      <path d="M56 46V22c0-1-1-2-2-2-8 0-14 2-22 6v24c8-4 14-6 22-6 1 0 2-1 2-2Z" />
      <path d="M32 50v-24" />
      <path d="M8 46c0 3 3 4 6 4h36c3 0 6-1 6-4" />
      {/* Page lines */}
      <path d="M15 28c4 0 7 1 11 3M15 34c4 0 7 1 11 3" strokeWidth={1.75} />
      {/* Quill */}
      <path
        d="M36 40c2-10 9-20 20-27-1 9-6 18-13 24-3 2-5 3-7 3Z"
        fill="currentColor"
        stroke="none"
      />
      <path d="M36 40l14-20" strokeWidth={1.5} className="text-surface" />
      {/* Sparkles */}
      <path d="M22 9v6M19 12h6" strokeWidth={2} />
      <path d="M12 16v4M10 18h4" strokeWidth={1.5} />
      <path d="M41 10v4M39 12h4" strokeWidth={1.5} />
    </svg>
  )
}
