import { ToastProvider } from '../context/ToastContext'
import { ModalProvider } from '../context/ModalContext'
import AppShell from './layout/AppShell'

/**
 * Root application component.
 * Wraps all providers and renders the layout shell.
 */
function App() {
  return (
    <ToastProvider>
      <ModalProvider>
        <AppShell />
      </ModalProvider>
    </ToastProvider>
  )
}

export default App
