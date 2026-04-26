import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Plug, Trash2, TestTube, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Loader2, Key,
  Users, Trophy, Flag, Info, AlertTriangle,
} from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '../../services/api'
import { useToast } from '../../context/ToastContext'

const PLUGIN_TYPES = [
  {
    value: 'driver_details',
    label: 'Driver Details',
    icon: Users,
    description: 'Nicknames + avatars keyed by iRacing customer ID',
  },
  {
    value: 'race_details',
    label: 'Race Details',
    icon: Flag,
    description: 'Season, series, week, date, and venue for a subsession',
  },
  {
    value: 'championship_standings',
    label: 'Championship Standings',
    icon: Trophy,
    description: 'Standings array with points, deltas, and positions',
  },
]

const AUTH_METHODS = [
  { value: 'none', label: 'No Auth' },
  { value: 'api_key', label: 'API Key' },
  { value: 'bearer', label: 'Bearer Token' },
  { value: 'custom_header', label: 'Custom Header' },
]

const REQUEST_STYLES = [
  { value: 'post_body', label: 'POST body' },
  { value: 'path_param', label: 'Path param' },
]

const SECRET_KEYS = ['api_key', 'token', 'header_value']

function isMaskedSecret(value) {
  return typeof value === 'string' && value.includes('****')
}

function mergeMaskedAuthConfig(incomingConfig, currentConfig = {}) {
  const next = { ...(incomingConfig || {}) }
  for (const key of SECRET_KEYS) {
    if (isMaskedSecret(next[key]) && currentConfig[key]) {
      next[key] = currentConfig[key]
    }
  }
  return next
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
        'transition-colors duration-200 focus:outline-none disabled:opacity-40',
        checked ? 'bg-emerald-500' : 'bg-zinc-600',
      ].join(' ')}
    >
      <span className={[
        'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
        checked ? 'translate-x-4' : 'translate-x-0',
      ].join(' ')} />
    </button>
  )
}

function FormRow({ label, children }) {
  return (
    <div className="flex items-start gap-4 py-2.5 border-b border-border/40 last:border-0">
      <span className="text-[11px] text-text-tertiary w-28 shrink-0 pt-1.5">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}

function SchemaFields({ fields }) {
  if (!Array.isArray(fields) || fields.length === 0) {
    return <p className="text-[10px] text-text-disabled">No schema metadata available.</p>
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
          {field.description && <p className="text-[10px] text-text-tertiary mt-1">{field.description}</p>}
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
}

export default function DataPluginsPanel({ embedded = false }) {
  const { showError } = useToast()
  const [plugins, setPlugins] = useState([])
  const [formats, setFormats] = useState({})
  const [loading, setLoading] = useState(true)
  const [expandedType, setExpandedType] = useState(null)
  const [testing, setTesting] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const [showFormats, setShowFormats] = useState(false)
  const [creating, setCreating] = useState(null)

  const formatByType = useMemo(() => {
    const lookup = {}
    if (formats && typeof formats === 'object') {
      for (const [type, fmt] of Object.entries(formats)) {
        lookup[type] = (fmt && typeof fmt === 'object') ? fmt : {}
      }
    }
    return lookup
  }, [formats])

  const fetchPlugins = useCallback(async () => {
    try {
      const [pluginsRes, formatsRes] = await Promise.all([
        apiGet('/data-plugins/').catch(() => ({ plugins: [] })),
        apiGet('/data-plugins/formats').catch(() => ({ formats: {} })),
      ])
      setPlugins(pluginsRes?.plugins || [])
      setFormats(formatsRes?.formats || {})
    } catch {
      // API may not be available yet
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchPlugins() }, [fetchPlugins])

  const handleToggleType = useCallback(async (pluginType, currentPlugin) => {
    if (currentPlugin == null) {
      const meta = PLUGIN_TYPES.find(t => t.value === pluginType)
      setCreating(pluginType)
      try {
        const res = await apiPost('/data-plugins/', {
          name: meta?.label || 'New Plugin',
          plugin_type: pluginType,
          endpoint_url: '',
          auth_method: 'none',
          auth_config: {},
          enabled: true
        })
        if (res?.plugin) {
          setPlugins(prev => [...prev, res.plugin])
          setExpandedType(pluginType)
        }
      } catch (err) {
        showError(err?.message || 'Failed to enable data source')
      } finally {
        setCreating(null)
        fetchPlugins()
      }
    } else {
      const nextEnabled = !currentPlugin.enabled
      setPlugins(prev => prev.map(p => (p.id === currentPlugin.id ? { ...p, enabled: nextEnabled } : p)))
      try {
        const res = await apiPut(`/data-plugins/${currentPlugin.id}`, { enabled: nextEnabled })
        if (res?.plugin) {
          setPlugins(prev => prev.map(p => p.id === currentPlugin.id ? res.plugin : p))
        }
      } catch (err) {
        showError(err?.message || 'Failed to update data source state')
      } finally {
        fetchPlugins()
      }
    }
  }, [fetchPlugins, showError])

  const handleUpdate = useCallback(async (pluginId, updates) => {
    try {
      const res = await apiPut(`/data-plugins/${pluginId}`, updates)
      if (res?.plugin) {
        setPlugins(prev => prev.map(p => p.id === pluginId ? res.plugin : p))
      }
    } catch (err) {
      showError(err?.message || 'Failed to save data source changes')
    } finally {
      fetchPlugins()
    }
  }, [fetchPlugins, showError])

  const handleDelete = useCallback(async (pluginId, pluginType) => {
    try {
      await apiDelete(`/data-plugins/${pluginId}`)
      setPlugins(prev => prev.filter(p => p.id !== pluginId))
      if (expandedType === pluginType) setExpandedType(null)
    } catch (err) {
      showError(err?.message || 'Failed to remove data source')
    } finally {
      fetchPlugins()
    }
  }, [expandedType, fetchPlugins, showError])

  const handleTest = useCallback(async (pluginId) => {
    setTesting(pluginId)
    setTestResult(null)
    try {
      const res = await apiPost(`/data-plugins/${pluginId}/test`)
      setTestResult({ pluginId, ...res })
    } catch (err) {
      setTestResult({ pluginId, success: false, error: err.message })
    } finally {
      setTesting(null)
    }
  }, [])

  if (loading) {
    return (
      <div className={embedded ? 'py-8 flex items-center justify-center' : 'h-full flex items-center justify-center'}>
        <Loader2 className="w-4 h-4 animate-spin text-text-disabled mr-2" />
        <span className="text-xs text-text-tertiary">Loading...</span>
      </div>
    )
  }

  return (
    <div className={embedded ? '' : 'h-full overflow-auto p-4 md:p-6'}>
      <div className={embedded ? 'w-full max-w-xl space-y-3' : 'mx-auto w-full max-w-2xl space-y-3'}>
        <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
          {PLUGIN_TYPES.map(pt => {
            const plugin = plugins.find(p => p.plugin_type === pt.value) || null
            const isExpanded = expandedType === pt.value && plugin != null
            return (
              <PluginRow
                key={pt.value}
                pluginType={pt}
                plugin={plugin}
                formatDoc={formatByType[pt.value] || null}
                isExpanded={isExpanded}
                isCreating={creating === pt.value}
                onToggleExpand={() => plugin && setExpandedType(isExpanded ? null : pt.value)}
                onToggleEnabled={() => handleToggleType(pt.value, plugin)}
                onUpdate={handleUpdate}
                onDelete={(id) => handleDelete(id, pt.value)}
                onTest={handleTest}
                testing={testing === plugin?.id}
                testResult={testResult?.pluginId === plugin?.id ? testResult : null}
              />
            )
          })}
        </div>

        <div>
          <button
            onClick={() => setShowFormats(!showFormats)}
            className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors px-1 py-1"
          >
            {showFormats ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Info className="w-3 h-3 text-blue-400" />
            API Format Reference
          </button>
          {showFormats && (
            <div className="mt-2 rounded-xl border border-border overflow-hidden divide-y divide-border">
              {PLUGIN_TYPES.map(pt => {
                const fmt = formatByType[pt.value] || {}
                const reqSchema = fmt.request_schema || []
                const resSchema = fmt.response_schema || []
                const reqEx = fmt.request_example ?? fmt.request ?? {}
                const resEx = fmt.response_example ?? fmt.response ?? {}
                return (
                  <div key={pt.value} className="px-4 py-3 space-y-2">
                    <p className="text-[11px] font-medium text-text-primary">{pt.label}</p>
                    <p className="text-[10px] text-text-tertiary leading-relaxed">{fmt.description || ''}</p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      <div>
                        <p className="text-[9px] text-text-disabled uppercase tracking-wider mb-1">Request Schema</p>
                        <SchemaFields fields={reqSchema} />
                      </div>
                      <div>
                        <p className="text-[9px] text-text-disabled uppercase tracking-wider mb-1">Response Schema</p>
                        <SchemaFields fields={resSchema} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-[9px] text-text-disabled uppercase tracking-wider mb-1">Request</p>
                        <pre className="text-[10px] text-text-tertiary font-mono bg-bg-primary rounded p-2 overflow-x-auto">{JSON.stringify(reqEx, null, 2)}</pre>
                      </div>
                      <div>
                        <p className="text-[9px] text-text-disabled uppercase tracking-wider mb-1">Response</p>
                        <pre className="text-[10px] text-text-tertiary font-mono bg-bg-primary rounded p-2 overflow-x-auto">{JSON.stringify(resEx, null, 2)}</pre>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PluginRow({
  pluginType, plugin, formatDoc, isExpanded, isCreating,
  onToggleExpand, onToggleEnabled, onUpdate, onDelete, onTest, testing, testResult,
}) {
  const Icon = pluginType.icon
  const [localUrl, setLocalUrl] = useState(plugin?.endpoint_url || '')
  const [localName, setLocalName] = useState(plugin?.name || '')
  const [localAuth, setLocalAuth] = useState(plugin?.auth_method || 'none')
  const [localAuthConfig, setLocalAuthConfig] = useState(plugin?.auth_config || {})
  const [localRequestStyle, setLocalRequestStyle] = useState(plugin?.request_style || 'post_body')
  const skipAutosaveRef = useRef(false)

  const handleSave = useCallback(() => {
    if (plugin == null) return
    onUpdate(plugin.id, {
      name: localName,
      endpoint_url: localUrl,
      request_style: localRequestStyle,
      auth_method: localAuth,
      auth_config: localAuthConfig,
    })
  }, [plugin, localName, localUrl, localRequestStyle, localAuth, localAuthConfig, onUpdate])

  // Use a ref so the autosave timer always calls the latest handleSave without
  // including handleSave itself as a dep (which would re-trigger on every server response)
  const handleSaveRef = useRef(handleSave)
  useEffect(() => { handleSaveRef.current = handleSave }, [handleSave])

  useEffect(() => {
    if (plugin == null) return
    skipAutosaveRef.current = true
    setLocalUrl(plugin.endpoint_url || '')
    setLocalName(plugin.name || '')
    setLocalAuth(plugin.auth_method || 'none')
    setLocalAuthConfig(current => mergeMaskedAuthConfig(plugin.auth_config || {}, current))
    setLocalRequestStyle(plugin.request_style || 'post_body')
  }, [plugin?.id, plugin?.endpoint_url, plugin?.name, plugin?.auth_method, plugin?.auth_config, plugin?.request_style])

  useEffect(() => {
    if (!isExpanded || plugin == null) return undefined
    if (skipAutosaveRef.current) { skipAutosaveRef.current = false; return undefined }
    const t = window.setTimeout(() => handleSaveRef.current(), 350)
    return () => window.clearTimeout(t)
  }, [isExpanded, localName, localUrl, localRequestStyle, localAuth, localAuthConfig, plugin?.id])

  const isConfigured = plugin != null
  const isEnabled = plugin?.enabled === true
  const hasEndpoint = Boolean((plugin?.endpoint_url || '').trim())
  const testOk = plugin?.last_test_ok === true
  const dotClass = isEnabled && hasEndpoint
    ? testOk ? 'bg-emerald-500' : 'bg-amber-400'
    : 'bg-zinc-600'

  const callPreview = useMemo(() => {
    if (localUrl === '') return null
    const base = localUrl.replace(/\/$/, '')
    const exampleParam = pluginType.value === 'driver_details' ? '12345' : '99887766'
    const exampleBody = pluginType.value === 'driver_details'
      ? '{ "customer_ids": [12345, ...] }'
      : '{ "subsession_id": 99887766 }'
    if (localRequestStyle === 'path_param' && pluginType.value !== 'driver_details') {
      return `GET ${base}/${exampleParam}`
    }
    if (localRequestStyle === 'path_param' && pluginType.value === 'driver_details') {
      return `POST ${base}  ${exampleBody}  (path param fallback for batched driver IDs)`
    }
    return `POST ${base}  ${exampleBody}`
  }, [localUrl, localRequestStyle, pluginType.value])

  return (
    <div className="bg-bg-secondary/10">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={onToggleExpand}
          disabled={isConfigured === false}
          className="shrink-0 text-text-disabled hover:text-text-secondary transition-colors disabled:opacity-30 disabled:cursor-default"
        >
          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={onToggleExpand}
          disabled={isConfigured === false}
          className="flex items-center gap-2.5 flex-1 min-w-0 text-left disabled:cursor-default"
        >
          <Icon className={isConfigured ? 'w-4 h-4 shrink-0 text-emerald-400' : 'w-4 h-4 shrink-0 text-text-disabled'} />
          <div className="min-w-0">
            <p className={isConfigured ? 'text-xs font-medium leading-tight truncate text-text-primary' : 'text-xs font-medium leading-tight truncate text-text-tertiary'}>
              {pluginType.label}
            </p>
            <p className="text-[10px] text-text-disabled truncate">{pluginType.description}</p>
          </div>
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {testOk && <CheckCircle2 className="w-3 h-3 text-emerald-500" title="Last test passed" />}
          {!hasEndpoint && isEnabled && (
            <AlertTriangle className="w-3 h-3 text-amber-400" title="No endpoint configured" />
          )}
          <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
          {isCreating
            ? <Loader2 className="w-4 h-4 animate-spin text-text-disabled" />
            : <Toggle checked={isEnabled} onChange={onToggleEnabled} />
          }
        </div>
      </div>

      {isExpanded && plugin != null && (
        <div className="border-t border-border/50 px-4 pt-1 pb-4">
          <FormRow label="Display name">
            <input
              type="text"
              value={localName}
              onChange={e => setLocalName(e.target.value)}
              onBlur={handleSave}
              className="w-full bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
            />
          </FormRow>
          <FormRow label="Endpoint URL">
            <input
              type="url"
              value={localUrl}
              onChange={e => setLocalUrl(e.target.value)}
              onBlur={handleSave}
              placeholder="https://api.example.com/v1/..."
              className="w-full bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
            />
          </FormRow>
          <FormRow label="Request style">
            <div className="flex flex-col gap-1.5">
              <div className="inline-flex rounded-md border border-border overflow-hidden w-fit">
                {REQUEST_STYLES.map(rs => (
                  <button
                    key={rs.value}
                    type="button"
                    onClick={() => {
                      setLocalRequestStyle(rs.value)
                      if (plugin != null) {
                        onUpdate(plugin.id, { request_style: rs.value })
                      }
                    }}
                    className={localRequestStyle === rs.value
                      ? 'px-3 py-1 text-[10px] font-medium transition-colors bg-accent text-white'
                      : 'px-3 py-1 text-[10px] font-medium transition-colors bg-bg-secondary text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                    }
                  >
                    {rs.label}
                  </button>
                ))}
              </div>
              {callPreview && (
                <code className="text-[10px] text-text-tertiary font-mono">{callPreview}</code>
              )}
            </div>
          </FormRow>
          <FormRow label="Authentication">
            <select
              value={localAuth}
              onChange={e => { setLocalAuth(e.target.value); setLocalAuthConfig({}) }}
              className="bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
            >
              {AUTH_METHODS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </FormRow>
          {localAuth === 'api_key' && (
            <>
              <FormRow label="Header name">
                <input
                  type="text"
                  value={localAuthConfig.header_name || 'X-API-Key'}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, header_name: e.target.value }))}
                  onBlur={handleSave}
                  className="w-full bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </FormRow>
              <FormRow label="API key">
                <input
                  type="password"
                  value={localAuthConfig.api_key || ''}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, api_key: e.target.value }))}
                  onBlur={handleSave}
                  placeholder="Enter API key"
                  className="w-full bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </FormRow>
            </>
          )}
          {localAuth === 'bearer' && (
            <FormRow label="Bearer token">
              <input
                type="password"
                value={localAuthConfig.token || ''}
                onChange={e => setLocalAuthConfig(c => ({ ...c, token: e.target.value }))}
                onBlur={handleSave}
                placeholder="Enter bearer token"
                className="w-full bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
              />
            </FormRow>
          )}
          {localAuth === 'custom_header' && (
            <>
              <FormRow label="Header name">
                <input
                  type="text"
                  value={localAuthConfig.header_name || ''}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, header_name: e.target.value }))}
                  onBlur={handleSave}
                  placeholder="X-Custom-Auth"
                  className="w-full bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </FormRow>
              <FormRow label="Header value">
                <input
                  type="password"
                  value={localAuthConfig.header_value || ''}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, header_value: e.target.value }))}
                  onBlur={handleSave}
                  placeholder="Secret value"
                  className="w-full bg-bg-secondary border border-border rounded-md px-2.5 py-1.5 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </FormRow>
            </>
          )}

          <div className="flex items-center gap-2 pt-3">
            <button
              onClick={() => onTest(plugin.id)}
              disabled={testing || localUrl === ''}
              className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-md border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 disabled:opacity-40 transition-colors"
            >
              {testing ? <Loader2 className="w-3 h-3 animate-spin" /> : <TestTube className="w-3 h-3" />}
              Test
            </button>
            <div className="flex-1" />
            <button
              onClick={() => onDelete(plugin.id)}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
              Remove
            </button>
          </div>

          {testResult && (
            <div className={testResult.success
              ? 'mt-3 rounded-lg border px-3 py-2 text-[10px] border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
              : 'mt-3 rounded-lg border px-3 py-2 text-[10px] border-red-500/30 bg-red-500/5 text-red-400'
            }>
              <div className="flex items-center gap-1 font-medium">
                {testResult.success
                  ? <><CheckCircle2 className="w-3 h-3" /> Connection successful</>
                  : <><XCircle className="w-3 h-3" /> Connection failed</>
                }
              </div>
              {testResult.error && <p className="text-text-tertiary mt-0.5">{testResult.error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
