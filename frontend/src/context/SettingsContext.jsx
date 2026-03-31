import { createContext, useContext, useCallback, useState, useEffect, useMemo } from 'react'
import { apiGet, apiPut, apiPost } from '../services/api'

const SettingsContext = createContext(null)

/**
 * Settings provider — loads settings from the backend on mount,
 * provides update functions, and manages theme application.
 */
export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)

  // ── Fetch settings on mount ──────────────────────────────────────────────
  const fetchSettings = useCallback(async () => {
    try {
      const data = await apiGet('/settings')
      setSettings(data)
      applyTheme(data.theme || 'dark')
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  // ── Update settings ──────────────────────────────────────────────────────
  const updateSettings = useCallback(async (updates) => {
    const data = await apiPut('/settings', updates)
    setSettings(data)
    // Apply theme immediately if changed
    if (updates.theme !== undefined) {
      applyTheme(updates.theme)
    }
    return data
  }, [])

  // ── Update a single setting ──────────────────────────────────────────────
  const updateSetting = useCallback(async (key, value) => {
    return updateSettings({ [key]: value })
  }, [updateSettings])

  // ── Reset to defaults ────────────────────────────────────────────────────
  const resetSettings = useCallback(async () => {
    const data = await apiPost('/settings/reset')
    setSettings(data)
    applyTheme(data.theme || 'dark')
    return data
  }, [])

  // ── Context value (memoized) ─────────────────────────────────────────────
  const value = useMemo(() => ({
    settings,
    loading,
    updateSettings,
    updateSetting,
    resetSettings,
    fetchSettings,
  }), [settings, loading, updateSettings, updateSetting, resetSettings, fetchSettings])

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  )
}

/**
 * Hook to access settings state and update functions.
 *
 * @returns {{
 *   settings: object|null,
 *   loading: boolean,
 *   updateSettings: (updates: object) => Promise<object>,
 *   updateSetting: (key: string, value: any) => Promise<object>,
 *   resetSettings: () => Promise<object>,
 *   fetchSettings: () => Promise<void>,
 * }}
 */
export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider')
  }
  return context
}

// ── Theme helpers ────────────────────────────────────────────────────────────

/**
 * Apply theme to the document element.
 * Supports 'dark', 'light', and 'system' (follows OS preference).
 */
function applyTheme(theme) {
  const root = document.documentElement

  if (theme === 'system') {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.classList.toggle('dark', prefersDark)
    root.classList.toggle('light', !prefersDark)
  } else {
    root.classList.toggle('dark', theme === 'dark')
    root.classList.toggle('light', theme === 'light')
  }
}

/**
 * Listen for OS theme changes when 'system' theme is active.
 * Call this once at app startup.
 */
export function initSystemThemeListener(getTheme) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    if (getTheme() === 'system') {
      applyTheme('system')
    }
  })
}
