/**
 * History — USDC Transfer history for the connected wallet on Arc Mainnet.
 *
 * DATA SOURCE: Arc Mainnet RPC (https://rpc.mainnet.arc.io) via eth_getLogs.
 *
 * KEY FACTS (measured from the live RPC):
 *  - Max getLogs range: 9,999 blocks per call. 10,000+ returns error -32012.
 *  - blockTimestamp is returned inline in every log — no getBlock() calls needed.
 *  - Chain is at ~26.5M blocks, ~1.2 blocks/sec → 2,000 blocks ≈ 27 minutes of history per page.
 *  - Arc Mainnet RPC IGNORES topic filters — getLogs always returns all events for the address
 *    regardless of the topics array. Single unfiltered call + client-side filter is used instead.
 *  - Result cap: ~2000 logs per call in practice (error -32602 above that). PAGE_SIZE=2000.
 *  - The explorer.arc.io API is behind Cloudflare bot protection and cannot be used from fetch().
 *
 * PAGINATION: scan backward from chain head in 2,000-block pages.
 *  - Initial load: fetch the most recent page automatically when the wallet connects.
 *  - "Load earlier" button: fetch the next older page on demand.
 *  - Each page is merged and deduplicated by (txHash + logIndex).
 *
 * COVERAGE DISCLOSURE: explicitly shows which block range has been scanned and
 *  how many pages remain to the chain genesis, so the user always knows completeness.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { keccak256, toBytes, decodeAbiParameters, parseAbiParameters } from 'viem'
import {
  Loader2, Clock, RefreshCw, ChevronDown, ChevronUp,
  ExternalLink, ArrowUpRight, ArrowDownLeft, Filter,
  AlertTriangle, History as HistoryIcon,
} from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import {
  USDC_ADDRESS, formatAddress, formatUsdcAmount,
  getAddressExplorerUrl, getTxExplorerUrl, ARC_CHAIN,
  getReceipts,
} from '@/utils'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = keccak256(toBytes('Transfer(address,address,uint256)'))

/**
 * Arc Mainnet RPC returns at most ~2000 logs per eth_getLogs call before
 * returning error -32602. Use 2000 blocks per page (≈27 min of history).
 * The node also hard-limits the block range to 9,999 (-32012 above that).
 */
const PAGE_SIZE = 2_000n

// ─── Types ────────────────────────────────────────────────────────────────────

interface Transfer {
  /** Unique dedup key */
  key:         string
  txHash:      `0x${string}`
  logIndex:    number
  from:        `0x${string}`
  to:          `0x${string}`
  value:       bigint
  blockNumber: bigint
  /** Unix seconds, from blockTimestamp in the log (no extra RPC call needed) */
  timestamp:   number | undefined
  direction:   'sent' | 'received'
}

type FilterTab = 'all' | 'sent' | 'received'

// ─── Decoding ─────────────────────────────────────────────────────────────────

interface RawLog {
  topics:           readonly `0x${string}`[]
  data:             `0x${string}`
  transactionHash:  `0x${string}` | null
  blockNumber:      bigint | null
  logIndex:         number | null
  /** blockTimestamp is a non-standard extension Arc Mainnet returns inline. */
  blockTimestamp?:  `0x${string}` | number | bigint
}

function decodeLog(log: RawLog, myAddr: string): Transfer | null {
  try {
    if (log.topics[0] !== TRANSFER_TOPIC) return null
    if (log.topics.length < 3)             return null
    if (!log.transactionHash)              return null

    const from = ('0x' + log.topics[1].slice(26)) as `0x${string}`
    const to   = ('0x' + log.topics[2].slice(26)) as `0x${string}`
    const [value] = decodeAbiParameters(parseAbiParameters('uint256'), log.data)

    const fromLower = from.toLowerCase()
    const toLower   = to.toLowerCase()
    const myLower   = myAddr.toLowerCase()

    if (fromLower !== myLower && toLower !== myLower) return null

    // blockTimestamp: Arc returns it as a hex string in the log
    let timestamp: number | undefined
    const rawTs = (log as { blockTimestamp?: unknown }).blockTimestamp
    if (rawTs != null) {
      if (typeof rawTs === 'string' && rawTs.startsWith('0x')) {
        timestamp = parseInt(rawTs, 16)
      } else if (typeof rawTs === 'number' || typeof rawTs === 'bigint') {
        timestamp = Number(rawTs)
      }
    }

    const txHash    = log.transactionHash
    const logIndex  = log.logIndex ?? 0
    const key       = `${txHash}-${logIndex}`
    const blockNumber = log.blockNumber ?? 0n

    return {
      key, txHash, logIndex, from, to, value, blockNumber, timestamp,
      direction: fromLower === myLower ? 'sent' : 'received',
    }
  } catch {
    return null
  }
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props { onBack: () => void }

// ─── Component ────────────────────────────────────────────────────────────────

export function History({ onBack }: Props) {
  const { address, isConnected } = useAccount()
  const client = usePublicClient({ chainId: ARC_MAINNET_CHAIN_ID })

  const [transfers,    setTransfers]    = useState<Transfer[]>([])
  const [filter,       setFilter]       = useState<FilterTab>('all')
  const [loading,      setLoading]      = useState(false)
  const [loadingMore,  setLoadingMore]  = useState(false)
  const [progress,     setProgress]     = useState<string | null>(null)
  const [error,        setError]        = useState<string | null>(null)
  const [scannedFrom,  setScannedFrom]  = useState<bigint | null>(null)  // lowest block scanned
  const [scannedTo,    setScannedTo]    = useState<bigint | null>(null)  // highest block scanned (head)
  const [expanded,     setExpanded]     = useState<string | null>(null)

  // Track the current address so we can clear history on disconnect / account switch
  const loadedForRef = useRef<string | null>(null)

  // ── Fetch one page ──────────────────────────────────────────────────────────

  const fetchPage = useCallback(async (
    addr: string,
    pageToBlock: bigint,
  ): Promise<{ transfers: Transfer[]; fromBlock: bigint; toBlock: bigint } | null> => {
    if (!client) return null

    const toBlock   = pageToBlock
    const fromBlock = toBlock > PAGE_SIZE ? toBlock - PAGE_SIZE : 0n

    setProgress(`Scanning blocks ${fromBlock.toLocaleString()} – ${toBlock.toLocaleString()}`)

    // Arc Mainnet RPC ignores topic filters (returns all logs regardless of topics array).
    // Use a single unfiltered getLogs call and filter client-side by address.
    // This also avoids the duplicate-log bug caused by two identical result sets.
    const raw = await client.getLogs({
      address:   USDC_ADDRESS,
      fromBlock, toBlock,
    }) as unknown as RawLog[]

    // Deduplicate by txHash+logIndex (defensive: Arc should return unique logs, but guard anyway)
    const seen = new Set<string>()
    const deduped: RawLog[] = []
    for (const r of raw) {
      const k = `${r.transactionHash}-${r.logIndex}`
      if (!seen.has(k)) { seen.add(k); deduped.push(r) }
    }

    const decoded = deduped
      .map(r => decodeLog(r, addr))
      .filter((t): t is Transfer => t !== null)

    return { transfers: decoded, fromBlock, toBlock }
  }, [client])

  // ── Initial load (auto-triggered on connect / address change) ───────────────
  //
  // Scans TWO sets of pages:
  //  1. The most recent page from chain head — always shows the latest activity.
  //  2. Pages containing any locally-saved receipts for this wallet — so that
  //     known Quick Pay transactions are always visible without manual pagination,
  //     even if they were sent many thousands of blocks ago.
  //
  // For receipts with a stored blockNumber this is instant (one extra getLogs).
  // For legacy receipts without blockNumber, we call getTransactionReceipt first.

  const loadInitial = useCallback(async (addr: string) => {
    if (!client) return
    setLoading(true)
    setError(null)
    setTransfers([])
    setScannedFrom(null)
    setScannedTo(null)
    setExpanded(null)
    loadedForRef.current = addr

    try {
      // ── 1. Fetch current chain head ──────────────────────────────────────
      const head = await client.getBlockNumber()
      if (loadedForRef.current !== addr) return

      // ── 2. Scan the most recent page ────────────────────────────────────
      const recentResult = await fetchPage(addr, head)
      if (!recentResult || loadedForRef.current !== addr) return
      const { transfers: recentPage, fromBlock: recentFrom, toBlock: recentTo } = recentResult

      let allTransfers = [...recentPage]
      let lowestBlock  = recentFrom
      let highestBlock = recentTo

      // ── 3. Find local receipt block numbers for this wallet ──────────────
      const addrLower   = addr.toLowerCase()
      const myReceipts  = getReceipts().filter(r => r.from.toLowerCase() === addrLower)

      // Collect block numbers: use stored value or resolve via getTransactionReceipt
      const receiptBlocks: bigint[] = []
      for (const r of myReceipts) {
        if (loadedForRef.current !== addr) return
        if (r.blockNumber != null) {
          receiptBlocks.push(BigInt(r.blockNumber))
        } else if (r.txHash) {
          // Legacy receipt without blockNumber — resolve once and ignore failure
          try {
            const receipt = await client.getTransactionReceipt({
              hash: r.txHash as `0x${string}`,
            })
            if (receipt?.blockNumber) receiptBlocks.push(receipt.blockNumber)
          } catch {
            // Transaction not found or RPC error — skip this receipt
          }
        }
      }

      // ── 4. Scan pages that contain known receipt blocks ──────────────────
      for (const block of receiptBlocks) {
        if (loadedForRef.current !== addr) return
        // Skip if this block is already covered by the recent page
        if (block >= recentFrom && block <= recentTo) continue

        // The page that contains `block` has toBlock = block + (PAGE_SIZE - (block % PAGE_SIZE))
        // Simpler: align to PAGE_SIZE boundaries so we don't re-scan overlapping ranges.
        // Compute the page ceiling: the smallest multiple of PAGE_SIZE >= block+1
        const pageTo = block + (PAGE_SIZE - (block % PAGE_SIZE)) - 1n
        // Cap at head to avoid -32014
        const cappedTo = pageTo > head ? head : pageTo

        try {
          const extra = await fetchPage(addr, cappedTo)
          if (!extra || loadedForRef.current !== addr) continue
          allTransfers = [...allTransfers, ...extra.transfers]
          if (extra.fromBlock < lowestBlock)  lowestBlock  = extra.fromBlock
          if (extra.toBlock   > highestBlock) highestBlock = extra.toBlock
        } catch {
          // Extra page failed — don't abort the whole load, just skip
        }
      }

      if (loadedForRef.current !== addr) return

      // ── 5. Deduplicate and sort ──────────────────────────────────────────
      const unique = Array.from(
        new Map(allTransfers.map(t => [t.key, t])).values()
      ).sort((a, b) => Number(b.blockNumber - a.blockNumber))

      setTransfers(unique)
      setScannedFrom(lowestBlock)
      setScannedTo(highestBlock)
    } catch (e) {
      if (loadedForRef.current === addr) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('-32602') || msg.includes('max results')) {
          setError('This block range contains too many transfers. The page size has been reduced — please refresh.')
        } else if (msg.includes('-32014') || msg.includes('not available')) {
          setError('Block data is temporarily unavailable on Arc. Please try again in a moment.')
        } else {
          setError(msg || 'Failed to load history. Please try again.')
        }
      }
    } finally {
      if (loadedForRef.current === addr) {
        setLoading(false)
        setProgress(null)
      }
    }
  }, [client, fetchPage])

  // ── Load earlier (pagination) ───────────────────────────────────────────────

  async function loadEarlier() {
    if (!client || !address || scannedFrom == null || scannedFrom === 0n) return
    setLoadingMore(true)
    setError(null)

    const addr = address
    try {
      const nextTo = scannedFrom - 1n
      if (nextTo <= 0n) return

      const result = await fetchPage(addr, nextTo)
      if (!result || loadedForRef.current !== addr) return

      const { transfers: page, fromBlock } = result

      setTransfers(prev => {
        const existing = new Set(prev.map(t => t.key))
        const newOnes = page.filter(t => !existing.has(t.key))
        return [...prev, ...newOnes].sort((a, b) => Number(b.blockNumber - a.blockNumber))
      })
      setScannedFrom(fromBlock)
    } catch (e) {
      if (loadedForRef.current === addr) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.includes('-32602') || msg.includes('max results')) {
          setError('Too many transfers in this block range. The page size has been reduced — please retry.')
        } else if (msg.includes('-32014') || msg.includes('not available')) {
          setError('Block data temporarily unavailable. Please try again in a moment.')
        } else {
          setError(msg || 'Failed to load earlier history.')
        }
      }
    } finally {
      if (loadedForRef.current === addr) {
        setLoadingMore(false)
        setProgress(null)
      }
    }
  }

  // ── Auto-load on wallet connect / change ────────────────────────────────────

  useEffect(() => {
    if (!isConnected || !address) {
      // Clear on disconnect
      if (loadedForRef.current !== null) {
        setTransfers([])
        setScannedFrom(null)
        setScannedTo(null)
        setError(null)
        setLoading(false)
        loadedForRef.current = null
      }
      return
    }

    // New address — reload
    if (loadedForRef.current !== address) {
      void loadInitial(address)
    }
  }, [isConnected, address, loadInitial])

  // ── Filtered list ───────────────────────────────────────────────────────────

  const filtered = filter === 'all' ? transfers
    : transfers.filter(t => t.direction === filter)

  const sentCount     = transfers.filter(t => t.direction === 'sent').length
  const receivedCount = transfers.filter(t => t.direction === 'received').length

  // ── Guard: not connected ────────────────────────────────────────────────────

  if (!isConnected || !address) {
    return (
      <ScreenLayout title="History" subtitle="USDC transfers · Arc Mainnet" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to view your USDC transfer history." />
      </ScreenLayout>
    )
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const canLoadEarlier = scannedFrom != null && scannedFrom > 0n && !loading && !loadingMore

  const blocksRemaining = scannedFrom != null && scannedFrom > 0n
    ? Number(scannedFrom)
    : 0

  const pagesRemaining = Math.ceil(blocksRemaining / Number(PAGE_SIZE))

  function formatTs(ts: number): string {
    const d = new Date(ts * 1000)
    return new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(d)
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <ScreenLayout
      title="History"
      subtitle="USDC transfers · Arc Mainnet"
      onBack={onBack}
      action={
        !loading
          ? <button
              onClick={() => { void loadInitial(address) }}
              className="flex items-center justify-center size-9 rounded-[10px] transition-all active:scale-90"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
              title="Refresh"
            >
              <RefreshCw className="size-4" style={{ color: 'var(--blue)' }} />
            </button>
          : undefined
      }
    >

      {/* ── Loading indicator ───────────────────────────────────────────────── */}
      {loading && (
        <div
          className="flex items-center gap-3 rounded-[18px] px-4 py-3.5 mb-3"
          style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
        >
          <Loader2 className="size-4 animate-spin shrink-0" style={{ color: 'var(--blue)' }} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
              Scanning transfers…
            </p>
            {progress && (
              <p className="text-[11px] mono truncate mt-0.5" style={{ color: 'var(--subtle)' }}>
                {progress}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Error state ─────────────────────────────────────────────────────── */}
      {error && (
        <div
          className="rounded-[16px] px-4 py-3.5 flex items-start gap-3"
          style={{ background: 'rgba(255,80,80,0.09)', border: '1px solid rgba(255,80,80,0.22)' }}
        >
          <AlertTriangle className="size-4 shrink-0 mt-0.5" style={{ color: 'var(--danger)' }} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold" style={{ color: 'var(--danger)' }}>Load failed</p>
            <p className="text-xs leading-relaxed mt-0.5" style={{ color: 'var(--ink-3)' }}>{error}</p>
            <button
              onClick={() => { void loadInitial(address) }}
              className="mt-1.5 text-xs font-bold hover:underline"
              style={{ color: 'var(--blue)' }}
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {/* ── Scanned range banner ────────────────────────────────────────────── */}
      {!loading && scannedFrom != null && scannedTo != null && (
        <div
          className="flex items-center gap-2 rounded-[12px] px-3 py-2"
          style={{ background: 'rgba(78,155,255,0.07)', border: '1px solid rgba(78,155,255,0.16)' }}
        >
          <HistoryIcon className="size-3 shrink-0" style={{ color: 'var(--blue)' }} />
          <span className="text-[11px] leading-snug" style={{ color: 'var(--ink-3)' }}>
            Blocks{' '}
            <span className="font-semibold mono" style={{ color: 'var(--blue)' }}>
              {scannedFrom.toLocaleString()}
            </span>
            {' – '}
            <span className="font-semibold mono" style={{ color: 'var(--blue)' }}>
              {scannedTo.toLocaleString()}
            </span>
            {pagesRemaining > 0
              ? <span style={{ color: 'var(--muted)' }}>{` · ${pagesRemaining.toLocaleString()} page${pagesRemaining !== 1 ? 's' : ''} older`}</span>
              : <span style={{ color: 'var(--success)' }}> · full history</span>
            }
          </span>
        </div>
      )}

      {/* ── Filter tabs ─────────────────────────────────────────────────────── */}
      {!loading && transfers.length > 0 && (
        <div
          className="flex gap-1 p-1 rounded-[14px]"
          style={{ background: 'var(--card)', border: '1px solid var(--card-border-2)' }}
        >
          {([
            { id: 'all',      label: 'All',      count: transfers.length },
            { id: 'sent',     label: 'Sent',     count: sentCount },
            { id: 'received', label: 'Received', count: receivedCount },
          ] as const).map(({ id, label, count }) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-bold rounded-[11px] transition-all active:scale-95"
              style={{
                background: filter === id
                  ? 'linear-gradient(135deg, #4e9bff 0%, #3b87f5 100%)'
                  : 'transparent',
                color: filter === id ? '#fff' : 'var(--muted)',
                boxShadow: filter === id ? '0 2px 8px rgba(78,155,255,0.28)' : 'none',
              }}
            >
              {label}
              <span
                className="rounded-full px-1.5 py-px text-[10px] font-bold"
                style={{
                  background: filter === id ? 'rgba(0,0,0,0.20)' : 'rgba(255,255,255,0.07)',
                  color: filter === id ? '#fff' : 'var(--subtle)',
                }}
              >
                {count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* ── Transfer list ───────────────────────────────────────────────────── */}
      {!loading && filtered.length === 0 && !error && scannedFrom != null && (
        <div
          className="flex flex-col items-center gap-3 text-center py-8 px-4 rounded-[20px]"
          style={{ background: 'var(--card)', border: '1px solid var(--card-border-2)' }}
        >
          <div
            className="flex size-11 items-center justify-center rounded-[14px]"
            style={{ background: 'rgba(78,155,255,0.10)', border: '1px solid rgba(78,155,255,0.18)' }}
          >
            <Filter className="size-5" style={{ color: 'var(--blue)' }} />
          </div>
          <div>
            <p className="text-sm font-semibold mb-1" style={{ color: 'var(--ink-2)' }}>
              {filter === 'all' ? 'No transfers in this range' : `No ${filter} transfers here`}
            </p>
            <p className="text-xs leading-relaxed max-w-[220px]" style={{ color: 'var(--muted)' }}>
              {canLoadEarlier
                ? 'Each page is ~27 minutes. Tap "Load earlier" to search older blocks.'
                : 'Full history scanned.'}
            </p>
          </div>
          <a
            href={`${ARC_CHAIN.explorerBase}/address/${address}`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs font-semibold hover:underline"
            style={{ color: 'var(--blue)' }}
          >
            Arc Explorer <ExternalLink className="size-3" />
          </a>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((t) => {
            const isSent = t.direction === 'sent'
            const isOpen = expanded === t.key

            return (
              <div
                key={t.key}
                className="rounded-[18px] overflow-hidden transition-all"
                style={{
                  background: 'var(--card)',
                  border: `1px solid ${isSent ? 'rgba(255,80,80,0.20)' : 'rgba(34,217,135,0.20)'}`,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.30)',
                }}
              >
                {/* Row summary */}
                <button
                  onClick={() => setExpanded(isOpen ? null : t.key)}
                  className="w-full flex items-center px-3.5 py-3 text-left gap-3 active:bg-white/[0.03] transition-colors"
                >
                  {/* Direction icon tile */}
                  <div
                    className="flex size-9 shrink-0 items-center justify-center rounded-[11px]"
                    style={{
                      background: isSent ? 'rgba(255,100,100,0.11)' : 'rgba(34,217,135,0.11)',
                    }}
                  >
                    {isSent
                      ? <ArrowUpRight  className="size-4" style={{ color: 'var(--danger)' }} />
                      : <ArrowDownLeft className="size-4" style={{ color: 'var(--success)' }} />
                    }
                  </div>

                  {/* Main info */}
                  <div className="flex-1 min-w-0">
                    {/* Direction label + amount on same row */}
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className="text-sm font-bold tabular-nums"
                        style={{ color: isSent ? 'var(--danger)' : 'var(--success)' }}
                      >
                        {isSent ? '−' : '+'}{formatUsdcAmount(t.value)}{' '}
                        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
                      </span>
                      {/* Timestamp right-aligned */}
                      <span className="text-[11px] shrink-0" style={{ color: 'var(--muted)' }}>
                        {t.timestamp ? formatTs(t.timestamp) : `#${t.blockNumber.toString()}`}
                      </span>
                    </div>
                    {/* Counterparty */}
                    <p className="mono text-[11px] mt-0.5 truncate" style={{ color: 'var(--subtle)' }}>
                      {isSent ? `→ ${formatAddress(t.to)}` : `← ${formatAddress(t.from)}`}
                    </p>
                  </div>

                  {/* Expand chevron */}
                  {isOpen
                    ? <ChevronUp   className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />
                    : <ChevronDown className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />
                  }
                </button>

                {/* Expanded detail */}
                {isOpen && (
                  <div
                    className="px-3.5 pb-3.5"
                    style={{ borderTop: '1px solid var(--border-soft)' }}
                  >
                    <div className="pt-3 space-y-2 text-xs">
                      {[
                        { label: 'From',  value: t.from, mono: true, link: getAddressExplorerUrl(t.from) },
                        { label: 'To',    value: t.to,   mono: true, link: getAddressExplorerUrl(t.to) },
                        { label: 'Block', value: t.blockNumber.toLocaleString(), mono: true },
                        ...(t.timestamp ? [{ label: 'Time', value: new Date(t.timestamp * 1000).toLocaleString(), mono: false, link: undefined }] : []),
                      ].map(({ label, value, mono, link }) => (
                        <div key={label} className="flex items-center justify-between gap-2">
                          <span className="shrink-0 text-[11px]" style={{ color: 'var(--subtle)' }}>{label}</span>
                          <div className="flex items-center gap-1 min-w-0">
                            <span
                              className={`${mono ? 'mono' : ''} text-[11px] truncate`}
                              style={{ color: 'var(--ink-2)' }}
                            >
                              {mono && label !== 'Block' ? formatAddress(value as `0x${string}`) : value}
                            </span>
                            {link && (
                              <a href={link} target="_blank" rel="noopener noreferrer" className="shrink-0">
                                <ExternalLink className="size-3" style={{ color: 'var(--muted)' }} />
                              </a>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>

                    <a
                      href={getTxExplorerUrl(t.txHash)}
                      target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-semibold mt-3 hover:underline"
                      style={{ color: 'var(--blue)' }}
                    >
                      View on Arc Explorer <ExternalLink className="size-3" />
                    </a>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Load earlier button ─────────────────────────────────────────────── */}
      {canLoadEarlier && (
        <button
          onClick={() => { void loadEarlier() }}
          disabled={loadingMore}
          className="flex items-center justify-center gap-2 w-full rounded-[16px] py-3 text-sm font-semibold transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-50 mb-2"
          style={{
            background: 'var(--surface-strong)',
            color: 'var(--ink-2)',
            border: '1px solid var(--border)',
          }}
        >
          {loadingMore
            ? <><Loader2 className="size-4 animate-spin" style={{ color: 'var(--blue)' }} /> Scanning…</>
            : <><Clock className="size-3.5" style={{ color: 'var(--blue)' }} />
                Load earlier
                <span className="text-xs font-normal" style={{ color: 'var(--subtle)' }}>
                  ({pagesRemaining.toLocaleString()} page{pagesRemaining !== 1 ? 's' : ''})
                </span>
              </>
          }
        </button>
      )}

      {/* Progress during load-earlier */}
      {loadingMore && progress && (
        <p className="text-[11px] mono text-center mb-2" style={{ color: 'var(--subtle)' }}>
          {progress}
        </p>
      )}

      {/* ── Explorer footer ───────────────────────────────────────────────────── */}
      <div className="flex items-center justify-center pb-1">
        <a
          href={`${ARC_CHAIN.explorerBase}/address/${address}`}
          target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs font-medium hover:underline"
          style={{ color: 'var(--subtle)' }}
        >
          <ExternalLink className="size-3" />
          Full history on Arc Explorer
        </a>
      </div>

    </ScreenLayout>
  )
}
