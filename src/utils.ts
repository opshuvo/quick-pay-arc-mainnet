/**
 * Shared utilities for Quick Pay
 */

import { getUsdc, buildTxExplorerUrl, requireChain } from '@/onchain-facts'
import { ARC_MAINNET_CHAIN_ID } from '@/config'

// ─── Address helpers ───────────────────────────────────────────────────────────

export function formatAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

/** Return a checksum-ish display address (just lower for display) */
export function normalizeAddress(addr: string): `0x${string}` {
  return addr.toLowerCase() as `0x${string}`
}

// ─── Arc Mainnet facts (read from registry) ───────────────────────────────────

export const ARC_CHAIN = requireChain(ARC_MAINNET_CHAIN_ID)
export const ARC_USDC = getUsdc(ARC_MAINNET_CHAIN_ID)!

// Safety assertion — we should always have USDC on Arc
if (!ARC_USDC) {
  throw new Error('USDC not found for Arc Mainnet in onchain-facts registry')
}

export const USDC_ADDRESS = ARC_USDC.address as `0x${string}`
export const USDC_DECIMALS = ARC_USDC.decimals // 6
export const EXPLORER_BASE = ARC_CHAIN.explorerBase

export function getTxExplorerUrl(txHash: string): string {
  return buildTxExplorerUrl(ARC_MAINNET_CHAIN_ID, txHash)
}

export function getAddressExplorerUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`
}

// ─── Amount helpers (string-based, no float) ──────────────────────────────────

/** Parse a user-entered USDC string to bigint (6 decimals). Returns null on invalid input. */
export function parseUsdcInput(value: string): bigint | null {
  if (!value || value.trim() === '') return null
  const trimmed = value.trim()
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '.') return null

  const [whole = '0', frac = ''] = trimmed.split('.')
  if (frac.length > USDC_DECIMALS) return null

  const paddedFrac = frac.padEnd(USDC_DECIMALS, '0')
  try {
    return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(paddedFrac)
  } catch {
    return null
  }
}

/** Format a raw bigint USDC amount (6 decimals) to a display string. */
export function formatUsdcAmount(raw: bigint, maxDecimals = 6): string {
  const factor = 10n ** BigInt(USDC_DECIMALS)
  const whole = raw / factor
  const frac = raw % factor
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0')
  const trimmed = fracStr.slice(0, maxDecimals).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : `${whole}`
}

/** Format for dollar-style display: always 2 decimal places */
export function formatUsdcDisplay(raw: bigint): string {
  const factor = 10n ** BigInt(USDC_DECIMALS)
  const whole = raw / factor
  const frac = raw % factor
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').slice(0, 2)
  return `${whole.toLocaleString('en-US')}.${fracStr}`
}

// ─── Error parsing ─────────────────────────────────────────────────────────────

export function parseOnchainError(error: unknown): string {
  const err = error as { message?: string; code?: number; shortMessage?: string }
  const message = (err?.shortMessage ?? err?.message ?? '').toLowerCase()
  const code = err?.code

  if (code === 4001 || message.includes('user rejected') || message.includes('user denied')) {
    return 'Transaction cancelled.'
  }
  if (message.includes('insufficient funds') || message.includes('exceeds balance')) {
    return 'Insufficient USDC balance. Please check your balance and try again.'
  }
  if (message.includes('reverted')) {
    const reasonMatch = message.match(/reason="([^"]+)"/)
    return reasonMatch
      ? `Transaction failed: ${reasonMatch[1]}`
      : 'Transaction failed. The contract rejected the request.'
  }
  if (message.includes('network') || message.includes('timeout') || message.includes('fetch')) {
    return 'Network error. Please check your connection and try again.'
  }
  if (message.includes('nonce')) {
    return 'Transaction nonce conflict. Please wait a moment and retry.'
  }
  if (message.includes('gas')) {
    return 'Gas estimation failed. Please ensure you have enough USDC for fees.'
  }
  return 'Something went wrong. Please try again.'
}

// ─── Payment request URI ───────────────────────────────────────────────────────

export interface PaymentRequestData {
  to: string
  amount?: string
  note?: string
  chainId?: number
  token?: string
}

export function encodePaymentURI(data: PaymentRequestData): string {
  const params = new URLSearchParams()
  params.set('chain', String(data.chainId ?? ARC_MAINNET_CHAIN_ID))
  params.set('token', data.token ?? USDC_ADDRESS)
  if (data.amount) params.set('amount', data.amount)
  if (data.note) params.set('note', encodeURIComponent(data.note))
  return `quickpay:${data.to}?${params.toString()}`
}

export function decodePaymentURI(uri: string): PaymentRequestData | null {
  try {
    // Support both "quickpay:0x..." and plain "0x..." (address only)
    if (/^0x[0-9a-fA-F]{40}$/.test(uri.trim())) {
      return { to: uri.trim() }
    }
    const match = uri.match(/^quickpay:(0x[0-9a-fA-F]{40})(?:\?(.*))?$/)
    if (!match) return null
    const [, to, queryStr] = match
    const params = new URLSearchParams(queryStr ?? '')
    return {
      to,
      amount: params.get('amount') ?? undefined,
      note: params.get('note') ? decodeURIComponent(params.get('note')!) : undefined,
      chainId: params.has('chain') ? Number(params.get('chain')) : undefined,
      token: params.get('token') ?? undefined,
    }
  } catch {
    return null
  }
}

// ─── Local storage helpers (payment notes, local requests) ────────────────────

const NOTES_KEY = 'quickpay:notes'
const REQUESTS_KEY = 'quickpay:requests'

export interface LocalNote {
  txHash: string
  note: string
  timestamp: number
}

export interface LocalPaymentRequest {
  id: string
  to: string
  amount: string
  note?: string
  createdAt: number
  /** Never set this from UI submission — only from confirmed onchain receipt */
  paidTxHash?: string
}

export function saveNote(note: LocalNote): void {
  try {
    const notes = getNotes()
    notes[note.txHash] = note
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes))
  } catch {
    /* storage unavailable */
  }
}

export function getNotes(): Record<string, LocalNote> {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}') as Record<string, LocalNote>
  } catch {
    return {}
  }
}

export function getNote(txHash: string): string | undefined {
  return getNotes()[txHash]?.note
}

export function savePaymentRequest(req: LocalPaymentRequest): void {
  try {
    const all = getPaymentRequests()
    all.unshift(req)
    localStorage.setItem(REQUESTS_KEY, JSON.stringify(all.slice(0, 50)))
  } catch {
    /* storage unavailable */
  }
}

export function getPaymentRequests(): LocalPaymentRequest[] {
  try {
    return JSON.parse(localStorage.getItem(REQUESTS_KEY) ?? '[]') as LocalPaymentRequest[]
  } catch {
    return []
  }
}

export function deletePaymentRequest(id: string): void {
  try {
    const all = getPaymentRequests().filter((r) => r.id !== id)
    localStorage.setItem(REQUESTS_KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}

// ─── Saved recipients ─────────────────────────────────────────────────────────

const RECIPIENTS_KEY = 'quickpay:recipients'

export interface SavedRecipient {
  id: string
  address: string
  label: string
  addedAt: number
}

export function getRecipients(): SavedRecipient[] {
  try {
    return JSON.parse(localStorage.getItem(RECIPIENTS_KEY) ?? '[]') as SavedRecipient[]
  } catch {
    return []
  }
}

export function saveRecipient(r: SavedRecipient): void {
  try {
    const all = getRecipients().filter((x) => x.id !== r.id)
    all.unshift(r)
    localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(all.slice(0, 100)))
  } catch { /* storage unavailable */ }
}

export function deleteRecipient(id: string): void {
  try {
    localStorage.setItem(RECIPIENTS_KEY, JSON.stringify(getRecipients().filter((r) => r.id !== id)))
  } catch { /* storage unavailable */ }
}

// ─── Local receipts (confirmed transactions stored after onchain success) ──────

const RECEIPTS_KEY = 'quickpay:receipts'

export interface LocalReceipt {
  txHash: string
  from: string
  to: string
  amount: string        // human-readable e.g. "12.50"
  network: 'Arc Mainnet'
  chainId: number
  confirmedAt: number   // Date.now() when receipt was saved
  note?: string
  /** Block number of the confirmed tx — stored so History can jump directly to that page. */
  blockNumber?: number
}

export function saveReceipt(r: LocalReceipt): void {
  try {
    const all = getReceipts().filter((x) => x.txHash !== r.txHash)
    all.unshift(r)
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify(all.slice(0, 200)))
  } catch { /* storage unavailable */ }
}

export function getReceipts(): LocalReceipt[] {
  try {
    return JSON.parse(localStorage.getItem(RECEIPTS_KEY) ?? '[]') as LocalReceipt[]
  } catch {
    return []
  }
}

// ─── Misc ──────────────────────────────────────────────────────────────────────

export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text)
  }
  // Fallback
  const el = document.createElement('textarea')
  el.value = text
  el.style.position = 'fixed'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
  return Promise.resolve()
}

export function formatTimestamp(ts: number): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts))
}

export function nanoid(len = 12): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  const arr = new Uint8Array(len)
  crypto.getRandomValues(arr)
  for (const byte of arr) result += chars[byte % chars.length]
  return result
}
