/**
 * ScanPay — QR code scanner for payment URIs.
 * Camera fix (facingMode: 'environment' plain string) preserved.
 * Robust DOM-ready detection: defers scanner start until the reader div
 * is actually in the DOM, avoiding silent "element not found" failures on
 * mobile browsers that render asynchronously after state change.
 */

import { useState, useRef, useEffect } from 'react'
import { Html5Qrcode, Html5QrcodeScannerState } from 'html5-qrcode'
import { ScanLine, CameraOff, RefreshCw, CheckCircle2, XCircle, Zap } from 'lucide-react'
import { decodePaymentURI, isValidAddress } from '@/utils'
import { ScreenLayout } from '@/components/ScreenLayout'

interface Props {
  onBack: () => void
  onScanned: (result: { to: string; amount?: string; note?: string }) => void
}

type ScanState = 'idle' | 'scanning' | 'success' | 'error'

const READER_ID = 'qp-qr-reader'

/** Wait for a DOM element to exist, polling via rAF. Resolves when found or rejects after timeout. */
function waitForElement(id: string, timeoutMs = 3000): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function check() {
      const el = document.getElementById(id)
      if (el) { resolve(el); return }
      if (Date.now() > deadline) { reject(new Error(`DOM element #${id} not found within ${timeoutMs}ms`)); return }
      requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
  })
}

export function ScanPay({ onBack, onScanned }: Props) {
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [errorMsg,  setErrorMsg]  = useState('')
  const [preview,   setPreview]   = useState<{ to: string; amount?: string; note?: string } | null>(null)

  const scannerRef    = useRef<Html5Qrcode | null>(null)
  const isScanningRef = useRef(false)
  const mountedRef    = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Start scanner only after the scanning state renders the DOM element.
  // waitForElement() polls via rAF so we never call scanner.start() before
  // the #qp-qr-reader div is in the DOM — which is the root cause of silent
  // camera failures on iOS Safari and some Android browsers.
  useEffect(() => {
    if (scanState !== 'scanning') return
    if (isScanningRef.current) return

    let cancelled = false

    async function startScanner() {
      try {
        // Wait for the reader div to actually appear in the DOM
        await waitForElement(READER_ID)
        if (cancelled || !mountedRef.current) return

        const scanner = new Html5Qrcode(READER_ID)
        scannerRef.current   = scanner
        isScanningRef.current = true

        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          (decodedText) => {
            // Stop scanner then process result
            void stopScanner().then(() => {
              if (mountedRef.current) handleDecode(decodedText)
            })
          },
          // Per-frame error callback — suppress; only care about fatal errors
          undefined,
        )
      } catch (err: unknown) {
        if (cancelled || !mountedRef.current) return
        isScanningRef.current = false
        const msg = err instanceof Error ? err.message : String(err)
        setScanState('error')
        if (msg.toLowerCase().includes('permission') || msg.toLowerCase().includes('denied') || msg.toLowerCase().includes('notallowed')) {
          setErrorMsg('Camera permission denied. Allow camera access in your browser settings, then try again.')
        } else if (!window.isSecureContext) {
          setErrorMsg('Camera requires a secure (HTTPS) connection.')
        } else if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no cameras')) {
          setErrorMsg('No camera found. Make sure the device has a camera and try again.')
        } else {
          setErrorMsg(`Camera error: ${msg}`)
        }
      }
    }

    void startScanner()

    return () => {
      cancelled = true
      void stopScanner()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanState])

  async function stopScanner() {
    if (!scannerRef.current) return
    const sc = scannerRef.current
    try {
      const state = sc.getState()
      if (
        state === Html5QrcodeScannerState.SCANNING ||
        state === Html5QrcodeScannerState.PAUSED
      ) {
        await sc.stop()
      }
    } catch { /* ignore */ }
    try { sc.clear() } catch { /* ignore */ }
    scannerRef.current    = null
    isScanningRef.current = false
  }

  function handleDecode(text: string) {
    const trimmed = text.trim()

    // 1. Try Quick Pay URI first (quickpay:0x...?chain=...&token=...&amount=...)
    try {
      const decoded = decodePaymentURI(trimmed)
      if (decoded?.to && isValidAddress(decoded.to)) {
        setPreview({
          to:     decoded.to,
          amount: decoded.amount,
          note:   decoded.note,
        })
        setScanState('success')
        return
      }
    } catch { /* not a quick-pay URI */ }

    // 2. Plain EIP-55 / EIP-681 ethereum: URI
    // ethereum:0x<addr>[@chainId][/functionName][?params]
    const ethMatch = trimmed.match(/^ethereum:(0x[0-9a-fA-F]{40})/)
    if (ethMatch && isValidAddress(ethMatch[1])) {
      // Parse optional value param: ethereum:0xADDR?value=1000000 (6-dec USDC micro-units)
      // or amount= (human)
      let amount: string | undefined
      try {
        const qIdx = trimmed.indexOf('?')
        if (qIdx >= 0) {
          const params = new URLSearchParams(trimmed.slice(qIdx + 1))
          const raw = params.get('uint256') ?? params.get('amount') ?? params.get('value')
          if (raw) amount = raw
        }
      } catch { /* ignore parse errors */ }
      setPreview({ to: ethMatch[1], amount })
      setScanState('success')
      return
    }

    // 3. Bare 0x address
    if (/^0x[0-9a-fA-F]{40}$/.test(trimmed) && isValidAddress(trimmed)) {
      setPreview({ to: trimmed })
      setScanState('success')
      return
    }

    // 4. Invalid
    setScanState('error')
    setErrorMsg(
      trimmed.startsWith('0x') || trimmed.startsWith('quickpay:') || trimmed.startsWith('ethereum:')
        ? `Invalid address or URI format in QR code: "${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}"`
        : 'QR code does not contain a wallet address or payment URI. Make sure you are scanning a Quick Pay or Ethereum address QR code.'
    )
  }

  function handleStart() { setErrorMsg(''); setPreview(null); setScanState('scanning') }

  function handleReset() {
    void stopScanner().then(() => {
      if (mountedRef.current) {
        setPreview(null); setErrorMsg(''); setScanState('idle')
      }
    })
  }

  return (
    <ScreenLayout
      title="Scan &amp; Pay"
      subtitle="Scan a Quick Pay or Ethereum address QR code"
      onBack={() => { void stopScanner(); onBack() }}
    >
      {/* Scanner viewport */}
      {scanState === 'scanning' ? (
        <div className="mb-5">
          <div
            className="relative rounded-[20px] overflow-hidden"
            style={{
              background: '#000',
              border: '1px solid var(--border-accent)',
              boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
            }}
          >
            <div id={READER_ID} style={{ width: '100%' }} />

            {/* Corner bracket overlay */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <svg width="220" height="220" viewBox="0 0 220 220" fill="none">
                {[
                  'M20,52 L20,20 L52,20',
                  'M168,20 L200,20 L200,52',
                  'M200,168 L200,200 L168,200',
                  'M52,200 L20,200 L20,168',
                ].map((d, i) => (
                  <path key={i} d={d} stroke="rgba(78,155,255,0.9)" strokeWidth="3.5"
                    strokeLinecap="round" strokeLinejoin="round" />
                ))}
                <line x1="50" y1="110" x2="170" y2="110"
                  stroke="rgba(78,155,255,0.4)" strokeWidth="1" strokeDasharray="4 4" />
              </svg>
            </div>
          </div>

          <button
            onClick={handleReset}
            className="flex items-center justify-center gap-2 w-full mt-3 rounded-[14px] py-3.5 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
            style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
          >
            <XCircle className="size-4" style={{ color: 'var(--subtle)' }} /> Cancel scan
          </button>
        </div>
      ) : (
        <div className="mb-5">
          {/* Idle / error placeholder */}
          <div
            className="flex flex-col items-center justify-center rounded-[20px] py-14 gap-4 mb-4"
            style={{
              background: 'linear-gradient(145deg, var(--surface) 0%, var(--surface-strong) 100%)',
              border: `1px ${scanState === 'error' ? 'solid rgba(255,91,91,0.22)' : 'dashed var(--border)'}`,
            }}
          >
            <div
              className="flex size-18 items-center justify-center rounded-[22px]"
              style={{
                background: scanState === 'error' ? 'var(--danger-dim)' : 'var(--blue-dim)',
                border: `1px solid ${scanState === 'error' ? 'rgba(255,91,91,0.20)' : 'var(--border-accent)'}`,
              }}
            >
              {scanState === 'error'
                ? <CameraOff className="size-8" style={{ color: 'var(--danger)' }} />
                : <ScanLine  className="size-8" style={{ color: 'var(--blue)' }} />}
            </div>

            {scanState === 'error' ? (
              <p className="text-sm text-center max-w-[260px] leading-relaxed px-4" style={{ color: 'var(--danger)' }}>
                {errorMsg}
              </p>
            ) : (
              <p className="text-sm" style={{ color: 'var(--muted)' }}>Point camera at a QR code</p>
            )}
          </div>

          {/* Success preview */}
          {scanState === 'success' && preview && (
            <div
              className="rounded-[18px] p-4 mb-4 space-y-2.5"
              style={{
                background: 'rgba(34,217,135,0.06)',
                border: '1px solid rgba(34,217,135,0.18)',
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="size-4" style={{ color: 'var(--success)' }} />
                <span className="text-sm font-bold" style={{ color: 'var(--success)' }}>QR code scanned</span>
              </div>
              {[
                { label: 'To',     value: preview.to,    mono: true  },
                { label: 'Amount', value: preview.amount ? `${preview.amount} USDC` : 'Not specified', mono: false },
                ...(preview.note ? [{ label: 'Note', value: preview.note, mono: false }] : []),
              ].map(({ label, value, mono }) => (
                <div key={label} className="flex justify-between text-sm">
                  <span style={{ color: 'var(--subtle)' }}>{label}</span>
                  <span className={mono ? 'mono text-xs' : ''} style={{ color: 'var(--ink-2)' }}>{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* CTAs */}
      {scanState === 'success' && preview ? (
        <div className="space-y-3">
          <button
            onClick={() => onScanned(preview)}
            className="flex items-center justify-center gap-2 w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
            style={{ background: 'var(--blue)', color: '#04090f' }}
          >
            <Zap className="size-4" /> Review &amp; send
          </button>
          <button
            onClick={handleReset}
            className="w-full rounded-[16px] py-3.5 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
            style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
          >
            Scan another code
          </button>
        </div>
      ) : scanState === 'error' ? (
        <button
          onClick={handleReset}
          className="flex items-center justify-center gap-2 w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
          style={{ background: 'var(--surface-strong)', color: 'var(--ink)', border: '1px solid var(--border)' }}
        >
          <RefreshCw className="size-4" /> Try again
        </button>
      ) : scanState === 'idle' ? (
        <button
          onClick={handleStart}
          className="flex items-center justify-center gap-2 w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99]"
          style={{ background: 'var(--blue)', color: '#04090f' }}
        >
          <ScanLine className="size-4" /> Start camera
        </button>
      ) : null}

      {scanState !== 'scanning' && (
        <p className="text-center text-xs mt-5" style={{ color: 'var(--subtle)' }}>
          Quick Pay uses your rear camera only. No images are stored or transmitted.
        </p>
      )}
    </ScreenLayout>
  )
}
