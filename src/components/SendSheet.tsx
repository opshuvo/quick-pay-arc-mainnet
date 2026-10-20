/**
 * SendSheet — ERC-20 USDC transfer on Arc Mainnet.
 * All blockchain logic unchanged. Visual layer uses ScreenLayout.
 */

import { useState, useEffect, useRef } from 'react'
import {
  useAccount, useReadContract, useWriteContract,
  useWaitForTransactionReceipt, useSwitchChain,
} from 'wagmi'
import { erc20Abi } from 'viem'
import { arc } from 'viem/chains'
import {
  Loader2, ExternalLink, CheckCircle2,
  XCircle, Info, AlertTriangle, ChevronRight, ArrowUpRight,
} from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import {
  USDC_ADDRESS, formatAddress, formatUsdcDisplay, formatUsdcAmount,
  parseUsdcInput, isValidAddress, parseOnchainError, getTxExplorerUrl,
  saveNote, saveReceipt, type LocalReceipt,
} from '@/utils'
import { PaymentReceipt } from '@/components/PaymentReceipt'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

interface Props {
  onBack: () => void
  prefill?: { to?: string; amount?: string; note?: string }
}

type Step = 'form' | 'confirm' | 'success' | 'error'

export function SendSheet({ onBack, prefill }: Props) {
  const { address, chainId, isConnected } = useAccount()
  const { switchChain, isPending: switchPending } = useSwitchChain()

  const [to,     setTo]     = useState(prefill?.to     ?? '')
  const [amount, setAmount] = useState(prefill?.amount ?? '')
  const [note,   setNote]   = useState(prefill?.note   ?? '')
  const [step,   setStep]   = useState<Step>('form')
  const [errorMsg, setErrorMsg] = useState('')
  const [pendingReceipt, setPendingReceipt] = useState<LocalReceipt | null>(null)

  const wrongChain = isConnected && chainId !== ARC_MAINNET_CHAIN_ID

  const { data: rawBalance } = useReadContract({
    address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_MAINNET_CHAIN_ID,
    query: { enabled: !!address },
  })

  const {
    writeContract, data: txHash,
    isPending: walletPending, error: writeError, reset: resetWrite,
  } = useWriteContract()

  const {
    isLoading: isConfirming, isSuccess, isError: receiptError,
    data: txReceipt,
  } = useWaitForTransactionReceipt({ hash: txHash, chainId: ARC_MAINNET_CHAIN_ID })

  const parsedAmount     = parseUsdcInput(amount)
  const addressValid     = isValidAddress(to)
  const amountValid      = parsedAmount !== null && parsedAmount > 0n
  const hasSufficientBal = rawBalance != null && parsedAmount != null && rawBalance >= parsedAmount
  const isSelf           = !!address && to.toLowerCase() === address.toLowerCase()
  const formValid        = addressValid && amountValid && hasSufficientBal && !isSelf

  const processedRef = useRef(false)

  function handleSubmit() {
    if (!formValid || !parsedAmount) return
    processedRef.current = false
    setStep('confirm')
    writeContract({
      address: USDC_ADDRESS, abi: erc20Abi, functionName: 'transfer',
      args: [to as `0x${string}`, parsedAmount],
      chainId: ARC_MAINNET_CHAIN_ID,
    })
  }

  function handleReset() {
    processedRef.current = false
    resetWrite()
    setTo(''); setAmount(''); setNote('')
    setStep('form'); setErrorMsg('')
    setPendingReceipt(null)
  }

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (processedRef.current) return
    if (isSuccess && step === 'confirm') {
      processedRef.current = true
      if (txHash && note.trim()) saveNote({ txHash, note: note.trim(), timestamp: Date.now() })
      if (txHash && address && parsedAmount != null) {
        const r: LocalReceipt = {
          txHash, from: address, to,
          amount: formatUsdcAmount(parsedAmount),
          network: 'Arc Mainnet', chainId: ARC_MAINNET_CHAIN_ID,
          confirmedAt: Date.now(),
          note: note.trim() || undefined,
          // blockNumber lets History jump directly to this page instead of paginating back
          blockNumber: txReceipt?.blockNumber != null
            ? Number(txReceipt.blockNumber)
            : undefined,
        }
        saveReceipt(r)
        setPendingReceipt(r)
      }
      setStep('success')
    }
  }, [isSuccess, step, txHash, note])

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (processedRef.current) return
    if (receiptError && step === 'confirm') {
      processedRef.current = true
      setErrorMsg('Transaction was included but failed onchain.')
      setStep('error')
    }
  }, [receiptError, step])

  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    if (processedRef.current) return
    if (writeError && step === 'confirm') {
      processedRef.current = true
      const msg = parseOnchainError(writeError)
      if (!msg.includes('cancelled')) { setErrorMsg(msg); setStep('error') }
      else setStep('form')
    }
  }, [writeError, step])

  const isPending = walletPending || isConfirming

  if (!isConnected) {
    return (
      <ScreenLayout title="Send USDC" subtitle="Arc Mainnet · USDC" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to send USDC." />
      </ScreenLayout>
    )
  }

  /* ── Success ──────────────────────────────────────────────────────────── */
  if (step === 'success' && txHash) {
    return (
      <ScreenLayout title="Payment Sent" onBack={onBack}>
        {pendingReceipt && (
          <PaymentReceipt receipt={pendingReceipt} onClose={() => setPendingReceipt(null)} />
        )}
        <div className="flex flex-col items-center text-center gap-5 pt-4">
          <div
            className="flex size-20 items-center justify-center rounded-[24px]"
            style={{
              background: 'var(--success-dim)',
              border: '1px solid var(--success-glow)',
              boxShadow: '0 0 40px rgba(34,217,135,0.08)',
            }}
          >
            <CheckCircle2 className="size-10" style={{ color: 'var(--success)' }} />
          </div>
          <div>
            <h2 className="display text-2xl font-bold mb-1" style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}>
              Payment sent
            </h2>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              USDC transfer confirmed onchain.
            </p>
          </div>

          <SummaryCard>
            <DetailRow label="Amount"  value={`${formatUsdcAmount(parsedAmount ?? 0n)} USDC`} accent />
            <DetailRow label="To"      value={formatAddress(to)} mono />
            <DetailRow label="Network" value="Arc Mainnet" />
            {txHash && <DetailRow label="Tx hash" value={formatAddress(txHash)} mono />}
          </SummaryCard>

          <a
            href={getTxExplorerUrl(txHash)}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm font-semibold"
            style={{ color: 'var(--blue)' }}
          >
            View on Arc Explorer <ExternalLink className="size-3.5" />
          </a>

          {pendingReceipt && (
            <button
              onClick={() => setPendingReceipt(pendingReceipt)}
              className="text-sm font-semibold transition-opacity hover:opacity-70"
              style={{ color: 'var(--accent)' }}
            >
              View receipt
            </button>
          )}

          <PrimaryBtn onClick={handleReset} variant="ghost">Send another payment</PrimaryBtn>
        </div>
      </ScreenLayout>
    )
  }

  /* ── Error ────────────────────────────────────────────────────────────── */
  if (step === 'error') {
    return (
      <ScreenLayout title="Transfer Failed" onBack={onBack}>
        <div className="flex flex-col items-center text-center gap-5 pt-4">
          <div
            className="flex size-20 items-center justify-center rounded-[24px]"
            style={{
              background: 'var(--danger-dim)',
              border: '1px solid rgba(255,91,91,0.22)',
            }}
          >
            <XCircle className="size-10" style={{ color: 'var(--danger)' }} />
          </div>
          <div>
            <h2 className="display text-xl font-bold mb-1" style={{ color: 'var(--ink)' }}>Transfer failed</h2>
            <p className="text-sm max-w-[280px] leading-relaxed" style={{ color: 'var(--ink-3)' }}>{errorMsg}</p>
          </div>
          <PrimaryBtn onClick={() => { resetWrite(); setStep('form'); setErrorMsg('') }} variant="ghost">
            Try again
          </PrimaryBtn>
        </div>
      </ScreenLayout>
    )
  }

  /* ── Form ─────────────────────────────────────────────────────────────── */
  return (
    <ScreenLayout title="Send USDC" subtitle="Arc Mainnet · USDC" onBack={onBack}>

      {/* Warning banner */}
      <Banner color="warning">
        <AlertTriangle className="size-3.5 shrink-0 mt-0.5" style={{ color: 'var(--warning)' }} />
        Sending real USDC on Arc Mainnet. Transactions are irreversible.
      </Banner>

      {/* Wrong-chain banner */}
      {wrongChain && (
        <div
          className="flex items-center justify-between rounded-[14px] px-4 py-3 mb-4 text-sm"
          style={{ background: 'rgba(255,91,91,0.07)', border: '1px solid rgba(255,91,91,0.20)' }}
        >
          <span style={{ color: 'var(--danger)' }}>Switch to Arc Mainnet</span>
          <button
            onClick={() => switchChain({ chainId: arc.id })}
            disabled={switchPending}
            className="text-xs font-bold ml-3 shrink-0 hover:underline disabled:opacity-50"
            style={{ color: 'var(--accent)' }}
          >
            {switchPending ? 'Switching…' : 'Switch'}
          </button>
        </div>
      )}

      {/* Recipient field */}
      <FormField label="Recipient address">
        <input
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          placeholder="0x..."
          disabled={isPending}
          className="w-full bg-transparent text-sm mono outline-none disabled:opacity-50 placeholder:opacity-30"
          style={{ color: 'var(--ink)' }}
          spellCheck={false}
          autoComplete="off"
        />
        {to && !addressValid && <FieldMsg type="error">Invalid Ethereum address</FieldMsg>}
        {isSelf && <FieldMsg type="warn">This is your own address</FieldMsg>}
      </FormField>

      {/* Amount */}
      <FormField label="Amount">
        <div className="flex items-center gap-2">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              if (v.split('.').length <= 2) setAmount(v)
            }}
            placeholder="0.00"
            disabled={isPending}
            className="display flex-1 bg-transparent text-3xl font-bold tabular-nums outline-none placeholder:opacity-20 disabled:opacity-50"
            style={{ color: 'var(--ink)', letterSpacing: '-0.04em' }}
          />
          <span className="text-sm font-bold" style={{ color: 'var(--muted)' }}>USDC</span>
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>6 decimal precision</span>
          {rawBalance != null && (
            <button
              onClick={() => setAmount(formatUsdcAmount(rawBalance))}
              disabled={isPending}
              className="text-xs font-bold hover:underline disabled:opacity-50"
              style={{ color: 'var(--blue)' }}
            >
              Max: {formatUsdcDisplay(rawBalance)}
            </button>
          )}
        </div>
        {amount && !amountValid && <FieldMsg type="error">Enter a valid amount (up to 6 decimals)</FieldMsg>}
        {amountValid && parsedAmount != null && rawBalance != null && parsedAmount > rawBalance && (
          <FieldMsg type="error">Insufficient USDC balance</FieldMsg>
        )}
      </FormField>

      {/* Note */}
      <FormField label="Note (optional)">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, 140))}
          placeholder="What's this for?"
          disabled={isPending}
          className="w-full bg-transparent text-sm outline-none disabled:opacity-50 placeholder:opacity-30"
          style={{ color: 'var(--ink)' }}
        />
        <div className="flex items-center gap-1 mt-1.5">
          <Info className="size-3 shrink-0" style={{ color: 'var(--subtle)' }} />
          <span className="text-xs" style={{ color: 'var(--subtle)' }}>
            Saved on this device only — not recorded onchain.
          </span>
        </div>
      </FormField>

      {/* Confirm preview */}
      {step === 'confirm' && (
        <SummaryCard accent>
          <DetailRow label="Sending" value={`${amount} USDC`} accent />
          <DetailRow label="To"      value={formatAddress(to)} mono />
          <DetailRow label="Network" value="Arc Mainnet" />
          <DetailRow label="Token"   value={formatAddress(USDC_ADDRESS)} mono />
          <div
            className="flex items-start gap-2 rounded-xl p-2.5 mt-1"
            style={{ background: 'rgba(78,155,255,0.07)' }}
          >
            <Info className="size-3.5 mt-0.5 shrink-0" style={{ color: 'var(--blue)' }} />
            <span className="text-xs" style={{ color: 'var(--ink-3)' }}>
              Gas fees are paid in USDC on Arc Mainnet. Confirm in your wallet.
            </span>
          </div>
        </SummaryCard>
      )}

      {/* Status rows */}
      {walletPending && (
        <StatusRow>
          <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blue)' }} />
          Waiting for wallet confirmation…
        </StatusRow>
      )}
      {isConfirming && txHash && (
        <StatusRow>
          <Loader2 className="size-4 animate-spin" style={{ color: 'var(--success)' }} />
          <span className="flex-1">Waiting for onchain confirmation…</span>
          <a href={getTxExplorerUrl(txHash)} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-3.5" style={{ color: 'var(--blue)' }} />
          </a>
        </StatusRow>
      )}

      {/* CTA */}
      <button
        onClick={step === 'form' ? handleSubmit : undefined}
        disabled={!isConnected || wrongChain || !formValid || isPending}
        className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-108 active:scale-[0.99] disabled:opacity-38 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        style={{
          background: 'linear-gradient(135deg, #4e9bff 0%, #3b87f5 100%)',
          color: '#fff',
          letterSpacing: '-0.01em',
          boxShadow: '0 4px 18px rgba(78,155,255,0.28)',
        }}
      >
        {!isConnected     ? 'Connect wallet'
          : wrongChain    ? 'Switch to Arc Mainnet'
          : walletPending ? <><Loader2 className="size-4 animate-spin" /> Confirm in wallet…</>
          : isConfirming  ? <><Loader2 className="size-4 animate-spin" /> Confirming…</>
          : step === 'form'
            ? <><ArrowUpRight className="size-4" /> Review &amp; send<ChevronRight className="size-4" /></>
            : 'Send USDC'}
      </button>
    </ScreenLayout>
  )
}

/* ── Shared sub-components ──────────────────────────────────────────────── */

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        className="block text-[11px] font-bold mb-1.5 uppercase"
        style={{ color: 'var(--subtle)', letterSpacing: '0.09em' }}
      >
        {label}
      </label>
      <div
        className="rounded-[14px] px-4 py-3.5"
        style={{
          background: 'var(--card)',
          border: '1px solid rgba(78,155,255,0.18)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function FieldMsg({ type, children }: { type: 'error' | 'warn'; children: React.ReactNode }) {
  return (
    <p className="mt-1.5 text-xs" style={{ color: type === 'error' ? 'var(--danger)' : 'var(--warning)' }}>
      {children}
    </p>
  )
}

function Banner({ color, children }: { color: 'warning' | 'info'; children: React.ReactNode }) {
  const bg  = color === 'warning' ? 'rgba(255,176,32,0.09)' : 'rgba(78,155,255,0.09)'
  const bdr = color === 'warning' ? 'rgba(255,176,32,0.24)' : 'rgba(78,155,255,0.22)'
  const c   = color === 'warning' ? 'var(--warning)'       : 'var(--ink-3)'
  return (
    <div
      className="flex items-start gap-2.5 rounded-[13px] px-3.5 py-3 text-xs"
      style={{ background: bg, border: `1px solid ${bdr}`, color: c }}
    >
      {children}
    </div>
  )
}

function SummaryCard({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <div
      className="rounded-[16px] p-4 space-y-2.5 text-sm"
      style={{
        background: 'var(--card)',
        border: `1px solid ${accent ? 'rgba(78,155,255,0.28)' : 'var(--card-border-2)'}`,
        boxShadow: accent ? '0 0 0 1px rgba(78,155,255,0.08) inset' : 'none',
      }}
    >
      {children}
    </div>
  )
}

function DetailRow({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: 'var(--subtle)' }}>{label}</span>
      <span
        className={mono ? 'mono text-xs' : 'font-semibold text-sm'}
        style={{ color: accent ? 'var(--accent)' : 'var(--ink-2)' }}
      >
        {value}
      </span>
    </div>
  )
}

function StatusRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 text-sm rounded-[13px] px-4 py-3"
      style={{ background: 'var(--card)', border: '1px solid rgba(78,155,255,0.16)', color: 'var(--ink-3)' }}
    >
      {children}
    </div>
  )
}

function PrimaryBtn({ onClick, children, variant }: { onClick: () => void; children: React.ReactNode; variant?: 'ghost' }) {
  const isGhost = variant === 'ghost'
  return (
    <button
      onClick={onClick}
      className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-108 active:scale-[0.99]"
      style={
        isGhost
          ? { background: 'var(--card)', color: 'var(--ink)', border: '1px solid rgba(78,155,255,0.18)' }
          : {
              background: 'linear-gradient(135deg, #4e9bff 0%, #3b87f5 100%)',
              color: '#fff',
              boxShadow: '0 4px 18px rgba(78,155,255,0.32)',
            }
      }
    >
      {children}
    </button>
  )
}
