import { useEffect, useRef } from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'

/**
 * Modal dialog component — larger, friendlier, with better visual hierarchy.
 *
 * @param {Object} props
 * @param {string} props.title
 * @param {string} props.message
 * @param {'confirm' | 'info'} [props.variant='info']
 * @param {boolean} [props.danger=false]
 * @param {string} [props.confirmText='Confirm']
 * @param {string} [props.cancelText='Cancel']
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 */
function Modal({
  title,
  message,
  variant = 'info',
  danger = false,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}) {
  const overlayRef = useRef(null)
  const confirmRef = useRef(null)

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel])

  // Focus confirm button on mount
  useEffect(() => {
    confirmRef.current?.focus()
  }, [])

  // Close on backdrop click
  const handleBackdropClick = (e) => {
    if (e.target === overlayRef.current) onCancel()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm
                 animate-fade-in"
    >
      <div className="bg-bg-tertiary border border-border rounded-2xl shadow-float w-full max-w-lg
                      mx-4 animate-scale-in">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div className="flex items-center gap-3">
            {danger ? (
              <div className="w-10 h-10 rounded-xl bg-danger-muted flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-danger" />
              </div>
            ) : (
              <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
                <Info className="w-5 h-5 text-accent" />
              </div>
            )}
            <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-2 rounded-xl hover:bg-surface-hover transition-all duration-150 cursor-pointer"
          >
            <X className="w-5 h-5 text-text-tertiary" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          <p className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed">{message}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
          {variant === 'confirm' && (
            <button
              onClick={onCancel}
              className="px-5 py-2.5 text-sm font-medium text-text-secondary
                         hover:text-text-primary hover:bg-surface-hover rounded-xl
                         transition-all duration-150 cursor-pointer"
            >
              {cancelText}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`px-5 py-2.5 text-sm font-semibold rounded-xl transition-all duration-150
                        cursor-pointer active:scale-[0.97] ${
              danger
                ? 'bg-danger hover:bg-danger/80 text-white'
                : 'bg-accent hover:bg-accent-hover text-white shadow-glow-sm'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

export default Modal
