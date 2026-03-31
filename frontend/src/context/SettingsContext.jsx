import { createContext, useContext, useCallback, useState, useEffect, useMemo, useRef } from 'react'
import { apiGet, apiPut, apiPost } from '../services/api'

const SettingsContext = createContext(null)

/**
 * Settings provider — loads settings from the backend on mount,
 * provides update functions, and manages theme application.
 */
export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const settingsRef = useRef(null)

  // Keep ref in sync for the system theme listener
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

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

  // ── Listen for OS theme changes (system theme) ───────────────────────────
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      if (settingsRef.current?.theme === 'system') {
        applyTheme('system')
      }
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

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
 * Also persists to localStorage for FOUC prevention on next load.
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

  // Persist for FOUC prevention (read by inline script in index.html)
  try {
    localStorage.setItem('lrs-theme', theme)
  } catch (e) {
    // localStorage may be unavailable — ignore
  }
}
