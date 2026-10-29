/**
 * Dashboard — hero balance card + quick-action grid + recent transactions.
 * All blockchain reads preserved (wagmi useReadContract + useBlockNumber).
 * Visual-only changes in this file.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAccount, useBlockNumber, useConnectorClient } from 'wagmi'
import { erc20Abi } from 'viem'
import { readContract } from 'viem/actions'
import {
  Eye, EyeOff, RefreshCw,
  ArrowUpRight, QrCode, ScanLine, FileText,
  Copy, Check, ExternalLink, Users, HelpCircle,
  Clock, Shuffle, ArrowLeftRight,
} from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import {
  formatAddress, formatUsdcDisplay, copyToClipboard,
  getAddressExplorerUrl, USDC_ADDRESS, ARC_CHAIN,
  getReceipts, type LocalReceipt,
} from '@/utils'
import type { Tab } from '@/App'

interface Props { onNavigate: (tab: Tab) => void }

// ── Action tile config ──────────────────────────────────────────────────────
const ACTIONS: {
  tab: Tab
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>
  label: string
  /** Icon color */
  color: string
  /** Tile background (solid dark, not transparent) */
  bg: string
  /** Border color */
  border: string
  /** Glow behind icon */
  glow: string
}[] = [
  {
    tab: 'send',      icon: ArrowUpRight, label: 'Send',
    color: '#ff7070', bg: '#190d0d', border: 'rgba(255,80,80,0.22)',
    glow: 'rgba(255,80,80,0.18)',
  },
  {
    tab: 'receive',   icon: QrCode,       label: 'Receive',
    color: '#22d987', bg: '#0c1d14', border: 'rgba(34,217,135,0.22)',
    glow: 'rgba(34,217,135,0.18)',
  },
  {
    tab: 'scan',      icon: ScanLine,     label: 'Scan',
    color: '#0de8ff', bg: '#071e23', border: 'rgba(13,232,255,0.20)',
    glow: 'rgba(13,232,255,0.16)',
  },
  {
    tab: 'requests',  icon: FileText,     label: 'Request',
    color: '#9d78fb', bg: '#130e22', border: 'rgba(157,120,251,0.22)',
    glow: 'rgba(157,120,251,0.16)',
  },
  {
    tab: 'recipients', icon: Users,       label: 'Contacts',
    color: '#4e9bff', bg: '#0c1828', border: 'rgba(78,155,255,0.22)',
    glow: 'rgba(78,155,255,0.16)',
  },
  {
    tab: 'bridge',    icon: ArrowLeftRight, label: 'Bridge',
    color: '#a78bfa', bg: '#130e22', border: 'rgba(167,139,250,0.22)',
    glow: 'rgba(167,139,250,0.16)',
  },
  {
    tab: 'split',     icon: Shuffle,     label: 'Split',
    color: '#22d987', bg: '#0c1d14', border: 'rgba(34,217,135,0.18)',
    glow: 'rgba(34,217,135,0.14)',
  },
  {
    tab: 'assistant', icon: HelpCircle,  label: 'Help',
    color: '#ffb020', bg: '#1c1500', border: 'rgba(255,176,32,0.20)',
    glow: 'rgba(255,176,32,0.14)',
  },
]

export function Dashboard({ onNavigate }: Props) {
  const { address, isConnected } = useAccount()
  const [hidden,         setHidden]         = useState(false)
  const [copied,         setCopied]         = useState(false)
  const [recentReceipts, setRecentReceipts] = useState<LocalReceipt[]>([])

  // Receipts written by SendSheet — no blockchain call
  useEffect(() => {
    if (!address) return
    const addrLower = address.toLowerCase()
    const all  = getReceipts()
    const mine = all.filter(r => r.from.toLowerCase() === addrLower).slice(0, 3)
    setRecentReceipts(mine)
  }, [address])

  // ── Balance read: wallet-provider first, HTTP transport fallback ────────────
  // Arc's USDC precompile (0x3600…) responds correctly to eth_call.
  // However, wagmi's public client uses our configured HTTP transport
  // (fallback across 4 Arc RPC URLs), which can fail on some mobile networks.
  // Using the wallet's own EIP-1193 provider bypasses our HTTP transport
  // and uses whatever RPC the wallet (MetaMask) has configured for chain 5042.
  const { data: walletClient } = useConnectorClient({ chainId: ARC_MAINNET_CHAIN_ID })
  const [rawBalance,    setRawBalance]    = useState<bigint | undefined>(undefined)
  const [balanceLoading, setBalanceLoading] = useState(false)
  const [balanceError,  setBalanceError]  = useState(false)
  const [isFetching,    setIsFetching]    = useState(false)

  const fetchBalance = useCallback(async () => {
    if (!address) return
    // Wait for the wallet client to resolve before attempting any read.
    // useConnectorClient returns undefined on first render and resolves async.
    if (walletClient === undefined) return
    setIsFetching(true)
    setBalanceLoading(rawBalance === undefined)
    setBalanceError(false)
    // Single outer finally ensures balanceLoading + isFetching always clear,
    // regardless of which code path (wallet success, wallet fail → HTTP, all fail) runs.
    try {
      // Wrap a promise with a timeout — returns a rejected promise after ms
      function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
        return Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
          ),
        ])
      }
      try {
        // Primary: wallet client's EIP-1193 transport (wallet's own RPC for chain 5042).
        // 15-second timeout prevents indefinite hang when MetaMask's Arc RPC is slow.
        const result = await withTimeout(
          readContract(walletClient, {
            address:      USDC_ADDRESS,
            abi:          erc20Abi,
            functionName: 'balanceOf',
            args:         [address],
          }),
          15_000,
        )
        setRawBalance(result)
        setBalanceError(false)
        return   // success — outer finally still runs
      } catch (walletErr) {
        console.warn('[QuickPay] wallet-client balanceOf failed, trying HTTP transport:', walletErr)
      }
      // Fallback: direct HTTP transport across all official Arc RPC endpoints.
      // Retry up to 2 times with 2-second back-off to handle transient RPC rate limits.
      let lastHttpErr: unknown
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2_000 * attempt))
        try {
          const { createPublicClient, http, fallback } = await import('viem')
          const { arc } = await import('viem/chains')
          const publicClient = createPublicClient({
            chain: arc,
            transport: fallback(arc.rpcUrls.default.http.map(url => http(url, { timeout: 12_000 }))),
          })
          const result = await withTimeout(
            readContract(publicClient, {
              address:      USDC_ADDRESS,
              abi:          erc20Abi,
              functionName: 'balanceOf',
              args:         [address],
            }),
            14_000,
          )
          setRawBalance(result)
          setBalanceError(false)
          return  // success — outer finally still runs
        } catch (e) {
          lastHttpErr = e
          console.warn(`[QuickPay] HTTP balanceOf attempt ${attempt + 1} failed:`, e)
        }
      }
      console.error('[QuickPay] balanceOf all paths failed:', lastHttpErr)
      setBalanceError(true)
    } catch (httpErr) {
      console.error('[QuickPay] balanceOf all paths failed:', httpErr)
      setBalanceError(true)
    } finally {
      setIsFetching(false)
      setBalanceLoading(false)
    }
  }, [address, walletClient, rawBalance])

  const refetch = fetchBalance

  // Fetch whenever address or walletClient changes (walletClient resolves async).
  // walletClient starts as undefined and resolves on the next render cycle;
  // the guard above ensures we only run once it is defined.
  useEffect(() => {
    void fetchBalance()
    const id = setInterval(() => { void fetchBalance() }, 20_000)
    return () => clearInterval(id)
  }, [address, walletClient]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: blockNumber } = useBlockNumber({
    chainId: ARC_MAINNET_CHAIN_ID,
    watch:   false,
    query:   { enabled: !!address },
  })

  const balance = rawBalance != null ? formatUsdcDisplay(rawBalance) : null

  function handleCopy() {
    if (!address) return
    void copyToClipboard(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    })
  }

  /* ── Not connected ──────────────────────────────────────────────────────── */
  if (!isConnected) {
    return (
      <div className="app-col pb-nav space-y-4">
        {/* Hero splash */}
        <div
          className="flex flex-col items-center text-center py-10 gap-6 rounded-[24px] px-6"
          style={{
            background: 'linear-gradient(160deg, #0d2248 0%, #091830 50%, #0b1a36 100%)',
            border: '1px solid rgba(78,155,255,0.22)',
            boxShadow: '0 8px 40px rgba(78,155,255,0.12), 0 1px 0 rgba(255,255,255,0.05) inset',
          }}
        >
          {/* Logo mark large */}
          <div
            className="flex size-[72px] items-center justify-center rounded-[22px]"
            style={{
              background: 'linear-gradient(145deg, #0d2248 0%, #071530 100%)',
              border: '1px solid rgba(78,155,255,0.32)',
              boxShadow: '0 8px 32px rgba(78,155,255,0.20)',
            }}
          >
            <svg width="36" height="36" viewBox="0 0 44 44" fill="none">
              <defs>
                <linearGradient id="wlg" x1="10" y1="5" x2="34" y2="40" gradientUnits="userSpaceOnUse">
                  <stop offset="0%"   stopColor="#4e9bff" />
                  <stop offset="45%"  stopColor="#0de8ff" />
                  <stop offset="100%" stopColor="#9d78fb" />
                </linearGradient>
                <filter id="wlg-glow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                </filter>
              </defs>
              <path d="M25 7L14 24.5H21.5L18 37L30 19.5H22.5L25 7Z"
                fill="url(#wlg)" filter="url(#wlg-glow)" opacity="0.7" />
              <path d="M25 7L14 24.5H21.5L18 37L30 19.5H22.5L25 7Z"
                fill="url(#wlg)" />
            </svg>
          </div>

          <div>
            <h2 className="display text-2xl font-bold mb-2"
              style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}>
              Quick Pay
            </h2>
            <p className="text-sm leading-relaxed max-w-[220px] mx-auto"
              style={{ color: 'var(--ink-3)' }}>
              Send and receive USDC instantly on Arc Mainnet.
            </p>
          </div>

          {/* Chain info */}
          <div
            className="w-full rounded-[16px] overflow-hidden"
            style={{ background: 'rgba(0,0,0,0.30)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            {[
              ['Network', 'Arc Mainnet'],
              ['Asset',   'USDC'],
              ['Chain',   '5042'],
            ].map(([k, v], i) => (
              <div
                key={k}
                className="flex justify-between items-center px-4 py-2.5 text-sm"
                style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : undefined }}
              >
                <span style={{ color: 'var(--subtle)' }}>{k}</span>
                <span className="font-semibold" style={{ color: 'var(--ink-2)' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Feature capsules */}
        <div className="grid grid-cols-3 gap-2.5">
          {[
            { icon: ArrowUpRight, label: 'Send USDC',  color: '#ff7070', bg: '#190d0d', border: 'rgba(255,80,80,0.20)' },
            { icon: QrCode,       label: 'Receive',    color: '#22d987', bg: '#0c1d14', border: 'rgba(34,217,135,0.20)' },
            { icon: ScanLine,     label: 'Scan & Pay', color: '#0de8ff', bg: '#071e23', border: 'rgba(13,232,255,0.20)' },
          ].map(({ icon: Icon, label, color, bg, border }) => (
            <div
              key={label}
              className="flex flex-col items-center gap-2 rounded-[16px] py-4 px-2"
              style={{ background: bg, border: `1px solid ${border}` }}
            >
              <Icon className="size-5" style={{ color }} strokeWidth={1.8} />
              <span className="text-xs font-semibold text-center" style={{ color: 'var(--ink-3)' }}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  /* ── Connected ──────────────────────────────────────────────────────────── */
  return (
    <div className="app-col pb-nav space-y-3">

      {/* ── Hero balance card ──────────────────────────────────────────────── */}
      <div
        className="relative rounded-[24px] overflow-hidden"
        style={{
          background: 'linear-gradient(150deg, #0e2448 0%, #091a38 45%, #0b1a34 100%)',
          border: '1px solid rgba(78,155,255,0.28)',
          boxShadow: '0 2px 0 rgba(255,255,255,0.06) inset, 0 12px 48px rgba(78,155,255,0.16), 0 32px 60px rgba(0,0,0,0.60)',
        }}
      >
        {/* Ambient glow blobs */}
        <div className="absolute pointer-events-none"
          style={{
            top: '-80px', right: '-60px',
            width: '240px', height: '240px', borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(78,155,255,0.20) 0%, transparent 65%)',
          }} />
        <div className="absolute pointer-events-none"
          style={{
            bottom: '-60px', left: '-40px',
            width: '200px', height: '200px', borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(157,120,251,0.14) 0%, transparent 65%)',
          }} />
        <div className="absolute pointer-events-none"
          style={{
            top: '20px', left: '40%',
            width: '120px', height: '120px', borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(13,232,255,0.08) 0%, transparent 70%)',
          }} />

        <div className="relative p-6">
          {/* Row 1: network pill + controls */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full pulse-dot"
                style={{ background: 'var(--success)', boxShadow: '0 0 8px var(--success)' }} />
              <span className="text-[11px] font-bold uppercase tracking-wider"
                style={{ color: 'var(--ink-3)', letterSpacing: '0.12em' }}>
                Arc Mainnet · USDC
              </span>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => setHidden(v => !v)}
                className="flex size-8 items-center justify-center rounded-xl transition-all hover:bg-white/8 active:scale-90"
                aria-label={hidden ? 'Show balance' : 'Hide balance'}
              >
                {hidden
                  ? <EyeOff className="size-4" style={{ color: 'var(--muted)' }} />
                  : <Eye    className="size-4" style={{ color: 'var(--muted)' }} />}
              </button>
              <button
                onClick={() => { void refetch() }}
                disabled={isFetching}
                className="flex size-8 items-center justify-center rounded-xl transition-all hover:bg-white/8 active:scale-90 disabled:opacity-40"
                aria-label="Refresh balance"
              >
                <RefreshCw
                  className={`size-4 ${isFetching ? 'animate-spin' : ''}`}
                  style={{ color: 'var(--muted)' }}
                />
              </button>
            </div>
          </div>

          {/* Balance display */}
          <div className="mb-6">
            {balanceLoading ? (
              <div className="space-y-2">
                <div className="skeleton h-12 w-44 rounded-xl" />
                <div className="skeleton h-4 w-24 rounded-lg" />
              </div>
            ) : balanceError ? (
              <div>
                <p className="display text-4xl font-bold" style={{ color: 'var(--danger)' }}>—</p>
                <p className="text-xs mt-1 font-semibold" style={{ color: 'var(--danger)' }}>Balance unavailable — tap refresh</p>
              </div>
            ) : (
              <div>
                <div className="flex items-baseline gap-2.5 mb-1.5">
                  <span
                    className="display font-bold tabular-nums"
                    style={{
                      fontSize: 'clamp(2.8rem, 11vw, 3.8rem)',
                      color: 'var(--ink)',
                      filter:     hidden ? 'blur(14px) saturate(0)' : 'none',
                      transition: 'filter 0.25s',
                      userSelect: hidden ? 'none' : 'auto',
                      letterSpacing: '-0.045em',
                    }}
                  >
                    {balance ?? '0.00'}
                  </span>
                  <span
                    className="font-bold pb-1"
                    style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.30)', letterSpacing: '-0.02em' }}
                  >
                    USDC
                  </span>
                </div>
                {blockNumber != null && (
                  <p className="mono text-[11px] tabular-nums" style={{ color: 'var(--subtle)' }}>
                    Block {blockNumber.toString()}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Address bar */}
          <div
            className="flex items-center justify-between rounded-[13px] px-3.5 py-2"
            style={{
              background: 'rgba(0,0,0,0.38)',
              border: '1px solid rgba(255,255,255,0.07)',
            }}
          >
            <span className="mono text-xs" style={{ color: 'var(--ink-3)' }}>
              {formatAddress(address!)}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleCopy}
                className="flex size-7 items-center justify-center rounded-lg transition-all hover:bg-white/10 active:scale-90"
                aria-label="Copy address"
              >
                {copied
                  ? <Check className="size-3.5" style={{ color: 'var(--success)' }} />
                  : <Copy  className="size-3.5" style={{ color: 'var(--muted)' }} />}
              </button>
              <a
                href={getAddressExplorerUrl(address!)}
                target="_blank" rel="noopener noreferrer"
                className="flex size-7 items-center justify-center rounded-lg transition-all hover:bg-white/10 active:scale-90"
                aria-label="View on Arc Explorer"
              >
                <ExternalLink className="size-3.5" style={{ color: 'var(--muted)' }} />
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* ── Quick-action grid ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-2.5">
        {ACTIONS.map(({ tab: t, icon: Icon, label, color, bg, border, glow }) => (
          <button
            key={t}
            onClick={() => onNavigate(t)}
            className="flex flex-col items-center gap-3 rounded-[18px] py-5 px-2 transition-all active:scale-95 hover:brightness-110"
            style={{
              background: bg,
              border: `1px solid ${border}`,
              boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
            }}
          >
            {/* Icon circle */}
            <div
              className="flex size-12 items-center justify-center rounded-[14px]"
              style={{
                background: `radial-gradient(circle at 35% 35%, ${glow}, transparent 70%)`,
                border: `1px solid ${border}`,
              }}
            >
              <Icon className="size-[22px]" style={{ color }} strokeWidth={1.8} />
            </div>
            <span className="text-[13px] font-semibold" style={{ color: 'var(--ink-2)' }}>
              {label}
            </span>
          </button>
        ))}
      </div>

      {/* ── Recent Transactions ─────────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2.5 px-0.5">
          <span className="section-label">Recent</span>
          <button
            onClick={() => onNavigate('history')}
            className="flex items-center gap-1 text-[11px] font-semibold hover:underline active:scale-95 transition-all"
            style={{ color: 'var(--blue)' }}
          >
            View all <ArrowUpRight className="size-3" />
          </button>
        </div>

        {recentReceipts.length > 0 ? (
          <div
            className="rounded-[20px] overflow-hidden"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--card-border)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.30)',
            }}
          >
            {recentReceipts.map((r, i) => (
              <div
                key={r.txHash}
                className="flex items-center gap-3 px-4 py-3"
                style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : undefined }}
              >
                {/* Icon */}
                <div
                  className="flex size-9 shrink-0 items-center justify-center rounded-[11px]"
                  style={{ background: 'rgba(255,80,80,0.12)', border: '1px solid rgba(255,80,80,0.16)' }}
                >
                  <ArrowUpRight className="size-4" style={{ color: 'var(--danger)' }} strokeWidth={2} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
                      −{r.amount}
                      <span className="text-xs font-normal ml-1" style={{ color: 'var(--muted)' }}>USDC</span>
                    </span>
                    <span className="text-[11px] shrink-0" style={{ color: 'var(--subtle)' }}>
                      {formatRelativeTime(r.confirmedAt)}
                    </span>
                  </div>
                  <p className="mono text-[11px] truncate mt-0.5" style={{ color: 'var(--muted)' }}>
                    → {formatAddress(r.to)}
                    {r.note && <span> · {r.note}</span>}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <button
            onClick={() => onNavigate('history')}
            className="flex items-center gap-3 w-full rounded-[18px] px-4 py-3 text-left transition-all active:scale-[0.99] hover:brightness-110"
            style={{
              background: 'var(--card)',
              border: '1px solid var(--card-border-2)',
            }}
          >
            <div
              className="flex size-9 items-center justify-center rounded-[11px]"
              style={{ background: 'rgba(78,155,255,0.10)', border: '1px solid rgba(78,155,255,0.16)' }}
            >
              <Clock className="size-4" style={{ color: 'var(--blue)' }} strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--ink-3)' }}>No recent transactions</p>
              <p className="text-[11px]" style={{ color: 'var(--subtle)' }}>Tap to view full history</p>
            </div>
            <ArrowUpRight className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
          </button>
        )}
      </div>

      {/* ── Network strip ───────────────────────────────────────────────────── */}
      <div
        className="flex items-center justify-between rounded-[14px] px-4 py-2.5 text-xs"
        style={{
          background: 'var(--card)',
          border: '1px solid var(--card-border-2)',
        }}
      >
        <NetStat label="Network" value="Arc Mainnet" />
        <div className="h-4 w-px" style={{ background: 'rgba(255,255,255,0.07)' }} />
        <NetStat label="Gas" value="USDC" accent />
        <div className="h-4 w-px" style={{ background: 'rgba(255,255,255,0.07)' }} />
        <NetStat label="Chain ID" value={ARC_CHAIN.chainId.toString()} mono />
      </div>
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.floor(diff / 60_000)
  const h = Math.floor(diff / 3_600_000)
  const d = Math.floor(diff / 86_400_000)
  if (m < 1)  return 'just now'
  if (m < 60) return `${m}m ago`
  if (h < 24) return `${h}h ago`
  return `${d}d ago`
}

function NetStat({
  label, value, accent, mono,
}: { label: string; value: string; accent?: boolean; mono?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span style={{ color: 'var(--subtle)', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span
        className={mono ? 'mono' : 'font-semibold'}
        style={{ color: accent ? 'var(--success)' : 'var(--ink-2)', fontSize: '12px' }}
      >
        {value}
      </span>
    </div>
  )
}
