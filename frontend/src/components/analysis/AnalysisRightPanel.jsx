import { useRef, useState, useCallback, useEffect, memo } from 'react'
import {
  Eye, Users, ChevronLeft,
} from 'lucide-react'
import { useLocalStorage } from '../../hooks/useLocalStorage'
import CollapsibleSection from '../ui/CollapsibleSection'

/**
 * AnalysisRightPanel — right column showing cameras and drivers.
 * Includes a drag-resize divider on the left edge and full-column collapse.
 */
export default memo(function AnalysisRightPanel({
  isConnected,
  replayState,
  cameraGroups, drivers,
  rightPanelWidth, setRightPanelWidth, isPortrait,
  handleSwitchCamera, handleSwitchDriver,
}) {
  const rightDragRef = useRef(null)
  const [collapsed, setCollapsed] = useState(false)
  const [camerasOpen, setCamerasOpen] = useState(true)
  const [driversOpen, setDriversOpen] = useState(true)
  const [width, setWidth] = useLocalStorage('lrs:analysis:rightWidth', rightPanelWidth)
  const widthRef = useRef(width)
  useEffect(() => { widthRef.current = width }, [width])

  const startResize = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widthRef.current
    const onMove = (mv) => {
      const w = Math.max(200, Math.min(600, startW + (startX - mv.clientX)))
      setWidth(w)
      setRightPanelWidth(w)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [setWidth, setRightPanelWidth])

  if (!isConnected) return null
  if (isPortrait) return null

  /* ---- collapsed = full-height icon bar ---- */
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="shrink-0 w-9 border-l border-border bg-bg-secondary flex flex-col items-center py-2 gap-3
                   hover:bg-bg-primary/50 transition-colors cursor-pointer"
        title="Expand Cameras & Drivers"
      >
        <Eye className="w-4 h-4 text-accent" />
        <Users className="w-4 h-4 text-accent" />
      </button>
    )
  }

  return (
    <>
      {/* Drag-resize divider */}
      <div
        ref={rightDragRef}
        className="shrink-0 cursor-col-resize group/divider relative"
        style={{ width: 1, marginLeft: -1 }}
        onMouseDown={startResize}
      >
        <div className="absolute inset-y-0 -left-2 -right-2 z-20" />
        <div className="absolute inset-y-0 left-0 w-px bg-border transition-colors group-hover/divider:bg-accent group-active/divider:bg-accent" />
      </div>

      {/* Right panel */}
      <div className="flex flex-col gap-0 shrink-0 overflow-hidden bg-bg-secondary"
           style={{ width }}>

        {/* Header — click to collapse */}
        <button
          onClick={() => setCollapsed(true)}
          className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 w-full text-left hover:bg-bg-primary/50 transition-colors"
        >
          <Eye className="w-4 h-4 text-accent" />
          <h3 className="text-xs font-semibold text-text-primary uppercase tracking-wider flex-1">
            Cameras & Drivers
          </h3>
          <ChevronLeft className="w-3 h-3 text-text-tertiary" />
        </button>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          {/* Cameras section */}
          <div className="border-b border-border overflow-hidden flex flex-col"
                 style={{ maxHeight: camerasOpen ? '40%' : 'auto' }}>
            <div className="shrink-0 px-3 py-2 border-b border-border">
              <CollapsibleSection
                icon={Eye}
                label="Cameras"
                open={camerasOpen}
                onToggle={() => setCamerasOpen(v => !v)}
                right={replayState?.cam_group_num != null && cameraGroups.find(c => c.group_num === replayState.cam_group_num) ? (
                  <span className="text-xxs text-accent truncate">
                    {cameraGroups.find(c => c.group_num === replayState.cam_group_num)?.group_name}
                  </span>
                ) : null}
              />
            </div>
            {camerasOpen && (
              <div className="flex-1 overflow-y-auto">
                {cameraGroups.map(cam => (
                  <button key={cam.group_num}
                    onClick={() => handleSwitchCamera(cam.group_num)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                               hover:bg-bg-hover transition-colors border-b border-border-subtle/30
                               ${replayState?.cam_group_num === cam.group_num
                                 ? 'bg-accent/10 text-accent font-medium'
                                 : 'text-text-secondary'}`}>
                    <Eye size={10} className={replayState?.cam_group_num === cam.group_num ? 'text-accent' : 'text-text-disabled'} />
                    <span className="truncate">{cam.group_name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Drivers section */}
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <div className="shrink-0 px-3 py-2 border-b border-border">
              <CollapsibleSection
                icon={Users}
                label="Drivers"
                open={driversOpen}
                onToggle={() => setDriversOpen(v => !v)}
                right={replayState?.cam_car_idx != null && drivers.find(d => d.car_idx === replayState.cam_car_idx) ? (
                  <span className="text-xxs text-accent truncate">
                    {drivers.find(d => d.car_idx === replayState.cam_car_idx)?.user_name}
                  </span>
                ) : null}
              />
            </div>
            {driversOpen && (
              <div className="flex-1 overflow-y-auto">
                {drivers.filter(d => !d.is_spectator).map(d => (
                  <button key={d.car_idx}
                    onClick={() => handleSwitchDriver(d.car_idx)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xxs
                               hover:bg-bg-hover transition-colors border-b border-border-subtle/30
                               ${replayState?.cam_car_idx === d.car_idx
                                 ? 'bg-accent/10 text-accent font-medium'
                                 : 'text-text-secondary'}`}>
                    <span className="font-mono shrink-0 w-5 text-right">#{d.car_number}</span>
                    <span className="truncate">{d.user_name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
})
