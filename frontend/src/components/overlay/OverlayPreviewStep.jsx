import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useOverlay } from '../../context/OverlayContext'
import { useProject } from '../../context/ProjectContext'
import { useToast } from '../../context/ToastContext'
import { formatTime } from '../../utils/time'
import {
  Play, Pause, SkipBack, SkipForward, Layers, Eye, EyeOff,
  ChevronRight, ChevronDown, Monitor, Film, Award, Flag,
  Clock, Gauge, RefreshCw, Loader2, AlertTriangle, Maximize2,
} from 'lucide-react'

/**
 * Section metadata for the overlay preview.
 */
const SECTIONS = [
  { id: 'intro', label: 'Intro', icon: Film, color: 'text-blue-400' },
  { id: 'qualifying_results', label: 'Qualifying', icon: Award, color: 'text-amber-400' },
  { id: 'race', label: 'Race', icon: Flag, color: 'text-emerald-400' },
  { id: 'race_results', label: 'Results', icon: Monitor, color: 'text-purple-400' },
]

/**
 * OverlayPreviewStep — Read-only timeline with overlay preview.
 *
 * Displays a read-only timeline derived from the script, with section tabs
 * (intro / qualifying / race / results).  The preview region shows the
 * overlay rendered over the iRacing replay stream for each segment.
 *
 * All overlays are telemetry-driven, so the preview updates correctly
 * as the user scrubs / plays through the timeline.
 *
 * @param {Object} props
 * @param {Array} props.script - The video composition script segments
 * @param {number} [props.projectId] - Active project ID
 * @param {string} [props.selectedTemplateId] - Active overlay template
 */
export default function OverlayPreviewStep({ script = [], projectId, selectedTemplateId }) {
  const { templates, engineStatus, initEngine, fetchTemplates } = useOverlay()
  const { showSuccess, showError } = useToast()

  const [activeSection, setActiveSection] = useState('race')
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [playbackSpeed, setPlaybackSpeed] = useState(1)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewFrame, setPreviewFrame] = useState(null)
  const timelineRef = useRef(null)
  const playIntervalRef = useRef(null)

  // Init engine on mount
  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  // ── Script analysis ─────────────────────────────────────────────────────
  const segments = useMemo(() => {
    if (!script || !Array.isArray(script)) return []
    return script.filter(s => s.type !== 'transition' && (s.end_time_seconds - s.start_time_seconds) > 0)
  }, [script])

  const sectionSegments = useMemo(() => {
    return segments.filter(s => {
      const sec = s.section || 'race'
      if (activeSection === 'qualifying_results') return sec === 'qualifying' || sec === 'qualifying_results'
      if (activeSection === 'race_results') return sec === 'results' || sec === 'race_results'
      return sec === activeSection
    })
  }, [segments, activeSection])

  const totalDuration = useMemo(() => {
    if (sectionSegments.length === 0) return 0
    const maxEnd = Math.max(...sectionSegments.map(s => s.end_time_seconds || 0))
    const minStart = Math.min(...sectionSegments.map(s => s.start_time_seconds || 0))
    return maxEnd - minStart
  }, [sectionSegments])

  const sectionStart = useMemo(() => {
    if (sectionSegments.length === 0) return 0
    return Math.min(...sectionSegments.map(s => s.start_time_seconds || 0))
  }, [sectionSegments])

  const currentSegment = useMemo(() => {
    const absTime = sectionStart + currentTime
    return sectionSegments.find(s =>
      absTime >= s.start_time_seconds && absTime <= s.end_time_seconds
    ) || null
  }, [sectionSegments, sectionStart, currentTime])

  const sectionCounts = useMemo(() => {
    const counts = {}
    SECTIONS.forEach(s => {
      counts[s.id] = segments.filter(seg => {
        const sec = seg.section || 'race'
        if (s.id === 'qualifying_results') return sec === 'qualifying' || sec === 'qualifying_results'
        if (s.id === 'race_results') return sec === 'results' || sec === 'race_results'
        return sec === s.id
      }).length
    })
    return counts
  }, [segments])

  // ── Playback ────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => {
    setPlaying(prev => !prev)
  }, [])

  useEffect(() => {
    if (playing && totalDuration > 0) {
      playIntervalRef.current = setInterval(() => {
        setCurrentTime(prev => {
          const next = prev + (0.05 * playbackSpeed)
          if (next >= totalDuration) {
            setPlaying(false)
            return totalDuration
          }
          return next
        })
      }, 50)
    } else {
      clearInterval(playIntervalRef.current)
    }
    return () => clearInterval(playIntervalRef.current)
  }, [playing, playbackSpeed, totalDuration])

  const handleScrub = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setCurrentTime(x * totalDuration)
  }, [totalDuration])

  const cycleSpeed = useCallback(() => {
    setPlaybackSpeed(prev => {
      const speeds = [0.25, 0.5, 1, 2, 4]
      const idx = speeds.indexOf(prev)
      return speeds[(idx + 1) % speeds.length]
    })
  }, [])

  const skipBack = useCallback(() => {
    setCurrentTime(prev => Math.max(0, prev - 5))
  }, [])

  const skipForward = useCallback(() => {
    setCurrentTime(prev => Math.min(totalDuration, prev + 5))
  }, [totalDuration])

  // ── Template for current section ────────────────────────────────────────
  const activeTemplate = useMemo(() => {
    if (selectedTemplateId) return templates.find(t => t.id === selectedTemplateId)
    return templates[0] || null
  }, [templates, selectedTemplateId])

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-bg-secondary shrink-0">
        <Layers className="w-5 h-5 text-accent" />
        <h2 className="text-sm font-semibold text-text-primary">Overlay Preview</h2>
        <div className="flex-1" />
        <button
          onClick={() => setOverlayVisible(v => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xxs font-medium
            border border-border hover:bg-bg-hover transition-colors"
          title={overlayVisible ? 'Hide overlay' : 'Show overlay'}
        >
          {overlayVisible
            ? <Eye className="w-3 h-3 text-accent" />
            : <EyeOff className="w-3 h-3 text-text-tertiary" />
          }
          {overlayVisible ? 'Overlay On' : 'Overlay Off'}
        </button>
        {activeTemplate && (
          <span className="px-2 py-0.5 rounded-full text-xxs font-medium border border-border text-text-tertiary bg-bg-primary">
            {activeTemplate.name || activeTemplate.id}
          </span>
        )}
      </div>

      {/* Section tabs */}
      <div className="flex border-b border-border bg-bg-secondary shrink-0">
        {SECTIONS.map(sec => (
          <button
            key={sec.id}
            onClick={() => { setActiveSection(sec.id); setCurrentTime(0); setPlaying(false) }}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors
              border-b-2 ${activeSection === sec.id
                ? `border-accent text-accent bg-accent/5`
                : 'border-transparent text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
              }`}
          >
            <sec.icon className={`w-3.5 h-3.5 ${activeSection === sec.id ? sec.color : ''}`} />
            {sec.label}
            {sectionCounts[sec.id] > 0 && (
              <span className="ml-1 px-1.5 py-0 rounded-full text-xxs bg-bg-primary border border-border">
                {sectionCounts[sec.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Preview area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {sectionSegments.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-tertiary">
            <Film className="w-8 h-8 opacity-40" />
            <p className="text-sm font-medium">No segments in this section</p>
            <p className="text-xs text-text-disabled">
              Switch to a section with script segments to preview overlays.
            </p>
          </div>
        ) : (
          <>
            {/* Preview viewport */}
            <div className="flex-1 relative bg-black/50 flex items-center justify-center overflow-hidden">
              {/* Simulated preview area */}
              <div className="relative w-full max-w-4xl aspect-video bg-bg-primary/20 rounded-lg overflow-hidden
                border border-border/30">
                {/* Replay stream placeholder */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center space-y-2">
                    <Monitor className="w-12 h-12 text-text-disabled mx-auto opacity-30" />
                    <p className="text-xs text-text-disabled">iRacing Replay Stream</p>
                    {currentSegment && (
                      <p className="text-xxs text-text-tertiary mt-1">
                        Segment: {currentSegment.id || 'unknown'} · {currentSegment.event_type || currentSegment.type || 'event'}
                      </p>
                    )}
                  </div>
                </div>

                {/* Overlay layer */}
                {overlayVisible && currentSegment && (
                  <div className="absolute inset-0 pointer-events-none">
                    {/* Simulated overlay HUD - telemetry driven */}
                    <OverlayHUD
                      section={activeSection}
                      segment={currentSegment}
                      time={sectionStart + currentTime}
                      template={activeTemplate}
                    />
                  </div>
                )}

                {/* Timestamp badge */}
                <div className="absolute top-3 right-3 px-2 py-1 bg-black/60 rounded text-xxs font-mono text-white/80">
                  {formatTime(currentTime)} / {formatTime(totalDuration)}
                </div>

                {/* Section badge */}
                <div className="absolute top-3 left-3 px-2 py-1 bg-black/60 rounded text-xxs font-medium text-white/80 capitalize">
                  {activeSection.replace('_', ' ')}
                </div>
              </div>
            </div>

            {/* Controls */}
            <div className="shrink-0 px-4 py-2 border-t border-border bg-bg-secondary">
              <div className="flex items-center gap-3">
                <button onClick={skipBack} className="p-1 rounded hover:bg-bg-hover transition-colors" title="Back 5s">
                  <SkipBack className="w-4 h-4 text-text-secondary" />
                </button>
                <button
                  onClick={togglePlay}
                  className="p-1.5 rounded-full bg-accent hover:bg-accent-hover transition-colors"
                  title={playing ? 'Pause' : 'Play'}
                >
                  {playing
                    ? <Pause className="w-4 h-4 text-white" />
                    : <Play className="w-4 h-4 text-white ml-0.5" />
                  }
                </button>
                <button onClick={skipForward} className="p-1 rounded hover:bg-bg-hover transition-colors" title="Forward 5s">
                  <SkipForward className="w-4 h-4 text-text-secondary" />
                </button>
                <button
                  onClick={cycleSpeed}
                  className="px-2 py-1 rounded text-xxs font-mono font-medium border border-border
                    hover:bg-bg-hover transition-colors text-text-secondary"
                  title="Playback speed"
                >
                  {playbackSpeed}×
                </button>

                <div className="flex-1" />

                <span className="text-xxs font-mono text-text-tertiary">
                  {formatTime(currentTime)}
                </span>
              </div>
            </div>

            {/* Timeline scrubber */}
            <div className="shrink-0 border-t border-border bg-bg-primary">
              <div
                ref={timelineRef}
                className="relative h-16 cursor-pointer"
                onClick={handleScrub}
                onMouseDown={(e) => {
                  handleScrub(e)
                  const onMove = (ev) => handleScrub(ev)
                  const onUp = () => {
                    document.removeEventListener('mousemove', onMove)
                    document.removeEventListener('mouseup', onUp)
                  }
                  document.addEventListener('mousemove', onMove)
                  document.addEventListener('mouseup', onUp)
                }}
              >
                {/* Segment blocks */}
                {sectionSegments.map((seg, idx) => {
                  const relStart = (seg.start_time_seconds - sectionStart)
                  const segDur = seg.end_time_seconds - seg.start_time_seconds
                  const left = totalDuration > 0 ? (relStart / totalDuration) * 100 : 0
                  const width = totalDuration > 0 ? (segDur / totalDuration) * 100 : 0

                  return (
                    <div
                      key={seg.id || idx}
                      className={`absolute top-2 bottom-2 rounded-sm transition-colors
                        ${currentSegment?.id === seg.id
                          ? 'bg-accent/30 border border-accent/50'
                          : 'bg-bg-hover border border-border/50 hover:bg-bg-secondary'
                        }`}
                      style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%` }}
                      title={`${seg.id || 'segment'}: ${formatTime(relStart)} - ${formatTime(relStart + segDur)}`}
                    >
                      <div className="px-1 py-0.5 truncate">
                        <span className="text-xxs text-text-tertiary truncate block">
                          {seg.event_type || seg.type || 'event'}
                        </span>
                      </div>
                    </div>
                  )
                })}

                {/* Playhead */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-accent z-10 pointer-events-none"
                  style={{ left: `${totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0}%` }}
                >
                  <div className="absolute -top-0.5 -left-1 w-2.5 h-2.5 bg-accent rounded-full" />
                </div>

                {/* Time labels */}
                <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 pb-0.5">
                  <span className="text-xxs font-mono text-text-disabled">{formatTime(0)}</span>
                  <span className="text-xxs font-mono text-text-disabled">{formatTime(totalDuration)}</span>
                </div>
              </div>
            </div>

            {/* Segment list */}
            <div className="shrink-0 max-h-40 overflow-y-auto border-t border-border bg-bg-secondary">
              <div className="px-3 py-1.5">
                <h4 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider mb-1">
                  Segments ({sectionSegments.length})
                </h4>
                <div className="space-y-0.5">
                  {sectionSegments.map((seg, idx) => {
                    const isActive = currentSegment?.id === seg.id
                    const relStart = seg.start_time_seconds - sectionStart
                    const dur = seg.end_time_seconds - seg.start_time_seconds

                    return (
                      <button
                        key={seg.id || idx}
                        onClick={() => { setCurrentTime(relStart); setPlaying(false) }}
                        className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors
                          ${isActive
                            ? 'bg-accent/10 border border-accent/30'
                            : 'hover:bg-bg-hover border border-transparent'
                          }`}
                      >
                        <ChevronRight className={`w-3 h-3 shrink-0 ${isActive ? 'text-accent' : 'text-text-disabled'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-xs font-medium ${isActive ? 'text-accent' : 'text-text-secondary'}`}>
                              {seg.event_type || seg.type || 'event'}
                            </span>
                            {seg.driver_names?.length > 0 && (
                              <span className="text-xxs text-text-tertiary truncate">
                                · {seg.driver_names.slice(0, 2).join(', ')}
                              </span>
                            )}
                          </div>
                        </div>
                        <span className="text-xxs font-mono text-text-disabled shrink-0">
                          {formatTime(relStart)} ({dur.toFixed(1)}s)
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}


// ── Overlay HUD (simulated telemetry-driven overlay) ────────────────────────

function OverlayHUD({ section, segment, time, template }) {
  if (!segment) return null

  const drivers = segment.driver_names || []
  const eventType = segment.event_type || segment.type || ''
  const position = segment.position || segment.involved_positions?.[0] || null

  // Different HUD layouts per section
  if (section === 'intro') {
    return (
      <div className="absolute inset-0 p-4 flex flex-col justify-end">
        <div className="bg-black/40 backdrop-blur-sm rounded-lg p-4 border border-white/10">
          <div className="text-white/90 text-lg font-bold tracking-wider uppercase">
            {segment.series_name || 'Race Broadcast'}
          </div>
          <div className="text-white/60 text-sm mt-1">
            {segment.track_name || 'Circuit'}
          </div>
          <div className="h-0.5 w-20 bg-accent mt-2 rounded-full" />
        </div>
      </div>
    )
  }

  if (section === 'qualifying_results') {
    return (
      <div className="absolute inset-x-4 top-4 bottom-4 flex flex-col">
        <div className="bg-black/50 backdrop-blur-sm rounded-lg p-3 border border-white/10">
          <div className="text-white/80 text-xs font-bold uppercase tracking-wider mb-2">
            Qualifying Results
          </div>
          <div className="space-y-1">
            {(segment.qualifying_results || drivers).slice(0, 5).map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-white/70 text-xxs font-mono">
                <span className="w-5 text-right text-white/40">P{i + 1}</span>
                <span className="flex-1">{typeof item === 'string' ? item : item.name || `Driver ${i + 1}`}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (section === 'race_results') {
    return (
      <div className="absolute inset-x-4 top-4 bottom-4 flex flex-col">
        <div className="bg-black/50 backdrop-blur-sm rounded-lg p-3 border border-white/10">
          <div className="text-white/80 text-xs font-bold uppercase tracking-wider mb-2">
            Race Results
          </div>
          <div className="space-y-1">
            {(segment.race_results || drivers).slice(0, 5).map((item, i) => (
              <div key={i} className="flex items-center gap-2 text-white/70 text-xxs font-mono">
                <span className="w-5 text-right text-white/40">P{i + 1}</span>
                <span className="flex-1">{typeof item === 'string' ? item : item.name || `Driver ${i + 1}`}</span>
                {typeof item !== 'string' && item.gap && (
                  <span className="text-white/40">+{item.gap}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Race section (default)
  return (
    <div className="absolute inset-0">
      {/* Top bar — timing / position */}
      <div className="absolute top-3 left-3 right-3 flex items-center gap-2">
        <div className="bg-black/50 backdrop-blur-sm rounded px-2.5 py-1 border border-white/10 flex items-center gap-2">
          <Clock className="w-3 h-3 text-white/60" />
          <span className="text-xxs font-mono text-white/80">
            {formatTime(time)}
          </span>
        </div>
        {position && (
          <div className="bg-black/50 backdrop-blur-sm rounded px-2.5 py-1 border border-white/10">
            <span className="text-xxs font-bold text-white/90">P{position}</span>
          </div>
        )}
        {eventType && (
          <div className="bg-accent/80 backdrop-blur-sm rounded px-2 py-0.5 text-xxs font-bold text-white uppercase">
            {eventType.replace(/_/g, ' ')}
          </div>
        )}
      </div>

      {/* Bottom bar — driver info */}
      <div className="absolute bottom-3 left-3 right-3">
        <div className="bg-black/50 backdrop-blur-sm rounded-lg px-3 py-2 border border-white/10">
          <div className="flex items-center gap-3">
            <div className="flex-1">
              {drivers.length > 0 && (
                <div className="text-white/90 text-xs font-bold">
                  {drivers[0]}
                  {drivers.length > 1 && (
                    <span className="text-white/50 font-normal ml-1">vs {drivers[1]}</span>
                  )}
                </div>
              )}
            </div>
            <Gauge className="w-3.5 h-3.5 text-white/40" />
          </div>
        </div>
      </div>
    </div>
  )
}
