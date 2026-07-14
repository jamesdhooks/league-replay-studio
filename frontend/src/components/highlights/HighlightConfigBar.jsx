import { useState, useEffect, useRef } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import { useIRacing } from '../../context/IRacingContext'
import { useProject } from '../../context/ProjectContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import {
  GitCompare, ToggleRight, Zap,
} from 'lucide-react'
import ScriptGenerationButton from './ScriptGenerationButton'

/**
 * HighlightConfigBar — Compact toolbar for A/B compare and save/apply.
 * (Presets have moved to the inline PresetSelector in the tuning pane.)
 */
export default function HighlightConfigBar({ projectId }) {
  const {
    abMode, activeConfig, startABCompare, stopABCompare, switchABConfig,
    applyHighlights,
    generateVideoScript,
    serverScoring,
    productionTimeline,
    videoScript,
    scriptProjectId,
  } = useHighlight()
  const { activeProject } = useProject()
  const { sessionData } = useIRacing()
  const [autoGenerate, setAutoGenerate] = useLocalStorage('lrs:highlights:autoGenerate', false)
  const autoGenDebounce = useRef(null)
  const isFirstRender = useRef(true)
  const hasExistingScript = (
    activeProject?.id === projectId
    && (
      (Array.isArray(activeProject.script) && activeProject.script.length > 0)
      || Boolean(activeProject.script_generated_at)
    )
  ) || (
    scriptProjectId === projectId
    && Array.isArray(videoScript)
    && videoScript.length > 0
  )

  // Auto-generate: silently regenerate script whenever productionTimeline changes
  useEffect(() => {
    // Skip the very first render so toggling on doesn't fire immediately for stale data
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    if (!autoGenerate || hasExistingScript || !projectId || serverScoring) return
    clearTimeout(autoGenDebounce.current)
    autoGenDebounce.current = setTimeout(async () => {
      try {
        await applyHighlights(projectId)
        await generateVideoScript(projectId, { cameras: sessionData?.cameras })
      } catch {
        // Silent — errors only surface via console, not toast
      }
    }, 1500)
    return () => clearTimeout(autoGenDebounce.current)
  }, [productionTimeline]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-bg-tertiary shrink-0">
      {/* A/B compare */}
      {abMode ? (
        <div className="flex items-center gap-1">
          <button
            onClick={() => switchABConfig('A')}
            className={`px-2 py-0.5 text-xxs font-medium rounded transition-colors
              ${activeConfig === 'A'
                ? 'bg-accent text-white'
                : 'bg-bg-primary text-text-secondary hover:text-text-primary border border-border'
              }`}
          >
            A
          </button>
          <button
            onClick={() => switchABConfig('B')}
            className={`px-2 py-0.5 text-xxs font-medium rounded transition-colors
              ${activeConfig === 'B'
                ? 'bg-accent text-white'
                : 'bg-bg-primary text-text-secondary hover:text-text-primary border border-border'
              }`}
          >
            B
          </button>
          <button
            onClick={stopABCompare}
            className="p-1 text-text-tertiary hover:text-text-primary transition-colors"
            title="Exit A/B compare"
          >
            <ToggleRight className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={startABCompare}
          className="flex items-center gap-1 px-2 py-1 text-xxs text-text-secondary
                     hover:text-text-primary transition-colors"
          title="A/B Compare Mode"
        >
          <GitCompare className="w-3 h-3" />
          A/B
        </button>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Auto-generate toggle + Apply button */}
      <button
        onClick={() => setAutoGenerate(v => !v)}
        disabled={hasExistingScript}
        title={hasExistingScript ? 'Existing scripts require review before re-generation' : (autoGenerate ? 'Auto-generate on (click to disable)' : 'Auto-generate script on changes')}
        className={`p-1.5 rounded transition-colors ${
          autoGenerate
            ? 'text-accent bg-accent/15 hover:bg-accent/25'
            : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-primary/50'
        } disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <Zap className="w-3.5 h-3.5" />
      </button>
      <ScriptGenerationButton projectId={projectId} hasExistingScript={hasExistingScript} />
    </div>
  )
}
