import { useMemo, useState } from 'react'
import { useHighlight } from '../../context/HighlightContext'
import { useTimeline, EVENT_COLORS } from '../../context/TimelineContext'

/** Section display colors */
const SECTION_COLORS = {
  intro: '#8b5cf6',              // Purple
  qualifying_results: '#06b6d4', // Cyan
  race: 'transparent',           // Race events use EVENT_COLORS
  race_results: '#f59e0b',       // Amber
}

/** Section labels for display */
const SECTION_LABELS = {
  intro: 'Intro',
  qualifying_results: 'Qualifying',
  race: 'Race',
  race_results: 'Results',
}

/**
 * HighlightTimeline — Condensed mini-timeline showing all events.
 *
 * Now includes four sections (intro, qualifying, race, results)
 * with distinct visual regions. Non-race sections are shown as
 * solid colored blocks that can be clicked to select for editing.
 *
 * Included events are bright and fully opaque.
 * Excluded events are dimmed with striped pattern, showing what was NOT selected.
 * Gives a clear visual overview of the editing decisions.
 */
export default function HighlightTimeline() {
  const { selection, metrics, videoScript, videoSections, updateSectionConfig } = useHighlight()
  const { raceDuration, seekTo, playheadTime } = useTimeline()
  const [selectedSection, setSelectedSection] = useState(null)

  const { highlightEvents, fullVideoEvents, excludedEvents } = useMemo(() => {
    const sorted = [...selection.scoredEvents].sort((a, b) => a.start_time_seconds - b.start_time_seconds)
    return {
      highlightEvents: sorted.filter(e => e.inclusion === 'highlight'),
      fullVideoEvents: sorted.filter(e => e.inclusion === 'full-video'),
      excludedEvents: sorted.filter(e => e.inclusion === 'excluded'),
    }
  }, [selection.scoredEvents])

  // Compute section regions from videoScript
  const sectionRegions = useMemo(() => {
    if (!videoScript || videoScript.length === 0) return []
    const regions = {}
    for (const seg of videoScript) {
      const section = seg.section || 'race'
      if (!regions[section]) {
        regions[section] = {
          name: section,
          start: seg.start_time_seconds || 0,
          end: seg.end_time_seconds || 0,
          segments: [],
        }
      } else {
        regions[section].start = Math.min(regions[section].start, seg.start_time_seconds || 0)
        regions[section].end = Math.max(regions[section].end, seg.end_time_seconds || 0)
      }
      regions[section].segments.push(seg)
    }
    return Object.values(regions)
  }, [videoScript])

  // Use race duration or compute total from script
  const totalDuration = useMemo(() => {
    if (raceDuration > 0) return raceDuration
    if (sectionRegions.length > 0) {
      return Math.max(...sectionRegions.map(r => r.end), 0)
    }
    return 0
  }, [raceDuration, sectionRegions])

  if (totalDuration <= 0) {
    return (
      <div className="h-full flex items-center justify-center text-text-disabled text-xxs">
        No timeline data
      </div>
    )
  }

  const handleClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const time = (x / rect.width) * totalDuration
    seekTo(time)
  }

  const playheadPct = (playheadTime / totalDuration) * 100

  return (
    <div className="h-full flex flex-col px-3 py-1.5 bg-bg-secondary">
      {/* Label row with legend */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <span className="text-xxs text-text-tertiary font-medium">
            Highlight Timeline
          </span>
          <span className="flex items-center gap-1 text-xxs text-text-disabled">
            <span className="inline-block w-2 h-2 rounded-sm bg-accent" /> Highlight
          </span>
          <span className="flex items-center gap-1 text-xxs text-text-disabled">
            <span className="inline-block w-2 h-2 rounded-sm bg-info opacity-50" /> Full-video
          </span>
          <span className="flex items-center gap-1 text-xxs text-text-disabled">
            <span className="inline-block w-2 h-2 rounded-sm bg-text-disabled opacity-20" /> Excluded
          </span>
          {/* Section legend */}
          {sectionRegions.length > 0 && (
            <>
              <span className="text-xxs text-text-disabled mx-1">│</span>
              {Object.entries(SECTION_COLORS).filter(([k]) => k !== 'race').map(([key, color]) => (
                <span key={key} className="flex items-center gap-1 text-xxs text-text-disabled">
                  <span
                    className="inline-block w-2 h-2 rounded-sm"
                    style={{ backgroundColor: color }}
                  />
                  {SECTION_LABELS[key]}
                </span>
              ))}
            </>
          )}
        </div>
        <span className="text-xxs text-text-disabled font-mono">
          {metrics.eventCount} highlight + {metrics.fullVideoCount || 0} full · {formatCompactDuration(metrics.duration)}
        </span>
      </div>

      {/* Timeline bar */}
      <div
        className="flex-1 relative bg-bg-primary rounded cursor-pointer overflow-hidden min-h-[16px]"
        onClick={handleClick}
      >
        {/* Section region backgrounds (non-race) */}
        {sectionRegions.filter(r => r.name !== 'race').map(region => {
          const left = (region.start / totalDuration) * 100
          const width = Math.max(0.5, ((region.end - region.start) / totalDuration) * 100)
          const color = SECTION_COLORS[region.name] || '#666'
          const isSelected = selectedSection === region.name

          return (
            <div
              key={`section-${region.name}`}
              className={`absolute top-0 bottom-0 rounded-sm cursor-pointer transition-opacity ${
                isSelected ? 'ring-2 ring-white/40' : ''
              }`}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: isSelected ? 0.6 : 0.3,
              }}
              onClick={(e) => {
                e.stopPropagation()
                setSelectedSection(prev => prev === region.name ? null : region.name)
              }}
              title={`${SECTION_LABELS[region.name] || region.name} (${formatCompactDuration(region.end - region.start)})`}
            >
              {width > 3 && (
                <span className="absolute inset-0 flex items-center justify-center text-white/80 text-xxs font-semibold truncate px-0.5">
                  {SECTION_LABELS[region.name]}
                </span>
              )}
            </div>
          )
        })}

        {/* Excluded event segments (background, dimmed) */}
        {excludedEvents.map(evt => {
          const left = (evt.start_time_seconds / totalDuration) * 100
          const width = Math.max(0.15, ((evt.end_time_seconds - evt.start_time_seconds) / totalDuration) * 100)
          const color = EVENT_COLORS[evt.event_type] || '#666'

          return (
            <div
              key={`ex-${evt.id}`}
              className="absolute top-0 bottom-0 rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: 0.12,
              }}
              title={`✗ ${evt.event_type} [${evt.tier || '?'}] (score ${evt.score}) — ${evt.reason}`}
            />
          )
        })}

        {/* Full-video event segments (mid brightness) */}
        {fullVideoEvents.map(evt => {
          const left = (evt.start_time_seconds / totalDuration) * 100
          const width = Math.max(0.15, ((evt.end_time_seconds - evt.start_time_seconds) / totalDuration) * 100)
          const color = EVENT_COLORS[evt.event_type] || '#666'

          return (
            <div
              key={`fv-${evt.id}`}
              className="absolute top-0 bottom-0 rounded-sm border border-white/10"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: 0.4,
              }}
              title={`○ ${evt.event_type} [${evt.tier || '?'}] (score ${evt.score}) — full-video only`}
            />
          )
        })}

        {/* Highlight event segments (foreground, bright) */}
        {highlightEvents.map(evt => {
          const left = (evt.start_time_seconds / totalDuration) * 100
          const width = Math.max(0.2, ((evt.end_time_seconds - evt.start_time_seconds) / totalDuration) * 100)
          const color = EVENT_COLORS[evt.event_type] || '#666'

          return (
            <div
              key={`hl-${evt.id}`}
              className="absolute top-0 bottom-0 rounded-sm ring-1 ring-white/20"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                backgroundColor: color,
                opacity: 0.85,
              }}
              title={`✓ ${evt.event_type} [${evt.tier || '?'}] (score ${evt.score})`}
            />
          )
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-accent z-10"
          style={{ left: `${playheadPct}%` }}
        />
      </div>

      {/* Section editor (when a non-race section is selected) */}
      {selectedSection && selectedSection !== 'race' && (
        <SectionEditor
          sectionName={selectedSection}
          region={sectionRegions.find(r => r.name === selectedSection)}
          onUpdate={updateSectionConfig}
          onClose={() => setSelectedSection(null)}
        />
      )}
    </div>
  )
}

/**
 * SectionEditor — Inline editor for non-race section properties.
 * Allows changing duration and camera preference.
 */
function SectionEditor({ sectionName, region, onUpdate, onClose }) {
  const duration = region ? (region.end - region.start) : 10
  const segment = region?.segments?.[0] || {}
  const camPrefs = segment.camera_preferences || []
  const currentCam = segment.camera_group

  return (
    <div className="mt-1.5 p-2 bg-bg-tertiary rounded border border-border-subtle text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium text-text-secondary">
          {SECTION_LABELS[sectionName] || sectionName} Section
        </span>
        <button
          className="text-text-disabled hover:text-text-primary text-xxs"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1.5">
          <span className="text-text-tertiary">Duration:</span>
          <input
            type="number"
            className="w-16 px-1.5 py-0.5 bg-bg-primary border border-border rounded text-text-primary text-xs"
            value={Math.round(duration)}
            min={3}
            max={60}
            step={1}
            onChange={(e) => onUpdate(sectionName, { duration: Number(e.target.value) })}
          />
          <span className="text-text-disabled">sec</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-text-tertiary">Camera:</span>
          <select
            className="px-1.5 py-0.5 bg-bg-primary border border-border rounded text-text-primary text-xs"
            value={currentCam || ''}
            onChange={(e) => onUpdate(sectionName, {
              camera_group: e.target.value ? Number(e.target.value) : null,
            })}
          >
            <option value="">Auto ({camPrefs[0] || 'Default'})</option>
            {/* Dynamic camera options would come from iRacing bridge */}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-text-tertiary">Start:</span>
          <input
            type="number"
            className="w-20 px-1.5 py-0.5 bg-bg-primary border border-border rounded text-text-primary text-xs"
            value={Math.round(region?.start || 0)}
            min={0}
            step={1}
            onChange={(e) => onUpdate(sectionName, { start_time_seconds: Number(e.target.value) })}
          />
          <span className="text-text-disabled">sec</span>
        </label>
      </div>
    </div>
  )
}


function formatCompactDuration(seconds) {
  if (!seconds) return '0s'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
