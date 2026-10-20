/**
 * QuickPayLogo — Quick Pay brand mark.
 * Lightning bolt in electric blue→cyan→violet on a deep navy tile.
 * Sharp at any size. No icon library dependency.
 */

interface Props {
  size?: number
  iconOnly?: boolean
  className?: string
}

export function QuickPayLogo({ size = 36, iconOnly = false, className = '' }: Props) {
  const id = 'qpl'
  return (
    <div className={`flex items-center gap-2.5 select-none ${className}`}>
      {/* ── Icon tile ── */}
      <svg
        width={size}
        height={size}
        viewBox="0 0 44 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Quick Pay"
        role="img"
        style={{ flexShrink: 0 }}
      >
        <defs>
          {/* Tile gradient */}
          <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="44" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stopColor="#0d2248" />
            <stop offset="100%" stopColor="#071530" />
          </linearGradient>
          {/* Bolt gradient */}
          <linearGradient id={`${id}-bolt`} x1="10" y1="5" x2="34" y2="40" gradientUnits="userSpaceOnUse">
            <stop offset="0%"    stopColor="#4e9bff" />
            <stop offset="45%"   stopColor="#0de8ff" />
            <stop offset="100%"  stopColor="#9d78fb" />
          </linearGradient>
          {/* Glow blur */}
          <filter id={`${id}-glow`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="3.5" result="blur" />
          </filter>
          {/* Border gradient */}
          <linearGradient id={`${id}-border`} x1="0" y1="0" x2="44" y2="44" gradientUnits="userSpaceOnUse">
            <stop offset="0%"   stopColor="#4e9bff" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#9d78fb" stopOpacity="0.35" />
          </linearGradient>
        </defs>

        {/* Tile background */}
        <rect width="44" height="44" rx="13" fill={`url(#${id}-tile)`} />

        {/* Inner glow ring */}
        <rect x="0.75" y="0.75" width="42.5" height="42.5" rx="12.35"
          stroke={`url(#${id}-border)`} strokeWidth="1.5" fill="none" />

        {/* Subtle top highlight */}
        <rect x="6" y="1" width="32" height="2" rx="1"
          fill="white" fillOpacity="0.06" />

        {/* Bolt glow layer */}
        <path
          d="M25 7L14 24.5H21.5L18 37L30 19.5H22.5L25 7Z"
          fill={`url(#${id}-bolt)`}
          filter={`url(#${id}-glow)`}
          opacity="0.7"
        />
        {/* Bolt sharp */}
        <path
          d="M25 7L14 24.5H21.5L18 37L30 19.5H22.5L25 7Z"
          fill={`url(#${id}-bolt)`}
        />
      </svg>

      {/* ── Wordmark ── */}
      {!iconOnly && (
        <div className="flex flex-col leading-none">
          <span
            className="display font-bold tracking-tight"
            style={{ fontSize: '15px', color: 'var(--ink)', letterSpacing: '-0.04em' }}
          >
            Quick Pay
          </span>
          <span
            style={{
              fontSize: '9px',
              letterSpacing: '0.14em',
              fontWeight: 600,
              textTransform: 'uppercase',
              background: 'var(--grad-brand)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            USDC · ARC
          </span>
        </div>
      )}
    </div>
  )
}
