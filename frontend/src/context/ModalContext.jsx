import { createContext, useContext, useCallback, useState } from 'react'
import Modal from '../components/ui/Modal'

const ModalContext = createContext(null)

/**
 * Modal dialog provider.
 * Provides openModal and closeModal functions.
 */
export function ModalProvider({ children }) {
  const [modal, setModal] = useState(null)

  const openModal = useCallback((id, type, options = {}) => {
    setModal({ id, type, ...options })
  }, [])

  const closeModal = useCallback(() => {
    setModal(null)
  }, [])

  return (
    <ModalContext.Provider value={{ openModal, closeModal, modal }}>
      {children}
      {modal && (
        <Modal
          title={modal.title}
          message={modal.message}
          variant={modal.variant || 'info'}
          danger={modal.danger || false}
          confirmText={modal.confirmText || 'Confirm'}
          cancelText={modal.cancelText || 'Cancel'}
          onConfirm={async () => {
            if (modal.onConfirm) await modal.onConfirm()
            closeModal()
          }}
          onCancel={() => {
            if (modal.onCancel) modal.onCancel()
            closeModal()
          }}
        />
      )}
    </ModalContext.Provider>
  )
}

/**
 * Hook to access modal dialog functions.
 *
 * @returns {{ openModal, closeModal, modal }}
 */
export function useModal() {
  const context = useContext(ModalContext)
  if (!context) {
    throw new Error('useModal must be used within a ModalProvider')
  }
  return context
}
