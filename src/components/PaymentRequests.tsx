/**
 * PaymentRequests — create shareable payment request links + QR codes.
 * Requests are labelled UNPAID — no automatic onchain verification.
 * All logic preserved. Uses ScreenLayout.
 */

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { QRCodeSVG } from 'qrcode.react'
import { Plus, Copy, Check, Trash2, Info, FileText, ChevronRight } from 'lucide-react'
import {
  encodePaymentURI, formatAddress, formatTimestamp, copyToClipboard,
  savePaymentRequest, getPaymentRequests, deletePaymentRequest,
  isValidAddress, nanoid, type LocalPaymentRequest,
} from '@/utils'
import { ARC_MAINNET_CHAIN_ID } from '@/config'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

interface Props { onBack: () => void }
type View = 'list' | 'create' | 'detail'

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        void copyToClipboard(text).then(() => {
          setCopied(true); setTimeout(() => setCopied(false), 2000)
        })
      }}
      className="flex items-center justify-center gap-2 rounded-[14px] py-3 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
      style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
    >
      {copied
        ? <Check className="size-4" style={{ color: 'var(--success)' }} />
        : <Copy  className="size-4" />}
      {label}
    </button>
  )
}

export function PaymentRequests({ onBack }: Props) {
  const { address, isConnected } = useAccount()
  const [view, setView]     = useState<View>('list')
  const [requests, setReqs] = useState<LocalPaymentRequest[]>(getPaymentRequests)
  const [selected, setSel]  = useState<LocalPaymentRequest | null>(null)

  const [createAmount, setCreateAmount] = useState('')
  const [createNote,   setCreateNote]   = useState('')
  const [createTo,     setCreateTo]     = useState('')

  if (!isConnected || !address) {
    return (
      <ScreenLayout title="Requests" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to create payment requests." />
      </ScreenLayout>
    )
  }

  function handleCreate() {
    const to  = createTo.trim() || address!
    const req: LocalPaymentRequest = {
      id: nanoid(), to, amount: createAmount.trim(),
      note: createNote.trim() || undefined, createdAt: Date.now(),
    }
    savePaymentRequest(req)
    setReqs(getPaymentRequests())
    setSel(req); setView('detail')
    setCreateAmount(''); setCreateNote(''); setCreateTo('')
  }

  function handleDelete(id: string) {
    deletePaymentRequest(id)
    setReqs(getPaymentRequests())
    setView('list'); setSel(null)
  }

  /* ── Detail ──────────────────────────────────────────────────────────── */
  if (view === 'detail' && selected) {
    const uri      = encodePaymentURI({ to: selected.to, amount: selected.amount || undefined, note: selected.note, chainId: ARC_MAINNET_CHAIN_ID })
    const shareUrl = `${window.location.origin}${window.location.pathname}?req=${encodeURIComponent(uri)}`

    return (
      <ScreenLayout title="Payment Request" onBack={() => setView('list')}>
        {/* Status badge */}
        <div className="flex justify-center mb-5">
          <span
            className="text-xs font-bold px-3 py-1.5 rounded-full uppercase tracking-wider"
            style={{
              background: 'var(--warning-dim)',
              color: 'var(--warning)',
              border: '1px solid rgba(255,176,32,0.22)',
            }}
          >
            Unpaid
          </span>
        </div>

        {/* QR */}
        <div className="flex justify-center mb-5">
          <div
            className="p-1 rounded-[22px]"
            style={{
              background: 'linear-gradient(135deg, rgba(78,155,255,0.22) 0%, rgba(157,120,251,0.18) 100%)',
              boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
            }}
          >
            <div className="rounded-[18px] p-4 bg-white">
              <QRCodeSVG value={uri} size={184} level="M" marginSize={0} />
            </div>
          </div>
        </div>

        {/* Details */}
        <div
          className="rounded-[18px] p-4 mb-4 space-y-2.5 text-sm"
          style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
        >
          {selected.amount && (
            <div className="flex justify-between">
              <span style={{ color: 'var(--subtle)' }}>Amount</span>
              <span className="font-bold" style={{ color: 'var(--accent)' }}>{selected.amount} USDC</span>
            </div>
          )}
          <div className="flex justify-between">
            <span style={{ color: 'var(--subtle)' }}>To</span>
            <span className="mono text-xs" style={{ color: 'var(--ink-2)' }}>{formatAddress(selected.to)}</span>
          </div>
          {selected.note && (
            <div className="flex justify-between">
              <span style={{ color: 'var(--subtle)' }}>Note</span>
              <span className="text-right max-w-[180px]" style={{ color: 'var(--ink-2)' }}>{selected.note}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span style={{ color: 'var(--subtle)' }}>Created</span>
            <span style={{ color: 'var(--muted)' }}>{formatTimestamp(selected.createdAt)}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--subtle)' }}>Network</span>
            <span style={{ color: 'var(--ink-2)' }}>Arc Mainnet</span>
          </div>
        </div>

        {/* Warning */}
        <div
          className="flex items-start gap-2.5 rounded-[14px] px-3.5 py-3 mb-4 text-xs"
          style={{ background: 'var(--warning-dim)', border: '1px solid rgba(255,176,32,0.18)' }}
        >
          <Info className="size-3.5 mt-0.5 shrink-0" style={{ color: 'var(--warning)' }} />
          <span style={{ color: 'var(--warning)' }}>
            Labelled Unpaid. Quick Pay does not auto-verify payment — check Arc Explorer.
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <CopyBtn text={uri}      label="Copy URI" />
          <CopyBtn text={shareUrl} label="Copy link" />
        </div>

        <button
          onClick={() => handleDelete(selected.id)}
          className="flex items-center justify-center gap-2 w-full rounded-[16px] py-3.5 text-sm font-bold transition-all hover:opacity-70 active:scale-[0.99]"
          style={{ color: 'var(--danger)', border: '1px solid rgba(255,91,91,0.20)' }}
        >
          <Trash2 className="size-4" /> Delete request
        </button>
      </ScreenLayout>
    )
  }

  /* ── Create ──────────────────────────────────────────────────────────── */
  if (view === 'create') {
    const amountValid = !createAmount || /^\d*\.?\d{0,6}$/.test(createAmount)
    const toValid     = !createTo || isValidAddress(createTo)

    return (
      <ScreenLayout title="New Request" onBack={() => setView('list')}>
        <div className="space-y-4 mb-6">
          <FieldBlock label="Your receive address">
            <div
              className="rounded-[14px] px-4 py-3 mono text-xs break-all"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', color: 'var(--muted)' }}
            >
              {address}
            </div>
          </FieldBlock>

          <FieldBlock label="Recipient address (optional)">
            <input
              value={createTo}
              onChange={(e) => setCreateTo(e.target.value.trim())}
              placeholder={address}
              className="w-full rounded-[14px] px-4 py-3 text-sm mono outline-none"
              style={{
                background: 'var(--surface-strong)',
                border: `1px solid ${createTo && !toValid ? 'var(--danger)' : 'var(--border)'}`,
                color: 'var(--ink)',
              }}
              spellCheck={false}
            />
            {createTo && !toValid && (
              <p className="mt-1.5 text-xs" style={{ color: 'var(--danger)' }}>Invalid address</p>
            )}
          </FieldBlock>

          <FieldBlock label="Amount USDC (optional)">
            <input
              inputMode="decimal"
              value={createAmount}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (v.split('.').length <= 2) setCreateAmount(v)
              }}
              placeholder="0.00"
              className="w-full rounded-[14px] px-4 py-3 text-sm outline-none"
              style={{
                background: 'var(--surface-strong)',
                border: `1px solid ${!amountValid ? 'var(--danger)' : 'var(--border)'}`,
                color: 'var(--ink)',
              }}
            />
          </FieldBlock>

          <FieldBlock label="Note (optional)">
            <input
              value={createNote}
              onChange={(e) => setCreateNote(e.target.value.slice(0, 80))}
              placeholder="Invoice #123, coffee…"
              className="w-full rounded-[14px] px-4 py-3 text-sm outline-none"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', color: 'var(--ink)' }}
            />
          </FieldBlock>
        </div>

        <button
          onClick={handleCreate}
          disabled={!amountValid || !toValid}
          className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-35 disabled:cursor-not-allowed"
          style={{ background: 'var(--blue)', color: '#04090f' }}
        >
          Generate request
        </button>
      </ScreenLayout>
    )
  }

  /* ── List ────────────────────────────────────────────────────────────── */
  return (
    <ScreenLayout
      title="Requests"
      onBack={onBack}
      action={
        <button
          onClick={() => setView('create')}
          className="flex items-center gap-1.5 rounded-[12px] px-3 py-2 text-sm font-bold transition-all hover:brightness-105 active:scale-95"
          style={{ background: 'var(--blue)', color: '#04090f' }}
        >
          <Plus className="size-3.5" /> New
        </button>
      }
    >
      {requests.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center gap-4">
          <div
            className="flex size-16 items-center justify-center rounded-[20px]"
            style={{
              background: 'var(--surface-strong)',
              border: '1px solid var(--border)',
            }}
          >
            <FileText className="size-8" style={{ color: 'var(--subtle)' }} />
          </div>
          <div>
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--ink-2)' }}>No requests yet</p>
            <p className="text-xs max-w-[220px]" style={{ color: 'var(--muted)' }}>
              Create a request to share a QR code or payment link.
            </p>
          </div>
          <button
            onClick={() => setView('create')}
            className="flex items-center gap-2 rounded-[14px] px-5 py-3 text-sm font-bold transition-all hover:brightness-105 active:scale-95"
            style={{ background: 'var(--blue)', color: '#04090f' }}
          >
            <Plus className="size-4" /> Create first request
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {requests.map((req) => (
            <button
              key={req.id}
              onClick={() => { setSel(req); setView('detail') }}
              className="w-full rounded-[18px] px-4 py-3.5 text-left transition-all hover:brightness-105 active:scale-[0.99]"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-bold" style={{ color: req.amount ? 'var(--accent)' : 'var(--ink)', fontSize: '0.95rem' }}>
                  {req.amount ? `${req.amount} USDC` : 'Open amount'}
                </span>
                <div className="flex items-center gap-2">
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded-full"
                    style={{ background: 'var(--warning-dim)', color: 'var(--warning)' }}
                  >
                    Unpaid
                  </span>
                  <ChevronRight className="size-4" style={{ color: 'var(--subtle)' }} />
                </div>
              </div>
              <p className="mono text-xs" style={{ color: 'var(--subtle)' }}>{formatAddress(req.to)}</p>
              {req.note && <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted)' }}>{req.note}</p>}
              <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>{formatTimestamp(req.createdAt)}</p>
            </button>
          ))}
        </div>
      )}
    </ScreenLayout>
  )
}

function FieldBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label
        className="block text-xs font-bold mb-2 uppercase tracking-wider"
        style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}
      >
        {label}
      </label>
      {children}
    </div>
  )
}
