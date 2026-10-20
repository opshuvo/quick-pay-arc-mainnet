/**
 * SavedRecipients — locally stored labelled wallet addresses.
 * All logic preserved. Uses ScreenLayout.
 */

import { useState } from 'react'
import { Plus, Pencil, Trash2, Copy, Check, Users, Send } from 'lucide-react'
import {
  getRecipients, saveRecipient, deleteRecipient,
  isValidAddress, formatAddress, formatTimestamp,
  copyToClipboard, nanoid, type SavedRecipient,
} from '@/utils'
import { toast } from 'sonner'
import { ScreenLayout } from '@/components/ScreenLayout'

interface Props {
  onBack: () => void
  onSendTo?: (address: string) => void
}

type View = 'list' | 'add' | 'edit'

export function SavedRecipients({ onBack, onSendTo }: Props) {
  const [view,       setView]      = useState<View>('list')
  const [recipients, setRecipients] = useState<SavedRecipient[]>(getRecipients)
  const [editing,    setEditing]   = useState<SavedRecipient | null>(null)
  const [formAddress, setFormAddress] = useState('')
  const [formLabel,   setFormLabel]   = useState('')
  const [copied,      setCopied]      = useState<string | null>(null)

  function reload() { setRecipients(getRecipients()) }

  function openAdd() { setFormAddress(''); setFormLabel(''); setEditing(null); setView('add') }
  function openEdit(r: SavedRecipient) {
    setFormAddress(r.address); setFormLabel(r.label); setEditing(r); setView('edit')
  }

  function handleSave() {
    const addr  = formAddress.trim()
    const label = formLabel.trim()
    if (!isValidAddress(addr) || !label) return
    const r: SavedRecipient = {
      id: editing?.id ?? nanoid(), address: addr, label,
      addedAt: editing?.addedAt ?? Date.now(),
    }
    saveRecipient(r); reload()
    toast.success(editing ? 'Recipient updated' : 'Recipient saved')
    setView('list')
  }

  function handleDelete(id: string) {
    deleteRecipient(id); reload()
    toast.success('Recipient removed')
    if (view !== 'list') setView('list')
  }

  function handleCopy(addr: string) {
    void copyToClipboard(addr).then(() => {
      setCopied(addr)
      setTimeout(() => setCopied(null), 2200)
    })
  }

  const addrValid  = isValidAddress(formAddress.trim())
  const labelValid = formLabel.trim().length > 0

  /* ── Add / Edit ─────────────────────────────────────────────────────── */
  if (view === 'add' || view === 'edit') {
    return (
      <ScreenLayout
        title={view === 'add' ? 'Add Recipient' : 'Edit Recipient'}
        onBack={() => setView('list')}
      >
        <div className="space-y-4 mb-6">
          <div>
            <label
              className="block text-xs font-bold mb-2 uppercase tracking-wider"
              style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}
            >
              Wallet address
            </label>
            <input
              value={formAddress}
              onChange={(e) => setFormAddress(e.target.value.trim())}
              placeholder="0x..."
              disabled={view === 'edit'}
              className="w-full rounded-[14px] px-4 py-3.5 text-sm mono outline-none disabled:opacity-60"
              style={{
                background: 'var(--surface-strong)',
                border: `1px solid ${formAddress && !addrValid ? 'var(--danger)' : 'var(--border)'}`,
                color: 'var(--ink)',
              }}
              spellCheck={false}
              autoComplete="off"
            />
            {formAddress && !addrValid && (
              <p className="mt-1.5 text-xs" style={{ color: 'var(--danger)' }}>Invalid Ethereum address</p>
            )}
          </div>

          <div>
            <label
              className="block text-xs font-bold mb-2 uppercase tracking-wider"
              style={{ color: 'var(--subtle)', letterSpacing: '0.08em' }}
            >
              Label
            </label>
            <input
              value={formLabel}
              onChange={(e) => setFormLabel(e.target.value.slice(0, 40))}
              placeholder="e.g. Alice, Work wallet, Exchange"
              className="w-full rounded-[14px] px-4 py-3.5 text-sm outline-none"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', color: 'var(--ink)' }}
            />
            <p className="mt-1.5 text-xs" style={{ color: 'var(--subtle)' }}>
              Labels are stored on this device only.
            </p>
          </div>
        </div>

        <div className="space-y-2.5">
          <button
            onClick={handleSave}
            disabled={!addrValid || !labelValid}
            className="w-full rounded-[16px] py-4 text-sm font-bold transition-all hover:brightness-105 active:scale-[0.99] disabled:opacity-35 disabled:cursor-not-allowed"
            style={{ background: 'var(--blue)', color: '#04090f' }}
          >
            {view === 'add' ? 'Save recipient' : 'Save changes'}
          </button>

          {view === 'edit' && editing && (
            <button
              onClick={() => handleDelete(editing.id)}
              className="w-full flex items-center justify-center gap-2 rounded-[16px] py-3.5 text-sm font-bold transition-all hover:opacity-70 active:scale-[0.99]"
              style={{ color: 'var(--danger)', border: '1px solid rgba(255,91,91,0.20)' }}
            >
              <Trash2 className="size-4" /> Remove recipient
            </button>
          )}
        </div>
      </ScreenLayout>
    )
  }

  /* ── List ────────────────────────────────────────────────────────────── */
  return (
    <ScreenLayout
      title="Recipients"
      onBack={onBack}
      action={
        <button
          onClick={openAdd}
          className="flex items-center gap-1.5 rounded-[12px] px-3 py-2 text-sm font-bold transition-all hover:brightness-105 active:scale-95"
          style={{ background: 'var(--blue)', color: '#04090f' }}
        >
          <Plus className="size-3.5" /> Add
        </button>
      }
    >
      {recipients.length === 0 ? (
        <div className="flex flex-col items-center py-16 text-center gap-4">
          <div
            className="flex size-16 items-center justify-center rounded-[20px]"
            style={{
              background: 'var(--surface-strong)',
              border: '1px solid var(--border)',
            }}
          >
            <Users className="size-8" style={{ color: 'var(--subtle)' }} />
          </div>
          <div>
            <p className="text-sm font-bold mb-1" style={{ color: 'var(--ink-2)' }}>No saved recipients</p>
            <p className="text-xs max-w-[220px]" style={{ color: 'var(--muted)' }}>
              Save wallet addresses with labels to find them quickly.
            </p>
          </div>
          <button
            onClick={openAdd}
            className="flex items-center gap-2 rounded-[14px] px-5 py-3 text-sm font-bold transition-all hover:brightness-105 active:scale-95"
            style={{ background: 'var(--blue)', color: '#04090f' }}
          >
            <Plus className="size-4" /> Add first recipient
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {recipients.map((r) => (
            <div
              key={r.id}
              className="rounded-[18px] px-4 py-3.5"
              style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
            >
              {/* Label row + actions */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  {/* Avatar initial */}
                  <div
                    className="flex size-9 shrink-0 items-center justify-center rounded-[11px] font-bold text-sm"
                    style={{
                      background: 'var(--blue-dim)',
                      color: 'var(--blue)',
                      border: '1px solid var(--border-accent)',
                    }}
                  >
                    {r.label.charAt(0).toUpperCase()}
                  </div>
                  <span className="font-bold truncate" style={{ color: 'var(--ink)', fontSize: '0.95rem' }}>
                    {r.label}
                  </span>
                </div>

                <div className="flex items-center gap-0.5 shrink-0">
                  <IconBtn onClick={() => handleCopy(r.address)} label="Copy address">
                    {copied === r.address
                      ? <Check  className="size-3.5" style={{ color: 'var(--success)' }} />
                      : <Copy   className="size-3.5" style={{ color: 'var(--muted)' }} />}
                  </IconBtn>
                  <IconBtn onClick={() => openEdit(r)} label="Edit">
                    <Pencil className="size-3.5" style={{ color: 'var(--muted)' }} />
                  </IconBtn>
                  <IconBtn onClick={() => handleDelete(r.id)} label="Delete">
                    <Trash2 className="size-3.5" style={{ color: 'var(--danger)' }} />
                  </IconBtn>
                </div>
              </div>

              {/* Address */}
              <p className="mono text-xs mb-2.5" style={{ color: 'var(--muted)' }}>
                {formatAddress(r.address)}
              </p>

              {/* Footer */}
              <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                  Added {formatTimestamp(r.addedAt)}
                </p>
                {onSendTo && (
                  <button
                    onClick={() => onSendTo(r.address)}
                    className="flex items-center gap-1.5 text-xs font-bold rounded-[10px] px-3 py-1.5 transition-all hover:brightness-110 active:scale-95"
                    style={{ background: 'var(--blue-dim)', color: 'var(--blue)', border: '1px solid var(--border-accent)' }}
                  >
                    <Send className="size-3" /> Send
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </ScreenLayout>
  )
}

function IconBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex size-8 items-center justify-center rounded-[10px] transition-all hover:bg-white/8 active:scale-90"
      aria-label={label}
    >
      {children}
    </button>
  )
}
