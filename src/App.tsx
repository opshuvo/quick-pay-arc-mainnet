/**
 * Quick Pay — Arc Mainnet USDC Payment App
 * Chain ID: 5042 | USDC: 0x3600000000000000000000000000000000000000
 *
 * Transactions on Arc Mainnet involve real USDC and are irreversible.
 * Always verify addresses, amounts and network before confirming.
 */

import { useState, useEffect } from 'react'
import { ConnectKitButton } from 'connectkit'
import {
  LayoutGrid, ArrowUpRight, QrCode, ScanLine, Clock, HelpCircle,
} from 'lucide-react'

import { Dashboard }        from '@/components/Dashboard'
import { SendSheet }        from '@/components/SendSheet'
import { ReceiveSheet }     from '@/components/ReceiveSheet'
import { ScanPay }          from '@/components/ScanPay'
import { PaymentRequests }  from '@/components/PaymentRequests'
import { History as HistoryView } from '@/components/History'
import { SavedRecipients }  from '@/components/SavedRecipients'
import { AIAssistant }      from '@/components/AIAssistant'
import { NetworkGuard }     from '@/components/NetworkGuard'
import { QuickPayLogo }     from '@/components/QuickPayLogo'
import { BridgeSheet }      from '@/components/BridgeSheet'
import { SplitPayment }     from '@/components/SplitPayment'
import { decodePaymentURI } from '@/utils'

export type Tab =
  | 'dashboard' | 'send' | 'receive' | 'scan'
  | 'history'   | 'assistant' | 'recipients' | 'requests'
  | 'bridge'    | 'split'

const PRIMARY_NAV: {
  tab: Tab
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  label: string
}[] = [
  { tab: 'dashboard', icon: LayoutGrid,   label: 'Home'    },
  { tab: 'send',      icon: ArrowUpRight, label: 'Send'    },
  { tab: 'receive',   icon: QrCode,       label: 'Receive' },
  { tab: 'scan',      icon: ScanLine,     label: 'Scan'    },
  { tab: 'history',   icon: Clock,        label: 'History' },
  { tab: 'assistant', icon: HelpCircle,   label: 'Help'    },
]

const PRIMARY_TABS = new Set<Tab>(['dashboard','send','receive','scan','history','assistant'])

interface SendPrefill { to?: string; amount?: string; note?: string }

export default function App() {
  const [tab, setTab]               = useState<Tab>('dashboard')
  const [sendPrefill, setSendPrefill] = useState<SendPrefill | undefined>()

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    const p   = new URLSearchParams(window.location.search)
    const req = p.get('req')
    if (req) {
      try {
        const decoded = decodePaymentURI(decodeURIComponent(req))
        if (decoded?.to) {
          setSendPrefill({ to: decoded.to, amount: decoded.amount, note: decoded.note })
          setTab('send')
        }
      } catch { /* ignore malformed */ }
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  function handleScanResult(r: { to: string; amount?: string; note?: string }) {
    setSendPrefill(r)
    setTab('send')
  }

  function handleSendTo(address: string) {
    setSendPrefill({ to: address })
    setTab('send')
  }

  function renderContent() {
    switch (tab) {
      case 'dashboard':  return <Dashboard onNavigate={setTab} />
      case 'send':       return <SendSheet onBack={() => setTab('dashboard')} prefill={sendPrefill} />
      case 'receive':    return <ReceiveSheet onBack={() => setTab('dashboard')} />
      case 'scan':       return <ScanPay onBack={() => setTab('dashboard')} onScanned={handleScanResult} />
      case 'requests':   return <PaymentRequests onBack={() => setTab('dashboard')} />
      case 'history':    return <HistoryView onBack={() => setTab('dashboard')} />
      case 'recipients': return <SavedRecipients onBack={() => setTab('dashboard')} onSendTo={handleSendTo} />
      case 'assistant':  return <AIAssistant onBack={() => setTab('dashboard')} />
      case 'bridge':     return <BridgeSheet onBack={() => setTab('dashboard')} />
      case 'split':      return <SplitPayment onBack={() => setTab('dashboard')} />
    }
  }

  const isDashboard  = tab === 'dashboard'
  const activeNavTab: Tab = PRIMARY_TABS.has(tab) ? tab : 'dashboard'

  return (
    <div
      className="min-h-dvh flex flex-col"
      style={{
        background: '#050c18',
        backgroundImage: 'radial-gradient(ellipse 80% 40% at 50% 0%, rgba(78,155,255,0.12) 0%, transparent 60%), radial-gradient(ellipse 60% 30% at 100% 100%, rgba(157,120,251,0.07) 0%, transparent 60%)',
      }}
    >
      {/* ── App header ──────────────────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-40 w-full"
        style={{
          height: 'var(--header-h)',
          background: 'rgba(5,12,24,0.96)',
          backdropFilter: 'blur(28px)',
          WebkitBackdropFilter: 'blur(28px)',
          borderBottom: '1px solid rgba(78,155,255,0.10)',
          boxShadow: '0 1px 0 rgba(0,0,0,0.40)',
        }}
      >
        {/* Inner centered column — aligns with content */}
        <div className="app-col flex items-center justify-between h-full">
        <button onClick={() => setTab('dashboard')} className="outline-none -ml-0.5">
          <QuickPayLogo size={36} />
        </button>

        <div className="flex items-center gap-2">
          {/* Live network pill */}
          <div
            className="hidden sm:flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={{
              background: 'rgba(34,217,135,0.08)',
              border: '1px solid rgba(34,217,135,0.18)',
              color: 'var(--success)',
            }}
          >
            <span
              className="size-1.5 rounded-full pulse-dot"
              style={{ background: 'var(--success)', boxShadow: '0 0 6px var(--success)' }}
            />
            Arc Mainnet
          </div>

          <ConnectKitButton
            label="Connect"
            customTheme={{
              '--ck-font-family':                   "'DM Sans', sans-serif",
              '--ck-connectbutton-background':       'rgba(78,155,255,0.14)',
              '--ck-connectbutton-color':            '#eef3ff',
              '--ck-connectbutton-border-radius':    '12px',
              '--ck-connectbutton-font-size':        '13px',
              '--ck-connectbutton-font-weight':      '600',
              '--ck-connectbutton-hover-background': 'rgba(78,155,255,0.24)',
              '--ck-connectbutton-box-shadow':       '0 0 0 1px rgba(78,155,255,0.22)',
              '--ck-primary-button-background':      '#4e9bff',
              '--ck-primary-button-color':           '#fff',
              '--ck-body-background':                '#07111f',
              '--ck-body-background-secondary':      '#0c1e35',
              '--ck-body-color':                     '#f0f6ff',
              '--ck-body-color-muted':               '#5a7a9f',
              '--ck-modal-box-shadow':               '0 32px 80px rgba(0,0,0,0.95)',
              '--ck-border-radius':                  '24px',
              '--ck-overlay-background':             'rgba(0,0,0,0.82)',
            }}
          />
        </div>
        </div>{/* end app-col */}
      </header>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <NetworkGuard>
        <main
          className="flex-1 w-full"
          style={{ paddingTop: isDashboard ? '8px' : '0' }}
        >
          {renderContent()}
        </main>

        {/* ── Bottom nav ──────────────────────────────────────────────────── */}
        <nav
          className="fixed bottom-0 inset-x-0 z-40"
          style={{
            background: 'rgba(5,12,24,0.98)',
            backdropFilter: 'blur(32px)',
            WebkitBackdropFilter: 'blur(32px)',
            borderTop: '1px solid rgba(78,155,255,0.10)',
            boxShadow: '0 -1px 0 rgba(0,0,0,0.50)',
          }}
        >
          <div
            className="grid grid-cols-6 px-2 max-w-lg mx-auto"
            style={{
              height: 'var(--nav-h)',
              paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            }}
          >
            {PRIMARY_NAV.map(({ tab: t, icon: Icon, label }) => {
              const active = activeNavTab === t
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className="relative flex flex-col items-center justify-center gap-[3px] transition-all active:scale-90"
                  style={{ color: active ? 'var(--blue)' : 'var(--subtle)' }}
                  aria-current={active ? 'page' : undefined}
                >
                  {/* Active bar */}
                  {active && (
                    <span
                      className="absolute top-0 left-1/2 -translate-x-1/2"
                      style={{
                        width: '22px',
                        height: '2px',
                        borderRadius: '0 0 3px 3px',
                        background: 'var(--grad-brand)',
                      }}
                    />
                  )}

                  {/* Icon container */}
                  <div
                    className="flex size-[34px] items-center justify-center rounded-[10px] transition-all"
                    style={{
                      background: active ? 'rgba(78,155,255,0.16)' : 'transparent',
                      boxShadow:  active ? '0 0 12px rgba(78,155,255,0.18)' : 'none',
                    }}
                  >
                    <Icon
                      className="size-[18px]"
                      strokeWidth={active ? 2.2 : 1.6}
                    />
                  </div>

                  <span
                    style={{
                      fontSize: '9.5px',
                      fontWeight: active ? 700 : 500,
                      letterSpacing: '0.01em',
                    }}
                  >
                    {label}
                  </span>
                </button>
              )
            })}
          </div>
        </nav>
      </NetworkGuard>
    </div>
  )
}
