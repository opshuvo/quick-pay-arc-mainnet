/**
 * SwapSheet — Token swap on Arc Mainnet.
 *
 * IMPLEMENTATION STATUS: On-chain quoter UI using Uniswap V3 contracts
 * deployed at standard addresses on Arc Mainnet.
 *
 * HONEST DISCLOSURE:
 * - Uniswap V3 factory (0x1F98431c8aD98523631AE4a59f267346ea31F984) is
 *   deployed on Arc at the standard address, but as of the time of writing
 *   no liquidity pools have been created (feeAmountTickSpacing returns 0).
 * - The Uniswap Trading API (api.uniswap.org) requires a private API key
 *   and is not usable from client-side code without a backend proxy.
 * - This screen shows the on-chain state honestly: if no pool exists for
 *   a pair it says "No liquidity pool found" rather than pretending to quote.
 * - When pools do exist in future, the QuoterV2 on-chain call will return
 *   a real quote without any API key.
 *
 * Arc Mainnet has USDC as the only token with significant liquidity.
 * Additional tokens can be added to TOKEN_LIST as the ecosystem grows.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAccount, useConnectorClient } from 'wagmi'
import { createPublicClient, custom } from 'viem'
import {
  ArrowDownUp, Loader2, Info, AlertTriangle, RefreshCw,
} from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import { USDC_ADDRESS, parseUsdcInput, formatUsdcAmount } from '@/utils'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

// ─── Contracts ────────────────────────────────────────────────────────────────

const UNI_FACTORY   = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
const UNI_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e'

// Minimal factory ABI to check if a pool exists
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
  {
    name: 'feeAmountTickSpacing',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'fee', type: 'uint24' }],
    outputs: [{ name: '', type: 'int24' }],
  },
] as const

// QuoterV2 ABI (minimal — quoteExactInputSingle)
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

// ─── Token list ────────────────────────────────────────────────────────────────

interface Token {
  address:  `0x${string}`
  symbol:   string
  decimals: number
  name:     string
}

// Only tokens with confirmed Arc Mainnet deployments.
// USDC is the native USDC precompile at 0x3600..
// Add more tokens here as the Arc ecosystem grows.
const TOKEN_LIST: Token[] = [
  {
    address:  USDC_ADDRESS,
    symbol:   'USDC',
    decimals: 6,
    name:     'USD Coin',
  },
  // Placeholder — replace with real Arc-deployed token addresses when available.
  // {
  //   address:  '0x...',
  //   symbol:   'WETH',
  //   decimals: 18,
  //   name:     'Wrapped Ether',
  // },
]

// Standard Uniswap V3 fee tiers
const FEE_TIERS = [500, 3000, 10000] as const
type FeeTier = typeof FEE_TIERS[number]
const FEE_LABELS: Record<FeeTier, string> = {
  500:   '0.05%',
  3000:  '0.30%',
  10000: '1.00%',
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props { onBack: () => void }

export function SwapSheet({ onBack }: Props) {
  const { address, isConnected } = useAccount()
  const { data: walletClient }   = useConnectorClient({ chainId: ARC_MAINNET_CHAIN_ID })

  const [tokenIn,  setTokenIn]  = useState<Token>(TOKEN_LIST[0])
  const [tokenOut, setTokenOut] = useState<Token | null>(null)
  const [amount,   setAmount]   = useState('')
  const [feeTier,  setFeeTier]  = useState<FeeTier>(3000)

  const [poolAddress,  setPoolAddress]  = useState<string | null>(null)
  const [poolChecking, setPoolChecking] = useState(false)
  const [poolError,    setPoolError]    = useState<string | null>(null)

  const [quoteOut,     setQuoteOut]     = useState<bigint | null>(null)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [quoteError,   setQuoteError]   = useState<string | null>(null)

  // Build a public client from the wallet client transport
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
        setPoolAddress(null)
        setPoolError(`No Uniswap V3 pool found for ${tIn.symbol}/${tOut.symbol} at ${FEE_LABELS[fee]} fee tier on Arc Mainnet. Liquidity pools may not have been created yet.`)
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
  }, [tokenIn, tokenOut, feeTier, checkPool, publicClient])

  // ── Get quote ─────────────────────────────────────────────────────────────
  const fetchQuote = useCallback(async () => {
    if (!publicClient || !tokenOut || !poolAddress) return
    const parsed = parseUsdcInput(amount)
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
        setQuoteError('No route available — the pool exists but has no liquidity for this amount.')
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
  }, [amount, poolAddress, tokenOut, fetchQuote])

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!isConnected || !address) {
    return (
      <ScreenLayout title="Swap" subtitle="Token swap on Arc Mainnet" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to swap tokens." />
      </ScreenLayout>
    )
  }

  const availableOut = TOKEN_LIST.filter(t => t.address !== tokenIn.address)

  return (
    <ScreenLayout title="Swap" subtitle="Uniswap V3 · Arc Mainnet" onBack={onBack}>

      {/* ── Status notice ────────────────────────────────────────────────────── */}
      <div className="rounded-[14px] px-3.5 py-3 flex items-start gap-2.5"
        style={{ background: 'rgba(255,176,32,0.08)', border: '1px solid rgba(255,176,32,0.20)' }}>
        <Info className="size-4 mt-0.5 shrink-0" style={{ color: '#ffb020' }} />
        <div className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
          <p className="font-semibold mb-0.5" style={{ color: '#ffb020' }}>Limited liquidity on Arc Mainnet</p>
          <p>
            Uniswap V3 contracts are deployed at standard addresses on Arc, but liquidity pools
            are sparse. This screen checks on-chain pool existence before quoting.
            If no pool is found for a pair, no swap is shown.
          </p>
        </div>
      </div>

      {/* ── Token In ──────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <label className="section-label">You send</label>
        <div className="flex gap-2">
          <div className="flex items-center gap-2 rounded-[14px] px-3 py-2.5 shrink-0"
            style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}>
            <span className="text-sm font-bold" style={{ color: 'var(--ink)' }}>{tokenIn.symbol}</span>
          </div>
          <input
            type="text" inputMode="decimal" placeholder="0.00"
            value={amount}
            onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            className="flex-1 rounded-[14px] px-4 py-2.5 text-base font-semibold tabular-nums outline-none"
            style={{ background: 'var(--card)', border: '1px solid var(--card-border)', color: 'var(--ink)' }}
          />
        </div>
      </div>

      {/* ── Swap direction ────────────────────────────────────────────────────── */}
      <div className="flex justify-center">
        <button
          className="flex size-9 items-center justify-center rounded-full transition-all hover:brightness-110"
          style={{ background: 'rgba(78,155,255,0.12)', border: '1px solid rgba(78,155,255,0.22)' }}
          onClick={() => {
            if (tokenOut) { setTokenIn(tokenOut); setTokenOut(tokenIn) }
          }}
          disabled={!tokenOut}
        >
          <ArrowDownUp className="size-4" style={{ color: 'var(--blue)' }} />
        </button>
      </div>

      {/* ── Token Out ─────────────────────────────────────────────────────────── */}
      <div className="space-y-1.5">
        <label className="section-label">You receive</label>
        <div className="flex gap-2">
          <select
            value={tokenOut?.address ?? ''}
            onChange={e => {
              const t = TOKEN_LIST.find(x => x.address === e.target.value) ?? null
              setTokenOut(t)
            }}
            className="rounded-[14px] px-3 py-2.5 text-sm font-semibold outline-none"
            style={{ background: 'var(--card)', border: '1px solid var(--card-border)', color: 'var(--ink)', minWidth: '90px' }}
          >
            <option value="">Select</option>
            {availableOut.map(t => (
              <option key={t.address} value={t.address}>{t.symbol}</option>
            ))}
          </select>
          <div className="flex-1 flex items-center rounded-[14px] px-4 py-2.5"
            style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}>
            {quoteLoading
              ? <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blue)' }} />
              : quoteOut != null
                ? <span className="text-base font-semibold tabular-nums" style={{ color: 'var(--success)' }}>
                    {formatUsdcAmount(quoteOut)}
                  </span>
                : <span className="text-sm" style={{ color: 'var(--subtle)' }}>—</span>
            }
          </div>
        </div>
      </div>

      {/* ── Fee tier ──────────────────────────────────────────────────────────── */}
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

      {/* ── Pool status ───────────────────────────────────────────────────────── */}
      {poolChecking && (
        <div className="flex items-center gap-2 py-1">
          <Loader2 className="size-3.5 animate-spin" style={{ color: 'var(--blue)' }} />
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Checking pool…</span>
        </div>
      )}
      {poolError && !poolChecking && (
        <div className="rounded-[14px] px-4 py-3 flex items-start gap-2.5"
          style={{ background: 'rgba(255,80,80,0.07)', border: '1px solid rgba(255,80,80,0.18)' }}>
          <AlertTriangle className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
          <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>{poolError}</p>
        </div>
      )}
      {poolAddress && !poolChecking && (
        <div className="flex items-center gap-2 rounded-[12px] px-3 py-2"
          style={{ background: 'rgba(34,217,135,0.07)', border: '1px solid rgba(34,217,135,0.18)' }}>
          <span className="size-2 rounded-full" style={{ background: 'var(--success)', flexShrink: 0 }} />
          <span className="text-xs" style={{ color: 'var(--success)' }}>Pool found</span>
          <span className="text-[10px] mono truncate" style={{ color: 'var(--subtle)' }}>{poolAddress}</span>
        </div>
      )}
      {quoteError && (
        <p className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>{quoteError}</p>
      )}

      {/* ── CTA ──────────────────────────────────────────────────────────────── */}
      {poolAddress && quoteOut != null ? (
        <div className="space-y-3">
          <div className="rounded-[14px] px-3.5 py-3 text-xs"
            style={{ background: 'rgba(78,155,255,0.07)', border: '1px solid rgba(78,155,255,0.18)' }}>
            <p className="font-bold mb-1" style={{ color: 'var(--ink)' }}>Swap summary</p>
            <p style={{ color: 'var(--ink-3)' }}>
              {amount} {tokenIn.symbol} → ~{formatUsdcAmount(quoteOut)} {tokenOut?.symbol}
              {' '}at {FEE_LABELS[feeTier]} fee
            </p>
            <p className="mt-1" style={{ color: 'var(--subtle)' }}>
              Swap execution is not yet implemented — it requires an approve + swapExactInputSingle
              call to the Uniswap V3 SwapRouter02. This will be enabled once Arc Mainnet pool
              liquidity is confirmed.
            </p>
          </div>
          <button
            disabled
            className="w-full rounded-[16px] py-4 text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--blue)', color: '#04090f' }}
          >
            Swap (coming soon)
          </button>
        </div>
      ) : (
        <button
          disabled
          className="w-full rounded-[16px] py-4 text-sm font-bold disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ background: 'var(--blue)', color: '#04090f' }}
        >
          {!tokenOut ? 'Select a token' : poolError ? 'No pool available' : 'Enter amount'}
        </button>
      )}

      {/* ── Refresh pools button ──────────────────────────────────────────────── */}
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
        <a href="https://uniswap.org" target="_blank" rel="noopener noreferrer"
          className="hover:underline" style={{ color: 'var(--blue)' }}>Uniswap V3</a>
        {' '}· Arc Mainnet chain 5042
      </p>
    </ScreenLayout>
  )
}
