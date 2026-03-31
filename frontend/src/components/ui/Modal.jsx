import { useEffect, useRef } from 'react'
import { AlertTriangle, Info, X } from 'lucide-react'

/**
 * Modal dialog component.
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm
                 animate-fade-in"
    >
      <div className="bg-bg-tertiary border border-border rounded-xl shadow-2xl w-full max-w-md
                      mx-4 animate-slide-up">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            {danger ? (
              <AlertTriangle className="w-5 h-5 text-danger" />
            ) : (
              <Info className="w-5 h-5 text-accent" />
            )}
            <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded-md hover:bg-surface-hover transition-colors"
          >
            <X className="w-4 h-4 text-text-tertiary" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-sm text-text-secondary whitespace-pre-wrap">{message}</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          {variant === 'confirm' && (
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-text-secondary
                         hover:text-text-primary hover:bg-surface-hover rounded-lg
                         transition-colors"
            >
              {cancelText}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              danger
                ? 'bg-danger hover:bg-danger/80 text-white'
                : 'bg-accent hover:bg-accent-hover text-white'
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
