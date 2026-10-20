/**
 * NetworkGuard — blocks UI when wallet is on the wrong chain.
 * Offers switch/add-network flow for Arc Mainnet (chain ID 5042).
 * All logic preserved.
 */

import { useAccount, useSwitchChain } from 'wagmi'
import { arc } from 'viem/chains'
import { Loader2, AlertTriangle } from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import { QuickPayLogo } from '@/components/QuickPayLogo'

interface Props { children: React.ReactNode }

export function NetworkGuard({ children }: Props) {
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending, error } = useSwitchChain()

  if (!isConnected)                     return <>{children}</>
  if (chainId === ARC_MAINNET_CHAIN_ID) return <>{children}</>

  const isUnknown = !chainId

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-5"
      style={{ background: 'rgba(6,13,26,0.95)', backdropFilter: 'blur(20px)' }}
    >
      <div
        className="w-full max-w-sm rounded-[28px] p-6 space-y-5"
        style={{
          background: 'linear-gradient(160deg, #0d1e38 0%, #091526 50%, #0b1a2e 100%)',
          border: '1px solid rgba(255,91,91,0.22)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.8), 0 0 60px rgba(255,91,91,0.04)',
        }}
      >
        {/* Logo */}
        <div className="flex justify-center">
          <QuickPayLogo size={36} iconOnly />
        </div>

        {/* Warning icon */}
        <div className="flex justify-center">
          <div
            className="flex size-16 items-center justify-center rounded-[20px]"
            style={{
              background: 'rgba(255,91,91,0.10)',
              border: '1px solid rgba(255,91,91,0.20)',
            }}
          >
            <AlertTriangle className="size-8" style={{ color: 'var(--danger)' }} />
          </div>
        </div>

        <div className="text-center space-y-2">
          <h2
            className="display text-xl font-bold"
            style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}
          >
            Wrong Network
          </h2>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--ink-3)' }}>
            {isUnknown
              ? 'Your wallet is not connected to a recognised network.'
              : `Connected to chain ${chainId}. Quick Pay requires Arc Mainnet.`}
          </p>
        </div>

        {/* Network info */}
        <div
          className="rounded-[16px] divide-y"
          style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
        >
          {[
            ['Required', 'Arc Mainnet'],
            ['Chain ID', '5042'],
            ['RPC',      'rpc.mainnet.arc.io'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between items-center px-4 py-2.5 text-xs">
              <span style={{ color: 'var(--subtle)' }}>{k}</span>
              <span className="font-bold mono" style={{ color: 'var(--ink-2)' }}>{v}</span>
            </div>
          ))}
        </div>

        {error && (
          <p className="text-xs text-center" style={{ color: 'var(--danger)' }}>
            {error.message?.includes('Unrecognized')
              ? 'Network not found — add Arc Mainnet manually in your wallet.'
              : 'Could not switch — add Arc Mainnet manually in your wallet.'}
          </p>
        )}

        <button
          onClick={() => switchChain({ chainId: arc.id })}
          disabled={isPending}
          className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-45 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          style={{ background: 'var(--blue)', color: '#04090f', letterSpacing: '-0.01em' }}
        >
          {isPending
            ? <><Loader2 className="size-4 animate-spin" /> Switching…</>
            : 'Switch to Arc Mainnet'}
        </button>

        <p className="text-xs text-center" style={{ color: 'var(--subtle)' }}>
          If the switch fails, add Arc Mainnet manually in your wallet settings.
        </p>
      </div>
    </div>
  )
}
