/**
 * PaymentReceipt — modal overlay shown after confirmed onchain USDC transfer.
 * Only displayed with a real receipt. Visual layer redesigned.
 */

import { useState } from 'react'
import { CheckCircle2, Copy, Check, Share2, ExternalLink, X } from 'lucide-react'
import { copyToClipboard, formatAddress, getTxExplorerUrl, type LocalReceipt } from '@/utils'
import { toast } from 'sonner'

interface Props { receipt: LocalReceipt; onClose: () => void }

export function PaymentReceipt({ receipt, onClose }: Props) {
  const [copiedHash, setCopiedHash] = useState(false)

  function handleCopyHash() {
    void copyToClipboard(receipt.txHash).then(() => {
      setCopiedHash(true)
      setTimeout(() => setCopiedHash(false), 2000)
    })
  }

  async function handleShare() {
    const text =
      `Quick Pay Receipt\n` +
      `Amount: ${receipt.amount} USDC\n` +
      `To: ${receipt.to}\n` +
      `Network: ${receipt.network}\n` +
      `Tx: ${receipt.txHash}\n` +
      `Explorer: ${getTxExplorerUrl(receipt.txHash)}`
    if (navigator.share) {
      try { await navigator.share({ title: 'Quick Pay Receipt', text }) }
      catch { /* cancelled */ }
    } else {
      void copyToClipboard(text).then(() => toast.success('Receipt copied'))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(16px)' }}
    >
      <div
        className="w-full max-w-sm rounded-[28px] p-5 space-y-4"
        style={{
          background: 'linear-gradient(160deg, #0d1e38 0%, #091730 50%, #0a1a2e 100%)',
          border: '1px solid rgba(34,217,135,0.22)',
          boxShadow:
            '0 0 80px rgba(34,217,135,0.06), ' +
            '0 32px 80px rgba(0,0,0,0.9), ' +
            '0 1px 0 rgba(255,255,255,0.05) inset',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="flex size-12 items-center justify-center rounded-[16px]"
              style={{
                background: 'rgba(34,217,135,0.12)',
                border: '1px solid rgba(34,217,135,0.22)',
              }}
            >
              <CheckCircle2 className="size-6" style={{ color: 'var(--success)' }} />
            </div>
            <div>
              <h2
                className="display font-bold"
                style={{ fontSize: '1.05rem', color: 'var(--ink)', letterSpacing: '-0.03em' }}
              >
                Payment sent
              </h2>
              <p className="text-xs font-semibold" style={{ color: 'var(--success)' }}>
                Confirmed · Arc Mainnet
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-xl transition-all hover:bg-white/8 active:scale-90"
            aria-label="Close receipt"
          >
            <X className="size-4" style={{ color: 'var(--muted)' }} />
          </button>
        </div>

        {/* Amount hero */}
        <div
          className="rounded-[18px] py-5 text-center"
          style={{
            background: 'rgba(34,217,135,0.06)',
            border: '1px solid rgba(34,217,135,0.14)',
          }}
        >
          <p
            className="display font-bold tabular-nums"
            style={{
              fontSize: 'clamp(2rem, 8vw, 2.5rem)',
              color: 'var(--ink)',
              letterSpacing: '-0.04em',
            }}
          >
            {receipt.amount}
          </p>
          <p className="font-semibold mt-1" style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.35)' }}>USDC</p>
        </div>

        {/* Details */}
        <div
          className="rounded-[16px] p-4 space-y-2.5 text-sm"
          style={{ background: 'rgba(0,0,0,0.28)', border: '1px solid var(--border-soft)' }}
        >
          <RRow label="To"      value={formatAddress(receipt.to)}   mono />
          <RRow label="From"    value={formatAddress(receipt.from)} mono />
          <RRow label="Network" value={receipt.network} />
          <RRow label="Status"  value="Confirmed" success />
          {receipt.note && <RRow label="Note" value={receipt.note} />}
          <RRow label="Date"    value={new Date(receipt.confirmedAt).toLocaleString()} />
          {/* Tx hash */}
          <div className="flex items-center justify-between">
            <span style={{ color: 'var(--subtle)' }}>Tx hash</span>
            <div className="flex items-center gap-1.5">
              <span className="mono text-xs" style={{ color: 'var(--ink-2)' }}>
                {formatAddress(receipt.txHash)}
              </span>
              <button
                onClick={handleCopyHash}
                className="flex size-6 items-center justify-center rounded-lg transition-all hover:bg-white/10 active:scale-90"
              >
                {copiedHash
                  ? <Check className="size-3" style={{ color: 'var(--success)' }} />
                  : <Copy  className="size-3" style={{ color: 'var(--muted)' }} />}
              </button>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 gap-2.5">
          <button
            onClick={() => { void handleShare() }}
            className="flex items-center justify-center gap-2 rounded-[14px] py-3.5 text-sm font-bold transition-all hover:brightness-110 active:scale-[0.99]"
            style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
          >
            <Share2 className="size-4" /> Share
          </button>
          <a
            href={getTxExplorerUrl(receipt.txHash)}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-[14px] py-3.5 text-sm font-bold transition-all hover:brightness-110 active:scale-[0.99]"
            style={{ background: 'rgba(78,155,255,0.12)', color: 'var(--blue)', border: '1px solid rgba(78,155,255,0.20)' }}
          >
            Explorer <ExternalLink className="size-3.5" />
          </a>
        </div>

        <button
          onClick={onClose}
          className="w-full rounded-[16px] py-3.5 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
          style={{ background: 'var(--blue)', color: '#04090f', letterSpacing: '-0.01em' }}
        >
          Done
        </button>
      </div>
    </div>
  )
}

function RRow({ label, value, mono, success }: { label: string; value: string; mono?: boolean; success?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: 'var(--subtle)' }}>{label}</span>
      <span
        className={mono ? 'mono text-xs' : 'font-semibold text-sm'}
        style={{ color: success ? 'var(--success)' : 'var(--ink-2)' }}
      >
        {value}
      </span>
    </div>
  )
}
