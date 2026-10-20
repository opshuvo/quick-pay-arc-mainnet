/**
 * ScreenLayout — shared header + scroll wrapper for all non-Dashboard screens.
 * Sticky sub-header spans full page width with a centered inner column.
 * Content uses .app-col for responsive centering.
 */

import { ArrowLeft } from 'lucide-react'

interface Props {
  title: string
  subtitle?: string
  onBack: () => void
  /** Extra element placed at the right of the header bar */
  action?: React.ReactNode
  children: React.ReactNode
  /** Extra className on the scrollable content wrapper */
  contentClassName?: string
}

export function ScreenLayout({
  title, subtitle, onBack, action, children, contentClassName = '',
}: Props) {
  return (
    <div className="flex flex-col">
      {/* ── Sticky sub-header ─────────────────────────────────────────────── */}
      <div
        className="sticky z-30 w-full"
        style={{
          top: 'var(--header-h)',
          background: 'rgba(5,12,24,0.95)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          borderBottom: '1px solid rgba(78,155,255,0.10)',
        }}
      >
        {/* Inner centered column */}
        <div className="flex items-center gap-3 app-col py-3">
          <button
            onClick={onBack}
            className="flex size-9 shrink-0 items-center justify-center rounded-[11px] transition-all active:scale-90 hover:brightness-110"
            style={{
              background: 'rgba(78,155,255,0.12)',
              border: '1px solid rgba(78,155,255,0.20)',
              color: 'var(--blue)',
            }}
            aria-label="Go back"
          >
            <ArrowLeft className="size-4" strokeWidth={2.2} />
          </button>

          <div className="flex-1 min-w-0">
            <h1
              className="display font-bold leading-tight truncate"
              style={{ fontSize: '1.05rem', color: 'var(--ink)', letterSpacing: '-0.03em' }}
            >
              {title}
            </h1>
            {subtitle && (
              <p className="text-[11px] truncate mt-px" style={{ color: 'var(--muted)' }}>
                {subtitle}
              </p>
            )}
          </div>

          {action && <div className="shrink-0">{action}</div>}
        </div>
      </div>

      {/* ── Scrollable content ────────────────────────────────────────────── */}
      <div className={`app-col pt-4 pb-nav space-y-4 ${contentClassName}`}>
        {children}
      </div>
    </div>
  )
}

/** Compact empty-state for wallet-not-connected screens */
export function EmptyWalletState({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center py-16 text-center gap-4 px-6">
      <div
        className="flex size-16 items-center justify-center rounded-[20px]"
        style={{
          background: 'linear-gradient(135deg, rgba(78,155,255,0.14) 0%, rgba(157,120,251,0.10) 100%)',
          border: '1px solid rgba(78,155,255,0.24)',
          boxShadow: '0 4px 20px rgba(78,155,255,0.10)',
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
          stroke="var(--blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 12V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v5"/>
          <path d="M2 14h20M2 14v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3"/>
          <circle cx="16" cy="17" r="1" fill="var(--blue)" stroke="none"/>
        </svg>
      </div>
      <p className="text-sm max-w-[200px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        {message ?? 'Connect your wallet to continue.'}
      </p>
    </div>
  )
}
