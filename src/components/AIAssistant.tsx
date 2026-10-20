/**
 * AIAssistant — rule-based help engine for Quick Pay.
 * No AI backend connected. VITE_ASSISTANT_API_URL hook preserved.
 * Uses ScreenLayout.
 */

import { useState, useRef, useEffect } from 'react'
import { Send, Bot, User, Info, RefreshCw, Sparkles } from 'lucide-react'
import { ScreenLayout } from '@/components/ScreenLayout'

interface Props { onBack: () => void }
interface Message { id: string; role: 'user' | 'assistant'; text: string; ts: number }

interface KBEntry { patterns: RegExp[]; answer: string }

const KB: KBEntry[] = [
  {
    patterns: [/how.*send/i, /send.*usdc/i, /make.*payment/i, /transfer/i],
    answer: 'To send USDC: tap **Send** in the navigation, enter the recipient address (starting with 0x), enter the amount, optionally add a note, then tap **Review & send**. Confirm in your wallet. Transactions on Arc Mainnet are irreversible.',
  },
  {
    patterns: [/receive|receive.*usdc|my.*address/i],
    answer: 'Tap **Receive** in the navigation. Your wallet address and QR code are shown. Share your address or let the sender scan the QR. You can optionally encode a requested amount and note. Displaying the QR does not itself receive funds.',
  },
  {
    patterns: [/scan|qr.*pay|scan.*pay/i],
    answer: 'Tap **Scan** in the navigation. Allow camera access when prompted. After a successful scan you\'ll see a review screen. Tap **Review and send** to go to the Send form — nothing is sent automatically.',
  },
  {
    patterns: [/history|transaction.*history|past.*payment/i],
    answer: 'Tap **History** and then **Load transaction history**. Quick Pay scans on-chain USDC Transfer events in chunks. Only transfers within the scanned block range are shown. For full history, use the **Arc Explorer** link at the bottom of the History screen.',
  },
  {
    patterns: [/request.*money|payment.*request|request.*payment|create.*request/i],
    answer: 'Tap **Requests** (from the bottom nav secondary row), then **New**. Enter an amount, optional note, and recipient. Quick Pay generates a QR code and shareable link. Note: requests are labelled **Unpaid** — Quick Pay does not automatically verify onchain payment.',
  },
  {
    patterns: [/recipient|save.*address|address.*book|contact/i],
    answer: 'Tap **Recipients** to manage saved addresses. Add a wallet address and label (e.g. "Alice"). Labels are stored on your device only. From the list you can copy, tap **Send** to pre-fill the payment form, edit, or delete.',
  },
  {
    patterns: [/receipt|proof.*payment/i],
    answer: 'After a USDC transfer is confirmed onchain, Quick Pay shows a **Payment Receipt** with the transaction hash, amount, recipient, and network. Receipts are only shown after real on-chain confirmation.',
  },
  {
    patterns: [/wallet.*connect|connect.*wallet/i],
    answer: 'Tap **Connect** in the top-right. Quick Pay supports any injected EVM wallet (MetaMask, Rabby, etc.). Your private key or seed phrase is never shared with Quick Pay. After connecting, Quick Pay checks you\'re on Arc Mainnet (chain ID 5042).',
  },
  {
    patterns: [/wrong.*network|switch.*network|arc.*mainnet|chain.*id/i],
    answer: 'Quick Pay only works on Arc Mainnet (chain ID 5042). If your wallet is on a different chain, a **Switch to Arc Mainnet** button appears. Manual settings: RPC https://rpc.mainnet.arc.io, chain ID 5042, symbol USDC, explorer https://explorer.arc.io.',
  },
  {
    patterns: [/gas|fee|cost.*send/i],
    answer: 'On Arc Mainnet, gas fees are paid in USDC — no separate ETH or native token required. Fees are very low (typically fractions of a cent). The estimated fee is shown before you confirm each transaction.',
  },
  {
    patterns: [/failed|error.*transaction|transaction.*fail/i],
    answer: 'Common causes: (1) Insufficient USDC balance — check your balance covers amount + gas. (2) Wrong network — switch to Arc Mainnet. (3) You rejected the signature in your wallet. (4) RPC timeout — wait a moment and retry.',
  },
  {
    patterns: [/usdc.*contract|contract.*address|token.*address/i],
    answer: 'The USDC contract on Arc Mainnet is **0x3600000000000000000000000000000000000000** with 6 decimal places. You can verify it on the Arc Explorer.',
  },
  {
    patterns: [/safe|security|private.*key|seed.*phrase/i],
    answer: 'Quick Pay never requests, stores, or transmits your private key or seed phrase. All transaction signing happens in your connected wallet. Payment notes are stored locally on your device only.',
  },
  {
    patterns: [/arc.*explorer|explorer/i],
    answer: 'The Arc Explorer is at **https://explorer.arc.io**. It shows all transactions, token transfers, and block data on Arc Mainnet. Quick Pay links directly to the explorer for every transaction and address.',
  },
  {
    patterns: [/what.*quick.*pay|about.*app|what.*this/i],
    answer: 'Quick Pay is a USDC payment app for Arc Mainnet. Send and receive USDC, scan QR codes, create payment requests, view on-chain history, and save frequently used addresses — all with real USDC on Arc Mainnet.',
  },
]

const FALLBACK = 'I don\'t have a specific answer for that. Try asking about: sending USDC, receiving USDC, QR scanner, transaction history, payment requests, recipients, gas fees, network settings, or transaction errors.'

function getAnswer(q: string): string {
  for (const entry of KB) {
    if (entry.patterns.some(p => p.test(q))) return entry.answer
  }
  return FALLBACK
}

const SUGGESTIONS = [
  'How do I send USDC?',
  'How do I receive USDC?',
  'Why did my transaction fail?',
  'What are the gas fees?',
  'How do I scan a QR code?',
  'How do I save a recipient?',
]

let msgCounter = 0
function nextId() { return `msg-${++msgCounter}` }

const API_URL = import.meta.env.VITE_ASSISTANT_API_URL as string | undefined

export function AIAssistant({ onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([{
    id: nextId(), role: 'assistant', ts: Date.now(),
    text: API_URL
      ? 'Hello! I\'m your Quick Pay assistant. Ask me anything about sending USDC, payments, or how to use Quick Pay.'
      : 'Hello! I\'m the Quick Pay help assistant. Ask me anything about sending USDC, the QR scanner, history, payment requests, gas fees, and more.\n\n*Note: Running a built-in rule-based help engine — not a live AI service.*',
  }])
  const [input,   setInput]   = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return
    const question = text.trim()
    setInput('')

    const userMsg: Message = { id: nextId(), role: 'user', text: question, ts: Date.now() }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)

    let answerText: string
    if (API_URL) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as { answer?: string }
        answerText = typeof data.answer === 'string' ? data.answer : getAnswer(question)
      } catch {
        answerText = 'The assistant backend is currently unavailable. Local answer:\n\n' + getAnswer(question)
      }
    } else {
      await new Promise(r => setTimeout(r, 280))
      answerText = getAnswer(question)
    }

    setMessages(prev => [...prev, { id: nextId(), role: 'assistant', text: answerText, ts: Date.now() }])
    setLoading(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(input) }
  }

  function handleReset() {
    setMessages([{ id: nextId(), role: 'assistant', ts: Date.now(), text: 'Conversation cleared. What would you like to know about Quick Pay?' }])
    setInput('')
  }

  return (
    <ScreenLayout
      title="Help"
      subtitle="Quick Pay assistant"
      onBack={onBack}
      action={
        <button
          onClick={handleReset}
          className="flex items-center gap-1 text-xs font-bold rounded-lg px-2.5 py-1.5 transition-all hover:opacity-70 active:scale-90"
          style={{ color: 'var(--subtle)', background: 'var(--surface-raised)' }}
          aria-label="Clear conversation"
        >
          <RefreshCw className="size-3" /> Clear
        </button>
      }
    >
      {/* Mode label */}
      {!API_URL && (
        <div
          className="flex items-center gap-2 rounded-[12px] px-3 py-2.5 mb-4 text-xs"
          style={{ background: 'rgba(78,155,255,0.06)', border: '1px solid rgba(78,155,255,0.13)' }}
        >
          <Info className="size-3 shrink-0" style={{ color: 'var(--blue)' }} />
          <span style={{ color: 'var(--ink-3)' }}>
            Rule-based help mode — no AI service connected.
          </span>
        </div>
      )}

      {/* Bot avatar header */}
      <div className="flex items-center gap-3 mb-5">
        <div
          className="flex size-10 items-center justify-center rounded-[13px]"
          style={{
            background: 'linear-gradient(135deg, rgba(78,155,255,0.20) 0%, rgba(157,120,251,0.16) 100%)',
            border: '1px solid var(--border-accent)',
          }}
        >
          <Sparkles className="size-5" style={{ color: 'var(--blue)' }} />
        </div>
        <div>
          <p className="font-bold text-sm" style={{ color: 'var(--ink)' }}>Quick Pay Assistant</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Ask anything about the app</p>
        </div>
      </div>

      {/* Messages */}
      <div
        className="space-y-3 mb-4 overflow-y-auto"
        style={{ maxHeight: 'calc(100dvh - 420px)', minHeight: '180px' }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-2.5 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
          >
            {/* Avatar */}
            <div
              className="flex size-7 shrink-0 items-center justify-center rounded-[10px] mt-0.5"
              style={{
                background: msg.role === 'user'
                  ? 'rgba(160,190,230,0.12)'
                  : 'var(--blue-dim)',
              }}
            >
              {msg.role === 'user'
                ? <User className="size-3.5" style={{ color: 'var(--ink-3)' }} />
                : <Bot  className="size-3.5" style={{ color: 'var(--blue)' }} />}
            </div>

            {/* Bubble */}
            <div
              className="max-w-[85%] rounded-[16px] px-4 py-3 text-sm leading-relaxed"
              style={
                msg.role === 'user'
                  ? {
                    background: 'rgba(78,155,255,0.13)',
                    border: '1px solid rgba(78,155,255,0.22)',
                    color: 'var(--ink)',
                  }
                  : {
                    background: 'var(--surface-strong)',
                    border: '1px solid var(--border)',
                    color: 'var(--ink-2)',
                  }
              }
            >
              <FormattedText text={msg.text} />
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-2.5">
            <div
              className="flex size-7 shrink-0 items-center justify-center rounded-[10px]"
              style={{ background: 'var(--blue-dim)' }}
            >
              <Bot className="size-3.5" style={{ color: 'var(--blue)' }} />
            </div>
            <div
              className="rounded-[16px] px-4 py-3.5 flex items-center gap-1.5"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-1.5 rounded-full animate-pulse"
                  style={{ background: 'var(--blue)', animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Suggestion chips */}
      {messages.length <= 1 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => { void sendMessage(s) }}
              className="text-xs rounded-full px-3 py-1.5 transition-all hover:brightness-110 active:scale-95"
              style={{
                background: 'var(--surface-raised)',
                border: '1px solid var(--border)',
                color: 'var(--ink-3)',
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div
        className="flex items-end gap-2 rounded-[18px] px-4 py-3"
        style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about sending, receiving, errors…"
          rows={1}
          className="flex-1 bg-transparent text-sm resize-none outline-none placeholder:opacity-30"
          style={{ color: 'var(--ink)', maxHeight: '80px' }}
        />
        <button
          onClick={() => { void sendMessage(input) }}
          disabled={!input.trim() || loading}
          className="flex size-8 shrink-0 items-center justify-center rounded-[12px] transition-all disabled:opacity-30 hover:brightness-110 active:scale-90"
          style={{ background: 'var(--blue)' }}
          aria-label="Send"
        >
          <Send className="size-3.5" style={{ color: '#04090f' }} />
        </button>
      </div>
    </ScreenLayout>
  )
}

function FormattedText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\n)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part === '\n') return <br key={i} />
        if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
        return <span key={i}>{part}</span>
      })}
    </>
  )
}
