/**
 * BridgeSheet — Bridge USDC from Arc Mainnet to other chains via Across Protocol.
 *
 * API: https://across.to/api (no key required)
 * SpokePool on Arc Mainnet: 0x9b4A302A548c7e313c2b74C461db7b84d3074A84
 *
 * Routes are loaded live from the Across available-routes endpoint.
 * Fees and output amount are fetched from suggested-fees before every deposit.
 * The user signs one USDC approve + one depositV3 transaction.
 * Transfer status is polled from the Across status endpoint.
 *
 * HONEST DISCLOSURES:
 * - Only routes confirmed by the Across API are shown.
 * - Amounts below the Across minimum deposit are rejected.
 * - The UI never marks a bridge as complete until the Across status API
 *   returns "filled".
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  useAccount, useConnectorClient, useReadContract, useWriteContract,
  useWaitForTransactionReceipt,
} from 'wagmi'
import { erc20Abi } from 'viem'
import { readContract } from 'viem/actions'
import {
  Loader2, ArrowRight, RefreshCw, CheckCircle2,
  AlertTriangle, ExternalLink, Info, ChevronDown,
} from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import {
  USDC_ADDRESS, formatAddress, formatUsdcDisplay, parseUsdcInput,
  isValidAddress, getTxExplorerUrl,
} from '@/utils'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

// ─── Constants ────────────────────────────────────────────────────────────────

const SPOKE_POOL = '0x9b4A302A548c7e313c2b74C461db7b84d3074A84' as `0x${string}`
const ACROSS_API = 'https://across.to/api'

// SpokePoolV3 depositV3 ABI (minimal)
const SPOKE_POOL_ABI = [
  {
    name: 'depositV3',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'depositor',            type: 'address' },
      { name: 'recipient',            type: 'address' },
      { name: 'inputToken',           type: 'address' },
      { name: 'outputToken',          type: 'address' },
      { name: 'inputAmount',          type: 'uint256' },
      { name: 'outputAmount',         type: 'uint256' },
      { name: 'destinationChainId',   type: 'uint256' },
      { name: 'exclusiveRelayer',     type: 'address' },
      { name: 'quoteTimestamp',       type: 'uint32'  },
      { name: 'fillDeadline',         type: 'uint32'  },
      { name: 'exclusivityDeadline',  type: 'uint32'  },
      { name: 'message',              type: 'bytes'   },
    ],
    outputs: [],
  },
] as const

// ─── Types ────────────────────────────────────────────────────────────────────

interface Route {
  originChainId:        number
  originToken:          `0x${string}`
  destinationChainId:   number
  destinationToken:     `0x${string}`
  originTokenSymbol:    string
  destinationTokenSymbol: string
}

interface Quote {
  outputAmount:         string   // raw USDC units (6 dec)
  totalRelayFeePct:     string   // e.g. "159400000000000" (1e18 = 100%)
  totalRelayFeeTotal:   string   // raw USDC units
  minDeposit:           string
  maxDeposit:           string
  spokePoolAddress:     `0x${string}`
  quoteTimestamp:       number
  fillDeadline:         number
  exclusiveRelayer:     `0x${string}`
  exclusivityDeadline:  number
  estimatedFillTimeSec: number
  quoteId:              string
}

type BridgeStep = 'form' | 'approve' | 'deposit' | 'pending' | 'complete' | 'error'

// ─── Chain name map ───────────────────────────────────────────────────────────

const CHAIN_NAMES: Record<number, string> = {
  1:     'Ethereum',
  10:    'Optimism',
  56:    'BNB Chain',
  130:   'Unichain',
  137:   'Polygon',
  143:   'Ink',
  324:   'zkSync Era',
  480:   'World Chain',
  999:   'Zora',
  1868:  'Soneium',
  4217:  'Path',
  4663:  'Goldfinch',
  8453:  'Base',
  42161: 'Arbitrum',
  43114: 'Avalanche',
  57073: 'Ink',
  59144: 'Linea',
}

function chainName(id: number): string {
  return CHAIN_NAMES[id] ?? `Chain ${id}`
}

function fmtUsdc(raw: string | bigint): string {
  const n = BigInt(raw)
  const whole = n / 1_000_000n
  const frac  = n % 1_000_000n
  const f2    = frac.toString().padStart(6, '0').slice(0, 2)
  return `${whole.toLocaleString('en-US')}.${f2}`
}

function feePct(pctStr: string): string {
  // pct is expressed as a fraction of 1e18
  const pct = Number(pctStr) / 1e18 * 100
  return pct.toFixed(3) + '%'
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props { onBack: () => void }

export function BridgeSheet({ onBack }: Props) {
  const { address, isConnected } = useAccount()
  const { data: walletClient }   = useConnectorClient({ chainId: ARC_MAINNET_CHAIN_ID })

  // ── State ──────────────────────────────────────────────────────────────────
  const [routes,      setRoutes]      = useState<Route[]>([])
  const [routesLoading, setRoutesLoading] = useState(true)
  const [routesError, setRoutesError] = useState<string | null>(null)

  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null)
  const [showRoutes,    setShowRoutes]    = useState(false)

  const [recipient,  setRecipient]  = useState('')
  const [amount,     setAmount]     = useState('')
  const [quote,      setQuote]      = useState<Quote | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError,   setQuoteError]   = useState<string | null>(null)

  const [step,     setStep]     = useState<BridgeStep>('form')
  const [errorMsg, setErrorMsg] = useState('')
  const [bridgeTxHash, setBridgeTxHash] = useState<`0x${string}` | undefined>()
  const [depositId,    setDepositId]    = useState<string | null>(null)
  const [fillStatus,   setFillStatus]   = useState<string>('pending')

  const quoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Balance (via wallet client, same pattern as Dashboard) ────────────────
  const [usdcBalance, setUsdcBalance] = useState<bigint | undefined>()
  useEffect(() => {
    if (!address || !walletClient) return
    void readContract(walletClient, {
      address: USDC_ADDRESS, abi: erc20Abi,
      functionName: 'balanceOf', args: [address],
    }).then(setUsdcBalance).catch(() => {})
  }, [address, walletClient])

  // ── Allowance check ────────────────────────────────────────────────────────
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address:      USDC_ADDRESS,
    abi:          erc20Abi,
    functionName: 'allowance',
    args:         address ? [address, SPOKE_POOL] : undefined,
    chainId:      ARC_MAINNET_CHAIN_ID,
    query:        { enabled: !!address },
  })

  // ── Write hooks ────────────────────────────────────────────────────────────
  const {
    writeContract:  writeApprove,
    data:           approveTxHash,
    isPending:      approveWalletPending,
    error:          approveWriteError,
    reset:          resetApprove,
  } = useWriteContract()

  const {
    isLoading: approveConfirming, isSuccess: approveSuccess, isError: approveError,
  } = useWaitForTransactionReceipt({ hash: approveTxHash, chainId: ARC_MAINNET_CHAIN_ID })

  const {
    writeContract:  writeDeposit,
    data:           depositTxHash,
    isPending:      depositWalletPending,
    error:          depositWriteError,
    reset:          resetDeposit,
  } = useWriteContract()

  const {
    isLoading: depositConfirming, isSuccess: depositSuccess, isError: depositTxError,
    data:      depositReceipt,
  } = useWaitForTransactionReceipt({ hash: depositTxHash, chainId: ARC_MAINNET_CHAIN_ID })

  // ── Load routes ────────────────────────────────────────────────────────────
  useEffect(() => {
    setRoutesLoading(true)
    setRoutesError(null)
    fetch(`${ACROSS_API}/available-routes?originChainId=5042`)
      .then(r => r.json())
      .then((data: Route[]) => {
        // Deduplicate by destinationChainId (prefer native USDC over bridged)
        const seen = new Set<number>()
        const unique: Route[] = []
        for (const r of data) {
          if (!seen.has(r.destinationChainId) ||
              r.destinationTokenSymbol === 'USDC') {
            seen.add(r.destinationChainId)
            unique.push(r)
          }
        }
        // Sort by chain name
        unique.sort((a, b) =>
          chainName(a.destinationChainId).localeCompare(chainName(b.destinationChainId)))
        setRoutes(unique)
        if (unique.length > 0) setSelectedRoute(unique[0])
      })
      .catch(() => setRoutesError('Failed to load available routes. Check your connection.'))
      .finally(() => setRoutesLoading(false))
  }, [])

  // ── Fetch quote ────────────────────────────────────────────────────────────
  const fetchQuote = useCallback(async (route: Route, inputAmount: string) => {
    const parsed = parseUsdcInput(inputAmount)
    if (!parsed || parsed <= 0n || !route) { setQuote(null); return }

    setQuoteLoading(true)
    setQuoteError(null)
    try {
      const params = new URLSearchParams({
        inputToken:           route.originToken,
        outputToken:          route.destinationToken,
        originChainId:        String(route.originChainId),
        destinationChainId:   String(route.destinationChainId),
        amount:               parsed.toString(),
      })
      const resp  = await fetch(`${ACROSS_API}/suggested-fees?${params}`)
      const data  = await resp.json() as {
        outputAmount: string
        totalRelayFee: { pct: string; total: string }
        limits: { minDeposit: string; maxDeposit: string }
        spokePoolAddress: string
        timestamp: string
        fillDeadline: string
        exclusiveRelayer: string
        exclusivityDeadline: number
        estimatedFillTimeSec: number
        id: string
        isAmountTooLow?: boolean
      }
      if ('errorCode' in data) throw new Error(String((data as { message?: string }).message ?? 'Quote failed'))
      if (data.isAmountTooLow) {
        setQuoteError(`Amount too low. Minimum: ${fmtUsdc(data.limits.minDeposit)} USDC`)
        setQuote(null)
        return
      }
      if (parsed > BigInt(data.limits.maxDeposit)) {
        setQuoteError(`Amount exceeds maximum: ${fmtUsdc(data.limits.maxDeposit)} USDC`)
        setQuote(null)
        return
      }
      setQuote({
        outputAmount:        data.outputAmount,
        totalRelayFeePct:    data.totalRelayFee.pct,
        totalRelayFeeTotal:  data.totalRelayFee.total,
        minDeposit:          data.limits.minDeposit,
        maxDeposit:          data.limits.maxDeposit,
        spokePoolAddress:    data.spokePoolAddress as `0x${string}`,
        quoteTimestamp:      Number(data.timestamp),
        fillDeadline:        Number(data.fillDeadline),
        exclusiveRelayer:    data.exclusiveRelayer as `0x${string}`,
        exclusivityDeadline: data.exclusivityDeadline,
        estimatedFillTimeSec: data.estimatedFillTimeSec,
        quoteId:             data.id,
      })
    } catch (e) {
      setQuoteError(e instanceof Error ? e.message : 'Failed to get quote')
      setQuote(null)
    } finally {
      setQuoteLoading(false)
    }
  }, [])

  // Debounce quote refresh when amount/route changes
  useEffect(() => {
    if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current)
    if (!selectedRoute || !amount) { setQuote(null); return }
    quoteTimerRef.current = setTimeout(() => {
      void fetchQuote(selectedRoute, amount)
    }, 600)
    return () => { if (quoteTimerRef.current) clearTimeout(quoteTimerRef.current) }
  }, [selectedRoute, amount, fetchQuote])

  // ── Handle approve success → trigger deposit ──────────────────────────────
  useEffect(() => {
    if (approveSuccess && step === 'approve') {
      void refetchAllowance()
      triggerDeposit()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveSuccess, step])

  useEffect(() => {
    if (approveWriteError && step === 'approve') {
      setErrorMsg(approveWriteError.message?.includes('rejected') || approveWriteError.message?.includes('denied')
        ? 'Approval cancelled.' : 'Approval failed. Please try again.')
      setStep('error')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveWriteError])

  // ── Handle deposit tx confirmed ───────────────────────────────────────────
  useEffect(() => {
    if (depositSuccess && step === 'deposit') {
      setBridgeTxHash(depositTxHash)
      setStep('pending')
      // Extract depositId from tx logs (topic[1] of V3FundsDeposited)
      if (depositReceipt) {
        const v3Topic = '0xa123dc29aebf7d0c3322c8eeb5b999e859f39937950ed31056a62096e9b4e1c0'
        const log = depositReceipt.logs.find(l => l.topics[0] === v3Topic)
        if (log?.topics[1]) {
          setDepositId(BigInt(log.topics[1]).toString())
        }
      }
    }
    if (depositTxError && step === 'deposit') {
      setErrorMsg('Deposit transaction failed onchain.')
      setStep('error')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositSuccess, depositTxError, step])

  useEffect(() => {
    if (depositWriteError && step === 'deposit') {
      setErrorMsg(depositWriteError.message?.includes('rejected') || depositWriteError.message?.includes('denied')
        ? 'Transaction cancelled.'
        : 'Deposit failed. Please try again.')
      setStep('error')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositWriteError])

  // ── Poll fill status after deposit confirmed ──────────────────────────────
  useEffect(() => {
    if (step !== 'pending' || !bridgeTxHash) return
    let cancelled = false
    const poll = async () => {
      for (let attempt = 0; attempt < 60 && !cancelled; attempt++) {
        await new Promise(r => setTimeout(r, 5000))
        if (cancelled) break
        try {
          const params = new URLSearchParams({ originChainId: '5042', depositTxHash: bridgeTxHash })
          const resp = await fetch(`${ACROSS_API}/deposit/status?${params}`)
          const data = await resp.json() as { status: string; fillTxHash?: string }
          setFillStatus(data.status ?? 'pending')
          if (data.status === 'filled') {
            setStep('complete')
            break
          }
          if (data.status === 'expired') {
            setErrorMsg('Bridge deposit expired before it could be filled. Funds will be returned.')
            setStep('error')
            break
          }
        } catch { /* network hiccup — keep polling */ }
      }
    }
    void poll()
    return () => { cancelled = true }
  }, [step, bridgeTxHash])

  // ── Submit flow ───────────────────────────────────────────────────────────

  function triggerDeposit() {
    if (!quote || !selectedRoute || !address || !parsedAmt) return
    setStep('deposit')
    const recipientAddr = (recipient.trim() || address) as `0x${string}`
    writeDeposit({
      address:      SPOKE_POOL,
      abi:          SPOKE_POOL_ABI,
      functionName: 'depositV3',
      args: [
        address,
        recipientAddr,
        USDC_ADDRESS,
        selectedRoute.destinationToken,
        parsedAmt,
        BigInt(quote.outputAmount),
        BigInt(selectedRoute.destinationChainId),
        quote.exclusiveRelayer,
        quote.quoteTimestamp,
        quote.fillDeadline,
        quote.exclusivityDeadline,
        '0x',
      ],
      chainId: ARC_MAINNET_CHAIN_ID,
    })
  }

  function handleBridge() {
    if (!quote || !parsedAmt || !address) return
    resetApprove(); resetDeposit()
    const needed = parsedAmt
    const current = allowance ?? 0n
    if (current >= needed) {
      triggerDeposit()
    } else {
      setStep('approve')
      writeApprove({
        address: USDC_ADDRESS, abi: erc20Abi, functionName: 'approve',
        args: [SPOKE_POOL, needed],
        chainId: ARC_MAINNET_CHAIN_ID,
      })
    }
  }

  function handleReset() {
    setStep('form')
    setErrorMsg('')
    setQuote(null)
    setDepositId(null)
    setBridgeTxHash(undefined)
    setFillStatus('pending')
    setAmount('')
    resetApprove(); resetDeposit()
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const parsedAmt   = parseUsdcInput(amount)
  const recipientOk = !recipient.trim() || isValidAddress(recipient.trim())
  const canBridge   = !!(quote && parsedAmt && parsedAmt > 0n && recipientOk && usdcBalance != null && usdcBalance >= parsedAmt)

  // ── Not connected ─────────────────────────────────────────────────────────
  if (!isConnected || !address) {
    return (
      <ScreenLayout title="Bridge" subtitle="Move USDC to another chain via Across" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to bridge USDC." />
      </ScreenLayout>
    )
  }

  // ── Success / pending ─────────────────────────────────────────────────────
  if (step === 'complete') {
    return (
      <ScreenLayout title="Bridge" subtitle="Transfer complete" onBack={onBack}>
        <div className="flex flex-col items-center gap-5 py-8 text-center">
          <div className="flex size-20 items-center justify-center rounded-[24px]"
            style={{ background: 'rgba(34,217,135,0.12)', border: '1px solid rgba(34,217,135,0.22)' }}>
            <CheckCircle2 className="size-10" style={{ color: 'var(--success)' }} />
          </div>
          <div>
            <p className="display text-xl font-bold mb-1" style={{ color: 'var(--ink)' }}>Bridge Complete</p>
            <p className="text-sm" style={{ color: 'var(--ink-3)' }}>
              Your USDC has arrived on{' '}
              <span className="font-semibold" style={{ color: 'var(--success)' }}>
                {selectedRoute ? chainName(selectedRoute.destinationChainId) : ''}
              </span>.
            </p>
          </div>
          {bridgeTxHash && (
            <a href={getTxExplorerUrl(bridgeTxHash)} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs font-semibold hover:underline"
              style={{ color: 'var(--blue)' }}>
              View deposit on Arc Explorer <ExternalLink className="size-3" />
            </a>
          )}
          <button onClick={handleReset}
            className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
            style={{ background: 'var(--blue)', color: '#04090f' }}>
            Bridge again
          </button>
        </div>
      </ScreenLayout>
    )
  }

  if (step === 'pending') {
    return (
      <ScreenLayout title="Bridge" subtitle="Waiting for fill…" onBack={onBack}>
        <div className="flex flex-col items-center gap-5 py-8 text-center">
          <Loader2 className="size-12 animate-spin" style={{ color: 'var(--blue)' }} />
          <div>
            <p className="display text-lg font-bold mb-1" style={{ color: 'var(--ink)' }}>
              Bridging in progress
            </p>
            <p className="text-sm" style={{ color: 'var(--ink-3)' }}>
              Status: <span className="font-semibold capitalize" style={{ color: 'var(--blue)' }}>{fillStatus}</span>
            </p>
            {quote && (
              <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
                Expected fill: ~{quote.estimatedFillTimeSec}s
              </p>
            )}
          </div>
          {bridgeTxHash && (
            <a href={getTxExplorerUrl(bridgeTxHash)} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs font-semibold hover:underline"
              style={{ color: 'var(--blue)' }}>
              View deposit on Arc Explorer <ExternalLink className="size-3" />
            </a>
          )}
          <p className="text-xs px-6" style={{ color: 'var(--subtle)' }}>
            Your Arc USDC is locked. A relayer is filling the order on the destination chain.
            Do not close this page — it will poll for up to 5 minutes.
          </p>
        </div>
      </ScreenLayout>
    )
  }

  if (step === 'error') {
    return (
      <ScreenLayout title="Bridge" subtitle="Bridge failed" onBack={onBack}>
        <div className="flex flex-col items-center gap-5 py-8 text-center">
          <div className="flex size-20 items-center justify-center rounded-[24px]"
            style={{ background: 'rgba(255,80,80,0.10)', border: '1px solid rgba(255,80,80,0.20)' }}>
            <AlertTriangle className="size-10" style={{ color: 'var(--danger)' }} />
          </div>
          <div>
            <p className="display text-xl font-bold mb-1" style={{ color: 'var(--danger)' }}>Bridge Failed</p>
            <p className="text-sm" style={{ color: 'var(--ink-3)' }}>{errorMsg}</p>
          </div>
          <button onClick={handleReset}
            className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
            style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}>
            Try again
          </button>
        </div>
      </ScreenLayout>
    )
  }

  const isTxStep = step === 'approve' || step === 'deposit'

  return (
    <ScreenLayout title="Bridge" subtitle="Move USDC to another chain via Across" onBack={onBack}>

      {/* ── Routes loading ─────────────────────────────────────────────────── */}
      {routesLoading && (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blue)' }} />
          <span className="text-sm" style={{ color: 'var(--ink-3)' }}>Loading available routes…</span>
        </div>
      )}
      {routesError && (
        <div className="rounded-[14px] px-4 py-3 text-sm flex items-start gap-2"
          style={{ background: 'rgba(255,80,80,0.08)', border: '1px solid rgba(255,80,80,0.20)', color: 'var(--danger)' }}>
          <AlertTriangle className="size-4 mt-0.5 shrink-0" /> {routesError}
        </div>
      )}

      {/* ── Destination chain picker ──────────────────────────────────────── */}
      {!routesLoading && !routesError && routes.length > 0 && (
        <div className="space-y-1.5">
          <label className="section-label">Destination Chain</label>
          <div className="relative">
            <button
              onClick={() => setShowRoutes(v => !v)}
              className="w-full flex items-center justify-between rounded-[14px] px-4 py-3 text-sm font-semibold transition-all hover:brightness-110"
              style={{ background: 'var(--card)', border: '1px solid var(--card-border)', color: 'var(--ink)' }}
            >
              <span>
                {selectedRoute ? `${chainName(selectedRoute.destinationChainId)} — ${selectedRoute.destinationTokenSymbol}` : 'Select chain'}
              </span>
              <ChevronDown className="size-4" style={{ color: 'var(--muted)' }} />
            </button>
            {showRoutes && (
              <div className="absolute z-20 mt-1 w-full rounded-[14px] overflow-hidden"
                style={{ background: 'var(--card)', border: '1px solid var(--card-border)', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
                {routes.map(r => (
                  <button
                    key={`${r.destinationChainId}-${r.destinationToken}`}
                    onClick={() => { setSelectedRoute(r); setShowRoutes(false) }}
                    className="w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left"
                    style={{ borderTop: '1px solid rgba(255,255,255,0.04)', color: 'var(--ink-2)' }}
                  >
                    <span className="font-semibold">{chainName(r.destinationChainId)}</span>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{r.destinationTokenSymbol}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Amount ───────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="section-label">Amount (USDC)</label>
          {usdcBalance != null && (
            <button
              className="text-[11px] font-semibold hover:underline"
              style={{ color: 'var(--blue)' }}
              onClick={() => setAmount(formatUsdcDisplay(usdcBalance))}
            >
              Max: {formatUsdcDisplay(usdcBalance)}
            </button>
          )}
        </div>
        <input
          type="text" inputMode="decimal" placeholder="0.00"
          value={amount}
          onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          className="w-full rounded-[14px] px-4 py-3 text-base font-semibold tabular-nums outline-none transition-all"
          style={{
            background: 'var(--card)', border: '1px solid var(--card-border)',
            color: 'var(--ink)',
          }}
          disabled={isTxStep}
        />
      </div>

      {/* ── Recipient (optional) ─────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <label className="section-label">Recipient on destination (optional)</label>
        <input
          type="text" placeholder={`Default: your address (${formatAddress(address)})`}
          value={recipient}
          onChange={e => setRecipient(e.target.value.trim())}
          className="w-full rounded-[14px] px-4 py-3 text-xs mono outline-none transition-all"
          style={{
            background: 'var(--card)', border: `1px solid ${recipient && !recipientOk ? 'rgba(255,80,80,0.4)' : 'var(--card-border)'}`,
            color: 'var(--ink)',
          }}
          disabled={isTxStep}
        />
        {recipient && !recipientOk && (
          <p className="text-xs" style={{ color: 'var(--danger)' }}>Invalid address</p>
        )}
      </div>

      {/* ── Quote ─────────────────────────────────────────────────────────────── */}
      {quoteLoading && (
        <div className="flex items-center gap-2 py-1">
          <Loader2 className="size-3.5 animate-spin" style={{ color: 'var(--blue)' }} />
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Getting quote…</span>
        </div>
      )}
      {quoteError && (
        <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>{quoteError}</p>
      )}
      {quote && !quoteLoading && (
        <div className="rounded-[16px] p-4 space-y-2.5"
          style={{ background: 'rgba(78,155,255,0.06)', border: '1px solid rgba(78,155,255,0.18)' }}>
          <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--blue)' }}>
            Quote (live · expires in ~60s)
          </p>
          {[
            ['You send',     `${fmtUsdc(parsedAmt ?? 0n)} USDC on Arc`],
            ['You receive',  `${fmtUsdc(quote.outputAmount)} ${selectedRoute?.destinationTokenSymbol ?? 'USDC'} on ${selectedRoute ? chainName(selectedRoute.destinationChainId) : ''}`],
            ['Relay fee',    `${fmtUsdc(quote.totalRelayFeeTotal)} USDC (${feePct(quote.totalRelayFeePct)})`],
            ['Est. fill',    `~${quote.estimatedFillTimeSec}s`],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-xs">
              <span style={{ color: 'var(--subtle)' }}>{k}</span>
              <span className="font-semibold text-right max-w-[60%]" style={{ color: 'var(--ink-2)' }}>{v}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Step status ───────────────────────────────────────────────────────── */}
      {isTxStep && (
        <div className="rounded-[14px] px-4 py-3 flex items-center gap-3"
          style={{ background: 'rgba(78,155,255,0.08)', border: '1px solid rgba(78,155,255,0.20)' }}>
          <Loader2 className="size-4 animate-spin shrink-0" style={{ color: 'var(--blue)' }} />
          <div>
            <p className="text-sm font-bold" style={{ color: 'var(--ink)' }}>
              {step === 'approve'
                ? (approveConfirming ? 'Confirming approval…' : 'Approve USDC in your wallet')
                : (depositConfirming ? 'Confirming deposit…' : 'Confirm deposit in your wallet')}
            </p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--subtle)' }}>
              {step === 'approve' ? 'Step 1 of 2 — Approve USDC spending' : 'Step 2 of 2 — Deposit to Across SpokePool'}
            </p>
          </div>
        </div>
      )}

      {/* ── Disclaimer ─────────────────────────────────────────────────────────── */}
      <div className="rounded-[14px] px-3.5 py-3 flex items-start gap-2.5"
        style={{ background: 'rgba(255,176,32,0.06)', border: '1px solid rgba(255,176,32,0.16)' }}>
        <Info className="size-4 mt-0.5 shrink-0" style={{ color: '#ffb020' }} />
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
          Bridging uses Across Protocol. Transactions on Arc Mainnet involve real USDC and are irreversible.
          Always verify amounts and destination before confirming.
        </p>
      </div>

      {/* ── CTA ──────────────────────────────────────────────────────────────────── */}
      <button
        onClick={handleBridge}
        disabled={!canBridge || isTxStep || approveWalletPending || depositWalletPending}
        className="w-full rounded-[16px] py-4 text-sm font-bold flex items-center justify-center gap-2 transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: 'var(--blue)', color: '#04090f' }}
      >
        {(approveWalletPending || depositWalletPending || approveConfirming || depositConfirming)
          ? <><Loader2 className="size-4 animate-spin" /> Processing…</>
          : <>{fmtUsdc(parsedAmt ?? 0n)} USDC <ArrowRight className="size-4" /> {selectedRoute ? chainName(selectedRoute.destinationChainId) : '…'}</>
        }
      </button>

      <p className="text-center text-xs pb-2" style={{ color: 'var(--subtle)' }}>
        Powered by{' '}
        <a href="https://across.to" target="_blank" rel="noopener noreferrer"
          className="hover:underline" style={{ color: 'var(--blue)' }}>Across Protocol</a>
      </p>
    </ScreenLayout>
  )
}
