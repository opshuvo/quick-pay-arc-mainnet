/**
 * wagmi configuration — Quick Pay on Arc Mainnet
 * Arc Mainnet: chain ID 5042, USDC as native gas token
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, fallback, createConfig } from 'wagmi'
import { mainnet, arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register Arc Mainnet RPC so traces show the correct chain name immediately
registerChain(arc.id, arc.rpcUrls.default.http[0])

export const ARC_MAINNET_CHAIN_ID = arc.id // 5042

// All four official Arc Mainnet RPC endpoints from viem/chains arc.rpcUrls.
// Verified working: each returns HTTP 200 for eth_call to the USDC precompile.
const ARC_RPCS = arc.rpcUrls.default.http // ['https://rpc.mainnet.arc.io', ...]

export const config = createConfig({
  chains: [arc, mainnet],
  connectors: [
    injected({ shimDisconnect: true }),
  ],
  // Disable Multicall3 batching for Arc Mainnet only.
  // Arc's USDC at 0x3600...0000 is a native precompile that reverts when called
  // via Multicall3.aggregate3 — all useReadContract calls must be direct eth_call.
  batch: {
    [arc.id]: { multicall: false },
  },
  transports: {
    // fallback() tries each Arc RPC in order; if one fails (network error,
    // rate limit, Cloudflare challenge) the next is used automatically.
    [arc.id]: fallback(ARC_RPCS.map(url => http(url))),
    [mainnet.id]: http(), // ENS resolution
  },
})
