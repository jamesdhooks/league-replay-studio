/**
 * ComposeProviders — Flattens deeply-nested React context providers
 * into a readable, maintainable list.
 *
 * Usage:
 *   <ComposeProviders providers={[
 *     [ToastProvider],
 *     [ModalProvider],
 *     [SettingsProvider],
 *     [ErrorBoundary, { name: 'App' }],
 *   ]}>
 *     <AppShell />
 *   </ComposeProviders>
 *
 * Each entry is [Component] or [Component, props].
 */
export default function ComposeProviders({ providers, children }) {
  return providers.reduceRight(
    (acc, [Provider, props]) => <Provider {...(props || {})}>{acc}</Provider>,
    children,
  )
}
