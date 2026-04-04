import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/**
 * Content modal — renders arbitrary React content in a modal overlay.
 *
 * @param {Object} props
 * @param {string} props.title
 * @param {boolean} [props.wide=false] - Use wider max-width (max-w-4xl vs max-w-lg)
 * @param {() => void} props.onClose
 * @param {React.ReactNode} props.children
 */
function ContentModal({ title, wide = false, onClose, children }) {
  const overlayRef = useRef(null)

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleBackdropClick = (e) => {
    if (e.target === overlayRef.current) onClose()
  }

  return (
    <div
      ref={overlayRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-sm
                 animate-fade-in"
    >
      <div className={`bg-bg-tertiary border border-border rounded-2xl shadow-float w-full
                       mx-4 animate-scale-in flex flex-col max-h-[85vh] ${
                         wide ? 'max-w-4xl' : 'max-w-lg'
                       }`}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h3 className="text-lg font-semibold text-text-primary truncate pr-4">{title}</h3>
          <button
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-surface-hover transition-all duration-150 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5 text-text-tertiary" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </div>
    </div>
  )
}

export default ContentModal
