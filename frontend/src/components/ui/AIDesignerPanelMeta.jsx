import { Sparkles } from 'lucide-react'

/**
 * AIDesignerPanelMeta — shared header + helper copy for AI Designer panels.
 */
export default function AIDesignerPanelMeta({
  subtitle = 'describe what to change',
  helper,
  showHeader = true,
  className = '',
}) {
  return (
    <>
      {showHeader ? (
        <div className={`flex items-center gap-2 text-xs text-text-tertiary ${className}`}>
          <Sparkles className="w-4 h-4 text-purple-400" />
          <span className="font-medium text-text-primary">AI Designer</span>
          <span className="text-text-disabled">- {subtitle}</span>
        </div>
      ) : null}
      {helper ? (
        <p className="text-[10px] text-text-disabled mt-1.5">{helper}</p>
      ) : null}
    </>
  )
}
