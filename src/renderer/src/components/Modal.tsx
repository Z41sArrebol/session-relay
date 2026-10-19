import React, { useEffect } from 'react'
import { IconX } from './Icons'

interface ModalProps {
  title: string
  subtitle?: string
  width?: number
  onClose: () => void
  children: React.ReactNode
  footer?: React.ReactNode
  dismissable?: boolean
  className?: string
}

export function Modal({ title, subtitle, width = 720, onClose, children, footer, dismissable = true, className }: ModalProps): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissable) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismissable, onClose])

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && dismissable && onClose()}>
      <div className={`modal ${className || ''}`} style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button className="icon-btn" onClick={onClose} disabled={!dismissable} aria-label="关闭">
            <IconX />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function Toast({ text, kind, onClose }: { text: string; kind: 'info' | 'error' | 'success'; onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const timer = setTimeout(onClose, kind === 'error' ? 7000 : 4000)
    return () => clearTimeout(timer)
  }, [kind, onClose])
  return (
    <div className={`toast toast-${kind}`} role="status">
      <span>{text}</span>
      <button className="toast-close" onClick={onClose} aria-label="关闭提示">
        ×
      </button>
    </div>
  )
}
