/**
 * onchain-facts.ts — Arc Mainnet chain and token registry for Quick Pay.
 *
 * Provides the three functions imported by src/utils.ts:
 *   requireChain, getUsdc, buildTxExplorerUrl
 *
 * All values verified from viem/chains `arc` object and project config:
 *   - Chain ID 5042 (arc.id from viem/chains)
 *   - RPC https://rpc.mainnet.arc.io (arc.rpcUrls.default.http[0])
 *   - Explorer https://explorer.arc.io (arc.blockExplorers.default.url)
 *   - USDC 0x3600000000000000000000000000000000000000, 6 decimals
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChainInfo {
  chainId: number
  explorerBase: string
  rpcUrls: string[]
}

export interface TokenInfo {
  address: string
  decimals: number
  symbol: string
}

// ─── Registry (Arc Mainnet only) ──────────────────────────────────────────────

const ARC_MAINNET: ChainInfo = {
  chainId:     5042,
  explorerBase: 'https://explorer.arc.io',
  rpcUrls:     ['https://rpc.mainnet.arc.io'],
}

/** USDC on Arc Mainnet — ERC-20 at 0x3600...0000, 6 decimals. */
const ARC_USDC: TokenInfo = {
  address:  '0x3600000000000000000000000000000000000000',
  decimals: 6,
  symbol:   'USDC',
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Return chain info for the given chain ID.
 * Throws if the chain ID is not Arc Mainnet (5042) — this app is Arc-only.
 */
export function requireChain(chainId: number): ChainInfo {
  if (chainId !== ARC_MAINNET.chainId) {
    throw new Error(
      `onchain-facts: unsupported chain ID ${chainId}. Quick Pay only runs on Arc Mainnet (5042).`
    )
  }
  return ARC_MAINNET
}

/**
 * Return USDC token info for the given chain ID, or null if USDC is not
 * known for that chain.
 */
export function getUsdc(chainId: number): TokenInfo | null {
  if (chainId === ARC_MAINNET.chainId) return ARC_USDC
  return null
}

/**
 * Build a transaction explorer URL for the given chain ID and tx hash.
 * Falls back to the Arc Explorer for unknown chains rather than throwing.
 */
export function buildTxExplorerUrl(chainId: number, txHash: string): string {
  const chain = chainId === ARC_MAINNET.chainId ? ARC_MAINNET : ARC_MAINNET
  return `${chain.explorerBase}/tx/${txHash}`
}
