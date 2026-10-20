/**
 * ReceiveSheet — QR code + address for receiving USDC.
 * All logic preserved. Uses ScreenLayout.
 */

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { QRCodeSVG } from 'qrcode.react'
import { Copy, Check, Share2, Info } from 'lucide-react'
import { copyToClipboard, encodePaymentURI } from '@/utils'
import { toast } from 'sonner'
import { ScreenLayout, EmptyWalletState } from '@/components/ScreenLayout'

interface Props { onBack: () => void }

export function ReceiveSheet({ onBack }: Props) {
  const { address, isConnected } = useAccount()
  const [requestAmount, setRequestAmount] = useState('')
  const [requestNote,   setRequestNote]   = useState('')
  const [copied, setCopied] = useState(false)

  if (!isConnected || !address) {
    return (
      <ScreenLayout title="Receive USDC" onBack={onBack}>
        <EmptyWalletState message="Connect your wallet to show your receive address." />
      </ScreenLayout>
    )
  }

  const hasAmount = requestAmount && /^\d*\.?\d+$/.test(requestAmount) && parseFloat(requestAmount) > 0
  const qrContent = encodePaymentURI({
    to:     address,
    amount: hasAmount ? requestAmount : undefined,
    note:   requestNote.trim() || undefined,
  })

  function handleCopy() {
    void copyToClipboard(address!).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    })
  }

  async function handleShare() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Quick Pay — Receive USDC',
          text:  `Send USDC to my address on Arc Mainnet:\n${address!}`,
          url:   window.location.href,
        })
      } catch { /* cancelled */ }
    } else {
      void copyToClipboard(address!).then(() => toast.success('Address copied'))
    }
  }

  return (
    <ScreenLayout
      title="Receive USDC"
      subtitle="Share your address or QR code"
      onBack={onBack}
    >
      {/* QR tile */}
      <div className="flex justify-center mb-5">
        <div
          className="p-1 rounded-[22px]"
          style={{
            background: 'linear-gradient(135deg, rgba(78,155,255,0.25) 0%, rgba(14,232,255,0.18) 50%, rgba(157,120,251,0.20) 100%)',
            boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          }}
        >
          <div className="rounded-[18px] p-4 bg-white">
            <QRCodeSVG value={qrContent} size={200} level="M" marginSize={0} />
          </div>
        </div>
      </div>

      {/* Address chip */}
      <div
        className="rounded-[16px] px-4 py-3.5 mb-4 flex items-center justify-between gap-3"
        style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
      >
        <span className="mono text-xs break-all flex-1 leading-relaxed" style={{ color: 'var(--ink-2)' }}>
          {address}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopy}
            className="flex size-8 items-center justify-center rounded-xl transition-all hover:bg-white/8 active:scale-90"
            aria-label="Copy address"
          >
            {copied
              ? <Check className="size-4" style={{ color: 'var(--success)' }} />
              : <Copy  className="size-4" style={{ color: 'var(--muted)' }} />}
          </button>
          <button
            onClick={() => { void handleShare() }}
            className="flex size-8 items-center justify-center rounded-xl transition-all hover:bg-white/8 active:scale-90"
            aria-label="Share address"
          >
            <Share2 className="size-4" style={{ color: 'var(--muted)' }} />
          </button>
        </div>
      </div>

      {/* Optional QR encoding */}
      <div
        className="rounded-[18px] p-4 mb-4 space-y-3"
        style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
      >
        <p
          className="text-xs font-bold uppercase tracking-wider"
          style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}
        >
          Encode in QR (optional)
        </p>

        <div>
          <label className="block text-xs mb-1.5 font-semibold" style={{ color: 'var(--muted)' }}>Amount (USDC)</label>
          <input
            inputMode="decimal"
            value={requestAmount}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              if (v.split('.').length <= 2) setRequestAmount(v)
            }}
            placeholder="0.00"
            className="w-full rounded-[12px] px-4 py-3 text-sm outline-none"
            style={{
              background: 'var(--surface-input)',
              border: '1px solid var(--border)',
              color: 'var(--ink)',
            }}
          />
        </div>

        <div>
          <label className="block text-xs mb-1.5 font-semibold" style={{ color: 'var(--muted)' }}>Note</label>
          <input
            value={requestNote}
            onChange={(e) => setRequestNote(e.target.value.slice(0, 80))}
            placeholder="What is this for?"
            className="w-full rounded-[12px] px-4 py-3 text-sm outline-none"
            style={{
              background: 'var(--surface-input)',
              border: '1px solid var(--border)',
              color: 'var(--ink)',
            }}
          />
        </div>
      </div>

      {/* Notice */}
      <div
        className="flex items-start gap-2.5 rounded-[14px] px-3.5 py-3 text-xs"
        style={{ background: 'rgba(78,155,255,0.06)', border: '1px solid rgba(78,155,255,0.14)' }}
      >
        <Info className="size-3.5 mt-0.5 shrink-0" style={{ color: 'var(--blue)' }} />
        <span style={{ color: 'var(--ink-3)' }}>
          Displaying this QR does not receive funds. The sender must sign a transaction.
          Quick Pay supports USDC on Arc Mainnet (chain ID 5042) only.
        </span>
      </div>
    </ScreenLayout>
  )
}
