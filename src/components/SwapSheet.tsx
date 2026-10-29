/**
 * SwapSheet — Token swap on Arc Mainnet via Uniswap V3.
 *
 * TOKEN LIST: All 5 tokens are from the official Arc Mainnet contract-addresses
 * page (https://docs.arc.io/arc/references/contract-addresses.md) and verified
 * on-chain: USDC, EURC, USYC, cirBTC, WETH.
 *
 * POOL STATUS: Uniswap V3 factory is deployed at the standard address on Arc.
 * The component checks on-chain pool existence before quoting — if no pool exists
 * for a pair it says so clearly rather than fabricating a quote.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useConnectorClient } from 'wagmi'
import { createPublicClient, custom, formatUnits } from 'viem'
import {
  ArrowDownUp, Loader2, Info, AlertTriangle, RefreshCw,
  Search, ChevronDown, X, CheckCircle2,
} from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import { USDC_ADDRESS, parseUsdcInput } from '@/utils'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

// ─── Contracts ────────────────────────────────────────────────────────────────

const UNI_FACTORY   = '0x1F98431c8aD98523631AE4a59f267346ea31F984' as const
const UNI_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e' as const

const FACTORY_ABI = [
  {
    name: 'getPool',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee',    type: 'uint24'  },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const

const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut',              type: 'uint256' },
      { name: 'sqrtPriceX96After',      type: 'uint160' },
      { name: 'initializedTicksCrossed',type: 'uint32'  },
      { name: 'gasEstimate',            type: 'uint256' },
    ],
  },
] as const

// ─── Verified Arc Mainnet token list ─────────────────────────────────────────
// All addresses from https://docs.arc.io/arc/references/contract-addresses.md
// Decimals verified on-chain (eth_call to decimals()).

interface Token {
  address:  `0x${string}`
  symbol:   string
  decimals: number
  name:     string
  /** Brief description shown in the token picker */
  description: string
}

const TOKEN_LIST: Token[] = [
  {
    address:     USDC_ADDRESS,
    symbol:      'USDC',
    decimals:    6,
    name:        'USD Coin',
    description: 'Native USDC — Arc gas token (ERC-20 interface)',
  },
  {
    address:     '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    symbol:      'EURC',
    decimals:    6,
    name:        'Euro Coin',
    description: 'Euro-denominated stablecoin by Circle',
  },
  {
    address:     '0x8a5D989Bbb96929F689B0200f435f53dA42bF490',
    symbol:      'USYC',
    decimals:    6,
    name:        'US Yield Coin',
    description: 'Yield-bearing token backed by US Treasuries (allowlisted)',
  },
  {
    address:     '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
    symbol:      'cirBTC',
    decimals:    8,
    name:        'Circle Wrapped Bitcoin',
    description: 'Circle wrapped Bitcoin on Arc',
  },
  {
    address:     '0x128cC466B61f542da60c70e3aA11c10e19B84EDB',
    symbol:      'WETH',
    decimals:    18,
    name:        'Wrapped Ether',
    description: 'Bridged WETH (lock Ethereum, mint on Arc)',
  },
]

// ─── Fee tiers ────────────────────────────────────────────────────────────────

const FEE_TIERS = [500, 3000, 10000] as const
type FeeTier = typeof FEE_TIERS[number]
const FEE_LABELS: Record<FeeTier, string> = { 500: '0.05%', 3000: '0.30%', 10000: '1.00%' }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTokenAmount(raw: bigint, decimals: number): string {
  const s = formatUnits(raw, decimals)
  // Trim to 6 significant decimal places for display
  const num = parseFloat(s)
  if (num === 0) return '0'
  if (num >= 1)  return num.toLocaleString('en-US', { maximumFractionDigits: 4 })
  return num.toPrecision(6).replace(/\.?0+$/, '')
}

function parseTokenAmount(value: string, decimals: number): bigint | null {
  const clean = value.replace(/[^0-9.]/g, '')
  if (!clean || clean === '.') return null
  try {
    const [whole = '0', frac = ''] = clean.split('.')
    const fracPadded = frac.slice(0, decimals).padEnd(decimals, '0')
    const result = BigInt(whole) * BigInt(10 ** decimals) + BigInt(fracPadded || 0)
    return result > 0n ? result : null
  } catch { return null }
}

// ─── TokenPicker modal ───────────────────────────────────────────────────────

interface TokenPickerProps {
  exclude:     `0x${string}` | null
  selected:    Token | null
  onSelect:    (t: Token) => void
  onClose:     () => void
}

function TokenPicker({ exclude, selected, onSelect, onClose }: TokenPickerProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const filtered = TOKEN_LIST.filter(t => {
    if (exclude && t.address.toLowerCase() === exclude.toLowerCase()) return false
    if (!query) return true
    const q = query.toLowerCase()
    return (
      t.symbol.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.address.toLowerCase().includes(q)
    )
  })

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-end justify-center"
      style={{ background: 'rgba(4,9,15,0.80)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      {/* Sheet */}
      <div
        className="w-full max-w-md rounded-t-[28px] flex flex-col"
        style={{
          background: 'linear-gradient(160deg,#0d1e38 0%,#091526 60%,#0b1a2e 100%)',
          border: '1px solid rgba(78,155,255,0.14)',
          maxHeight: '82vh',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="font-bold text-base" style={{ color: 'var(--ink)', letterSpacing: '-0.03em' }}>
            Select token
          </h3>
          <button
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-full transition-all hover:brightness-110"
            style={{ background: 'rgba(78,155,255,0.10)', color: 'var(--blue)' }}
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 pb-3">
          <div
            className="flex items-center gap-2.5 rounded-[14px] px-3.5 py-2.5"
            style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}
          >
            <Search className="size-4 shrink-0" style={{ color: 'var(--muted)' }} />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search by name, symbol, or address…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--ink)' }}
            />
            {query && (
              <button onClick={() => setQuery('')} className="shrink-0" style={{ color: 'var(--muted)' }}>
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Token count hint */}
        <p className="px-5 pb-1.5 text-[11px]" style={{ color: 'var(--subtle)' }}>
          {filtered.length === 0
            ? 'No tokens match your search.'
            : `${filtered.length} verified Arc Mainnet token${filtered.length !== 1 ? 's' : ''}`}
        </p>

        {/* List */}
        <div className="overflow-y-auto flex-1 px-3 pb-6 space-y-1.5">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center py-10 gap-3 text-center">
              <AlertTriangle className="size-8" style={{ color: 'var(--subtle)' }} />
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                No results for <span className="font-bold" style={{ color: 'var(--ink-2)' }}>"{query}"</span>
              </p>
              <p className="text-xs max-w-[220px] leading-relaxed" style={{ color: 'var(--subtle)' }}>
                Only tokens with verified Arc Mainnet deployments are shown.
                Custom token import is not supported to avoid scams.
              </p>
            </div>
          ) : (
            filtered.map(t => {
              const isSelected = selected?.address.toLowerCase() === t.address.toLowerCase()
              return (
                <button
                  key={t.address}
                  onClick={() => { onSelect(t); onClose() }}
                  className="w-full flex items-center gap-3 rounded-[16px] px-3.5 py-3 text-left transition-all hover:brightness-110 active:scale-[0.99]"
                  style={{
                    background: isSelected ? 'rgba(78,155,255,0.12)' : 'var(--card)',
                    border: `1px solid ${isSelected ? 'rgba(78,155,255,0.30)' : 'var(--card-border)'}`,
                  }}
                >
                  {/* Token icon placeholder */}
                  <div
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={{
                      background: 'linear-gradient(135deg,rgba(78,155,255,0.18) 0%,rgba(157,120,251,0.12) 100%)',
                      border: '1px solid rgba(78,155,255,0.20)',
                      color: 'var(--blue)',
                    }}
                  >
                    {t.symbol.slice(0, 3)}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-sm" style={{ color: 'var(--ink)' }}>{t.symbol}</span>
                      <span
                        className="text-[9px] font-bold px-1 rounded"
                        style={{ background: 'rgba(34,217,135,0.10)', color: 'var(--success)', border: '1px solid rgba(34,217,135,0.18)' }}
                      >
                        verified
                      </span>
                    </div>
                    <p className="text-xs truncate mt-0.5" style={{ color: 'var(--muted)' }}>{t.description}</p>
                    <p className="text-[10px] mono truncate mt-px" style={{ color: 'var(--subtle)' }}>
                      {t.address.slice(0, 10)}…{t.address.slice(-6)} · {t.decimals} decimals
                    </p>
                  </div>

                  {isSelected && (
                    <CheckCircle2 className="size-4 shrink-0" style={{ color: 'var(--blue)' }} />
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props { onBack: () => void }

export function SwapSheet({ onBack }: Props) {
  const { address, isConnected } = useAccount()
  const { data: walletClient }   = useConnectorClient({ chainId: ARC_MAINNET_CHAIN_ID })

  const [tokenIn,  setTokenIn]  = useState<Token>(TOKEN_LIST[0])
  const [tokenOut, setTokenOut] = useState<Token | null>(null)
  const [amount,   setAmount]   = useState('')
  const [feeTier,  setFeeTier]  = useState<FeeTier>(3000)

  // Token picker open state: 'in' | 'out' | null
  const [pickerFor, setPickerFor] = useState<'in' | 'out' | null>(null)

  const [poolAddress,  setPoolAddress]  = useState<string | null>(null)
  const [poolChecking, setPoolChecking] = useState(false)
  const [poolError,    setPoolError]    = useState<string | null>(null)

  const [quoteOut,     setQuoteOut]     = useState<bigint | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError,   setQuoteError]   = useState<string | null>(null)

  const publicClient = walletClient
    ? createPublicClient({ chain: walletClient.chain, transport: custom(walletClient.transport) })
    : null

  // ── Check pool existence ──────────────────────────────────────────────────
  const checkPool = useCallback(async (tIn: Token, tOut: Token, fee: FeeTier) => {
    if (!publicClient) return
    setPoolChecking(true)
    setPoolError(null)
    setPoolAddress(null)
    setQuoteOut(null)
    try {
      const pool = await publicClient.readContract({
        address:      UNI_FACTORY,
        abi:          FACTORY_ABI,
        functionName: 'getPool',
        args:         [tIn.address, tOut.address, fee],
      })
      const zeroAddr = '0x0000000000000000000000000000000000000000'
      if (!pool || pool.toLowerCase() === zeroAddr) {
        setPoolError(
          `No Uniswap V3 pool found for ${tIn.symbol}/${tOut.symbol} at the ${FEE_LABELS[fee]} fee tier on Arc Mainnet. ` +
          `Try a different fee tier, or liquidity for this pair may not have been provided yet.`
        )
      } else {
        setPoolAddress(pool)
      }
    } catch (e) {
      setPoolError(`Pool check failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPoolChecking(false)
    }
  }, [publicClient])

  useEffect(() => {
    if (!tokenOut || !publicClient) return
    void checkPool(tokenIn, tokenOut, feeTier)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenIn, tokenOut, feeTier, publicClient])

  // ── Get quote ─────────────────────────────────────────────────────────────
  const fetchQuote = useCallback(async () => {
    if (!publicClient || !tokenOut || !poolAddress) return
    const parsed = parseTokenAmount(amount, tokenIn.decimals)
    if (!parsed || parsed <= 0n) { setQuoteOut(null); return }

    setQuoteLoading(true)
    setQuoteError(null)
    try {
      const result = await publicClient.readContract({
        address:      UNI_QUOTER_V2,
        abi:          QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [{
          tokenIn:           tokenIn.address,
          tokenOut:          tokenOut.address,
          amountIn:          parsed,
          fee:               feeTier,
          sqrtPriceLimitX96: 0n,
        }],
      })
      setQuoteOut(result[0])
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('revert') || msg.includes('execution reverted')) {
        setQuoteError('No route — the pool exists but has insufficient liquidity for this amount.')
      } else {
        setQuoteError(`Quote failed: ${msg}`)
      }
      setQuoteOut(null)
    } finally {
      setQuoteLoading(false)
    }
  }, [publicClient, tokenOut, poolAddress, amount, tokenIn, feeTier])

  useEffect(() => {
    if (!amount || !poolAddress || !tokenOut) return
    const timer = setTimeout(() => { void fetchQuote() }, 600)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, poolAddress, tokenOut, fetchQuote])

  // Reset quote when tokens change
  useEffect(() => {
    setQuoteOut(null)
    setQuoteError(null)
  }, [tokenIn, tokenOut, feeTier])

  // ── Swap direction ────────────────────────────────────────────────────────
  function flipTokens() {
    if (!tokenOut) return
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmount('')
    setQuoteOut(null)
    setQuoteError(null)
  }

  if (!isConnected || !address) {
    return (
      <ScreenLayout title="Swap" subtitle="Token swap on Arc Mainnet" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to swap tokens." />
      </ScreenLayout>
    )
  }

  const amtValid     = parseTokenAmount(amount, tokenIn.decimals) !== null
  const canSwap      = !!poolAddress && !!quoteOut && amtValid

  const primaryBtnLabel = !tokenOut
    ? 'Select a receive token'
    : poolError
      ? 'No pool available'
      : !amount
        ? 'Enter an amount'
        : !amtValid
          ? 'Invalid amount'
          : quoteLoading
            ? 'Getting quote…'
            : !quoteOut
              ? 'No quote available'
              : 'Swap (coming soon)'

  return (
    <>
      <ScreenLayout title="Swap" subtitle="Uniswap V3 · Arc Mainnet" onBack={onBack}>

        {/* ── Status notice ──────────────────────────────────────────────────── */}
        <div
          className="rounded-[14px] px-3.5 py-3 flex items-start gap-2.5"
          style={{ background: 'rgba(255,176,32,0.08)', border: '1px solid rgba(255,176,32,0.20)' }}
        >
          <Info className="size-4 mt-0.5 shrink-0" style={{ color: '#ffb020' }} />
          <div className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
            <p className="font-semibold mb-0.5" style={{ color: '#ffb020' }}>Limited liquidity on Arc Mainnet</p>
            <p>
              Uniswap V3 is deployed on Arc. Pool existence and quotes are checked on-chain in real time.
              If no pool exists for a pair, the swap button stays disabled — no fake quotes.
            </p>
          </div>
        </div>

        {/* ── You send ──────────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <label className="section-label">You send</label>
          <div
            className="flex items-center gap-2 rounded-[18px] p-3"
            style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}
          >
            {/* Token button */}
            <button
              onClick={() => setPickerFor('in')}
              className="flex items-center gap-1.5 rounded-[12px] px-3 py-2 shrink-0 transition-all hover:brightness-110"
              style={{ background: 'rgba(78,155,255,0.10)', border: '1px solid rgba(78,155,255,0.18)' }}
            >
              <span className="text-sm font-bold" style={{ color: 'var(--ink)' }}>{tokenIn.symbol}</span>
              <ChevronDown className="size-3.5" style={{ color: 'var(--muted)' }} />
            </button>
            {/* Amount input */}
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              className="flex-1 bg-transparent outline-none text-right text-lg font-semibold tabular-nums"
              style={{ color: 'var(--ink)' }}
            />
          </div>
        </div>

        {/* ── Swap direction button ──────────────────────────────────────────── */}
        <div className="flex justify-center -my-1">
          <button
            className="flex size-9 items-center justify-center rounded-full transition-all hover:brightness-110 active:scale-90"
            style={{ background: 'rgba(78,155,255,0.12)', border: '1px solid rgba(78,155,255,0.22)' }}
            onClick={flipTokens}
            disabled={!tokenOut}
            aria-label="Flip tokens"
          >
            <ArrowDownUp className="size-4" style={{ color: 'var(--blue)' }} />
          </button>
        </div>

        {/* ── You receive ───────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <label className="section-label">You receive</label>
          <div
            className="flex items-center gap-2 rounded-[18px] p-3"
            style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}
          >
            {/* Token selector button */}
            <button
              onClick={() => setPickerFor('out')}
              className="flex items-center gap-1.5 rounded-[12px] px-3 py-2 shrink-0 transition-all hover:brightness-110"
              style={{
                background: tokenOut ? 'rgba(78,155,255,0.10)' : 'rgba(78,155,255,0.18)',
                border: `1px solid ${tokenOut ? 'rgba(78,155,255,0.18)' : 'rgba(78,155,255,0.35)'}`,
              }}
            >
              <span
                className="text-sm font-bold"
                style={{ color: tokenOut ? 'var(--ink)' : 'var(--blue)' }}
              >
                {tokenOut ? tokenOut.symbol : 'Select token'}
              </span>
              <ChevronDown className="size-3.5" style={{ color: 'var(--muted)' }} />
            </button>

            {/* Quote output */}
            <div className="flex-1 flex justify-end items-center">
              {quoteLoading
                ? <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blue)' }} />
                : quoteOut != null && tokenOut
                  ? <span className="text-lg font-semibold tabular-nums" style={{ color: 'var(--success)' }}>
                      {formatTokenAmount(quoteOut, tokenOut.decimals)}
                    </span>
                  : <span className="text-sm" style={{ color: 'var(--subtle)' }}>
                      {tokenOut ? '—' : ''}
                    </span>
              }
            </div>
          </div>
        </div>

        {/* ── Fee tier ──────────────────────────────────────────────────────── */}
        <div className="space-y-1.5">
          <label className="section-label">Fee tier</label>
          <div className="flex gap-1.5">
            {FEE_TIERS.map(fee => (
              <button
                key={fee}
                onClick={() => setFeeTier(fee)}
                className="flex-1 rounded-[12px] py-2 text-xs font-bold transition-all"
                style={{
                  background: feeTier === fee ? 'rgba(78,155,255,0.20)' : 'var(--card)',
                  border: `1px solid ${feeTier === fee ? 'rgba(78,155,255,0.35)' : 'var(--card-border)'}`,
                  color: feeTier === fee ? 'var(--blue)' : 'var(--muted)',
                }}
              >
                {FEE_LABELS[fee]}
              </button>
            ))}
          </div>
        </div>

        {/* ── Pool status ───────────────────────────────────────────────────── */}
        {tokenOut && (
          <>
            {poolChecking && (
              <div className="flex items-center gap-2 py-1">
                <Loader2 className="size-3.5 animate-spin" style={{ color: 'var(--blue)' }} />
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  Checking pool for {tokenIn.symbol}/{tokenOut.symbol}…
                </span>
              </div>
            )}
            {poolError && !poolChecking && (
              <div
                className="rounded-[14px] px-4 py-3 flex items-start gap-2.5"
                style={{ background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.18)' }}
              >
                <AlertTriangle className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
                <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>{poolError}</p>
              </div>
            )}
            {poolAddress && !poolChecking && (
              <div
                className="flex items-center gap-2 rounded-[12px] px-3 py-2"
                style={{ background: 'rgba(34,217,135,0.07)', border: '1px solid rgba(34,217,135,0.18)' }}
              >
                <span className="size-2 rounded-full shrink-0" style={{ background: 'var(--success)' }} />
                <span className="text-xs font-semibold" style={{ color: 'var(--success)' }}>Pool found</span>
                <span className="text-[10px] mono truncate" style={{ color: 'var(--subtle)' }}>{poolAddress}</span>
              </div>
            )}
            {quoteError && !quoteLoading && (
              <p className="text-xs font-semibold px-1" style={{ color: 'var(--danger)' }}>{quoteError}</p>
            )}
          </>
        )}

        {/* ── CTA ──────────────────────────────────────────────────────────── */}
        {canSwap ? (
          <div className="space-y-3">
            <div
              className="rounded-[14px] px-3.5 py-3 text-xs"
              style={{ background: 'rgba(78,155,255,0.07)', border: '1px solid rgba(78,155,255,0.18)' }}
            >
              <p className="font-bold mb-1" style={{ color: 'var(--ink)' }}>Swap summary</p>
              <p style={{ color: 'var(--ink-3)' }}>
                {amount} {tokenIn.symbol} → ~{formatTokenAmount(quoteOut, tokenOut!.decimals)} {tokenOut!.symbol}
                {' '}at {FEE_LABELS[feeTier]} fee
              </p>
              <p className="mt-1" style={{ color: 'var(--subtle)' }}>
                Swap execution (approve + swapExactInputSingle) will be enabled once Arc Mainnet
                pool liquidity is confirmed live. Quote is from the on-chain QuoterV2.
              </p>
            </div>
            <button
              disabled
              className="w-full rounded-[16px] py-4 text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--blue)', color: '#04090f' }}
            >
              Swap (coming soon — pool live, execution pending)
            </button>
          </div>
        ) : (
          <button
            disabled
            className="w-full rounded-[16px] py-4 text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed"
            style={{ background: 'var(--blue)', color: '#04090f' }}
          >
            {primaryBtnLabel}
          </button>
        )}

        {/* ── Refresh pools ────────────────────────────────────────────────── */}
        {tokenOut && (
          <button
            onClick={() => { void checkPool(tokenIn, tokenOut, feeTier) }}
            disabled={poolChecking}
            className="flex items-center justify-center gap-1.5 w-full rounded-[13px] py-2.5 text-xs font-semibold transition-all hover:brightness-110 disabled:opacity-40"
            style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            <RefreshCw className="size-3.5" /> Check pools again
          </button>
        )}

        <p className="text-center text-xs pb-2" style={{ color: 'var(--subtle)' }}>
          Powered by{' '}
          <a
            href="https://uniswap.org"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            style={{ color: 'var(--blue)' }}
          >Uniswap V3</a>
          {' '}· Arc Mainnet chain 5042
        </p>
      </ScreenLayout>

      {/* ── Token picker modal ───────────────────────────────────────────────── */}
      {pickerFor && (
        <TokenPicker
          exclude={pickerFor === 'out' ? tokenIn.address : (tokenOut?.address ?? null)}
          selected={pickerFor === 'out' ? tokenOut : tokenIn}
          onSelect={t => {
            if (pickerFor === 'in') {
              setTokenIn(t)
              if (tokenOut?.address.toLowerCase() === t.address.toLowerCase()) setTokenOut(null)
            } else {
              setTokenOut(t)
            }
            setPickerFor(null)
            setAmount('')
            setQuoteOut(null)
            setQuoteError(null)
            setPoolAddress(null)
            setPoolError(null)
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </>
  )
}
