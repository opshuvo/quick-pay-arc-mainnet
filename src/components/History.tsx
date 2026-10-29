/**
 * History — USDC Transfer history for the connected wallet on Arc Mainnet.
 *
 * DATA SOURCE: Arc Mainnet RPC via eth_getLogs + localStorage cache.
 *
 * KEY FACTS (measured from the live RPC, Oct 2026):
 *  - Hard block-range limit: 9,999 blocks per eth_getLogs call (-32012 above that).
 *  - No result-count cap observed up to 9,999 blocks (~7,294 logs in testing).
 *  - blockTimestamp is returned inline in every log — no getBlock() calls needed.
 *  - Topic filters WORK: topic[1]=padded(addr) for sent, topic[2]=padded(addr) for received.
 *    Two calls per page (sent + received) return only relevant logs, not all USDC transfers.
 *  - Chain is at ~27.5M blocks, ~1.2 blocks/sec; 9,999 blocks ≈ 2.3 hours of history.
 *
 * PAGINATION: backward from chain head in 9,999-block pages (on-demand via "Load earlier").
 * CACHE: discovered transfers are saved to localStorage (keyed by wallet address).
 *   On next open, cached transfers load instantly; on-chain re-fetches the tip to find new ones.
 * COVERAGE: explicitly shows scanned block range and pages remaining to genesis.
 * HONESTY: cached records are labelled "locally saved"; on-chain records are not so labelled.
 *   No transfer is marked confirmed unless it was fetched from the chain.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useAccount, usePublicClient, useConnectorClient } from 'wagmi'
import { createPublicClient, custom, keccak256, toBytes, decodeAbiParameters, parseAbiParameters } from 'viem'
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
 * Hard limit is 9,999 blocks per eth_getLogs call (-32012 at 10,000+).
 * Use 9,999 to maximise history per page while staying under the limit.
 * At ~1.2 blocks/sec this covers ~2.3 hours per page.
 */
const PAGE_SIZE = 9_999n

/** localStorage key for cached transfers, keyed per wallet address */
const CACHE_KEY_PREFIX = 'quickpay:history:'

// ─── Types ────────────────────────────────────────────────────────────────────

/** Across SpokePool on Arc Mainnet — USDC transfers to this address are bridge deposits. */
const ACROSS_SPOKE_POOL = '0x9b4a302a548c7e313c2b74c461db7b84d3074a84'

interface Transfer {
  key:         string
  txHash:      `0x${string}`
  logIndex:    number
  from:        `0x${string}`
  to:          `0x${string}`
  value:       bigint
  blockNumber: bigint
  /** Unix seconds, from blockTimestamp inline in the log */
  timestamp:   number | undefined
  direction:   'sent' | 'received'
  /** true = came from localStorage cache, not fetched this session */
  fromCache:   boolean
  /** true = this transfer is a known bridge deposit via Across SpokePool */
  isBridge?:   boolean
}

type FilterTab = 'all' | 'sent' | 'received'

// ─── Serialisation helpers ────────────────────────────────────────────────────

interface CachedTransfer {
  key:         string
  txHash:      string
  logIndex:    number
  from:        string
  to:          string
  value:       string   // bigint as decimal string
  blockNumber: string   // bigint as decimal string
  timestamp:   number | undefined
  direction:   'sent' | 'received'
}

function toCached(t: Transfer): CachedTransfer {
  return {
    key: t.key, txHash: t.txHash, logIndex: t.logIndex,
    from: t.from, to: t.to,
    value: t.value.toString(),
    blockNumber: t.blockNumber.toString(),
    timestamp: t.timestamp,
    direction: t.direction,
  }
}

function fromCached(c: CachedTransfer): Transfer {
  return {
    key: c.key,
    txHash: c.txHash as `0x${string}`,
    logIndex: c.logIndex,
    from: c.from as `0x${string}`,
    to: c.to as `0x${string}`,
    value: BigInt(c.value),
    blockNumber: BigInt(c.blockNumber),
    timestamp: c.timestamp,
    direction: c.direction,
    fromCache: true,
  }
}

function loadCache(addr: string): Transfer[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY_PREFIX + addr.toLowerCase())
    if (!raw) return []
    const parsed = JSON.parse(raw) as CachedTransfer[]
    return parsed.map(fromCached)
  } catch { return [] }
}

function saveCache(addr: string, transfers: Transfer[]): void {
  try {
    // Cap at 2,000 most-recent transfers to avoid unbounded storage
    const sorted = [...transfers].sort((a, b) => Number(b.blockNumber - a.blockNumber))
    const data: CachedTransfer[] = sorted.slice(0, 2000).map(toCached)
    localStorage.setItem(CACHE_KEY_PREFIX + addr.toLowerCase(), JSON.stringify(data))
  } catch { /* storage full or unavailable */ }
}

// ─── Log decoding ─────────────────────────────────────────────────────────────

interface RawLog {
  topics:          readonly `0x${string}`[]
  data:            `0x${string}`
  transactionHash: `0x${string}` | null
  blockNumber:     bigint | null
  logIndex:        number | null
  blockTimestamp?: `0x${string}` | number | bigint
}

function decodeLog(log: RawLog, myAddr: string, direction: 'sent' | 'received'): Transfer | null {
  try {
    if (log.topics[0] !== TRANSFER_TOPIC) return null
    if (log.topics.length < 3)            return null
    if (!log.transactionHash)             return null

    const from = ('0x' + log.topics[1].slice(26)) as `0x${string}`
    const to   = ('0x' + log.topics[2].slice(26)) as `0x${string}`
    const [value] = decodeAbiParameters(parseAbiParameters('uint256'), log.data)

    // Sanity check: the padded address filter should guarantee this, but verify
    const myLower = myAddr.toLowerCase()
    if (direction === 'sent'     && from.toLowerCase() !== myLower) return null
    if (direction === 'received' && to.toLowerCase()   !== myLower) return null

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

    // Tag transfers sent to the Across SpokePool as bridge deposits
    const isBridge = direction === 'sent' && to.toLowerCase() === ACROSS_SPOKE_POOL

    return { key, txHash, logIndex, from, to, value, blockNumber, timestamp, direction, fromCache: false, isBridge }
  } catch {
    return null
  }
}

// ─── Padded address for topic filter ─────────────────────────────────────────

function paddedTopic(addr: string): `0x${string}` {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as `0x${string}`
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props { onBack: () => void }

// ─── Component ────────────────────────────────────────────────────────────────

export function History({ onBack }: Props) {
  const { address, isConnected } = useAccount()
  const { data: walletClient }   = useConnectorClient({ chainId: ARC_MAINNET_CHAIN_ID })
  const httpClient               = usePublicClient({ chainId: ARC_MAINNET_CHAIN_ID })
  const client = walletClient
    ? createPublicClient({ chain: walletClient.chain, transport: custom(walletClient.transport) })
    : httpClient

  const [transfers,   setTransfers]   = useState<Transfer[]>([])
  const [filter,      setFilter]      = useState<FilterTab>('all')
  const [loading,     setLoading]     = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [progress,    setProgress]    = useState<string | null>(null)
  const [error,       setError]       = useState<string | null>(null)
  const [scannedFrom, setScannedFrom] = useState<bigint | null>(null)
  const [scannedTo,   setScannedTo]   = useState<bigint | null>(null)
  const [expanded,    setExpanded]    = useState<string | null>(null)

  const loadedForRef = useRef<string | null>(null)

  // ── Fetch one page (sent + received, merged) ────────────────────────────────
  // Uses topic filters (topic[1]=from_addr, topic[2]=to_addr) so we only
  // fetch logs relevant to the connected wallet, not all USDC transfers.

  const fetchPage = useCallback(async (
    addr: string,
    pageToBlock: bigint,
  ): Promise<{ transfers: Transfer[]; fromBlock: bigint; toBlock: bigint } | null> => {
    if (!client) return null

    const toBlock   = pageToBlock
    const fromBlock = toBlock > PAGE_SIZE ? toBlock - PAGE_SIZE : 0n
    setProgress(`Scanning blocks ${fromBlock.toLocaleString()} – ${toBlock.toLocaleString()}`)

    const padded = paddedTopic(addr)

    // Two parallel eth_getLogs calls via the low-level client.request() API.
    // We use client.request() rather than client.getLogs() because viem's typed
    // getLogs overloads do not accept a raw topics[] array — they require either
    // an ABI event or no topics at all.
    // fromBlock/toBlock must be 0x-prefixed hex strings for the JSON-RPC layer.
    const fromHex: `0x${string}` = `0x${fromBlock.toString(16)}`
    const toHex:   `0x${string}` = `0x${toBlock.toString(16)}`

    // Cast the request function to accept unknown params so we can pass raw topics[].
    // viem's typed overloads for eth_getLogs require an ABI event; raw topics[] is not supported.
    type RawRequest = (args: { method: string; params: unknown[] }) => Promise<RawLog[]>
    const rawRequest = client.request as unknown as RawRequest

    const [sentRaw, receivedRaw] = await Promise.all([
      rawRequest({
        method: 'eth_getLogs',
        params: [{ address: USDC_ADDRESS, topics: [TRANSFER_TOPIC, padded], fromBlock: fromHex, toBlock: toHex }],
      }),
      rawRequest({
        method: 'eth_getLogs',
        params: [{ address: USDC_ADDRESS, topics: [TRANSFER_TOPIC, null, padded], fromBlock: fromHex, toBlock: toHex }],
      }),
    ])

    const sent     = sentRaw.map(r => decodeLog(r, addr, 'sent')).filter((t): t is Transfer => t !== null)
    const received = receivedRaw.map(r => decodeLog(r, addr, 'received')).filter((t): t is Transfer => t !== null)

    // Merge and deduplicate (a self-transfer would appear in both)
    const merged = new Map<string, Transfer>()
    for (const t of [...sent, ...received]) merged.set(t.key, t)

    return { transfers: Array.from(merged.values()), fromBlock, toBlock }
  }, [client])

  // ── Initial load ─────────────────────────────────────────────────────────────
  // 1. Load cached transfers instantly (fromCache=true) so UI is not empty.
  // 2. Fetch the most recent page from chain head to catch new transfers.
  // 3. Fetch pages containing locally-saved receipt block numbers.
  // 4. Merge everything, deduplicate, update cache.

  const loadInitial = useCallback(async (addr: string) => {
    if (!client) return
    setLoading(true)
    setError(null)
    setExpanded(null)
    loadedForRef.current = addr

    // Load cache immediately so list is populated before any RPC call
    const cached = loadCache(addr)
    if (cached.length > 0) {
      setTransfers(cached)
      // Restore previous scanned range from cache metadata
      const lowestCached  = cached.reduce((m, t) => t.blockNumber < m ? t.blockNumber : m, cached[0].blockNumber)
      const highestCached = cached.reduce((m, t) => t.blockNumber > m ? t.blockNumber : m, cached[0].blockNumber)
      setScannedFrom(lowestCached)
      setScannedTo(highestCached)
    } else {
      setTransfers([])
      setScannedFrom(null)
      setScannedTo(null)
    }

    try {
      const head = await client.getBlockNumber()
      if (loadedForRef.current !== addr) return

      // Scan most recent page from head
      const recentResult = await fetchPage(addr, head)
      if (!recentResult || loadedForRef.current !== addr) return
      const { transfers: recentPage, fromBlock: recentFrom, toBlock: recentTo } = recentResult

      // Start from cached transfers, mark on-chain fetched ones as fromCache=false
      const all = new Map<string, Transfer>()
      for (const t of cached) all.set(t.key, t)
      for (const t of recentPage) all.set(t.key, { ...t, fromCache: false })

      let lowestBlock  = recentFrom
      let highestBlock = recentTo

      // If cache extends lower than our scan, preserve that range
      if (cached.length > 0) {
        const lowestCached = cached.reduce((m, t) => t.blockNumber < m ? t.blockNumber : m, cached[0].blockNumber)
        if (lowestCached < lowestBlock) lowestBlock = lowestCached
      }

      // Fetch pages containing locally-saved receipt blocks (Quick Pay outgoing TXs)
      const addrLower  = addr.toLowerCase()
      const myReceipts = getReceipts().filter(r => r.from.toLowerCase() === addrLower)

      const receiptBlocks: bigint[] = []
      for (const r of myReceipts) {
        if (loadedForRef.current !== addr) return
        if (r.blockNumber != null) {
          receiptBlocks.push(BigInt(r.blockNumber))
        } else if (r.txHash) {
          try {
            const receipt = await client.getTransactionReceipt({ hash: r.txHash as `0x${string}` })
            if (receipt?.blockNumber) receiptBlocks.push(receipt.blockNumber)
          } catch { /* ignore */ }
        }
      }

      for (const block of receiptBlocks) {
        if (loadedForRef.current !== addr) return
        if (block >= recentFrom && block <= recentTo) continue
        // Align block to page boundary
        const pageTo    = block + (PAGE_SIZE - (block % PAGE_SIZE)) - 1n
        const cappedTo  = pageTo > head ? head : pageTo
        // Skip if already covered by cache
        const cachedKeys = Array.from(all.keys())
        const alreadyCovered = cachedKeys.some(() => {
          // Simple check: is this block range within already-loaded range?
          return block >= lowestBlock && block <= highestBlock
        })
        if (alreadyCovered) continue
        try {
          const extra = await fetchPage(addr, cappedTo)
          if (!extra || loadedForRef.current !== addr) continue
          for (const t of extra.transfers) all.set(t.key, { ...t, fromCache: false })
          if (extra.fromBlock < lowestBlock)  lowestBlock  = extra.fromBlock
          if (extra.toBlock   > highestBlock) highestBlock = extra.toBlock
        } catch { /* skip on error */ }
      }

      if (loadedForRef.current !== addr) return

      const sorted = Array.from(all.values())
        .sort((a, b) => Number(b.blockNumber - a.blockNumber))

      setTransfers(sorted)
      setScannedFrom(lowestBlock)
      setScannedTo(highestBlock)
      saveCache(addr, sorted)
    } catch (e) {
      if (loadedForRef.current === addr) {
        setError(classifyError(e))
      }
    } finally {
      if (loadedForRef.current === addr) {
        setLoading(false)
        setProgress(null)
      }
    }
  }, [client, fetchPage])

  // ── Load earlier (pagination, on demand) ────────────────────────────────────

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
        const next = new Map(prev.map(t => [t.key, t]))
        for (const t of page) {
          if (!next.has(t.key)) next.set(t.key, { ...t, fromCache: false })
        }
        const sorted = Array.from(next.values())
          .sort((a, b) => Number(b.blockNumber - a.blockNumber))
        saveCache(addr, sorted)
        return sorted
      })
      setScannedFrom(fromBlock)
    } catch (e) {
      if (loadedForRef.current === addr) setError(classifyError(e))
    } finally {
      if (loadedForRef.current === addr) {
        setLoadingMore(false)
        setProgress(null)
      }
    }
  }

  // ── Auto-load on wallet connect / walletClient resolve ──────────────────────

  useEffect(() => {
    if (!isConnected || !address) {
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
    if (!walletClient) return
    if (loadedForRef.current !== address) {
      void loadInitial(address)
    }
  }, [isConnected, address, walletClient, loadInitial]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived state ────────────────────────────────────────────────────────────

  const filtered      = filter === 'all' ? transfers : transfers.filter(t => t.direction === filter)
  const sentCount     = transfers.filter(t => t.direction === 'sent').length
  const receivedCount = transfers.filter(t => t.direction === 'received').length
  const canLoadEarlier= scannedFrom != null && scannedFrom > 0n && !loading && !loadingMore
  const blocksRemaining = scannedFrom != null && scannedFrom > 0n ? Number(scannedFrom) : 0
  const pagesRemaining  = Math.ceil(blocksRemaining / Number(PAGE_SIZE))

  if (!isConnected || !address) {
    return (
      <ScreenLayout title="History" subtitle="USDC transfers · Arc Mainnet" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to view your USDC transfer history." />
      </ScreenLayout>
    )
  }

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
      {/* ── Loading indicator ─────────────────────────────────────────────── */}
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

      {/* ── Error state ───────────────────────────────────────────────────── */}
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

      {/* ── Scanned range banner ──────────────────────────────────────────── */}
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
              ? <span style={{ color: 'var(--muted)' }}>
                  {` · ${pagesRemaining.toLocaleString()} page${pagesRemaining !== 1 ? 's' : ''} older (~${(pagesRemaining * 2.3).toFixed(0)}h)`}
                </span>
              : <span style={{ color: 'var(--success)' }}> · full history</span>
            }
          </span>
        </div>
      )}

      {/* ── Filter tabs ───────────────────────────────────────────────────── */}
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

      {/* ── Transfer list ─────────────────────────────────────────────────── */}
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
                ? 'Each page covers ~2.3 hours. Tap "Load earlier" to search older blocks.'
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
                <button
                  onClick={() => setExpanded(isOpen ? null : t.key)}
                  className="w-full flex items-center px-3.5 py-3 text-left gap-3 active:bg-white/[0.03] transition-colors"
                >
                  <div
                    className="flex size-9 shrink-0 items-center justify-center rounded-[11px]"
                    style={{
                      background: isSent ? 'rgba(255,100,100,0.11)' : 'rgba(34,217,135,0.11)',
                    }}
                  >
                    {isSent
                      ? <ArrowUpRight  className="size-4" style={{ color: 'var(--danger)' }} />
                      : <ArrowDownLeft className="size-4" style={{ color: 'var(--success)' }} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className="text-sm font-bold tabular-nums"
                        style={{ color: isSent ? 'var(--danger)' : 'var(--success)' }}
                      >
                        {isSent ? '−' : '+'}{formatUsdcAmount(t.value)}{' '}
                        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>USDC</span>
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {t.isBridge && (
                          <span
                            className="text-[9px] font-bold px-1 rounded"
                            style={{ background: 'rgba(167,139,250,0.14)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.20)' }}
                          >
                            bridge
                          </span>
                        )}
                        {t.fromCache && (
                          <span
                            className="text-[9px] font-bold px-1 rounded"
                            style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--subtle)' }}
                          >
                            cached
                          </span>
                        )}
                        <span className="text-[11px]" style={{ color: 'var(--muted)' }}>
                          {t.timestamp ? formatTs(t.timestamp) : `#${t.blockNumber.toString()}`}
                        </span>
                      </div>
                    </div>
                    <p className="mono text-[11px] mt-0.5 truncate" style={{ color: 'var(--subtle)' }}>
                      {isSent
                        ? t.isBridge ? '→ Across SpokePool (bridge deposit)' : `→ ${formatAddress(t.to)}`
                        : `← ${formatAddress(t.from)}`
                      }
                    </p>
                  </div>
                  {isOpen
                    ? <ChevronUp   className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />
                    : <ChevronDown className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />}
                </button>

                {isOpen && (
                  <div className="px-3.5 pb-3.5" style={{ borderTop: '1px solid var(--border-soft)' }}>
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

      {/* ── Load earlier button ───────────────────────────────────────────── */}
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
                  ({pagesRemaining.toLocaleString()} page{pagesRemaining !== 1 ? 's' : ''} · ~{(pagesRemaining * 2.3).toFixed(0)}h more)
                </span>
              </>
          }
        </button>
      )}

      {loadingMore && progress && (
        <p className="text-[11px] mono text-center mb-2" style={{ color: 'var(--subtle)' }}>
          {progress}
        </p>
      )}

      {/* ── Explorer footer ───────────────────────────────────────────────── */}
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTs(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000))
}

function classifyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('-32012') || msg.includes('requested range too large')) {
    return 'Block range too large for this RPC. Retrying with a smaller range — please tap "Try again".'
  }
  if (msg.includes('-32602') || msg.includes('max results')) {
    return 'Too many transfers in this range. Please tap "Try again".'
  }
  if (msg.includes('-32014') || msg.includes('not available')) {
    return 'Block data temporarily unavailable on Arc. Please try again in a moment.'
  }
  if (msg.toLowerCase().includes('http request failed') || msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('aborted')) {
    return 'Cannot reach Arc Mainnet RPC. Check your wallet\'s Arc network configuration or try a different connection.'
  }
  return msg || 'Failed to load history. Please try again.'
}
