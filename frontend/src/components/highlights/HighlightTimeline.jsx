import { useMemo, useState, useCallback, useRef, useEffect } from 'react'
import { useHighlight, EVENT_TYPE_LABELS } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'
import { useIRacing } from '../../context/IRacingContext'
import { useProject } from '../../context/ProjectContext'
import { apiGet, apiPost } from '../../services/api'
import { formatTime } from '../../utils/time'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import TimelineToolbar from '../timeline/TimelineToolbar'
import { ChevronDown, ChevronRight, Film, FastForward, Square } from 'lucide-react'


/**
 * HighlightTimeline — Final Script Timeline (NLS / edit-order view).
 *
 * IMPORTANT: Segments are displayed in EDIT ORDER with sequential positioning —
 * not at race-time. This eliminates gaps between clips and shows the final video
 * as it will actually be cut: Intro → Qualifying Results → Race Clips → Results.
 *
 * Tracks (top → bottom):
 *   Section row  — coloured band per section (Intro / Qualifying / Race / Results)
 *   Camera track — iRacing camera group assigned to each clip
 *   Events track — clip blocks coloured by type / section
 *   Tick ruler   — edit time (final video minutes:seconds)
 *
 * Execute Script drives iRacing replay through every segment in script order.
 */

// ── Edit-timeline layout constants ──────────────────────────────────────────
const SECTION_H    = 18   // section label row
const CAM_H        = 18   // camera track
const EVT_H        = 46   // events track
const TICK_H       = 20   // tick ruler
const TOTAL_TRACK_H = SECTION_H + CAM_H + EVT_H + TICK_H
const GUTTER_W     = 52
const EDIT_PX_PER_SEC = 20  // pixels per second in edit time (fixed scale)

// ── Section metadata ─────────────────────────────────────────────────────────
const SECTION_ORDER = ['intro', 'qualifying_results', 'race', 'race_results']

const SECTION_META = {
  intro:              { label: 'Intro',      color: 'rgba(139,92,246,0.28)',  border: 'rgba(139,92,246,0.55)', text: 'rgba(192,165,255,0.95)' },
  qualifying_results: { label: 'Qualifying', color: 'rgba(6,182,212,0.20)',   border: 'rgba(6,182,212,0.48)',  text: 'rgba(103,232,249,0.95)' },
  race:               { label: 'Race',       color: 'rgba(249,115,22,0.15)',  border: 'rgba(249,115,22,0.40)', text: 'rgba(253,186,116,0.95)' },
  race_results:       { label: 'Results',    color: 'rgba(34,197,94,0.20)',   border: 'rgba(34,197,94,0.45)',  text: 'rgba(134,239,172,0.95)' },
}

// ── Camera assignment helpers ─────────────────────────────────────────────────
const DEFAULT_CAM = {
  battle: 'TV1', overtake: 'TV1',
  crash: 'Cockpit', incident: 'Cockpit', spinout: 'Cockpit',
  contact: 'Bumper', close_call: 'Bumper',
  race_start: 'TV Scenic', race_finish: 'TV Scenic',
  fastest_lap: 'TV1', pit_stop: 'Pit Lane',
  leader_change: 'TV1', first_lap: 'TV Scenic', last_lap: 'TV1',
}

function getCameraLabel(seg) {
  if (seg?.camera_hints?.establishing_angle) return seg.camera_hints.establishing_angle
  if (seg?.camera_preferences?.length)       return seg.camera_preferences[0]
  return DEFAULT_CAM[seg?.event_type] || 'TV1'
}

function fmtDur(sec) {
  if (!sec || sec <= 0) return '0s'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── Main component ────────────────────────────────────────────────────────────
export default function HighlightTimeline() {
  const { videoScript, metrics } = useHighlight()
  const { isConnected, sessionData } = useIRacing()
  const { activeProject } = useProject()

  const [collapsed, setCollapsed] = useLocalStorage('lrs:editing:timeline:collapsed', false)
  const [executing, setExecuting] = useState(false)
  const [activeSegId, setActiveSegId] = useState(null)
  const abortRef = useRef({ cancelled: false })
  const scrollRef = useRef(null)

  const [raceSessionNum, setRaceSessionNum] = useState(0)
  useEffect(() => {
    if (!activeProject?.id) return
    apiGet(`/projects/${activeProject.id}/analysis/race-duration`)
      .then(d => setRaceSessionNum(d?.race_session_num ?? 0))
      .catch(() => {})
  }, [activeProject?.id])

  // ── Build sequential edit segments ─────────────────────────────────────────
  // Converts videoScript (race-time positions) into edit-time (sequential).
  // Sections are ordered: intro → qualifying_results → race clips → race_results
  // Within the race section, clips are sorted by their race start_time_seconds.
  const editSegments = useMemo(() => {
    if (!videoScript?.length) return []

    const filtered = videoScript.filter(s => s.type !== 'transition')

    // Sort by section, then by race start time within each section
    const sorted = [...filtered].sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.section || 'race')
      const bi = SECTION_ORDER.indexOf(b.section || 'race')
      if (ai !== bi) return ai - bi
      return (a.start_time_seconds || 0) - (b.start_time_seconds || 0)
    })

    // Assign sequential edit positions — no gaps
    let cursor = 0
    return sorted.map(seg => {
      const dur = Math.max(1, (seg.end_time_seconds || 0) - (seg.start_time_seconds || 0))
      const editStart = cursor
      cursor += dur
      return { ...seg, editStart, editEnd: cursor, editDur: dur }
    })
  }, [videoScript])

  // Section spans for the section row
  const sectionSpans = useMemo(() => {
    const spans = {}
    for (const seg of editSegments) {
      const s = seg.section || 'race'
      if (!spans[s]) spans[s] = { editStart: seg.editStart, editEnd: seg.editEnd }
      else {
        spans[s].editStart = Math.min(spans[s].editStart, seg.editStart)
        spans[s].editEnd   = Math.max(spans[s].editEnd,   seg.editEnd)
      }
    }
    return spans
  }, [editSegments])

  const totalEditDuration = editSegments.length > 0
    ? editSegments[editSegments.length - 1].editEnd : 0

  const totalW = Math.max(totalEditDuration * EDIT_PX_PER_SEC, 600)
  const toX = useCallback((t) => t * EDIT_PX_PER_SEC, [])

  const hasData = editSegments.length > 0

  // ── Execute Script ──────────────────────────────────────────────────────────
  const executeScript = useCallback(async () => {
    if (!editSegments.length) return
    const abort = { cancelled: false }
    abortRef.current = abort
    setExecuting(true)

    const cameras = sessionData?.cameras || []

    for (const seg of editSegments) {
      if (abort.cancelled) break
      const startSec = seg.start_time_seconds ?? 0
      const durMs    = Math.max(500, seg.editDur * 1000)

      setActiveSegId(seg.id)

      try {
        await apiPost('/iracing/replay/seek-time', {
          session_num: raceSessionNum,
          session_time_ms: Math.round(startSec * 1000),
        })
      } catch { /* iRacing disconnected */ }

      try {
        const camLabel = getCameraLabel(seg)
        const cam = cameras.find(c => c.group_name === camLabel)
        if (cam) await apiPost('/iracing/replay/camera', { group_num: cam.group_num, position: 1 })
      } catch { /* non-fatal */ }

      try { await apiPost('/iracing/replay/play') } catch { /* non-fatal */ }

      await new Promise(resolve => {
        const timer = setTimeout(resolve, durMs)
        const poll  = setInterval(() => {
          if (abort.cancelled) { clearTimeout(timer); clearInterval(poll); resolve() }
        }, 100)
        setTimeout(() => clearInterval(poll), durMs + 200)
      })
    }

    if (!abort.cancelled) {
      try { await apiPost('/iracing/replay/pause') } catch { /* non-fatal */ }
    }
    setExecuting(false)
    setActiveSegId(null)
  }, [editSegments, raceSessionNum, sessionData])

  const stopExecution = useCallback(() => {
    abortRef.current.cancelled = true
    setExecuting(false)
    setActiveSegId(null)
    apiPost('/iracing/replay/pause').catch(() => {})
  }, [])

  // ── Clip count summary ──────────────────────────────────────────────────────
  const clipCount = editSegments.filter(s => s.type !== 'broll').length
  const brollCount = editSegments.filter(s => s.type === 'broll').length

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* Header / collapse toggle */}
      <button
        onClick={() => setCollapsed(v => !v)}
        className="flex items-center gap-2 px-3 py-2 border-b border-border bg-bg-secondary shrink-0 w-full text-left hover:bg-bg-primary/40 transition-colors"
      >
        {collapsed
          ? <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
          : <ChevronDown  className="w-3 h-3 text-text-tertiary shrink-0" />}
        <Film className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-text-primary uppercase tracking-wider whitespace-nowrap">
          Final Script
        </span>
        {!collapsed && hasData && (
          <>
            <span className="text-xs text-text-disabled">
              {clipCount} clips &middot; {brollCount} b-roll &middot; {fmtDur(totalEditDuration)}
            </span>
            <div className="flex-1" />
            <button
              className={`flex items-center gap-1 px-2.5 py-0.5 text-xs font-medium rounded border transition-colors ${
                executing
                  ? 'bg-red-500/15 text-red-400 border-red-500/30 hover:bg-red-500/25'
                  : isConnected
                    ? 'bg-accent/12 text-accent border-accent/30 hover:bg-accent/22'
                    : 'text-text-disabled border-border-subtle opacity-50 cursor-not-allowed'
              }`}
              onClick={e => { e.stopPropagation(); executing ? stopExecution() : executeScript() }}
              title={isConnected
                ? (executing ? 'Stop execution' : 'Execute script in iRacing')
                : 'iRacing not connected'}
            >
              {executing
                ? <><Square size={9} className="shrink-0" />&nbsp;Stop</>
                : <><FastForward size={9} className="shrink-0" />&nbsp;Execute Script</>}
            </button>
          </>
        )}
        {!hasData && !collapsed && <div className="flex-1" />}
      </button>

      {!collapsed && (
        <>
          {!hasData ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-1 text-center px-4 bg-bg-secondary">
              <Film className="w-5 h-5 text-text-disabled opacity-35" />
              <span className="text-xs text-text-disabled">No script generated yet.</span>
              <span className="text-xs text-text-disabled/60">
                Click &ldquo;Apply to Timeline&rdquo; in the Score Histogram header.
              </span>
            </div>
          ) : (
            <div className="flex-1 flex min-h-0 overflow-hidden bg-bg-secondary">

              {/* Gutter labels */}
              <div
                className="shrink-0 flex flex-col border-r border-border bg-bg-primary select-none z-10"
                style={{ width: GUTTER_W }}
              >
                <div className="border-b border-border-subtle flex items-center justify-end pr-2"
                     style={{ height: SECTION_H }}>
                  <span className="text-[7px] text-text-disabled uppercase tracking-wider">Sect</span>
                </div>
                <div className="border-b border-border-subtle flex items-center justify-end pr-2"
                     style={{ height: CAM_H }}>
                  <span className="text-[7px] text-text-disabled uppercase tracking-wider">Cam</span>
                </div>
                <div className="border-b border-border-subtle flex items-center justify-end pr-2"
                     style={{ height: EVT_H }}>
                  <span className="text-[7px] text-text-disabled uppercase tracking-wider">Clips</span>
                </div>
                <div style={{ height: TICK_H }} />
              </div>

              {/* Scrollable tracks */}
              <div
                ref={scrollRef}
                className="flex-1 overflow-x-auto overflow-y-hidden"
              >
                <div className="relative" style={{ width: totalW, height: TOTAL_TRACK_H }}>

                  {/* ── Section band row ──────────────────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle"
                       style={{ top: 0, height: SECTION_H }}>
                    {SECTION_ORDER.map(sectionName => {
                      const span   = sectionSpans[sectionName]
                      if (!span) return null
                      const meta   = SECTION_META[sectionName] || SECTION_META.race
                      const left   = toX(span.editStart)
                      const width  = Math.max(4, toX(span.editEnd - span.editStart))
                      return (
                        <div key={sectionName}
                             className="absolute top-0 h-full flex items-center overflow-hidden"
                             style={{
                               left, width,
                               backgroundColor: meta.color,
                               borderRight: `1px solid ${meta.border}`,
                             }}>
                          <span className="truncate select-none"
                                style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.07em',
                                         textTransform: 'uppercase', paddingLeft: 4,
                                         color: meta.text }}>
                            {meta.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Camera track ──────────────────────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle"
                       style={{ top: SECTION_H, height: CAM_H }}>
                    {editSegments.map(seg => {
                      const left  = toX(seg.editStart)
                      const width = Math.max(3, toX(seg.editDur))
                      const camLabel = getCameraLabel(seg)
                      const isActive = activeSegId === seg.id
                      const sectionMeta = SECTION_META[seg.section] || SECTION_META.race
                      const bgColor = isActive ? 'rgba(99,102,241,0.65)' : 'rgba(99,102,241,0.36)'
                      return (
                        <div key={`cam-${seg.id}`}
                             className={`absolute flex items-center overflow-hidden ${isActive ? 'ring-1 ring-white/60' : ''}`}
                             style={{
                               left, width, top: 2, height: CAM_H - 4,
                               backgroundColor: seg.section !== 'race' ? sectionMeta.color.replace('0.20', '0.50').replace('0.15', '0.45').replace('0.28', '0.55') : bgColor,
                               borderLeft: `2px solid ${isActive ? 'rgba(255,255,255,0.6)' : (seg.section !== 'race' ? sectionMeta.border : 'rgba(99,102,241,0.55)')}`,
                             }}
                             title={`${seg.section !== 'race' ? (SECTION_META[seg.section]?.label || seg.section) : ''} Camera: ${camLabel}`}>
                          {width > 18 && (
                            <span className="px-0.5 truncate font-mono leading-none"
                                  style={{ fontSize: 7, color: seg.section !== 'race' ? sectionMeta.text : 'rgba(220,210,255,0.85)' }}>
                              {camLabel}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Events / clips track ──────────────────────────── */}
                  <div className="absolute left-0 right-0 border-b border-border-subtle"
                       style={{ top: SECTION_H + CAM_H, height: EVT_H }}>
                    {editSegments.map(seg => {
                      const left   = toX(seg.editStart)
                      const width  = Math.max(3, toX(seg.editDur))
                      const isActive = activeSegId === seg.id
                      const section = seg.section || 'race'
                      const sectionMeta = SECTION_META[section] || SECTION_META.race

                      // Colour: event type for race clips, section colour for non-race
                      const color = section === 'race' && seg.type !== 'broll'
                        ? (EVENT_COLORS[seg.event_type] || '#f97316')
                        : sectionMeta.border.replace('0.40', '0.80').replace('0.45', '0.80')
                                             .replace('0.48', '0.80').replace('0.55', '0.80')

                      const isBroll  = seg.type === 'broll'
                      const isPip    = seg.segment_type === 'pip'
                      const label    = section !== 'race'
                        ? sectionMeta.label
                        : (EVENT_TYPE_LABELS[seg.event_type] || seg.event_type || 'Clip')

                      const raceTimeLabel = seg.start_time_seconds != null
                        ? formatTime(seg.start_time_seconds)
                        : null

                      return (
                        <div
                          key={`evt-${seg.id}`}
                          className={`absolute overflow-hidden cursor-pointer transition-all ${
                            isActive ? 'ring-2 ring-white/80 z-20' : 'hover:z-10'
                          }`}
                          style={{
                            left, width,
                            top: isBroll ? Math.floor(EVT_H * 0.62) : (isPip ? Math.floor(EVT_H * 0.50) : 2),
                            height: isBroll ? Math.floor(EVT_H * 0.34) : (isPip ? Math.floor(EVT_H * 0.46) : EVT_H - 4),
                            backgroundColor: color,
                            opacity: isActive ? 1 : isBroll ? 0.55 : 0.88,
                            borderLeft: `2px solid ${isActive ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.2)'}`,
                          }}
                          title={[
                            label,
                            raceTimeLabel ? `Race time: ${raceTimeLabel}` : null,
                            `Edit: ${formatTime(seg.editStart)} – ${formatTime(seg.editEnd)}`,
                            `Duration: ${fmtDur(seg.editDur)}`,
                            isBroll ? 'B-roll / gap filler' : null,
                          ].filter(Boolean).join('\n')}
                        >
                          {/* Hatching for b-roll */}
                          {isBroll && (
                            <div className="absolute inset-0 opacity-30"
                                 style={{ backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 3px,rgba(255,255,255,0.25) 3px,rgba(255,255,255,0.25) 6px)' }} />
                          )}
                          {/* PIP stripe */}
                          {isPip && width > 8 && (
                            <div className="absolute right-0 top-0 bottom-0 w-1/4 opacity-35"
                                 style={{ backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 2px,rgba(255,255,255,0.4) 2px,rgba(255,255,255,0.4) 4px)' }} />
                          )}
                          {/* Active pulse */}
                          {isActive && <div className="absolute inset-0 bg-white/12 animate-pulse pointer-events-none" />}
                          {/* Label */}
                          {width > 18 && !isBroll && (
                            <div className="px-0.5 pt-0.5 truncate" style={{ fontSize: 8, lineHeight: '10px' }}>
                              <span className="text-white/92 font-semibold">{label.slice(0, 10)}</span>
                            </div>
                          )}
                          {/* Race time stamp for race clips */}
                          {width > 38 && !isBroll && raceTimeLabel && (
                            <div className="px-0.5 truncate" style={{ fontSize: 7, lineHeight: '9px' }}>
                              <span className="text-white/55 font-mono">{raceTimeLabel}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* ── Edit-time tick ruler ───────────────────────────── */}
                  <EditTickRuler
                    totalW={totalW}
                    totalEditDuration={totalEditDuration}
                    pxPerSec={EDIT_PX_PER_SEC}
                    top={SECTION_H + CAM_H + EVT_H}
                    height={TICK_H}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Edit-time tick ruler ──────────────────────────────────────────────────────
function EditTickRuler({ totalW, totalEditDuration, pxPerSec, top, height }) {
  const ticks = useMemo(() => {
    if (totalEditDuration <= 0 || pxPerSec <= 0) return []
    const rawInterval = 80 / pxPerSec
    const nice = [1, 5, 10, 15, 30, 60, 120, 300, 600]
    const interv = nice.find(v => v >= rawInterval) || 600
    const major  = interv * 5
    const result = []
    for (let t = 0; t <= totalEditDuration + interv; t += interv) {
      result.push({ t, major: t % major === 0 })
    }
    return result
  }, [totalEditDuration, pxPerSec])

  return (
    <div className="absolute left-0 bg-bg-secondary border-t border-border-subtle select-none overflow-hidden"
         style={{ top, height, width: totalW }}>
      {ticks.map(({ t, major }) => (
        <div key={t} className="absolute" style={{ left: t * pxPerSec }}>
          <div className={`absolute top-0 w-px ${major ? 'h-full bg-border' : 'h-1/2 bg-border-subtle'}`} />
          {major && (
            <span className="absolute left-1 top-1 font-mono text-text-disabled whitespace-nowrap" style={{ fontSize: 7 }}>
              {formatTime(t)}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
