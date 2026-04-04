import { createContext, useContext, useCallback, useState } from 'react'
import Toast from '../components/ui/Toast'

const ToastContext = createContext(null)

/**
 * Toast notification provider.
 * Provides showSuccess, showError, showWarning, showInfo functions.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback((type, message, options = {}) => {
    const id = Date.now() + Math.random()
    const duration = options.duration || 4000

    setToasts(prev => [...prev, { id, type, message, duration }])

    // Auto-remove after duration
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, duration)

    return id
  }, [])

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const showSuccess = useCallback((message, options) => addToast('success', message, options), [addToast])
  const showError = useCallback((message, options) => addToast('error', message, options), [addToast])
  const showWarning = useCallback((message, options) => addToast('warning', message, options), [addToast])
  const showInfo = useCallback((message, options) => addToast('info', message, options), [addToast])

  return (
    <ToastContext.Provider value={{ showSuccess, showError, showWarning, showInfo, removeToast }}>
      {children}
      {/* Toast container — bottom-right */}
      <div className="fixed bottom-12 right-5 z-50 flex flex-col gap-3 pointer-events-none">
        {toasts.map(toast => (
          <Toast
            key={toast.id}
            type={toast.type}
            message={toast.message}
            onClose={() => removeToast(toast.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/**
 * Hook to access toast notification functions.
 *
 * @returns {{ showSuccess, showError, showWarning, showInfo, removeToast }}
 */
export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}
