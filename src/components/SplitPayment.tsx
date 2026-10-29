/**
 * SplitPayment — divide a payment among multiple recipients.
 *
 * IMPLEMENTATION: Sequential USDC ERC-20 transfers.
 * This is NOT atomic — each recipient is a separate transaction.
 * The UI clearly discloses this and shows per-transfer status.
 *
 * A "split" session stores all recipients + amounts and executes them
 * one at a time, waiting for each to confirm before proceeding.
 * If any transfer fails the remaining ones are not sent automatically.
 */

import { useState, useCallback } from 'react'
import {
  useAccount, useWriteContract, useWaitForTransactionReceipt,
} from 'wagmi'
import { erc20Abi } from 'viem'
import {
  Plus, Trash2, AlertTriangle, CheckCircle2,
  Loader2, Info, ArrowUpRight, ExternalLink,
} from 'lucide-react'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import {
  USDC_ADDRESS, formatAddress, parseUsdcInput, formatUsdcAmount,
  isValidAddress, getTxExplorerUrl,
} from '@/utils'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Recipient {
  id:      string
  address: string
  amount:  string  // human-readable
}

interface TxStatus {
  recipientId: string
  status:      'pending' | 'confirming' | 'success' | 'failed'
  txHash?:     `0x${string}`
  error?:      string
}

type SplitStep = 'form' | 'review' | 'executing' | 'done'

function nanoid(): string {
  return Math.random().toString(36).slice(2, 10)
}

// ─── Single-tx executor sub-component ─────────────────────────────────────────
// We can only have ONE useWriteContract + useWaitForTransactionReceipt pair
// active at a time, so we process recipients sequentially via a callback.

interface Props { onBack: () => void }

export function SplitPayment({ onBack }: Props) {
  const { address, isConnected } = useAccount()

  // ── Recipients list ────────────────────────────────────────────────────────
  const [recipients, setRecipients] = useState<Recipient[]>([
    { id: nanoid(), address: '', amount: '' },
    { id: nanoid(), address: '', amount: '' },
  ])

  // ── Split step ─────────────────────────────────────────────────────────────
  const [step, setStep] = useState<SplitStep>('form')

  // ── Execution state ────────────────────────────────────────────────────────
  const [txStatuses,    setTxStatuses]    = useState<TxStatus[]>([])
  const [currentIndex,  setCurrentIndex]  = useState(0)
  // Queue of pending recipients (set at review time)
  const [queue, setQueue] = useState<{ id: string; address: `0x${string}`; amount: bigint }[]>([])

  // ── Write hook (one at a time) ─────────────────────────────────────────────
  const {
    writeContract, data: txHash,
    isPending: walletPending, error: writeError, reset,
  } = useWriteContract()

  const {
    isLoading: isConfirming, isSuccess, isError: txFailed,
    data: txReceipt,
  } = useWaitForTransactionReceipt({ hash: txHash, chainId: ARC_MAINNET_CHAIN_ID })

  // ── Handlers ───────────────────────────────────────────────────────────────

  function addRecipient() {
    setRecipients(prev => [...prev, { id: nanoid(), address: '', amount: '' }])
  }

  function removeRecipient(id: string) {
    setRecipients(prev => prev.filter(r => r.id !== id))
  }

  function updateRecipient(id: string, field: 'address' | 'amount', value: string) {
    setRecipients(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
  }

  function handleFillEqual() {
    // Prompt for total amount and divide equally
    const total = prompt('Total USDC amount to split equally:')
    if (!total) return
    const parsed = parseUsdcInput(total)
    if (!parsed || parsed <= 0n) return
    const share = parsed / BigInt(recipients.length)
    const perPerson = formatUsdcAmount(share)
    setRecipients(prev => prev.map(r => ({ ...r, amount: perPerson })))
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  const validRecipients = recipients.filter(r =>
    isValidAddress(r.address.trim()) &&
    parseUsdcInput(r.amount) !== null &&
    parseUsdcInput(r.amount)! > 0n &&
    r.address.trim().toLowerCase() !== address?.toLowerCase()
  )

  const invalidCount = recipients.length - validRecipients.length
  const totalAmount  = validRecipients.reduce((sum, r) => sum + (parseUsdcInput(r.amount) ?? 0n), 0n)

  // Deduplicate addresses (warn but don't block)
  const addressSet = new Set(validRecipients.map(r => r.address.trim().toLowerCase()))
  const hasDuplicates = addressSet.size < validRecipients.length

  // ── Review → execute ────────────────────────────────────────────────────────

  function handleReview() {
    if (validRecipients.length < 1) return
    setStep('review')
  }

  function handleExecute() {
    const q = validRecipients.map(r => ({
      id:      r.id,
      address: r.address.trim() as `0x${string}`,
      amount:  parseUsdcInput(r.amount)!,
    }))
    const statuses: TxStatus[] = q.map(r => ({ recipientId: r.id, status: 'pending' as const }))
    setQueue(q)
    setTxStatuses(statuses)
    setCurrentIndex(0)
    setStep('executing')

    // Kick off the first transfer
    sendNext(q, statuses, 0)
  }

  const sendNext = useCallback((
    q:       typeof queue,
    statuses: TxStatus[],
    idx:     number,
  ) => {
    if (idx >= q.length) {
      setStep('done')
      return
    }
    const item = q[idx]
    setTxStatuses(prev => prev.map((s, i) =>
      i === idx ? { ...s, status: 'pending' } : s))
    setCurrentIndex(idx)
    reset()
    writeContract({
      address:      USDC_ADDRESS,
      abi:          erc20Abi,
      functionName: 'transfer',
      args:         [item.address, item.amount],
      chainId:      ARC_MAINNET_CHAIN_ID,
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writeContract, reset])

  // Watch for confirming state
  // eslint-disable-next-line react/set-state-in-effect
  if (step === 'executing' && walletPending && txStatuses[currentIndex]?.status === 'pending') {
    setTxStatuses(prev => prev.map((s, i) =>
      i === currentIndex ? { ...s, status: 'confirming' } : s))
  }

  // Watch for success
  // eslint-disable-next-line react/set-state-in-effect
  if (step === 'executing' && isSuccess && txHash && txStatuses[currentIndex]?.status === 'confirming') {
    const newStatuses = txStatuses.map((s, i) =>
      i === currentIndex ? { ...s, status: 'success' as const, txHash } : s)
    setTxStatuses(newStatuses)
    const nextIdx = currentIndex + 1
    if (nextIdx < queue.length) {
      setTimeout(() => sendNext(queue, newStatuses, nextIdx), 500)
    } else {
      setStep('done')
    }
  }

  // Watch for failure (write error or receipt error)
  const currentFailed = (!!writeError || txFailed) && step === 'executing'
  // eslint-disable-next-line react/set-state-in-effect
  if (currentFailed && txStatuses[currentIndex]?.status === 'confirming') {
    const errMsg = writeError?.message?.includes('rejected') || writeError?.message?.includes('denied')
      ? 'Cancelled by user'
      : (writeError?.message ?? 'Transaction failed')
    setTxStatuses(prev => prev.map((s, i) =>
      i === currentIndex ? { ...s, status: 'failed', error: errMsg } : s))
    setStep('done')
  }

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!isConnected || !address) {
    return (
      <ScreenLayout title="Split Payment" subtitle="Send USDC to multiple recipients" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to use Split Payment." />
      </ScreenLayout>
    )
  }

  // ── Done view ──────────────────────────────────────────────────────────────
  if (step === 'done') {
    const succeeded = txStatuses.filter(s => s.status === 'success').length
    const failed    = txStatuses.filter(s => s.status === 'failed').length
    return (
      <ScreenLayout title="Split Payment" subtitle="Session complete" onBack={onBack}>
        <div className="flex flex-col items-center gap-4 py-6 text-center">
          <div className="flex size-20 items-center justify-center rounded-[24px]"
            style={{
              background: failed > 0 ? 'rgba(255,80,80,0.10)' : 'rgba(34,217,135,0.10)',
              border: `1px solid ${failed > 0 ? 'rgba(255,80,80,0.20)' : 'rgba(34,217,135,0.20)'}`,
            }}>
            {failed > 0
              ? <AlertTriangle className="size-10" style={{ color: 'var(--danger)' }} />
              : <CheckCircle2  className="size-10" style={{ color: 'var(--success)' }} />
            }
          </div>
          <div>
            <p className="display text-xl font-bold mb-1" style={{ color: 'var(--ink)' }}>
              {succeeded} of {txStatuses.length} sent
            </p>
            {failed > 0 && (
              <p className="text-sm" style={{ color: 'var(--danger)' }}>
                {failed} transfer{failed > 1 ? 's' : ''} failed — remaining were not retried automatically.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2">
          {txStatuses.map((s, i) => {
            const r = validRecipients[i]
            return (
              <div key={s.recipientId}
                className="flex items-center gap-3 rounded-[16px] px-4 py-3"
                style={{
                  background: 'var(--card)',
                  border: `1px solid ${s.status === 'success' ? 'rgba(34,217,135,0.18)' : s.status === 'failed' ? 'rgba(255,80,80,0.18)' : 'var(--card-border)'}`,
                }}>
                <div className="flex size-8 items-center justify-center rounded-[10px] shrink-0"
                  style={{ background: s.status === 'success' ? 'rgba(34,217,135,0.12)' : 'rgba(255,80,80,0.10)' }}>
                  {s.status === 'success'
                    ? <CheckCircle2 className="size-4" style={{ color: 'var(--success)' }} />
                    : <AlertTriangle className="size-4" style={{ color: 'var(--danger)' }} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                    {r?.amount} USDC → {formatAddress(r?.address ?? '')}
                  </p>
                  {s.error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{s.error}</p>}
                </div>
                {s.txHash && (
                  <a href={getTxExplorerUrl(s.txHash)} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-3.5" style={{ color: 'var(--muted)' }} />
                  </a>
                )}
              </div>
            )
          })}
        </div>

        <button onClick={() => { setStep('form'); setRecipients([{ id: nanoid(), address: '', amount: '' }, { id: nanoid(), address: '', amount: '' }]) }}
          className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
          style={{ background: 'var(--blue)', color: '#04090f' }}>
          New split
        </button>
      </ScreenLayout>
    )
  }

  // ── Executing view ─────────────────────────────────────────────────────────
  if (step === 'executing') {
    return (
      <ScreenLayout title="Split Payment" subtitle={`Sending ${currentIndex + 1} of ${queue.length}…`} onBack={onBack}>
        <div className="space-y-2">
          {txStatuses.map((s, i) => {
            const r = validRecipients[i]
            const isCurrent = i === currentIndex
            return (
              <div key={s.recipientId}
                className="flex items-center gap-3 rounded-[16px] px-4 py-3 transition-all"
                style={{
                  background: 'var(--card)',
                  border: `1px solid ${
                    s.status === 'success' ? 'rgba(34,217,135,0.18)' :
                    s.status === 'failed'  ? 'rgba(255,80,80,0.18)' :
                    isCurrent             ? 'rgba(78,155,255,0.24)' :
                    'var(--card-border)'
                  }`,
                  boxShadow: isCurrent ? '0 0 16px rgba(78,155,255,0.10)' : 'none',
                }}>
                <div className="flex size-8 items-center justify-center rounded-[10px] shrink-0"
                  style={{
                    background: s.status === 'success' ? 'rgba(34,217,135,0.12)' :
                      s.status === 'failed' ? 'rgba(255,80,80,0.10)' :
                      isCurrent ? 'rgba(78,155,255,0.14)' :
                      'rgba(255,255,255,0.05)',
                  }}>
                  {s.status === 'success'   ? <CheckCircle2 className="size-4" style={{ color: 'var(--success)' }} />
                  : s.status === 'failed'   ? <AlertTriangle className="size-4" style={{ color: 'var(--danger)' }} />
                  : isCurrent && (walletPending || isConfirming) ? <Loader2 className="size-4 animate-spin" style={{ color: 'var(--blue)' }} />
                  : <span className="text-xs font-bold" style={{ color: 'var(--subtle)' }}>{i + 1}</span>
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
                    {r?.amount} USDC → {formatAddress(r?.address ?? '')}
                  </p>
                  <p className="text-[11px]" style={{ color: 'var(--subtle)' }}>
                    {s.status === 'success'   ? 'Confirmed onchain'
                    : s.status === 'failed'   ? (s.error ?? 'Failed')
                    : isCurrent && isConfirming ? 'Confirming…'
                    : isCurrent && walletPending ? 'Confirm in wallet'
                    : i < currentIndex ? 'Pending'
                    : 'Waiting'}
                  </p>
                </div>
                {s.txHash && (
                  <a href={getTxExplorerUrl(s.txHash)} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="size-3.5" style={{ color: 'var(--muted)' }} />
                  </a>
                )}
              </div>
            )
          })}
        </div>

        <div className="rounded-[14px] px-3.5 py-3 flex items-start gap-2.5"
          style={{ background: 'rgba(255,176,32,0.06)', border: '1px solid rgba(255,176,32,0.14)' }}>
          <Info className="size-4 mt-0.5 shrink-0" style={{ color: '#ffb020' }} />
          <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
            Each transfer is a separate transaction. Do not close this page until all are confirmed.
          </p>
        </div>
      </ScreenLayout>
    )
  }

  // ── Review view ────────────────────────────────────────────────────────────
  if (step === 'review') {
    return (
      <ScreenLayout title="Review Split" subtitle={`${validRecipients.length} recipients`} onBack={() => setStep('form')}>

        <div className="rounded-[18px] overflow-hidden"
          style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}>
          {validRecipients.map((r, i) => (
            <div key={r.id} className="flex items-center justify-between px-4 py-3 gap-3"
              style={{ borderTop: i > 0 ? '1px solid rgba(255,255,255,0.05)' : undefined }}>
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex size-8 items-center justify-center rounded-[10px] shrink-0"
                  style={{ background: 'rgba(255,80,80,0.10)' }}>
                  <ArrowUpRight className="size-4" style={{ color: 'var(--danger)' }} />
                </div>
                <span className="mono text-xs truncate" style={{ color: 'var(--ink-2)' }}>
                  {formatAddress(r.address)}
                </span>
              </div>
              <span className="text-sm font-bold tabular-nums shrink-0" style={{ color: 'var(--ink)' }}>
                {r.amount} USDC
              </span>
            </div>
          ))}
          <div className="flex items-center justify-between px-4 py-3"
            style={{ borderTop: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}>
            <span className="text-sm font-bold" style={{ color: 'var(--ink-3)' }}>Total</span>
            <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
              {formatUsdcAmount(totalAmount)} USDC
            </span>
          </div>
        </div>

        <div className="rounded-[14px] px-3.5 py-3 flex items-start gap-2.5"
          style={{ background: 'rgba(255,91,91,0.06)', border: '1px solid rgba(255,91,91,0.16)' }}>
          <AlertTriangle className="size-4 mt-0.5 shrink-0" style={{ color: 'var(--danger)' }} />
          <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
            <strong style={{ color: 'var(--danger)' }}>Not atomic.</strong>{' '}
            These are {validRecipients.length} separate wallet confirmations.
            If you cancel partway through, earlier recipients will have received funds and later ones will not.
          </p>
        </div>

        <button
          onClick={handleExecute}
          className="w-full rounded-[16px] py-4 text-sm font-bold flex items-center justify-center gap-2 transition-all hover:brightness-105 active:scale-[0.99]"
          style={{ background: 'var(--danger)', color: '#fff' }}>
          Send to {validRecipients.length} recipients
        </button>

        <button onClick={() => setStep('form')}
          className="w-full rounded-[16px] py-3.5 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
          style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}>
          Edit
        </button>
      </ScreenLayout>
    )
  }

  // ── Form view ──────────────────────────────────────────────────────────────
  return (
    <ScreenLayout
      title="Split Payment"
      subtitle="Send USDC to multiple recipients"
      onBack={onBack}
      action={
        <button onClick={handleFillEqual}
          className="text-xs font-bold px-3 py-1.5 rounded-[10px] transition-all hover:brightness-110"
          style={{ background: 'rgba(78,155,255,0.14)', border: '1px solid rgba(78,155,255,0.22)', color: 'var(--blue)' }}>
          Split equally
        </button>
      }
    >
      {/* Recipients */}
      <div className="space-y-3">
        {recipients.map((r, i) => {
          const addrOk  = !r.address || isValidAddress(r.address.trim())
          const amtOk   = !r.amount  || (parseUsdcInput(r.amount) !== null && parseUsdcInput(r.amount)! > 0n)
          const isSelf  = !!address && r.address.trim().toLowerCase() === address.toLowerCase()
          return (
            <div key={r.id}
              className="rounded-[18px] p-4 space-y-3"
              style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--subtle)' }}>
                  Recipient {i + 1}
                </span>
                {recipients.length > 1 && (
                  <button onClick={() => removeRecipient(r.id)}
                    className="size-7 flex items-center justify-center rounded-[8px] hover:bg-white/5 transition-colors"
                    style={{ color: 'var(--danger)' }}>
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>

              <input
                type="text" placeholder="0x wallet address"
                value={r.address}
                onChange={e => updateRecipient(r.id, 'address', e.target.value.trim())}
                className="w-full rounded-[12px] px-3 py-2.5 text-xs mono outline-none"
                style={{
                  background: 'rgba(0,0,0,0.25)',
                  border: `1px solid ${!addrOk || isSelf ? 'rgba(255,80,80,0.35)' : 'rgba(255,255,255,0.08)'}`,
                  color: 'var(--ink)',
                }}
              />
              {isSelf && <p className="text-xs" style={{ color: 'var(--danger)' }}>Cannot send to yourself</p>}
              {!addrOk && !isSelf && r.address && <p className="text-xs" style={{ color: 'var(--danger)' }}>Invalid address</p>}

              <input
                type="text" inputMode="decimal" placeholder="Amount (USDC)"
                value={r.amount}
                onChange={e => updateRecipient(r.id, 'amount', e.target.value.replace(/[^0-9.]/g, ''))}
                className="w-full rounded-[12px] px-3 py-2.5 text-sm font-semibold tabular-nums outline-none"
                style={{
                  background: 'rgba(0,0,0,0.25)',
                  border: `1px solid ${!amtOk ? 'rgba(255,80,80,0.35)' : 'rgba(255,255,255,0.08)'}`,
                  color: 'var(--ink)',
                }}
              />
            </div>
          )
        })}
      </div>

      {hasDuplicates && (
        <p className="text-xs font-semibold" style={{ color: '#ffb020' }}>
          Warning: duplicate recipient address detected.
        </p>
      )}

      {invalidCount > 0 && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          {invalidCount} recipient{invalidCount > 1 ? 's' : ''} with invalid or missing data will be skipped.
        </p>
      )}

      <button
        onClick={addRecipient}
        className="flex items-center justify-center gap-2 w-full rounded-[14px] py-3 text-sm font-semibold transition-all hover:brightness-110"
        style={{ background: 'rgba(78,155,255,0.08)', border: '1px dashed rgba(78,155,255,0.25)', color: 'var(--blue)' }}>
        <Plus className="size-4" /> Add recipient
      </button>

      {/* Total preview */}
      {validRecipients.length > 0 && (
        <div className="flex items-center justify-between rounded-[14px] px-4 py-3 text-sm"
          style={{ background: 'var(--card)', border: '1px solid var(--card-border)' }}>
          <span style={{ color: 'var(--subtle)' }}>Total ({validRecipients.length} recipients)</span>
          <span className="font-bold tabular-nums" style={{ color: 'var(--ink)' }}>
            {formatUsdcAmount(totalAmount)} USDC
          </span>
        </div>
      )}

      <button
        onClick={handleReview}
        disabled={validRecipients.length < 1}
        className="w-full rounded-[16px] py-4 text-sm font-bold flex items-center justify-center gap-2 transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ background: 'var(--blue)', color: '#04090f' }}>
        Review split ({validRecipients.length})
      </button>

      <div className="rounded-[14px] px-3.5 py-3 flex items-start gap-2.5"
        style={{ background: 'rgba(255,176,32,0.06)', border: '1px solid rgba(255,176,32,0.14)' }}>
        <Info className="size-4 mt-0.5 shrink-0" style={{ color: '#ffb020' }} />
        <p className="text-xs leading-relaxed" style={{ color: 'var(--ink-3)' }}>
          Each recipient requires a separate wallet confirmation. Transactions on Arc Mainnet involve real USDC and are irreversible.
        </p>
      </div>
    </ScreenLayout>
  )
}
