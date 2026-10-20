/**
 * wagmi configuration — Quick Pay on Arc Mainnet
 * Arc Mainnet: chain ID 5042, USDC as native gas token
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet, arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register Arc Mainnet RPC so traces show the correct chain name immediately
registerChain(arc.id, arc.rpcUrls.default.http[0])

export const ARC_MAINNET_CHAIN_ID = arc.id // 5042

export const config = createConfig({
  chains: [arc, mainnet],
  connectors: [
    injected({ shimDisconnect: true }),
  ],
  transports: {
    [arc.id]: http('https://rpc.mainnet.arc.io'),
    [mainnet.id]: http(), // ENS resolution
  },
})
