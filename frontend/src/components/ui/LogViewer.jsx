import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Trash2 } from 'lucide-react'
import UnifiedLogList from './UnifiedLogList'

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function defaultStructuredPayload({
  schema,
  title,
  rawEntries,
  entries,
  visibleEntries,
  clearedCount,
}) {
  return {
    schema,
    schema_version: 1,
    title,
    copied_at: new Date().toISOString(),
    entry_count: entries.length,
    visible_entry_count: visibleEntries.length,
    cleared_visible_count: clearedCount,
    raw_entries: rawEntries,
    entries,
    visible_entries: visibleEntries,
  }
}

export default function LogViewer({
  title = 'Log',
  entries = [],
  rawEntries = null,
  schema = 'league-replay-studio.log',
  emptyMessage = 'No log entries yet',
  loadingMessage = null,
  isLoading = false,
  showStep = true,
  compact = false,
  reverse = true,
  maxVisible = null,
  maxHeightClass = 'max-h-48',
  className = '',
  bodyClassName = '',
  headerClassName = '',
  rowClassName = '',
  collapsible = false,
  defaultExpanded = true,
  copyable = true,
  clearable = true,
  subtitle = '',
  buildPayload = null,
  bodyRef = null,
  listRef = null,
  footerRef = null,
  children = null,
}) {
  const normalizedEntries = Array.isArray(entries) ? entries : []
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [copied, setCopied] = useState(false)
  const [clearedCount, setClearedCount] = useState(0)

  useEffect(() => {
    if (normalizedEntries.length < clearedCount) {
      setClearedCount(0)
    }
  }, [clearedCount, normalizedEntries.length])

  const visibleEntries = useMemo(() => {
    const next = normalizedEntries.slice(clearedCount)
    return maxVisible ? next.slice(-maxVisible) : next
  }, [clearedCount, maxVisible, normalizedEntries])

  const raw = rawEntries ?? normalizedEntries

  const handleCopy = useCallback(async () => {
    const payload = buildPayload
      ? buildPayload({
        schema,
        title,
        rawEntries: raw,
        entries: normalizedEntries,
        visibleEntries,
        clearedCount,
      })
      : defaultStructuredPayload({
        schema,
        title,
        rawEntries: raw,
        entries: normalizedEntries,
        visibleEntries,
        clearedCount,
      })
    await copyTextToClipboard(JSON.stringify(payload, null, 2))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }, [buildPayload, clearedCount, normalizedEntries, raw, schema, title, visibleEntries])

  const handleClearVisible = useCallback(() => {
    setClearedCount(normalizedEntries.length)
  }, [normalizedEntries.length])

  const bodyVisible = !collapsible || expanded

  return (
    <div className={`h-full min-h-0 flex flex-col ${className}`}>
      <div className={`flex items-center gap-1.5 px-3 py-2 border-b border-border bg-bg-secondary text-text-secondary ${headerClassName}`}>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="min-w-0 flex-1 flex items-center gap-1.5 text-left text-xxs font-semibold uppercase tracking-wider hover:text-text-primary transition-colors"
            aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
          >
            {expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
            <span className="truncate">{title} ({normalizedEntries.length})</span>
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <p className="text-xxs font-semibold uppercase tracking-wider text-text-secondary truncate">
              {title} ({normalizedEntries.length})
            </p>
            {subtitle ? (
              <p className="text-[10px] text-text-disabled truncate mt-0.5">{subtitle}</p>
            ) : null}
          </div>
        )}

        {children}

        {clearable && normalizedEntries.length > 0 && (
          <button
            type="button"
            onClick={handleClearVisible}
            className="h-6 px-2 shrink-0 inline-flex items-center gap-1 rounded-md border border-border text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors text-xxs"
            title="Clear visible log entries"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
        )}

        {copyable && normalizedEntries.length > 0 && (
          <button
            type="button"
            onClick={handleCopy}
            className={`h-6 w-6 shrink-0 inline-flex items-center justify-center rounded-md border transition-colors ${
              copied
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-border text-text-tertiary hover:text-text-primary hover:bg-bg-hover'
            }`}
            title={copied ? 'Copied' : 'Copy structured JSON log'}
            aria-label="Copy structured JSON log"
          >
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          </button>
        )}
      </div>

      {bodyVisible && (
        <div ref={bodyRef} className={`flex-1 min-h-0 overflow-hidden ${bodyClassName}`}>
          <UnifiedLogList
            entries={visibleEntries}
            emptyMessage={clearedCount > 0 ? 'Visible log entries cleared. New entries will appear here.' : emptyMessage}
            loadingMessage={loadingMessage}
            isLoading={isLoading}
            reverse={reverse}
            maxHeightClass={maxHeightClass}
            className="h-full"
            rowClassName={rowClassName}
            listRef={listRef}
            footerRef={footerRef}
            showStep={showStep}
            compact={compact}
          />
        </div>
      )}
    </div>
  )
}
