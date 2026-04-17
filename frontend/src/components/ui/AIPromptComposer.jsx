import { Loader2, Send } from 'lucide-react'

/**
 * AIPromptComposer — shared AI prompt input + submit button.
 *
 * Keeps AI entry UX consistent across designer/editor surfaces.
 */
export default function AIPromptComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  loading = false,
  placeholder = 'Describe what you want to generate...',
  submitLabel = 'Generate',
  loadingLabel = 'Generating...',
  multiline = false,
  rows = 3,
  shortcut = 'enter', // 'enter' | 'mod+enter'
  className = '',
}) {
  const handleKeyDown = (e) => {
    if (shortcut === 'mod+enter') {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        onSubmit?.()
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit?.()
    }
  }

  const canSubmit = !disabled && !loading && String(value || '').trim().length > 0
  const InputTag = multiline ? 'textarea' : 'input'

  return (
    <div className={`flex gap-2 ${className}`}>
      <InputTag
        type={multiline ? undefined : 'text'}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || loading}
        rows={multiline ? rows : undefined}
        className={`flex-1 px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
          text-text-primary placeholder:text-text-disabled
          focus:outline-none focus:ring-2 focus:ring-purple-500/40 focus:border-purple-500
          transition-colors disabled:opacity-50 ${multiline ? 'resize-none' : ''}`}
      />
      <button
        onClick={onSubmit}
        disabled={!canSubmit}
        className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-purple-600 hover:bg-purple-500
          text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        {loading ? loadingLabel : submitLabel}
      </button>
    </div>
  )
}
