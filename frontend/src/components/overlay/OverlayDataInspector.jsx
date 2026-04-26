import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Database, PlayCircle, Loader2, CheckCircle2, XCircle, Eye, Braces,
} from 'lucide-react'
import { apiGet, apiPost } from '../../services/api'
import { useIRacing } from '../../context/IRacingContext'
import { useProject } from '../../context/ProjectContext'

const TYPE_LABELS = {
  driver_details: 'Driver Details',
  race_details: 'Race Details',
  championship_standings: 'Championship Standings',
}

function prettyJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return '{}'
  }
}

function buildDefaultRequest(pluginType, subsessionId, drivers) {
  if (pluginType === 'driver_details') {
    const custIds = Array.isArray(drivers)
      ? drivers.map(d => Number(d?.iracing_cust_id || 0)).filter(Boolean).slice(0, 6)
      : []
    return { customer_ids: custIds }
  }
  if (pluginType === 'race_details' || pluginType === 'championship_standings') {
    return { subsession_id: Number(subsessionId || 0) }
  }
  return {}
}

function buildCallPreview(plugin, requestBody) {
  if (!plugin?.endpoint_url) return null
  const style = plugin.request_style || 'post_body'
  const base = plugin.endpoint_url.replace(/\/$/, '')
  if (style === 'path_param') {
    const keys = Object.keys(requestBody || {})
    if (keys.length === 1) {
      const value = requestBody[keys[0]]
      if (!Array.isArray(value)) {
        return { method: 'GET', url: `${base}/${value}`, body: null }
      }
    }
  }
  return { method: 'POST', url: base, body: requestBody }
}

export default function OverlayDataInspector() {
  const { subsessionId, sessionData } = useIRacing()
  const { activeProject } = useProject()
  // Use live subsession_id when connected, fall back to the project's stored value
  const effectiveSubsessionId = subsessionId || activeProject?.subsession_id || 0
  const [plugins, setPlugins] = useState([])
  const [formats, setFormats] = useState({})
  const [loading, setLoading] = useState(true)
  const [selectedPluginId, setSelectedPluginId] = useState(null)
  const [requestDraft, setRequestDraft] = useState('{}')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [activeView, setActiveView] = useState('normalized')
  const [requestError, setRequestError] = useState('')

  const fetchPlugins = useCallback(async () => {
    setLoading(true)
    try {
      const [res, fmtRes] = await Promise.all([
        apiGet('/data-plugins/').catch(() => ({ plugins: [] })),
        apiGet('/data-plugins/formats').catch(() => ({ formats: {} })),
      ])
      const nextPlugins = res?.plugins || []
      setPlugins(nextPlugins)
      setFormats(fmtRes?.formats || {})
      if (!selectedPluginId && nextPlugins.length > 0) {
        setSelectedPluginId(nextPlugins[0].id)
      }
    } finally {
      setLoading(false)
    }
  }, [selectedPluginId])

  useEffect(() => {
    fetchPlugins()
  }, [fetchPlugins])

  const selectedPlugin = useMemo(
    () => plugins.find(p => p.id === selectedPluginId) || null,
    [plugins, selectedPluginId],
  )

  const selectedFormat = useMemo(
    () => (selectedPlugin ? (formats?.[selectedPlugin.plugin_type] || {}) : {}),
    [formats, selectedPlugin],
  )

  const renderSchemaFields = useCallback((fields) => {
    if (!Array.isArray(fields) || fields.length === 0) {
      return <div className="text-[10px] text-text-disabled">No schema metadata available.</div>
    }
    return (
      <div className="space-y-1.5">
        {fields.map((field, idx) => (
          <div key={`${field.field || 'field'}-${idx}`} className="rounded border border-border/70 bg-bg-primary/40 px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className="font-mono text-text-primary">{field.field || 'field'}</span>
              <span className="text-text-tertiary">{field.type || 'unknown'}</span>
              <span className={field.required ? 'text-amber-300' : 'text-text-disabled'}>{field.required ? 'required' : 'optional'}</span>
            </div>
            {field.description && <div className="text-[10px] text-text-tertiary mt-1">{field.description}</div>}
            {Array.isArray(field.children) && field.children.length > 0 && (
              <div className="mt-1 pl-2 border-l border-border/60 space-y-1">
                {field.children.map((child, childIdx) => (
                  <div key={`${child.field || 'child'}-${childIdx}`} className="text-[10px] flex items-center gap-1.5">
                    <span className="font-mono text-text-secondary">{child.field || 'field'}</span>
                    <span className="text-text-tertiary">{child.type || 'unknown'}</span>
                    <span className={child.required ? 'text-amber-300' : 'text-text-disabled'}>{child.required ? 'required' : 'optional'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }, [])

  useEffect(() => {
    if (!selectedPlugin) return
    const nextRequest = buildDefaultRequest(
      selectedPlugin.plugin_type,
      effectiveSubsessionId,
      sessionData?.drivers || [],
    )
    setRequestDraft(prettyJson(nextRequest))
    setRequestError('')
    setResult(null)
  }, [selectedPlugin, sessionData?.drivers, effectiveSubsessionId])

  const handleRun = useCallback(async () => {
    if (!selectedPlugin) return
    let requestBody = {}
    try {
      requestBody = JSON.parse(requestDraft || '{}')
      setRequestError('')
    } catch {
      setRequestError('Request body must be valid JSON')
      return
    }

    setRunning(true)
    setResult(null)
    try {
      const res = await apiPost(`/data-plugins/${selectedPlugin.id}/preview`, { request_body: requestBody })
      setResult(res)
      if (res?.success) {
        setActiveView('normalized')
      }
    } catch (err) {
      setResult({ success: false, error: err.message, request_body: requestBody })
    } finally {
      setRunning(false)
    }
  }, [requestDraft, selectedPlugin])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-text-tertiary gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading data sources…
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-4 md:p-6">
      <div className="mx-auto w-full max-w-6xl space-y-4">
        <div className="rounded-xl border border-border bg-bg-secondary/40 px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-emerald-400" />
            <div>
              <div className="text-sm font-semibold text-text-primary">Data Inspector</div>
              <div className="text-xxs text-text-tertiary">Test configured data sources with live request parameters and inspect the returned overlay data.</div>
            </div>
          </div>
          <button
            onClick={fetchPlugins}
            className="text-xxs px-2.5 py-1 rounded border border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover"
          >
            Refresh Sources
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)] gap-4">
          <div className="rounded-xl border border-border bg-bg-secondary/20 overflow-hidden h-fit">
            <div className="border-b border-border px-4 py-3 text-xs font-semibold text-text-primary">Configured Sources</div>
            <div className="p-3 space-y-2">
              {plugins.length === 0 && (
                <div className="text-xs text-text-tertiary px-2 py-6 text-center">No configured data sources found.</div>
              )}
              {plugins.map(plugin => {
                const selected = plugin.id === selectedPluginId
                return (
                  <button
                    key={plugin.id}
                    onClick={() => setSelectedPluginId(plugin.id)}
                    className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                      selected
                        ? 'border-accent bg-accent/10'
                        : 'border-border bg-bg-primary/20 hover:bg-bg-hover'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-text-primary truncate">{plugin.name}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${
                        plugin.enabled
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                          : 'border-border bg-bg-primary/30 text-text-disabled'
                      }`}>
                        {plugin.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-text-tertiary">{TYPE_LABELS[plugin.plugin_type] || plugin.plugin_type}</div>
                    <div className="mt-1 text-[10px] text-text-disabled truncate font-mono">{plugin.endpoint_url || 'No endpoint configured'}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-4 min-w-0">
            {!selectedPlugin && (
              <div className="rounded-xl border border-border bg-bg-secondary/20 px-4 py-10 text-center text-xs text-text-tertiary">
                Select a data source to test it.
              </div>
            )}

            {selectedPlugin && (
              <>
                <div className="rounded-xl border border-border bg-bg-secondary/20 overflow-hidden">
                  <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-text-primary">{selectedPlugin.name}</div>
                      <div className="text-xxs text-text-tertiary">{TYPE_LABELS[selectedPlugin.plugin_type] || selectedPlugin.plugin_type}</div>
                    </div>
                    <button
                      onClick={handleRun}
                      disabled={running}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs hover:bg-accent-hover disabled:opacity-60"
                    >
                      {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
                      Run Request
                    </button>
                  </div>

                  <div className="p-4 space-y-4">
                    <div className="rounded-lg border border-border bg-bg-primary/20 p-3 space-y-2">
                      <div className="text-[10px] uppercase tracking-wider text-text-disabled">Expected Schema</div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <div className="text-[10px] text-text-tertiary mb-1">Request</div>
                          {renderSchemaFields(selectedFormat.request_schema)}
                        </div>
                        <div>
                          <div className="text-[10px] text-text-tertiary mb-1">Response</div>
                          {renderSchemaFields(selectedFormat.response_schema)}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                      <div className="rounded-lg border border-border bg-bg-primary/30 px-3 py-2">
                        <div className="text-text-disabled uppercase tracking-wider text-[10px] mb-1">Endpoint</div>
                        <div className="font-mono text-text-secondary break-all">{selectedPlugin.endpoint_url || 'Not configured'}</div>
                      </div>
                      <div className="rounded-lg border border-border bg-bg-primary/30 px-3 py-2">
                        <div className="text-text-disabled uppercase tracking-wider text-[10px] mb-1">Helpful defaults</div>
                        <div className="text-text-tertiary">
                          {selectedPlugin.plugin_type === 'driver_details' && `Using up to ${(sessionData?.drivers || []).length ? Math.min((sessionData?.drivers || []).length, 6) : 0} driver customer IDs from live session data.`}
                          {(selectedPlugin.plugin_type === 'race_details' || selectedPlugin.plugin_type === 'championship_standings') && `${subsessionId ? 'Live' : 'Stored'} subsession_id: ${effectiveSubsessionId || 0}${!subsessionId && effectiveSubsessionId ? ' (from project)' : ''}`}
                        </div>
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-medium text-text-secondary">
                          {selectedPlugin.request_style === 'path_param' ? 'Request parameter' : 'Request body JSON'}
                        </label>
                        {(() => {
                          let parsed = {}
                          try { parsed = JSON.parse(requestDraft || '{}') } catch { /* ignore */ }
                          const preview = buildCallPreview(selectedPlugin, parsed)
                          if (!preview) return null
                          return (
                            <code className="text-[10px] text-text-tertiary font-mono">
                              {preview.method} {preview.url}
                            </code>
                          )
                        })()}
                      </div>
                      <textarea
                        value={requestDraft}
                        onChange={(e) => setRequestDraft(e.target.value)}
                        spellCheck={false}
                        className="w-full min-h-[180px] rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs font-mono text-text-primary focus:outline-none focus:border-accent"
                      />
                      {requestError && (
                        <div className="mt-2 text-xs text-red-400">{requestError}</div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-border bg-bg-secondary/20 overflow-hidden">
                  <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-3">
                    <div className="text-xs font-semibold text-text-primary">Response Viewer</div>
                    <div className="flex items-center gap-2">
                      {result && (
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] border ${
                          result.success
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-red-500/30 bg-red-500/10 text-red-400'
                        }`}>
                          {result.success ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                          {result.success ? 'Request succeeded' : 'Request failed'}
                        </span>
                      )}
                      {['normalized', 'raw'].map(view => (
                        <button
                          key={view}
                          onClick={() => setActiveView(view)}
                          className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xxs ${
                            activeView === view
                              ? 'border-accent text-accent bg-accent/10'
                              : 'border-border text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                          }`}
                        >
                          {view === 'normalized' ? <Eye className="w-3 h-3" /> : <Braces className="w-3 h-3" />}
                          {view === 'normalized' ? 'Overlay View' : 'Raw Response'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {!result && (
                    <div className="px-4 py-12 text-center text-xs text-text-tertiary">
                      Run a request to inspect the configured data source.
                    </div>
                  )}

                  {result && !result.success && (
                    <div className="p-4 space-y-3">
                      <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                        {result.error || 'Request failed'}
                      </div>
                      <pre className="overflow-auto rounded-lg border border-border bg-bg-primary px-3 py-3 text-xs text-text-tertiary font-mono">{prettyJson(result.request_body)}</pre>
                    </div>
                  )}

                  {result && result.success && (
                    <div className="p-4 space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
                        <div className="rounded-lg border border-border bg-bg-primary/30 px-3 py-2">
                          <div className="text-text-disabled uppercase tracking-wider text-[10px] mb-1">Status</div>
                          <div className="text-text-secondary">HTTP {result.status_code}</div>
                        </div>
                        <div className="rounded-lg border border-border bg-bg-primary/30 px-3 py-2">
                          <div className="text-text-disabled uppercase tracking-wider text-[10px] mb-1">Validation</div>
                          <div className="text-text-secondary">{result.validation?.valid ? 'Valid shape' : 'Unexpected shape'}</div>
                        </div>
                        <div className="rounded-lg border border-border bg-bg-primary/30 px-3 py-2">
                          <div className="text-text-disabled uppercase tracking-wider text-[10px] mb-1">Fields</div>
                          <div className="text-text-secondary truncate">{Array.isArray(result.validation?.fields_found) ? result.validation.fields_found.join(', ') : 'n/a'}</div>
                        </div>
                      </div>

                      <pre className="overflow-auto rounded-lg border border-border bg-bg-primary px-3 py-3 text-xs text-text-tertiary font-mono max-h-[28rem]">{
                        activeView === 'normalized'
                          ? prettyJson(result.normalized_data)
                          : prettyJson(result.raw_response)
                      }</pre>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
