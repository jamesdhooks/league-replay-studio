import { useState, useEffect, useCallback } from 'react'
import {
  Plug, Plus, Trash2, TestTube, ChevronDown, ChevronRight,
  CheckCircle2, XCircle, Loader2, Shield, Key, Globe,
  Users, Trophy, Flag, Info,
} from 'lucide-react'
import { apiGet, apiPost, apiPut, apiDelete } from '../../services/api'

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

/**
 * DataPluginsPanel — Configure 3rd-party API endpoints that provide
 * additional overlay variables (driver avatars, race metadata,
 * championship standings).
 */
export default function DataPluginsPanel() {
  const [plugins, setPlugins] = useState([])
  const [formats, setFormats] = useState({})
  const [loading, setLoading] = useState(true)
  const [expandedPlugin, setExpandedPlugin] = useState(null)
  const [testing, setTesting] = useState(null)
  const [testResult, setTestResult] = useState(null)
  const [showFormats, setShowFormats] = useState(false)

  // ── Fetch plugins + formats on mount ─────────────────────────────────────
  const fetchPlugins = useCallback(async () => {
    try {
      const [pluginsRes, formatsRes] = await Promise.all([
        apiGet('/data-plugins/'),
        apiGet('/data-plugins/formats'),
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

  // ── CRUD ─────────────────────────────────────────────────────────────────

  const handleCreate = useCallback(async (pluginType) => {
    const meta = PLUGIN_TYPES.find(t => t.value === pluginType)
    try {
      const res = await apiPost('/data-plugins/', {
        name: meta?.label || 'New Plugin',
        plugin_type: pluginType,
        endpoint_url: '',
        auth_method: 'none',
        auth_config: {},
      })
      if (res?.plugin) {
        setPlugins(prev => [...prev, res.plugin])
        setExpandedPlugin(res.plugin.id)
      }
    } catch {
      // Handle error
    }
  }, [])

  const handleUpdate = useCallback(async (pluginId, updates) => {
    try {
      const res = await apiPut(`/data-plugins/${pluginId}`, updates)
      if (res?.plugin) {
        setPlugins(prev => prev.map(p => p.id === pluginId ? res.plugin : p))
      }
    } catch {
      // Handle error
    }
  }, [])

  const handleDelete = useCallback(async (pluginId) => {
    try {
      await apiDelete(`/data-plugins/${pluginId}`)
      setPlugins(prev => prev.filter(p => p.id !== pluginId))
      if (expandedPlugin === pluginId) setExpandedPlugin(null)
    } catch {
      // Handle error
    }
  }, [expandedPlugin])

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

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-4 h-4 animate-spin text-text-disabled" />
        <span className="text-xs text-text-tertiary ml-2">Loading plugins…</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <Plug className="w-4 h-4 text-emerald-400" />
        <span className="text-sm font-medium text-text-primary">Data Plugins</span>
        <span className="text-[10px] text-text-disabled ml-auto">
          {plugins.length} configured
        </span>
      </div>

      {/* ── Description ──────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-b border-border bg-bg-secondary/30">
        <p className="text-[11px] text-text-tertiary leading-relaxed">
          Connect 3rd-party API endpoints to enrich overlay variables with driver
          avatars, race metadata, and championship standings. Configured data is
          automatically merged into <code className="text-accent">{'{{ frame.* }}'}</code> variables
          at preview and encoding time.
        </p>
      </div>

      {/* ── Plugin list ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {plugins.length === 0 && (
          <div className="px-4 py-6 text-center">
            <Plug className="w-8 h-8 text-text-disabled mx-auto mb-2" />
            <p className="text-xs text-text-tertiary mb-3">No data plugins configured</p>
            <p className="text-[10px] text-text-disabled mb-4">
              Add a plugin to enrich your overlays with external data
            </p>
          </div>
        )}

        {plugins.map(plugin => (
          <PluginCard
            key={plugin.id}
            plugin={plugin}
            isExpanded={expandedPlugin === plugin.id}
            onToggle={() => setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onTest={handleTest}
            testing={testing === plugin.id}
            testResult={testResult?.pluginId === plugin.id ? testResult : null}
          />
        ))}

        {/* ── Add plugin buttons ─────────────────────────────────────────── */}
        <div className="px-4 py-3 border-t border-border">
          <p className="text-[10px] text-text-tertiary mb-2 font-medium uppercase tracking-wider">
            Add Data Source
          </p>
          <div className="space-y-1.5">
            {PLUGIN_TYPES.map(pt => {
              const Icon = pt.icon
              const exists = plugins.some(p => p.plugin_type === pt.value)
              return (
                <button
                  key={pt.value}
                  onClick={() => handleCreate(pt.value)}
                  disabled={exists}
                  className={`w-full flex items-center gap-2 px-3 py-2 rounded border text-left transition-colors ${
                    exists
                      ? 'border-border/50 bg-bg-secondary/30 opacity-50 cursor-not-allowed'
                      : 'border-border hover:border-accent/50 hover:bg-bg-secondary/50 cursor-pointer'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-text-primary">{pt.label}</div>
                    <div className="text-[10px] text-text-tertiary truncate">{pt.description}</div>
                  </div>
                  {exists
                    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                    : <Plus className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
                  }
                </button>
              )
            })}
          </div>
        </div>

        {/* ── API Format Reference ───────────────────────────────────────── */}
        <div className="px-4 py-3 border-t border-border">
          <button
            onClick={() => setShowFormats(f => !f)}
            className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
          >
            {showFormats
              ? <ChevronDown className="w-3 h-3" />
              : <ChevronRight className="w-3 h-3" />
            }
            <Info className="w-3 h-3 text-blue-400" />
            API Format Reference
          </button>
          {showFormats && (
            <div className="mt-2 space-y-3">
              {Object.entries(formats).map(([type, fmt]) => {
                const meta = PLUGIN_TYPES.find(t => t.value === type)
                return (
                  <div key={type} className="rounded border border-border bg-bg-secondary/30 p-3">
                    <h4 className="text-[11px] font-medium text-text-primary mb-1">
                      {meta?.label || type}
                    </h4>
                    <p className="text-[10px] text-text-tertiary mb-2 leading-relaxed">
                      {fmt.description}
                    </p>
                    <div className="space-y-1.5">
                      <div>
                        <span className="text-[9px] font-medium text-text-disabled uppercase tracking-wider">
                          Request Body
                        </span>
                        <pre className="text-[10px] text-text-tertiary font-mono bg-bg-primary rounded p-1.5 mt-0.5 overflow-x-auto">
                          {JSON.stringify(fmt.request_example, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <span className="text-[9px] font-medium text-text-disabled uppercase tracking-wider">
                          Response Format
                        </span>
                        <pre className="text-[10px] text-text-tertiary font-mono bg-bg-primary rounded p-1.5 mt-0.5 overflow-x-auto">
                          {JSON.stringify(fmt.response_example, null, 2)}
                        </pre>
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


// ── Plugin Card (expandable) ────────────────────────────────────────────────

function PluginCard({ plugin, isExpanded, onToggle, onUpdate, onDelete, onTest, testing, testResult }) {
  const [localUrl, setLocalUrl] = useState(plugin.endpoint_url || '')
  const [localName, setLocalName] = useState(plugin.name || '')
  const [localAuth, setLocalAuth] = useState(plugin.auth_method || 'none')
  const [localAuthConfig, setLocalAuthConfig] = useState(plugin.auth_config || {})

  const meta = PLUGIN_TYPES.find(t => t.value === plugin.plugin_type)
  const Icon = meta?.icon || Plug

  const handleSave = useCallback(() => {
    onUpdate(plugin.id, {
      name: localName,
      endpoint_url: localUrl,
      auth_method: localAuth,
      auth_config: localAuthConfig,
      enabled: plugin.enabled,
    })
  }, [plugin.id, localName, localUrl, localAuth, localAuthConfig, plugin.enabled, onUpdate])

  const handleToggleEnabled = useCallback(() => {
    onUpdate(plugin.id, { enabled: !plugin.enabled })
  }, [plugin.id, plugin.enabled, onUpdate])

  return (
    <div className="border-b border-border">
      {/* Header row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-bg-secondary/30 transition-colors"
      >
        {isExpanded
          ? <ChevronDown className="w-3 h-3 text-text-tertiary flex-shrink-0" />
          : <ChevronRight className="w-3 h-3 text-text-tertiary flex-shrink-0" />
        }
        <Icon className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
        <span className="text-xs font-medium text-text-primary flex-1 text-left truncate">
          {plugin.name}
        </span>
        <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
          plugin.enabled
            ? 'bg-emerald-500/15 text-emerald-400'
            : 'bg-bg-secondary text-text-disabled'
        }`}>
          {plugin.enabled ? 'Active' : 'Disabled'}
        </span>
        {plugin.last_test_ok && (
          <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
        )}
      </button>

      {/* Expanded config form */}
      {isExpanded && (
        <div className="px-4 pb-3 space-y-3">
          {/* Name */}
          <div>
            <label className="text-[10px] text-text-tertiary font-medium block mb-1">
              Display Name
            </label>
            <input
              type="text"
              value={localName}
              onChange={e => setLocalName(e.target.value)}
              onBlur={handleSave}
              className="w-full bg-bg-secondary border border-border rounded px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
            />
          </div>

          {/* Endpoint URL */}
          <div>
            <label className="text-[10px] text-text-tertiary font-medium block mb-1">
              <Globe className="w-3 h-3 inline mr-1" />
              Endpoint URL
            </label>
            <input
              type="url"
              value={localUrl}
              onChange={e => setLocalUrl(e.target.value)}
              onBlur={handleSave}
              placeholder="https://api.example.com/v1/driver-details"
              className="w-full bg-bg-secondary border border-border rounded px-2.5 py-1.5 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
            />
          </div>

          {/* Auth method */}
          <div>
            <label className="text-[10px] text-text-tertiary font-medium block mb-1">
              <Shield className="w-3 h-3 inline mr-1" />
              Authentication
            </label>
            <select
              value={localAuth}
              onChange={e => {
                setLocalAuth(e.target.value)
                setLocalAuthConfig({})
              }}
              className="w-full bg-bg-secondary border border-border rounded px-2.5 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
            >
              {AUTH_METHODS.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          {/* Auth config fields */}
          {localAuth === 'api_key' && (
            <div className="space-y-2 pl-3 border-l-2 border-accent/30">
              <div>
                <label className="text-[10px] text-text-tertiary block mb-0.5">Header Name</label>
                <input
                  type="text"
                  value={localAuthConfig.header_name || 'X-API-Key'}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, header_name: e.target.value }))}
                  onBlur={handleSave}
                  className="w-full bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-tertiary block mb-0.5">
                  <Key className="w-3 h-3 inline mr-0.5" /> API Key
                </label>
                <input
                  type="password"
                  value={localAuthConfig.api_key || ''}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, api_key: e.target.value }))}
                  onBlur={handleSave}
                  placeholder="Enter API key"
                  className="w-full bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          )}

          {localAuth === 'bearer' && (
            <div className="pl-3 border-l-2 border-accent/30">
              <label className="text-[10px] text-text-tertiary block mb-0.5">
                <Key className="w-3 h-3 inline mr-0.5" /> Bearer Token
              </label>
              <input
                type="password"
                value={localAuthConfig.token || ''}
                onChange={e => setLocalAuthConfig(c => ({ ...c, token: e.target.value }))}
                onBlur={handleSave}
                placeholder="Enter bearer token"
                className="w-full bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
              />
            </div>
          )}

          {localAuth === 'custom_header' && (
            <div className="space-y-2 pl-3 border-l-2 border-accent/30">
              <div>
                <label className="text-[10px] text-text-tertiary block mb-0.5">Header Name</label>
                <input
                  type="text"
                  value={localAuthConfig.header_name || ''}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, header_name: e.target.value }))}
                  onBlur={handleSave}
                  placeholder="X-Custom-Auth"
                  className="w-full bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-tertiary block mb-0.5">Header Value</label>
                <input
                  type="password"
                  value={localAuthConfig.header_value || ''}
                  onChange={e => setLocalAuthConfig(c => ({ ...c, header_value: e.target.value }))}
                  onBlur={handleSave}
                  placeholder="Secret value"
                  className="w-full bg-bg-secondary border border-border rounded px-2 py-1 text-xs text-text-primary font-mono focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          )}

          {/* Actions row */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => handleToggleEnabled()}
              className={`text-[10px] px-2.5 py-1 rounded border transition-colors ${
                plugin.enabled
                  ? 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
                  : 'border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10'
              }`}
            >
              {plugin.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => onTest(plugin.id)}
              disabled={testing || !localUrl}
              className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded border border-blue-500/30 text-blue-400 hover:bg-blue-500/10 disabled:opacity-40 transition-colors"
            >
              {testing
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <TestTube className="w-3 h-3" />
              }
              Test Connection
            </button>
            <button
              onClick={handleSave}
              className="text-[10px] px-2.5 py-1 rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors"
            >
              Save
            </button>
            <div className="flex-1" />
            <button
              onClick={() => onDelete(plugin.id)}
              className="text-[10px] px-2 py-1 rounded text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>

          {/* Test result */}
          {testResult && (
            <div className={`rounded border p-2 text-[10px] ${
              testResult.success
                ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
                : 'border-red-500/30 bg-red-500/5 text-red-400'
            }`}>
              <div className="flex items-center gap-1 mb-1 font-medium">
                {testResult.success
                  ? <><CheckCircle2 className="w-3 h-3" /> Connection successful</>
                  : <><XCircle className="w-3 h-3" /> Connection failed</>
                }
              </div>
              {testResult.error && (
                <p className="text-text-tertiary">{testResult.error}</p>
              )}
              {testResult.validation && (
                <p className="text-text-tertiary">
                  {testResult.validation.fields_found && (
                    <>Fields: {testResult.validation.fields_found.join(', ')}</>
                  )}
                  {testResult.validation.entry_count !== null && testResult.validation.entry_count !== undefined && (
                    <> • {testResult.validation.entry_count} entries</>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
