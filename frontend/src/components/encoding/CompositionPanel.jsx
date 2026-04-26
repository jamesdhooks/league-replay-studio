import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useComposition } from '../../context/CompositionContext'
import { usePreset } from '../../context/PresetContext'
import { useProject } from '../../context/ProjectContext'
import { useScriptState } from '../../context/ScriptStateContext'
import { COMPOSE_MODES, GAP_POLICIES, DEFAULT_COMPOSITION_CONFIG } from '../../context/ScriptStateContext'
import { useToast } from '../../context/ToastContext'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import { useTimelineViewport } from '../../hooks/useTimelineViewport'
import { formatTime } from '../../utils/time'
import ResizableSidebar from '../layout/ResizableSidebar'
import CollapsibleControlsHeader from '../ui/CollapsibleControlsHeader'
import CollapsibleSection from '../ui/CollapsibleSection'
import CollapsiblePanelHeader from '../ui/CollapsiblePanelHeader'
import ResizableRowPane from '../ui/ResizableRowPane'
import ConfigurableTimelineTracks from '../ui/ConfigurableTimelineTracks'
import RangeSlider from '../ui/RangeSlider'
import PlaybackControls from '../ui/PlaybackControls'
import IsolatedHtmlPreview from '../ui/IsolatedHtmlPreview'
import ProjectFileBrowser from '../projects/ProjectFileBrowser'
import UnifiedLogList from '../ui/UnifiedLogList'
import { normalizeCompositionLogEntries } from '../../utils/logEntries'
import {
  Film, Play, Square, Settings2, Scissors, Palette,
  BarChart2, Layers, CheckCircle2, Loader2,
  XCircle, AlertTriangle, FolderOpen, HardDrive,
  Clapperboard, Eye, EyeOff, Monitor, Crosshair,
} from 'lucide-react'

const STEP_META = {
  trimming: { label: 'Trimming Clips', icon: Scissors, color: 'text-amber-400', range: [0, 25] },
  overlaying: { label: 'Rendering Overlays', icon: Palette, color: 'text-blue-400', range: [25, 65] },
  transitions: { label: 'Inserting Transitions', icon: Film, color: 'text-purple-400', range: [65, 80] },
  stitching: { label: 'Stitching Final Video', icon: Layers, color: 'text-emerald-400', range: [80, 100] },
}

const SECTION_META = {
  intro: { label: 'Intro', color: '#a855f7' },
  qualifying_results: { label: 'Qualifying', color: '#06b6d4' },
  race: { label: 'Race', color: '#22c55e' },
  race_results: { label: 'Results', color: '#f59e0b' },
}

const TIMELINE_ROW_SECTION = 18
const TIMELINE_ROW_CLIPS = 48
const TIMELINE_ROW_TICKS = 24

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function getSegmentId(segment) {
  return segment?.segment_id || segment?.id || null
}

function getSegmentStart(segment) {
  return num(segment?.start_time_seconds, num(segment?.start_time, 0))
}

function getSegmentEnd(segment) {
  const start = getSegmentStart(segment)
  const end = num(segment?.end_time_seconds, num(segment?.end_time, start + num(segment?.duration, 0)))
  return Math.max(start, end)
}

function getClipPath(clip) {
  if (!clip) return null
  return clip.clip_path || clip.file_path || clip.path || clip.output_path || clip.file || clip.clip || null
}

function getSegmentOverlayDesignId(segment, fallback = null) {
  if (!segment) return fallback
  return segment.overlay_preset_id || segment.overlay_preset || segment.overlayPresetId || fallback
}

function toProjectRelativePath(path) {
  if (!path || typeof path !== 'string') return null

  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) return null
  if (normalized.includes('..')) return null

  const projectRoots = new Set(['captures', 'clips', 'preview', 'exports', 'overlays', 'logs', 'replay'])

  const parts = normalized.split('/').filter(Boolean)
  const rootIndex = parts.findIndex((part) => projectRoots.has(String(part).toLowerCase()))
  if (rootIndex >= 0) {
    return parts.slice(rootIndex).join('/')
  }

  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//')) {
    return null
  }

  return normalized
}

function clipMatchesSegmentId(clip, segId) {
  if (!clip || !segId) return false
  const normalized = String(segId)
  const direct = [clip.segment_id, clip.id, clip.source_segment_id, clip.source_clip_id]
    .filter(Boolean)
    .map(String)
  if (direct.includes(normalized)) return true

  const grouped = [clip.segments, clip.segment_ids, clip.source_segment_ids]
  for (const bucket of grouped) {
    if (!Array.isArray(bucket)) continue
    if (bucket.map(String).includes(normalized)) return true
  }

  return false
}

function getClipDuration(clip, segment) {
  const fromClip = num(clip?.duration_seconds, num(clip?.duration, 0))
  if (fromClip > 0) return fromClip
  const segDuration = Math.max(0, getSegmentEnd(segment) - getSegmentStart(segment))
  return segDuration
}

function toVideoSrc(path, projectId) {
  if (!path || typeof path !== 'string') return null
  if (/^(https?:|data:|blob:)/i.test(path)) return path
  if (path.startsWith('/api/projects/')) return path

  // Accept project-relative absolute paths like "/clips/foo.mp4".
  // Keep blocking non-project API paths and UNC-style paths.
  const candidatePath = path.startsWith('/') ? path.replace(/^\/+/, '') : path
  if (path.startsWith('/') && (path.startsWith('//') || path.startsWith('/api/'))) return null

  const relPath = toProjectRelativePath(candidatePath)
  if (!relPath || !projectId) return null

  return `/api/projects/${projectId}/files/serve?path=${encodeURIComponent(relPath)}`
}

function normalizeComposePreviewHtml(html, renderWidth = 1920, renderHeight = 1080) {
  if (!html || typeof html !== 'string') return ''

  const safeW = Math.max(1, Number(renderWidth) || 1920)
  const safeH = Math.max(1, Number(renderHeight) || 1080)
  const baseStyle = `<style id="lrs-compose-iframe-base">html,body{margin:0;padding:0;width:${safeW}px;height:${safeH}px;background:transparent!important;overflow:hidden;}</style>`
  const hasHtmlDoc = /<html[\s>]/i.test(html)
  const hasTailwindRuntime = /id=["']lrs-tailwind-runtime["']/i.test(html) || /cdn\.tailwindcss\.com/i.test(html)
  const tailwindFallback = hasTailwindRuntime ? '' : '<script src="https://cdn.tailwindcss.com"></script>'

  if (!hasHtmlDoc) {
    return `<!DOCTYPE html><html><head>${tailwindFallback}${baseStyle}</head><body>${html}</body></html>`
  }

  let next = html
  if (/<head[\s>]/i.test(next)) {
    next = next.replace(/<head[^>]*>/i, (match) => `${match}${tailwindFallback}${baseStyle}`)
  } else {
    next = next.replace(/<html[^>]*>/i, (match) => `${match}<head>${tailwindFallback}${baseStyle}</head>`)
  }

  if (!/^\s*<!doctype/i.test(next)) {
    next = `<!DOCTYPE html>${next}`
  }

  return next
}

function toStepLabel(step) {
  if (!step) return 'Pending'
  return STEP_META[step]?.label || String(step).replace(/_/g, ' ')
}

export default function CompositionPanel({
  projectId,
  script = [],
  clipsManifest = [],
  outputDir = '',
}) {
  const {
    activeJob,
    recentJobs,
    logEntries,
    loading,
    error,
    startComposition,
    cancelComposition,
    fetchStatus,
  } = useComposition()
  const {
    presets: overlayPresets,
    selectedPresetId: selectedOverlayPresetId,
    setSelectedPresetId: setSelectedOverlayPresetId,
    fetchPresets: fetchOverlayPresets,
    renderPreview,
  } = usePreset()
  const {
    segments: scriptStateSegments,
    loading: scriptStateLoading,
    fetchState,
    overlayUiConfig,
    compositionConfig,
    fetchOverlayUiConfig,
    updateOverlayUiConfig,
    fetchCompositionConfig,
    updateCompositionConfig,
  } = useScriptState()
  const { showSuccess, showError } = useToast()
  const { activeProject } = useProject()

  const [fadeThreshold, setFadeThreshold] = useState(5.0)
  const [fadeDuration, setFadeDuration] = useState(1.5)
  const [trimStartBuffer, setTrimStartBuffer] = useState(0.5)
  const [trimEndBuffer, setTrimEndBuffer] = useState(0.5)

  // ── Compose scope & gap policy (backed by backend persistence) ────────────
  // Local cache key so selections load instantly before the backend responds.
  const COMPOSE_CONFIG_CACHE_KEY = projectId ? `lrs:compose:config:${projectId}` : null

  const [composeMode, setComposeModeLocal] = useState(() => {
    if (!COMPOSE_CONFIG_CACHE_KEY) return COMPOSE_MODES.ALL
    try { return JSON.parse(localStorage.getItem(COMPOSE_CONFIG_CACHE_KEY) || '{}').mode || COMPOSE_MODES.ALL } catch { return COMPOSE_MODES.ALL }
  })
  const [composeSelectedIds, setComposeSelectedIdsLocal] = useState(() => {
    if (!COMPOSE_CONFIG_CACHE_KEY) return []
    try { return JSON.parse(localStorage.getItem(COMPOSE_CONFIG_CACHE_KEY) || '{}').selected_segment_ids || [] } catch { return [] }
  })
  const [composeRegionStart, setComposeRegionStartLocal] = useState(() => {
    if (!COMPOSE_CONFIG_CACHE_KEY) return null
    try { return JSON.parse(localStorage.getItem(COMPOSE_CONFIG_CACHE_KEY) || '{}').region_start_seconds ?? null } catch { return null }
  })
  const [composeRegionEnd, setComposeRegionEndLocal] = useState(() => {
    if (!COMPOSE_CONFIG_CACHE_KEY) return null
    try { return JSON.parse(localStorage.getItem(COMPOSE_CONFIG_CACHE_KEY) || '{}').region_end_seconds ?? null } catch { return null }
  })
  const [gapPolicy, setGapPolicyLocal] = useState(() => {
    if (!COMPOSE_CONFIG_CACHE_KEY) return GAP_POLICIES.COMPRESS
    try { return JSON.parse(localStorage.getItem(COMPOSE_CONFIG_CACHE_KEY) || '{}').gap_policy || GAP_POLICIES.COMPRESS } catch { return GAP_POLICIES.COMPRESS }
  })

  const [controlsCollapsed, setControlsCollapsed] = useLocalStorage('lrs:compose:controls:collapsed', false)
  const [controlsWidth, setControlsWidth] = useLocalStorage('lrs:compose:controls:width', 360)
  const [logsWidth, setLogsWidth] = useLocalStorage('lrs:compose:logs:width', 400)
  const controlsWidthRef = useRef(controlsWidth)
  const logsWidthRef = useRef(logsWidth)

  const [previewCollapsed, setPreviewCollapsed] = useLocalStorage('lrs:compose:preview:collapsed', false)
  const [timelineCollapsed, setTimelineCollapsed] = useLocalStorage('lrs:compose:timeline:collapsed', false)
  const [selectedCaptureId, setSelectedCaptureId] = useLocalStorage('lrs:compose:selectedCapture', '')
  const [playheadTime, setPlayheadTime] = useState(0)
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useLocalStorage('lrs:compose:preview:speed', 1)
  const [previewRenderMode, setPreviewRenderMode] = useLocalStorage('lrs:compose:preview:renderMode', 'png')
  const [overlayVisible, setOverlayVisible] = useLocalStorage('lrs:compose:preview:overlayVisible', true)
  const [showVideoUnderlay, setShowVideoUnderlay] = useLocalStorage('lrs:compose:preview:videoUnderlay', true)
  const [isTimelineScrubbing, setIsTimelineScrubbing] = useState(false)
  const [overlayPreviewImage, setOverlayPreviewImage] = useState(null)
  const [overlayPreviewHtml, setOverlayPreviewHtml] = useState(null)
  const [overlayPreviewLoading, setOverlayPreviewLoading] = useState(false)
  const [initialComposeLoading, setInitialComposeLoading] = useState(Boolean(projectId))
  const [overlaySelectionHydrated, setOverlaySelectionHydrated] = useState(!projectId)
  const previewVideoRef = useRef(null)
  const pendingVideoSeekRef = useRef(null)
  const keepPlaybackAcrossClipSwitchRef = useRef(false)
  const switchingClipRef = useRef(false)
  const composeInitAppliedRef = useRef(false)

  useEffect(() => { controlsWidthRef.current = controlsWidth }, [controlsWidth])
  useEffect(() => { logsWidthRef.current = logsWidth }, [logsWidth])

  useEffect(() => {
    composeInitAppliedRef.current = false
  }, [projectId])

  useEffect(() => {
    let cancelled = false

    const hydrateComposeData = async () => {
      setInitialComposeLoading(Boolean(projectId))
      setOverlaySelectionHydrated(!projectId)

      await Promise.all([
        fetchStatus(),
        fetchOverlayPresets(),
      ])

      if (!projectId) {
        if (!cancelled) {
          setOverlaySelectionHydrated(true)
          setInitialComposeLoading(false)
        }
        return
      }

      const [, cfg] = await Promise.all([
        // Ensure segment clip paths are hydrated before compose UI renders.
        fetchState(projectId),
        fetchCompositionConfig(projectId),
        fetchOverlayUiConfig(projectId),
      ])

      if (cancelled) return

      if (cfg) {
        setComposeModeLocal(cfg.mode || COMPOSE_MODES.ALL)
        setComposeSelectedIdsLocal(cfg.selected_segment_ids || [])
        setComposeRegionStartLocal(cfg.region_start_seconds ?? null)
        setComposeRegionEndLocal(cfg.region_end_seconds ?? null)
        setGapPolicyLocal(cfg.gap_policy || GAP_POLICIES.COMPRESS)
        if (COMPOSE_CONFIG_CACHE_KEY) {
          try { localStorage.setItem(COMPOSE_CONFIG_CACHE_KEY, JSON.stringify(cfg)) } catch {}
        }
      }

      setOverlaySelectionHydrated(true)
      setInitialComposeLoading(false)
    }

    hydrateComposeData().catch(() => {
      if (!cancelled) {
        setOverlaySelectionHydrated(true)
        setInitialComposeLoading(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [
    COMPOSE_CONFIG_CACHE_KEY,
    fetchCompositionConfig,
    fetchOverlayPresets,
    fetchOverlayUiConfig,
    fetchState,
    fetchStatus,
    projectId,
  ])

  useEffect(() => {
    if (!overlaySelectionHydrated) return
    if (selectedOverlayPresetId) return
    const persistedId = overlayUiConfig?.selected_preset_id || null
    if (!persistedId) return
    if (!overlayPresets.some((p) => p.id === persistedId)) return
    setSelectedOverlayPresetId(persistedId)
  }, [overlayPresets, overlaySelectionHydrated, overlayUiConfig?.selected_preset_id, selectedOverlayPresetId, setSelectedOverlayPresetId])

  useEffect(() => {
    if (!overlaySelectionHydrated || !projectId) return
    const persistedId = overlayUiConfig?.selected_preset_id || null
    const normalizedSelected = selectedOverlayPresetId || null
    if (normalizedSelected && !overlayPresets.some((p) => p.id === normalizedSelected)) return
    if (persistedId === normalizedSelected) return
    updateOverlayUiConfig(projectId, { selected_preset_id: normalizedSelected }).catch(() => {})
  }, [overlayPresets, overlaySelectionHydrated, overlayUiConfig?.selected_preset_id, projectId, selectedOverlayPresetId, updateOverlayUiConfig])

  const startControlsResize = useCallback((event) => {
    event.preventDefault()
    const startX = event.clientX
    const startW = controlsWidthRef.current

    const onMove = (mv) => {
      const next = Math.max(280, Math.min(560, startW - (mv.clientX - startX)))
      setControlsWidth(next)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setControlsWidth])

  const startLogsResize = useCallback((event) => {
    event.preventDefault()
    const startX = event.clientX
    const startW = logsWidthRef.current

    const onMove = (mv) => {
      const next = Math.max(320, Math.min(700, startW + (startX - mv.clientX)))
      setLogsWidth(next)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setLogsWidth])

  // Persist a partial compose config update to local cache + backend.
  const persistComposeConfig = useCallback((updates) => {
    const next = {
      mode: composeMode,
      selected_segment_ids: composeSelectedIds,
      region_start_seconds: composeRegionStart,
      region_end_seconds: composeRegionEnd,
      gap_policy: gapPolicy,
      ...updates,
    }
    if (COMPOSE_CONFIG_CACHE_KEY) {
      try { localStorage.setItem(COMPOSE_CONFIG_CACHE_KEY, JSON.stringify(next)) } catch {}
    }
    if (projectId) updateCompositionConfig(projectId, updates).catch(() => {})
  }, [composeMode, composeSelectedIds, composeRegionStart, composeRegionEnd, gapPolicy, COMPOSE_CONFIG_CACHE_KEY, projectId, updateCompositionConfig])

  const isActive = Boolean(activeJob)
  const currentStep = activeJob?.step || null
  const stepMeta = currentStep ? STEP_META[currentStep] : null
  const progressPct = num(activeJob?.progress_pct, 0)

  const orderedCaptures = useMemo(() => {
    const scriptSegments = (Array.isArray(script) ? script : []).filter((seg) => {
      const type = String(seg?.type || '').toLowerCase()
      return type !== 'transition' && type !== 'bridge'
    })

    const manifest = Array.isArray(clipsManifest) ? clipsManifest : []
    const used = new Set()
    let sequentialCursor = 0

    return scriptSegments.map((segment, index) => {
      const segId = getSegmentId(segment)
      const segState = segId ? scriptStateSegments?.[segId] : null

      let manifestIndex = -1
      if (segId) {
        manifestIndex = manifest.findIndex((clip, clipIndex) => {
          if (used.has(clipIndex)) return false
          return clipMatchesSegmentId(clip, segId)
        })
      }

      // Prefer a matched manifest clip that has a valid path.
      if (manifestIndex >= 0) {
        const candidate = manifest[manifestIndex]
        if (!getClipPath(candidate)) {
          const withPathIndex = manifest.findIndex((clip, clipIndex) => {
            if (used.has(clipIndex) || clipIndex === manifestIndex) return false
            if (!clipMatchesSegmentId(clip, segId)) return false
            return Boolean(getClipPath(clip))
          })
          if (withPathIndex >= 0) manifestIndex = withPathIndex
        }
      }

      if (manifestIndex < 0) {
        for (let i = sequentialCursor; i < manifest.length; i += 1) {
          if (!used.has(i) && getClipPath(manifest[i])) {
            manifestIndex = i
            sequentialCursor = i + 1
            break
          }
        }
      }

      let clip = manifestIndex >= 0 ? manifest[manifestIndex] : null
      if (manifestIndex >= 0) used.add(manifestIndex)

      // Fallback to script-state captured path when manifest is stale/incomplete.
      if (!clip && segState?.clip_path) {
        clip = {
          id: segId,
          segment_id: segId,
          path: segState.clip_path,
          duration_seconds: num(segState.duration_seconds, 0),
          section: segState.section || segment?.section || 'race',
        }
      }

      const clipPath = getClipPath(clip)
      const fileName = clipPath ? clipPath.split(/[/\\]/).pop() : `missing-${segId || index + 1}`
      const clipDuration = getClipDuration(clip, segment)

      return {
        index,
        rowId: String(segId || `seg-${index + 1}`),
        segment,
        segmentId: segId || `seg-${index + 1}`,
        section: segment?.section || 'race',
        eventType: segment?.event_type || segment?.type || 'segment',
        segmentStart: getSegmentStart(segment),
        segmentEnd: getSegmentEnd(segment),
        segmentDuration: Math.max(0, getSegmentEnd(segment) - getSegmentStart(segment)),
        clip,
        clipPath,
        clipDuration,
        fileName,
        missing: !clipPath,
      }
    })
  }, [clipsManifest, script, scriptStateSegments])

  const totalSegments = useMemo(() => {
    const raw = num(activeJob?.total_segments, 0)
    if (raw > 0) return raw
    return orderedCaptures.length
  }, [activeJob?.total_segments, orderedCaptures.length])

  const activeSegmentIndex = useMemo(() => {
    const parsed = Number(activeJob?.segment_index)
    if (!Number.isFinite(parsed) || parsed < 0) return -1
    return Math.floor(parsed)
  }, [activeJob?.segment_index])

  const activeCaptureRowId = useMemo(() => {
    if (activeSegmentIndex < 0) return null
    if (!orderedCaptures.length) return null
    const safeIndex = Math.max(0, Math.min(orderedCaptures.length - 1, activeSegmentIndex))
    return orderedCaptures[safeIndex]?.rowId || null
  }, [activeSegmentIndex, orderedCaptures])

  const composeSidebarVisible = true

  const composeManifest = useMemo(() => {
    return orderedCaptures
      .filter((row) => Boolean(row.clipPath))
      .map((row) => {
        const source = row.clip && typeof row.clip === 'object' ? row.clip : {}
        return {
          ...source,
          id: source.id || row.segmentId,
          segment_id: source.segment_id || row.segmentId,
          path: getClipPath(source) || row.clipPath,
          section: source.section || row.section,
          start_time_seconds: source.start_time_seconds ?? row.segmentStart,
          end_time_seconds: source.end_time_seconds ?? row.segmentEnd,
          duration_seconds: source.duration_seconds ?? row.clipDuration,
        }
      })
  }, [orderedCaptures])

  useEffect(() => {
    if (!orderedCaptures.length) return
    const selectedRow = orderedCaptures.find((row) => row.rowId === selectedCaptureId)
    if (selectedRow?.clipPath) return
    const firstPlayable = orderedCaptures.find((row) => row.clipPath) || orderedCaptures[0]
    setSelectedCaptureId(firstPlayable.rowId)
  }, [orderedCaptures, selectedCaptureId, setSelectedCaptureId])

  const selectedCapture = useMemo(
    () => orderedCaptures.find((row) => row.rowId === selectedCaptureId) || orderedCaptures[0] || null,
    [orderedCaptures, selectedCaptureId],
  )

  useEffect(() => {
    if (!isActive || !activeCaptureRowId) return
    if (selectedCaptureId === activeCaptureRowId) return
    setSelectedCaptureId(activeCaptureRowId)
  }, [activeCaptureRowId, isActive, selectedCaptureId, setSelectedCaptureId])

  const selectedVideoSrc = useMemo(
    () => toVideoSrc(selectedCapture?.clipPath, projectId),
    [selectedCapture?.clipPath, projectId],
  )

  const effectiveOverlayPresetId = useMemo(
    () => selectedOverlayPresetId || getSegmentOverlayDesignId(selectedCapture?.segment, null),
    [selectedCapture?.segment, selectedOverlayPresetId],
  )

  const compositionEntries = useMemo(() => {
    if (!orderedCaptures.length) return []

    const result = []
    let cursor = 0

    for (let i = 0; i < orderedCaptures.length; i += 1) {
      const row = orderedCaptures[i]

      const baseDuration = Math.max(0.1, num(row.clipDuration, num(row.segmentDuration, 0.1)))
      const effectiveDuration = Math.max(0.1, baseDuration - num(trimStartBuffer, 0) - num(trimEndBuffer, 0))
      const start = cursor
      const end = start + effectiveDuration

      result.push({
        type: 'clip',
        rowId: row.rowId,
        section: row.section,
        eventType: row.eventType,
        label: row.fileName,
        start,
        end,
        duration: effectiveDuration,
        missing: row.missing,
      })

      cursor = end
    }

    return result
  }, [orderedCaptures, trimStartBuffer, trimEndBuffer])

  const totalTimelineDuration = useMemo(() => {
    if (!compositionEntries.length) return 0
    return compositionEntries[compositionEntries.length - 1].end
  }, [compositionEntries])

  const clipEntries = useMemo(
    () => compositionEntries.filter((entry) => entry.type === 'clip'),
    [compositionEntries],
  )
  const playableCaptureCount = useMemo(
    () => orderedCaptures.filter((row) => Boolean(row.clipPath)).length,
    [orderedCaptures],
  )

  const clipEntryByRowId = useMemo(() => {
    const map = new Map()
    for (const entry of clipEntries) map.set(entry.rowId, entry)
    return map
  }, [clipEntries])

  const resolvePlaybackTarget = useCallback((timelineTime) => {
    if (!clipEntries.length) return null
    const clamped = Math.max(0, Math.min(num(totalTimelineDuration, 0), num(timelineTime, 0)))

    let targetEntry = clipEntries.find((entry) => clamped >= entry.start && clamped <= entry.end)
    if (!targetEntry) {
      targetEntry = clipEntries.find((entry) => entry.start >= clamped) || clipEntries[clipEntries.length - 1]
    }
    if (!targetEntry) return null

    const row = orderedCaptures.find((capture) => capture.rowId === targetEntry.rowId)
    if (!row) return null

    const baseDuration = Math.max(0.1, num(row.clipDuration, 0.1))
    const trimStart = Math.max(0, num(trimStartBuffer, 0))
    const trimEnd = Math.max(0, num(trimEndBuffer, 0))
    const maxPlayable = Math.max(0.1, baseDuration - trimStart - trimEnd)
    const localTime = Math.max(0, Math.min(targetEntry.duration, clamped - targetEntry.start))
    const videoTime = Math.max(trimStart, Math.min(baseDuration - trimEnd, trimStart + Math.min(localTime, maxPlayable)))

    return { row, entry: targetEntry, timelineTime: clamped, videoTime, localTime }
  }, [clipEntries, orderedCaptures, totalTimelineDuration, trimEndBuffer, trimStartBuffer])

  const seekToTimelineTime = useCallback((timelineTime, options = {}) => {
    const { scrub = false } = options
    const target = resolvePlaybackTarget(timelineTime)
    if (!target) return

    setPlayheadTime(target.timelineTime)
    if (target.row.rowId !== selectedCaptureId) setSelectedCaptureId(target.row.rowId)

    const video = previewVideoRef.current
    const sameClip = video && selectedCapture?.rowId === target.row.rowId

    if (sameClip && Number.isFinite(target.videoTime)) {
      // Same clip seek can be applied immediately.
      if (scrub) {
        video.pause()
        setIsPreviewPlaying(false)
      }
      try { video.currentTime = target.videoTime } catch {}
      pendingVideoSeekRef.current = null
    } else {
      // Cross-clip seek must wait for next media element metadata.
      pendingVideoSeekRef.current = { rowId: target.row.rowId, time: target.videoTime }
    }
  }, [resolvePlaybackTarget, selectedCapture?.rowId, selectedCaptureId, setSelectedCaptureId])

  useEffect(() => {
    const pending = pendingVideoSeekRef.current
    const video = previewVideoRef.current
    if (!pending || !video || !selectedCapture || pending.rowId !== selectedCapture.rowId) return
    if (video.readyState >= 1) {
      try { video.currentTime = pending.time } catch {}
      pendingVideoSeekRef.current = null
    }
  }, [selectedCapture])

  useEffect(() => {
    if (!clipEntries.length) {
      setPlayheadTime(0)
      return
    }
    setPlayheadTime((prev) => Math.max(0, Math.min(totalTimelineDuration, prev)))
  }, [clipEntries.length, totalTimelineDuration])

  const activeClipIndex = useMemo(() => {
    if (!clipEntries.length) return -1
    const containing = clipEntries.findIndex((entry) => playheadTime >= entry.start && playheadTime <= entry.end)
    if (containing >= 0) return containing
    if (selectedCapture) {
      return clipEntries.findIndex((entry) => entry.rowId === selectedCapture.rowId)
    }
    return 0
  }, [clipEntries, playheadTime, selectedCapture])

  const handleTransportPrev = useCallback(() => {
    if (!clipEntries.length) return
    const current = activeClipIndex >= 0 ? activeClipIndex : 0
    const nextIndex = Math.max(0, current - 1)
    seekToTimelineTime(clipEntries[nextIndex].start)
  }, [activeClipIndex, clipEntries, seekToTimelineTime])

  const handleTransportNext = useCallback(() => {
    if (!clipEntries.length) return
    const current = activeClipIndex >= 0 ? activeClipIndex : 0
    const nextIndex = Math.min(clipEntries.length - 1, current + 1)
    seekToTimelineTime(clipEntries[nextIndex].start)
  }, [activeClipIndex, clipEntries, seekToTimelineTime])

  const seekToNextClipBoundary = useCallback(() => {
    if (!selectedCapture || !clipEntries.length) return false

    const currentIndex = clipEntries.findIndex((entry) => entry.rowId === selectedCapture.rowId)
    if (currentIndex < 0 || currentIndex >= clipEntries.length - 1) {
      keepPlaybackAcrossClipSwitchRef.current = false
      switchingClipRef.current = false
      setIsPreviewPlaying(false)
      setPlayheadTime(totalTimelineDuration)
      return false
    }

    const nextEntry = clipEntries[currentIndex + 1]
    keepPlaybackAcrossClipSwitchRef.current = true
    switchingClipRef.current = true
    seekToTimelineTime(nextEntry.start + 0.001)
    return true
  }, [clipEntries, selectedCapture, seekToTimelineTime, totalTimelineDuration])

  const handleTransportPlayPause = useCallback(() => {
    const video = previewVideoRef.current
    if (!video) return
    if (video.paused) {
      keepPlaybackAcrossClipSwitchRef.current = true
      switchingClipRef.current = false
      video.play().catch(() => {
        keepPlaybackAcrossClipSwitchRef.current = false
      })
    } else {
      keepPlaybackAcrossClipSwitchRef.current = false
      switchingClipRef.current = false
      video.pause()
    }
  }, [])

  const handlePlaybackSpeedChange = useCallback((speed) => {
    setPlaybackSpeed(speed)
    const video = previewVideoRef.current
    if (video) video.playbackRate = speed
  }, [setPlaybackSpeed])

  const nudgeTimeline = useCallback((deltaSeconds) => {
    const next = Math.max(0, Math.min(totalTimelineDuration, playheadTime + deltaSeconds))
    seekToTimelineTime(next)
  }, [playheadTime, seekToTimelineTime, totalTimelineDuration])

  useEffect(() => {
    if (composeInitAppliedRef.current) return
    if (!orderedCaptures.length || !clipEntries.length) return

    const selectedRow = orderedCaptures.find((row) => row.rowId === selectedCaptureId)
    const targetRow = (selectedRow && selectedRow.clipPath)
      ? selectedRow
      : (orderedCaptures.find((row) => row.clipPath) || orderedCaptures[0])
    if (!targetRow) return

    const targetEntry = clipEntryByRowId.get(targetRow.rowId)
    if (!targetEntry) return

    composeInitAppliedRef.current = true

    if (selectedCaptureId !== targetRow.rowId) {
      setSelectedCaptureId(targetRow.rowId)
    }

    const targetOverlayPresetId = getSegmentOverlayDesignId(targetRow.segment, null)
    const targetOverlayExists = targetOverlayPresetId && overlayPresets.some((preset) => preset.id === targetOverlayPresetId)
    if (targetOverlayExists && selectedOverlayPresetId !== targetOverlayPresetId) {
      setSelectedOverlayPresetId(targetOverlayPresetId)
    }

    seekToTimelineTime(targetEntry.start + 0.001)
  }, [
    clipEntries.length,
    clipEntryByRowId,
    orderedCaptures,
    overlayPresets,
    seekToTimelineTime,
    selectedCaptureId,
    selectedOverlayPresetId,
    setSelectedCaptureId,
    setSelectedOverlayPresetId,
  ])

  const sectionCounts = useMemo(() => {
    const counts = { intro: 0, qualifying_results: 0, race: 0, race_results: 0 }
    for (const row of orderedCaptures) {
      const section = row.section || 'race'
      counts[section] = (counts[section] || 0) + 1
    }
    return counts
  }, [orderedCaptures])

  const capturesTabContent = (
    <CapturesTab
      rows={orderedCaptures}
      selectedId={selectedCapture?.rowId || null}
      activeRowId={activeCaptureRowId}
      activeStep={currentStep}
      isComposing={isActive}
      onSelect={setSelectedCaptureId}
      inspectorVideoSrc={selectedVideoSrc}
      inspectorFileName={selectedCapture?.fileName || ''}
    />
  )

  const sidebarTabs = useMemo(() => ([
    {
      id: 'captures',
      label: 'Captures',
      icon: HardDrive,
      count: orderedCaptures.length,
      content: capturesTabContent,
    },
    {
      id: 'files',
      label: 'Files',
      icon: FolderOpen,
      content: <ProjectFileBrowser projectId={projectId} />,
    },
  ]), [capturesTabContent, orderedCaptures.length, projectId])

  const handleStart = useCallback(async () => {
    if (!composeManifest.length) {
      showError('No captured clips - run capture first')
      return
    }
    if (!script.length) {
      showError('No script - complete editing first')
      return
    }

    const result = await startComposition({
      projectId,
      script,
      clipsManifest: composeManifest,
      overlayConfig: selectedOverlayPresetId
        ? { template_id: selectedOverlayPresetId, per_section: {} }
        : null,
      transitionConfig: {
        fade_threshold: fadeThreshold,
        fade_duration: fadeDuration,
      },
      trimConfig: {
        trim_start_buffer: trimStartBuffer,
        trim_end_buffer: trimEndBuffer,
      },
      outputDir,
      compositionSelection: {
        mode: composeMode,
        selected_segment_ids: composeSelectedIds,
        region_start_seconds: composeRegionStart,
        region_end_seconds: composeRegionEnd,
      },
      gapPolicy,
    })

    if (result.success) {
      showSuccess('Composition started')
    } else {
      showError(result.error || 'Failed to start composition')
    }
  }, [
    composeManifest,
    composeMode,
    composeSelectedIds,
    composeRegionStart,
    composeRegionEnd,
    fadeDuration,
    fadeThreshold,
    gapPolicy,
    outputDir,
    projectId,
    script,
    selectedOverlayPresetId,
    showError,
    showSuccess,
    startComposition,
    trimEndBuffer,
    trimStartBuffer,
  ])

  const handleCancel = useCallback(async () => {
    if (!activeJob?.job_id) return
    const result = await cancelComposition(activeJob.job_id)
    if (result.success) showSuccess('Composition cancelled')
    else showError(result.error || 'Failed to cancel composition')
  }, [activeJob?.job_id, cancelComposition, showError, showSuccess])

  const primaryAction = isActive
    ? {
      label: 'Cancel',
      icon: Square,
      onClick: handleCancel,
      disabled: loading,
      className: 'bg-danger/12 text-danger border-danger/30 hover:bg-danger/18',
    }
    : {
      label: 'Start Composition',
      icon: Play,
      onClick: handleStart,
      disabled: loading || !composeManifest.length || !script.length,
      className: 'bg-accent/12 text-accent border-accent/30 hover:bg-accent/18',
    }

  const PrimaryActionIcon = primaryAction.icon
  const statusBadge = isActive
    ? { label: 'Composing', className: 'text-accent bg-accent/8 border-accent/35' }
    : error
      ? { label: 'Error', className: 'text-danger bg-danger/8 border-danger/35' }
      : { label: 'Ready', className: 'text-success bg-success/8 border-success/35' }

  const controlsContent = (
    <div className="h-full overflow-y-auto bg-bg-secondary space-y-0">
      <div className="border-t border-border-subtle px-2 py-2">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center justify-center rounded-md border px-3 py-2.5 text-sm font-semibold whitespace-nowrap ${statusBadge.className}`}>
            {statusBadge.label}
          </span>
          <button
            onClick={primaryAction.onClick}
            disabled={primaryAction.disabled}
            className={`flex-1 inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${primaryAction.className}`}
          >
            <PrimaryActionIcon className="w-4 h-4" />
            {primaryAction.label}
          </button>
        </div>
      </div>

      <CollapsibleSection icon={BarChart2} label="Script Summary" storageKey="lrs:compose:controls:summary" defaultOpen>
        <div className="space-y-2 mt-2">
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(sectionCounts).map(([section, count]) => (
              <div key={section} className="bg-bg-primary border border-border rounded px-2 py-1.5">
                <div className="text-sm font-mono text-text-primary">{count}</div>
                <div className="text-xxs text-text-tertiary uppercase tracking-wider">{(SECTION_META[section]?.label || section)}</div>
              </div>
            ))}
          </div>
          <p className="text-xxs text-text-tertiary">
            {orderedCaptures.length} scripted items · {playableCaptureCount} captured files
          </p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection icon={Crosshair} label="Compose Scope" storageKey="lrs:compose:controls:scope" defaultOpen>
        <div className="space-y-3 mt-2">
          {/* Mode selector */}
          <div>
            <label className="text-xxs text-text-tertiary uppercase tracking-wider block mb-1">Scope</label>
            <select
              value={composeMode}
              onChange={(e) => {
                setComposeModeLocal(e.target.value)
                persistComposeConfig({ mode: e.target.value })
              }}
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value={COMPOSE_MODES.ALL}>All captures</option>
              <option value={COMPOSE_MODES.CAPTURED}>Completed / Captured only</option>
              <option value={COMPOSE_MODES.SPECIFIC}>Specific captures</option>
              <option value={COMPOSE_MODES.REGION}>Captures in timeline region</option>
            </select>
          </div>

          {/* Specific captures multi-select */}
          {composeMode === COMPOSE_MODES.SPECIFIC && (
            <div>
              <label className="text-xxs text-text-tertiary uppercase tracking-wider block mb-1">
                Selected captures ({composeSelectedIds.length} of {orderedCaptures.length})
              </label>
              <div className="max-h-40 overflow-y-auto space-y-0.5 border border-border rounded-md bg-bg-primary p-1">
                {orderedCaptures.map((row) => (
                  <label
                    key={row.rowId}
                    className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-bg-secondary text-xs text-text-primary"
                  >
                    <input
                      type="checkbox"
                      checked={composeSelectedIds.includes(row.segmentId)}
                      onChange={(e) => {
                        const next = e.target.checked
                          ? [...composeSelectedIds, row.segmentId]
                          : composeSelectedIds.filter((id) => id !== row.segmentId)
                        setComposeSelectedIdsLocal(next)
                        persistComposeConfig({ selected_segment_ids: next })
                      }}
                      className="accent-accent"
                    />
                    <span className="truncate flex-1">{row.fileName}</span>
                    {row.missing && <AlertTriangle className="w-3 h-3 text-warning shrink-0" />}
                  </label>
                ))}
                {orderedCaptures.length === 0 && (
                  <p className="text-xxs text-text-tertiary px-2 py-1">No captures in script</p>
                )}
              </div>
            </div>
          )}

          {/* Timeline region inputs */}
          {composeMode === COMPOSE_MODES.REGION && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xxs text-text-tertiary block mb-1">Region start (s)</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={composeRegionStart ?? ''}
                  placeholder="0"
                  onChange={(e) => {
                    const v = e.target.value === '' ? null : Number(e.target.value)
                    setComposeRegionStartLocal(v)
                    persistComposeConfig({ region_start_seconds: v })
                  }}
                  className="w-full bg-bg-primary border border-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
              <div>
                <label className="text-xxs text-text-tertiary block mb-1">Region end (s)</label>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={composeRegionEnd ?? ''}
                  placeholder="end"
                  onChange={(e) => {
                    const v = e.target.value === '' ? null : Number(e.target.value)
                    setComposeRegionEndLocal(v)
                    persistComposeConfig({ region_end_seconds: v })
                  }}
                  className="w-full bg-bg-primary border border-border rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                />
              </div>
            </div>
          )}

          {/* Gap policy */}
          <div>
            <label className="text-xxs text-text-tertiary uppercase tracking-wider block mb-1">Gap Policy</label>
            <select
              value={gapPolicy}
              onChange={(e) => {
                setGapPolicyLocal(e.target.value)
                persistComposeConfig({ gap_policy: e.target.value })
              }}
              className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value={GAP_POLICIES.COMPRESS}>Compress gaps (remove dead time)</option>
              <option value={GAP_POLICIES.FILL_BLACK}>Fill gaps with black</option>
              <option value={GAP_POLICIES.FADE}>Fade bridge (insert fade on large gaps)</option>
            </select>
            <p className="text-xxs text-text-tertiary mt-1">
              {gapPolicy === GAP_POLICIES.COMPRESS && 'Dead time between clips is removed — clips stitch back to back.'}
              {gapPolicy === GAP_POLICIES.FILL_BLACK && 'A silent black clip matching each gap duration is inserted.'}
              {gapPolicy === GAP_POLICIES.FADE && 'A fade-to-black transition is inserted when gap exceeds the threshold below.'}
            </p>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection icon={Film} label="Transition Rules" storageKey="lrs:compose:controls:transitions" defaultOpen>
        <div className="space-y-3 mt-2">
          <ConfigSlider
            label="Fade Threshold"
            description="Insert fade when segment gap exceeds this threshold"
            value={fadeThreshold}
            onChange={setFadeThreshold}
            min={1}
            max={30}
            step={0.5}
            unit="s"
          />
          <ConfigSlider
            label="Fade Duration"
            description="Length of inserted fade clip"
            value={fadeDuration}
            onChange={setFadeDuration}
            min={0.5}
            max={5}
            step={0.25}
            unit="s"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection icon={Scissors} label="Clip Trimming" storageKey="lrs:compose:controls:trimming" defaultOpen>
        <div className="space-y-3 mt-2">
          <ConfigSlider
            label="Trim Start"
            description="Seconds removed from beginning"
            value={trimStartBuffer}
            onChange={setTrimStartBuffer}
            min={0}
            max={5}
            step={0.1}
            unit="s"
          />
          <ConfigSlider
            label="Trim End"
            description="Seconds removed from end"
            value={trimEndBuffer}
            onChange={setTrimEndBuffer}
            min={0}
            max={5}
            step={0.1}
            unit="s"
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection icon={Palette} label="Overlay Template" storageKey="lrs:compose:controls:overlay" defaultOpen>
        <div className="mt-2 space-y-1.5">
          <select
            value={selectedOverlayPresetId || ''}
            onChange={(e) => setSelectedOverlayPresetId(e.target.value || null)}
            className="w-full bg-bg-primary border border-border rounded-md px-3 py-2 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">None (skip overlays)</option>
            {overlayPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>{preset.name}</option>
            ))}
          </select>
          <p className="text-xxs text-text-tertiary">Shared with Overlay step. Changing either location updates the active design.</p>
        </div>
      </CollapsibleSection>

      <CollapsibleSection icon={Film} label="Preview Layers" storageKey="lrs:compose:controls:previewLayers" defaultOpen>
        <div className="mt-2 flex items-center gap-1.5">
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
            <button
              type="button"
              onClick={() => setPreviewRenderMode('png')}
              className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${
                previewRenderMode === 'png'
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'text-text-tertiary hover:text-text-primary'
              }`}
            >
              PNG
            </button>
            <button
              type="button"
              onClick={() => setPreviewRenderMode('html')}
              className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${
                previewRenderMode === 'html'
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'text-text-tertiary hover:text-text-primary'
              }`}
            >
              HTML
            </button>
          </div>

          <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
            <button
              type="button"
              onClick={() => setShowVideoUnderlay((v) => !v)}
              className={`rounded p-1 transition-colors ${
                showVideoUnderlay
                  ? 'bg-accent/15 text-accent hover:bg-accent/20'
                  : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
              }`}
              title={showVideoUnderlay ? 'Hide video underlay' : 'Show video underlay'}
            >
              <Monitor className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setOverlayVisible((v) => !v)}
              className={`rounded p-1 transition-colors ${
                overlayVisible
                  ? 'bg-accent/15 text-accent hover:bg-accent/20'
                  : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'
              }`}
              title={overlayVisible ? 'Hide overlay' : 'Show overlay'}
            >
              {overlayVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {recentJobs.length > 0 && (
        <CollapsibleSection icon={CheckCircle2} label="Recent Compositions" storageKey="lrs:compose:controls:recent" defaultOpen={false}>
          <div className="mt-2 space-y-1.5">
            {recentJobs.slice(0, 5).map((job) => (
              <div
                key={job.job_id}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded border ${job.state === 'completed' ? 'bg-success/6 border-success/25' : 'bg-danger/6 border-danger/25'}`}
              >
                {job.state === 'completed'
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" />
                  : <XCircle className="w-3.5 h-3.5 text-danger shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="text-xxs text-text-secondary truncate">{job.clip_count || '?'} clips · {job.preset_id || 'custom'}</div>
                  {job.elapsed_seconds > 0 && (
                    <div className="text-[10px] text-text-tertiary">{formatTime(job.elapsed_seconds)}</div>
                  )}
                  {job.error && (
                    <div className="text-[10px] text-danger truncate">{job.error}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {error && (
        <div className="mx-2 my-2 flex items-start gap-2 px-2.5 py-2 bg-danger/5 border border-danger/30 rounded-md">
          <XCircle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-danger font-medium">Error</p>
            <p className="text-xxs text-danger/80 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {orderedCaptures.length > 0 && playableCaptureCount === 0 && (
        <div className="mx-2 mb-2 flex items-start gap-2 px-2.5 py-2 bg-warning/8 border border-warning/30 rounded-md">
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
          <p className="text-xxs text-warning">No playable capture files were resolved for this script. Refresh captures or reopen the project to sync clip paths.</p>
        </div>
      )}
    </div>
  )

  const selectedEntry = selectedCapture ? clipEntryByRowId.get(selectedCapture.rowId) || null : null

  useEffect(() => {
    if (!selectedCapture || !selectedEntry || !effectiveOverlayPresetId || !overlayVisible) {
      setOverlayPreviewImage(null)
      setOverlayPreviewHtml(null)
      setOverlayPreviewLoading(false)
      return undefined
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      setOverlayPreviewLoading(true)

      const localOffset = Math.max(0, Math.min(selectedEntry.duration, playheadTime - selectedEntry.start))
      const frameData = {
        session_time: num(selectedCapture.segmentStart, 0) + localOffset,
        event_type: selectedCapture.eventType,
        section: selectedCapture.section,
        overlay_section_elapsed_seconds: localOffset,
        overlay_section_duration_seconds: Math.max(0.1, num(selectedEntry.duration, 0.1)),
      }

      const useHtmlMode = previewRenderMode === 'html'
      const result = await renderPreview(effectiveOverlayPresetId, selectedCapture.section || 'race', {
        projectId,
        frameData,
        includeRenderedHtml: true,
        // Match Overlay Step behavior so PNG snapshots also originate from
        // the HTML design path (with tailwind runtime injection).
        preferHtmlContent: true,
        renderScreenshot: !useHtmlMode,
      })

      if (cancelled) return
      if (useHtmlMode && result?.rendered_html) {
        const safeHtml = normalizeComposePreviewHtml(result.rendered_html, 1920, 1080)
        setOverlayPreviewHtml(safeHtml)
        setOverlayPreviewImage(null)
      } else if (result?.png_base64) {
        setOverlayPreviewImage(`data:image/png;base64,${result.png_base64}`)
        setOverlayPreviewHtml(null)
      } else {
        setOverlayPreviewImage(null)
        setOverlayPreviewHtml(null)
      }
      setOverlayPreviewLoading(false)
    }, 140)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [effectiveOverlayPresetId, overlayVisible, playheadTime, previewRenderMode, renderPreview, selectedCapture, selectedEntry])

  useEffect(() => {
    const video = previewVideoRef.current
    if (video) video.playbackRate = playbackSpeed
  }, [playbackSpeed, selectedCapture?.rowId])

  if (initialComposeLoading || (scriptStateLoading && !orderedCaptures.length)) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 animate-fade-in">
        <Loader2 className="w-5 h-5 animate-spin text-text-disabled" />
        <p className="text-xs text-text-tertiary">Loading compose captures…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 w-full h-full overflow-hidden min-h-0">
      <div className="flex-1 min-h-0 bg-bg-primary overflow-hidden">
        <div className="w-full h-full min-h-0 max-w-[2200px] mx-auto">
          <div className="w-full h-full min-h-0 flex overflow-hidden">
            <ResizableSidebar
              storageKey="lrs:compose:workspace:sidebar"
              defaultWidth={420}
              defaultTab="captures"
              tabs={sidebarTabs}
            />

            {controlsCollapsed && (
              <CollapsibleControlsHeader
                collapsed
                icon={Settings2}
                title="Composition Controls"
                onExpand={() => setControlsCollapsed(false)}
                expandTitle="Expand Composition Controls"
              />
            )}

            {!controlsCollapsed && (
              <div
                className="shrink-0 border-r border-border bg-bg-secondary flex flex-col min-h-0"
                style={{ width: controlsWidth }}
              >
                <CollapsibleControlsHeader
                  collapsed={false}
                  icon={Settings2}
                  title="Composition Controls"
                  onCollapse={() => setControlsCollapsed(true)}
                />
                <div className="flex-1 min-h-0 overflow-hidden">
                  {controlsContent}
                </div>
              </div>
            )}

            {!controlsCollapsed && (
              <div
                className="shrink-0 cursor-col-resize group/divider relative"
                style={{ width: 1, marginLeft: -1 }}
                onMouseDown={startControlsResize}
              >
                <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
              </div>
            )}

            <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
              <ResizableRowPane
                storageKey="lrs:compose:preview:split"
                defaultBottomHeight={220}
                top={(
                  <div className="flex flex-col h-full min-h-0">
                    <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                      <CollapsiblePanelHeader
                        open
                        icon={Film}
                        title="Composition Preview"
                        className="flex-1"
                        right={(
                          <div className="flex items-center gap-1.5 pr-2">
                            <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
                              <button
                                type="button"
                                onClick={() => setPreviewRenderMode('png')}
                                className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${previewRenderMode === 'png' ? 'bg-accent/20 text-accent border border-accent/40' : 'text-text-tertiary hover:text-text-primary'}`}
                                title="Render visual PNG overlay"
                              >
                                PNG
                              </button>
                              <button
                                type="button"
                                onClick={() => setPreviewRenderMode('html')}
                                className={`px-2 py-0.5 rounded text-xxs font-medium transition-colors ${previewRenderMode === 'html' ? 'bg-accent/20 text-accent border border-accent/40' : 'text-text-tertiary hover:text-text-primary'}`}
                                title="Render native HTML/CSS overlay"
                              >
                                HTML
                              </button>
                            </div>
                            <div className="flex items-center gap-0.5 rounded-md border border-border bg-bg-primary/50 px-1 py-0.5">
                              <button
                                type="button"
                                onClick={() => setShowVideoUnderlay((v) => !v)}
                                className={`rounded p-1 transition-colors ${showVideoUnderlay ? 'bg-accent/15 text-accent hover:bg-accent/20' : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'}`}
                                title={showVideoUnderlay ? 'Hide video underlay' : 'Show video underlay'}
                                aria-label={showVideoUnderlay ? 'Hide video underlay' : 'Show video underlay'}
                              >
                                <Monitor className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setOverlayVisible((v) => !v)}
                                className={`rounded p-1 transition-colors ${overlayVisible ? 'bg-accent/15 text-accent hover:bg-accent/20' : 'text-text-tertiary hover:bg-bg-secondary hover:text-text-primary'}`}
                                title={overlayVisible ? 'Hide overlay' : 'Show overlay'}
                                aria-label={overlayVisible ? 'Hide overlay' : 'Show overlay'}
                              >
                                {overlayVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                        )}
                      />
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden p-3 flex items-center justify-center bg-black/30">
                      {selectedVideoSrc ? (
                        <div className="relative max-h-full w-full aspect-video">
                          {activeProject && !activeProject.subsession_id && (
                            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-900/70 border border-amber-600/40 text-amber-300 text-[10px] pointer-events-none">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              No iRacing session linked — showing sample data
                            </div>
                          )}
                          {showVideoUnderlay ? (
                            <video
                              ref={previewVideoRef}
                              key={selectedCapture?.rowId || 'compose-preview'}
                              src={selectedVideoSrc}
                              controls={false}
                              preload="metadata"
                              onPlay={() => {
                                switchingClipRef.current = false
                                keepPlaybackAcrossClipSwitchRef.current = true
                                setIsPreviewPlaying(true)
                              }}
                              onPause={() => {
                                if (switchingClipRef.current) return
                                keepPlaybackAcrossClipSwitchRef.current = false
                                setIsPreviewPlaying(false)
                              }}
                              onEnded={() => {
                                if (!seekToNextClipBoundary()) {
                                  keepPlaybackAcrossClipSwitchRef.current = false
                                  setIsPreviewPlaying(false)
                                }
                              }}
                              onLoadedMetadata={() => {
                                const pending = pendingVideoSeekRef.current
                                const video = previewVideoRef.current
                                if (!video) return
                                video.playbackRate = playbackSpeed
                                if (pending) {
                                  try { video.currentTime = pending.time } catch {}
                                  pendingVideoSeekRef.current = null
                                }
                                if (keepPlaybackAcrossClipSwitchRef.current) {
                                  video.play().catch(() => {
                                    keepPlaybackAcrossClipSwitchRef.current = false
                                    setIsPreviewPlaying(false)
                                  })
                                }
                                switchingClipRef.current = false
                              }}
                              onTimeUpdate={() => {
                                if (isTimelineScrubbing || pendingVideoSeekRef.current) return
                                const video = previewVideoRef.current
                                if (!video || !selectedEntry || switchingClipRef.current) return
                                const clipDuration = Math.max(0.1, num(selectedCapture?.clipDuration, selectedEntry.duration))
                                const clipPlayableEnd = Math.max(0, clipDuration - num(trimEndBuffer, 0))
                                const local = Math.max(0, Math.min(selectedEntry.duration, num(video.currentTime, 0) - num(trimStartBuffer, 0)))
                                setPlayheadTime(Math.max(0, Math.min(totalTimelineDuration, selectedEntry.start + local)))
                                if (keepPlaybackAcrossClipSwitchRef.current && clipPlayableEnd > 0 && num(video.currentTime, 0) >= (clipPlayableEnd - 0.02)) {
                                  seekToNextClipBoundary()
                                }
                              }}
                              disablePictureInPicture
                              playsInline
                              controlsList="noremoteplayback"
                              draggable={false}
                              className="max-h-full max-w-full w-full rounded-md border border-border bg-black"
                            />
                          ) : (
                            <div className="max-h-full max-w-full w-full h-full rounded-md border border-border bg-black" />
                          )}

                          {overlayVisible && overlayPreviewImage && (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                              <img
                                src={overlayPreviewImage}
                                alt="Overlay preview"
                                className="max-h-full max-w-full w-full object-contain"
                              />
                            </div>
                          )}

                          {overlayVisible && previewRenderMode === 'html' && overlayPreviewHtml && (
                            <div className="pointer-events-none absolute inset-0">
                              <IsolatedHtmlPreview
                                html={overlayPreviewHtml}
                                className="w-full h-full border-0 bg-transparent"
                              />
                            </div>
                          )}

                          {overlayPreviewLoading && (
                            <div className="pointer-events-none absolute left-1/2 bottom-4 -translate-x-1/2">
                              <div className="px-3 py-1.5 rounded bg-black/70 border border-white/20 text-white/85 text-xxs flex items-center gap-1.5">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Rendering overlay...
                              </div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="w-full h-full border border-border rounded-md bg-bg-secondary flex items-center justify-center px-6 text-center">
                          <div>
                            <p className="text-sm text-text-secondary font-medium">No playable capture selected</p>
                            <p className="text-xs text-text-tertiary mt-1">Pick a captured file from the Captures tab to preview it here.</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                bottom={(
                  <div className="h-full min-h-0 overflow-hidden flex flex-col">
                    <div className="flex items-center border-b border-border bg-bg-secondary shrink-0">
                      <CollapsiblePanelHeader
                        open={!timelineCollapsed}
                        onToggle={() => setTimelineCollapsed((prev) => !prev)}
                        icon={Clapperboard}
                        title="Composition Timeline"
                        subtitle={`${compositionEntries.filter((entry) => entry.type === 'clip').length} clips · ${compositionEntries.filter((entry) => entry.type === 'fade').length} fades`}
                        className="flex-1"
                      />
                    </div>

                    {!timelineCollapsed && (
                      <div className="flex-1 min-h-0 overflow-hidden flex flex-col bg-bg-primary">
                        <PlaybackControls
                          onPrev={handleTransportPrev}
                          prevDisabled={activeClipIndex <= 0}
                          prevTitle="Previous clip"
                          onNext={handleTransportNext}
                          nextDisabled={activeClipIndex < 0 || activeClipIndex >= clipEntries.length - 1}
                          nextTitle="Next clip"
                          isPlaying={isPreviewPlaying}
                          onPlayPause={handleTransportPlayPause}
                          position={clipEntries.length ? `${Math.max(1, activeClipIndex + 1)} / ${clipEntries.length}` : '0 / 0'}
                          progress={totalTimelineDuration > 0 ? playheadTime / totalTimelineDuration : 0}
                          timeDisplay={formatTime(playheadTime)}
                          speeds={[0.5, 1, 1.5, 2]}
                          activeSpeed={playbackSpeed}
                          onSpeedChange={handlePlaybackSpeedChange}
                          leftSlot={(
                            <div className="flex items-center gap-1 mr-1">
                              <button
                                type="button"
                                onClick={() => nudgeTimeline(-1)}
                                className="px-1.5 py-0.5 text-xxs font-mono rounded text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors"
                                title="Step backward 1 second"
                              >
                                -1s
                              </button>
                              <button
                                type="button"
                                onClick={() => nudgeTimeline(-0.1)}
                                className="px-1.5 py-0.5 text-xxs font-mono rounded text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors"
                                title="Step backward 0.1 second"
                              >
                                -0.1s
                              </button>
                              <button
                                type="button"
                                onClick={() => nudgeTimeline(0.1)}
                                className="px-1.5 py-0.5 text-xxs font-mono rounded text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors"
                                title="Step forward 0.1 second"
                              >
                                +0.1s
                              </button>
                              <button
                                type="button"
                                onClick={() => nudgeTimeline(1)}
                                className="px-1.5 py-0.5 text-xxs font-mono rounded text-text-secondary hover:text-text-primary hover:bg-bg-secondary transition-colors"
                                title="Step forward 1 second"
                              >
                                +1s
                              </button>
                            </div>
                          )}
                        />
                        <div className="flex-1 min-h-0 overflow-hidden">
                          <CompositionTimeline
                            entries={compositionEntries}
                            totalDuration={totalTimelineDuration}
                            selectedRowId={selectedCapture?.rowId || null}
                            activeRowId={activeCaptureRowId}
                            activeStep={currentStep}
                            playheadTime={playheadTime}
                            onSeek={seekToTimelineTime}
                            onScrubStateChange={setIsTimelineScrubbing}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              />
            </div>

            {composeSidebarVisible && (
              <>
                <div
                  className="shrink-0 cursor-col-resize group/divider relative"
                  style={{ width: 1, marginLeft: -1 }}
                  onMouseDown={startLogsResize}
                >
                  <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
                </div>

                <div className="shrink-0 border-l border-border bg-bg-secondary min-h-0 flex flex-col" style={{ width: logsWidth }}>
                  <ComposeProgressSidebar
                    activeJob={activeJob}
                    isActive={isActive}
                    progressPct={progressPct}
                    currentStep={currentStep}
                    stepMeta={stepMeta}
                    error={error}
                    logEntries={logEntries}
                    totalSegments={totalSegments}
                    activeSegmentIndex={activeSegmentIndex}
                    activeCapture={activeCaptureRowId ? orderedCaptures.find((row) => row.rowId === activeCaptureRowId) : null}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ComposeProgressSidebar({
  activeJob,
  isActive,
  progressPct,
  currentStep,
  stepMeta,
  error,
  logEntries,
  totalSegments,
  activeSegmentIndex,
  activeCapture,
}) {
  const safePct = Math.max(0, Math.min(100, num(progressPct, 0)))
  const StepIcon = stepMeta?.icon || (isActive ? Loader2 : Film)
  const hasSegmentProgress = activeSegmentIndex >= 0 && totalSegments > 0
  const segmentLabel = hasSegmentProgress
    ? `${Math.min(activeSegmentIndex + 1, totalSegments)} / ${totalSegments}`
    : `0 / ${Math.max(0, totalSegments)}`

  const stateLabel = activeJob?.state
    ? String(activeJob.state).replace(/_/g, ' ')
    : (error ? 'error' : 'idle')

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="px-3 py-2 border-b border-border-subtle bg-bg-secondary/85">
        <div className="flex items-center gap-1.5">
          <BarChart2 className="w-3.5 h-3.5 text-accent" />
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Compose Progress</p>
        </div>
      </div>

      <div className="px-3 py-3 border-b border-border-subtle space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <StepIcon className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'animate-spin' : ''} ${stepMeta?.color || 'text-text-secondary'}`} />
            <span className="text-xs text-text-primary font-medium truncate">{toStepLabel(currentStep)}</span>
          </div>
          <span className="text-xs font-mono text-text-secondary tabular-nums">{safePct.toFixed(1)}%</span>
        </div>

        <div className="h-2 rounded-full bg-bg-primary border border-border-subtle overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${error ? 'bg-danger' : 'bg-accent'}`}
            style={{ width: `${safePct}%` }}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded border border-border bg-bg-primary px-2 py-1.5">
            <p className="text-text-disabled uppercase tracking-wider">State</p>
            <p className={`mt-0.5 font-medium capitalize ${error ? 'text-danger' : 'text-text-secondary'}`}>{stateLabel}</p>
          </div>
          <div className="rounded border border-border bg-bg-primary px-2 py-1.5">
            <p className="text-text-disabled uppercase tracking-wider">Segment</p>
            <p className="mt-0.5 font-mono text-text-secondary">{segmentLabel}</p>
          </div>
        </div>

        {activeCapture && (
          <div className="rounded border border-accent/30 bg-accent/6 px-2 py-1.5">
            <p className="text-[10px] uppercase tracking-wider text-accent">Active Capture</p>
            <p className="text-xs text-text-primary truncate mt-0.5">{activeCapture.fileName}</p>
            <p className="text-[10px] text-text-tertiary truncate mt-0.5">{activeCapture.segmentId}</p>
          </div>
        )}

        {error && (
          <div className="rounded border border-danger/35 bg-danger/8 px-2 py-1.5">
            <p className="text-[11px] font-medium text-danger">Composition failed</p>
            <p className="text-[11px] text-danger/90 mt-0.5">{error}</p>
          </div>
        )}
      </div>

      <CompositionLogList logEntries={logEntries} />
    </div>
  )
}

function CompositionLogList({ logEntries }) {
  const entries = normalizeCompositionLogEntries(logEntries)

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-2 border-b border-border-subtle">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">Compose Log</p>
      </div>

      <UnifiedLogList
        entries={entries.slice(-120)}
        emptyMessage="No compose log entries yet."
        maxHeightClass="max-h-none"
        className="flex-1 min-h-0"
      />
    </div>
  )
}

function CapturesTab({ rows, selectedId, activeRowId, activeStep, isComposing, onSelect, inspectorVideoSrc, inspectorFileName }) {
  const activeStepLabel = toStepLabel(activeStep)

  if (!rows.length) {
    return (
      <div className="h-full flex items-center justify-center p-4 text-center text-text-tertiary text-xs">
        No script/capture rows available yet.
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-bg-primary">
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1.5">
        {rows.map((row, order) => {
          const isSelected = row.rowId === selectedId
          const isActiveRow = isComposing && activeRowId && row.rowId === activeRowId
          return (
            <button
              key={row.rowId}
              onClick={() => onSelect(row.rowId)}
              className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors ${isActiveRow ? 'border-accent/60 bg-accent/12 ring-1 ring-accent/35' : isSelected ? 'border-accent/50 bg-accent/10 ring-1 ring-accent/20' : 'border-border-subtle bg-bg-secondary hover:border-border hover:bg-bg-hover'}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-text-disabled w-5">{order + 1}</span>
                <span className="text-xs text-text-primary font-medium truncate flex-1">{row.fileName}</span>
                <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${row.missing ? 'text-warning border-warning/35 bg-warning/10' : 'text-success border-success/30 bg-success/8'}`}>
                  {row.missing ? 'Missing' : 'Ready'}
                </span>
              </div>

              {isActiveRow && (
                <div className="mt-1 rounded border border-accent/30 bg-accent/8 px-1.5 py-1 flex items-center justify-between gap-2 text-[10px]">
                  <span className="inline-flex items-center gap-1 text-accent">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Active in compose
                  </span>
                  <span className="text-text-secondary uppercase tracking-wider truncate">{activeStepLabel}</span>
                </div>
              )}

              <div className="mt-1 flex items-center gap-2 text-[10px] text-text-tertiary">
                <span>{SECTION_META[row.section]?.label || row.section}</span>
                <span>•</span>
                <span>{row.eventType}</span>
                <span>•</span>
                <span>{Math.round(row.clipDuration || row.segmentDuration || 0)}s</span>
              </div>
              <div className="mt-0.5 text-[10px] text-text-disabled truncate">{row.segmentId}</div>
            </button>
          )
        })}
      </div>

      <div className="shrink-0 border-t border-border bg-bg-secondary p-2">
        <div className="text-xxs text-text-tertiary mb-1">Capture Inspector</div>
        {inspectorVideoSrc ? (
          <div className="rounded border border-border bg-black overflow-hidden">
            <video
              key={inspectorFileName || inspectorVideoSrc}
              src={inspectorVideoSrc}
              controls
              preload="metadata"
              className="w-full max-h-56 bg-black"
            />
          </div>
        ) : (
          <div className="rounded border border-border-subtle bg-bg-primary px-2 py-4 text-center text-xxs text-text-disabled">
            Select a playable capture to inspect it here.
          </div>
        )}
      </div>
    </div>
  )
}

function CompositionTimeline({ entries, totalDuration, selectedRowId, activeRowId, activeStep, playheadTime, onSeek, onScrubStateChange }) {
  const duration = Math.max(1, num(totalDuration, 0))
  const {
    containerRef,
    scrollRef,
    rangeStart,
    rangeEnd,
    setRange,
    containerHeight,
    contentWidth,
    toX,
    handleTimelineScroll,
  } = useTimelineViewport({
    totalDuration: duration,
    fallbackWidth: Math.max(900, duration * 36),
    measureKey: `${entries.length}:${duration}`,
  })

  const sectionSpans = useMemo(() => {
    const clips = entries.filter((entry) => entry.type === 'clip')
    const spans = new Map()
    for (const clip of clips) {
      const key = clip.section || 'race'
      if (!spans.has(key)) {
        spans.set(key, { section: key, start: clip.start, end: clip.end })
      } else {
        const current = spans.get(key)
        current.start = Math.min(current.start, clip.start)
        current.end = Math.max(current.end, clip.end)
      }
    }
    return Array.from(spans.values())
  }, [entries])

  const tickMarks = useMemo(() => {
    const tickCount = Math.min(10, Math.max(4, Math.round(duration / 30)))
    const step = duration / tickCount
    return Array.from({ length: tickCount + 1 }, (_, index) => {
      const value = Math.min(duration, index * step)
      return { value, left: toX(value) }
    })
  }, [duration, toX])

  const rangeEvents = useMemo(() => {
    return entries.map((entry) => ({
      start_time_seconds: entry.start,
      end_time_seconds: entry.end,
      event_type: entry.type === 'fade' ? 'transition' : (entry.section || 'race'),
      inclusion: entry.type === 'clip' ? 'highlight' : null,
      color: entry.type === 'fade'
        ? '#a855f7'
        : (SECTION_META[entry.section || 'race']?.color || '#6b7280'),
    }))
  }, [entries])

  const rangeSectionBands = useMemo(() => {
    if (duration <= 0) return []
    return sectionSpans.map((span) => {
      const safeStart = Math.max(0, Math.min(duration, num(span.start, 0)))
      const safeEnd = Math.max(safeStart, Math.min(duration, num(span.end, safeStart)))
      return {
        section: span.section,
        label: SECTION_META[span.section]?.label || span.section,
        color: SECTION_META[span.section]?.color || '#6b7280',
        start: safeStart,
        end: safeEnd,
        startPct: (safeStart / duration) * 100,
        widthPct: Math.max(0.5, ((safeEnd - safeStart) / duration) * 100),
      }
    })
  }, [duration, sectionSpans])

  const dynamicClipRowHeight = Math.max(
    TIMELINE_ROW_CLIPS,
    (containerHeight || 0) - TIMELINE_ROW_SECTION - TIMELINE_ROW_TICKS,
  )
  const canvasHeight = TIMELINE_ROW_SECTION + dynamicClipRowHeight + TIMELINE_ROW_TICKS

  const getTimeFromClientX = useCallback((clientX) => {
    const element = scrollRef.current
    if (!element || contentWidth <= 0) return 0
    const rect = element.getBoundingClientRect()
    const x = clientX - rect.left + element.scrollLeft
    const pct = Math.max(0, Math.min(1, x / contentWidth))
    return pct * duration
  }, [contentWidth, duration, scrollRef])

  const handleTimelinePointerDown = useCallback((event) => {
    if (typeof onSeek !== 'function') return
    event.preventDefault()
    event.stopPropagation()
    if (typeof onScrubStateChange === 'function') onScrubStateChange(true)

    const initial = getTimeFromClientX(event.clientX)
    onSeek(initial, { scrub: true })

    const onMove = (moveEvent) => {
      onSeek(getTimeFromClientX(moveEvent.clientX), { scrub: true })
    }

    const onUp = (upEvent) => {
      onSeek(getTimeFromClientX(upEvent.clientX), { scrub: true })
      if (typeof onScrubStateChange === 'function') onScrubStateChange(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [getTimeFromClientX, onScrubStateChange, onSeek])

  const playheadX = duration > 0 ? toX(Math.max(0, Math.min(duration, num(playheadTime, 0))) / duration * duration) : null

  return (
    <div className="h-full min-h-0 flex flex-col" ref={containerRef}>
      <ConfigurableTimelineTracks
        gutterWidth={52}
        canvasHeight={canvasHeight}
        contentWidth={contentWidth}
        containerClassName="flex-1 h-full min-h-0 flex items-end overflow-hidden bg-bg-primary"
        scrollClassName="flex-1 min-h-0 overflow-x-hidden overflow-y-hidden"
        scrollRef={scrollRef}
        onScroll={handleTimelineScroll}
        playheadX={playheadX}
        playheadClassName="bg-accent"
        playheadDraggingClassName="bg-accent"
        onPlayheadMouseDown={handleTimelinePointerDown}
        rows={[
          {
            key: 'section',
            label: 'Sect',
            height: TIMELINE_ROW_SECTION,
            render: ({ top, height }) => (
              <div className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize" style={{ top, height }} onMouseDown={handleTimelinePointerDown}>
                {sectionSpans.map((span) => {
                  const meta = SECTION_META[span.section] || SECTION_META.race
                  const left = toX(span.start)
                  const width = Math.max(4, toX(span.end - span.start))
                  return (
                    <div key={span.section} className="absolute top-0 h-full flex items-center overflow-hidden" style={{ left, width }}>
                      <div className="absolute inset-0 opacity-20" style={{ backgroundColor: meta.color }} />
                      <span className="relative truncate pl-1 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">{meta.label}</span>
                    </div>
                  )
                })}
              </div>
            ),
          },
          {
            key: 'clips',
            label: 'Comp',
            height: dynamicClipRowHeight,
            render: ({ top, height }) => (
              <div className="absolute left-0 right-0 border-b border-border-subtle cursor-ew-resize" style={{ top, height }} onMouseDown={handleTimelinePointerDown}>
                {entries.map((entry) => {
                  const left = toX(entry.start)
                  const width = Math.max(3, toX(entry.end - entry.start))
                  const isSelected = entry.type === 'clip' && entry.rowId === selectedRowId
                  const isActiveRow = entry.type === 'clip' && activeRowId && entry.rowId === activeRowId
                  const isFade = entry.type === 'fade'
                  const meta = SECTION_META[entry.section] || SECTION_META.race
                  const className = isFade
                    ? 'bg-purple-500/28 border-purple-500/45'
                    : entry.missing
                      ? 'bg-warning/20 border-warning/35'
                      : isActiveRow
                        ? 'bg-accent/45 border-accent/70 ring-1 ring-accent/45'
                      : isSelected
                        ? 'bg-accent/35 border-accent/65 ring-1 ring-accent/40'
                        : 'border-white/10'

                  const typeLabel = isFade
                    ? 'Fade'
                    : entry.section !== 'race'
                      ? (SECTION_META[entry.section]?.label || entry.section)
                      : entry.eventType
                        ? entry.eventType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
                        : 'Clip'

                  const durLabel = `${entry.duration.toFixed(1)}s`

                  return (
                    <div
                      key={entry.rowId}
                      className={`absolute top-1 bottom-1 border overflow-hidden flex items-center ${className}`}
                      style={{ left, width, backgroundColor: !isFade && !entry.missing && !isSelected && !isActiveRow ? `${meta.color}55` : undefined }}
                      title={`${isFade ? 'Fade transition' : entry.label}\n${formatTime(entry.start)} - ${formatTime(entry.end)} (${entry.duration.toFixed(1)}s)${isActiveRow ? `\nActive: ${toStepLabel(activeStep)}` : ''}`}
                    >
                      {isActiveRow && (
                        <div className="absolute inset-0 ring-1 ring-accent/60 animate-pulse pointer-events-none" />
                      )}
                      {width > 28 && (
                        <span
                          className="truncate px-1 font-medium leading-none select-none pointer-events-none"
                          style={{ fontSize: 10, color: isFade ? 'rgba(192,132,252,0.9)' : entry.missing ? 'rgba(251,191,36,0.9)' : isSelected || isActiveRow ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.7)' }}
                        >
                          {typeLabel}
                        </span>
                      )}
                      {width > 72 && (
                        <span
                          className="shrink-0 pr-1 font-mono leading-none select-none pointer-events-none"
                          style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)' }}
                        >
                          {durLabel}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            ),
          },
          {
            key: 'ticks',
            label: '',
            height: TIMELINE_ROW_TICKS,
            render: ({ top, height }) => (
              <div className="absolute left-0 right-0 cursor-ew-resize" style={{ top, height }} onMouseDown={handleTimelinePointerDown}>
                {tickMarks.map((tick, index) => (
                  <div key={index} className="absolute top-0 bottom-0" style={{ left: tick.left }}>
                    <div className="w-px h-2 bg-border" />
                    <span className="absolute top-2 left-1 text-[10px] text-text-disabled whitespace-nowrap tabular-nums">
                      {formatTime(tick.value)}
                    </span>
                  </div>
                ))}
              </div>
            ),
          },
        ]}
      />

      <RangeSlider
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        onChange={setRange}
        totalDuration={duration}
        events={rangeEvents}
        playheadTime={playheadTime}
        sectionBands={rangeSectionBands}
      />
    </div>
  )
}

function ConfigSlider({ label, description, value, onChange, min, max, step, unit }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-text-secondary">{label}</label>
        <span className="text-xs font-mono text-text-primary">{value}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(parseFloat(event.target.value))}
        className="w-full h-1.5 bg-bg-primary rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:cursor-pointer"
      />
      {description && (
        <p className="text-xxs text-text-disabled">{description}</p>
      )}
    </div>
  )
}
