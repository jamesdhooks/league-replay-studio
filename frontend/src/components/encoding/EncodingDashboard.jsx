import { useMemo } from 'react'
import { useEncoding } from '../../context/EncodingContext'
import { formatFileSize } from '../../utils/format'
import { formatTime } from '../../utils/time'
import {
  Cpu, Zap, Activity, HardDrive, Clock, Film, Timer,
} from 'lucide-react'

/**
 * EncodingDashboard — Real-time encoding metrics with GPU utilisation gauge.
 *
 * Shows: FPS, percentage, ETA, output file size, speed, GPU utilisation gauge,
 * and encoder label.
 *
 * @param {Object} props
 * @param {Object} props.job - Active encoding job with progress data
 * @param {Object} props.gpuInfo - GPU detection result
 */
export default function EncodingDashboard({ job, gpuInfo }) {
  if (!job) return null

  const progress = job.progress || {}
  const pct = progress.percentage || 0
  const eta = progress.eta_seconds
  const fps = progress.fps || 0
  const speed = progress.speed || ''
  const bitrate = progress.bitrate || ''
  const elapsed = job.elapsed_seconds || 0

  // Parse speed multiplier for GPU gauge (e.g. "2.5x" → 2.5)
  const speedMultiplier = useMemo(() => {
    if (!speed) return 0
    const match = speed.match(/([\d.]+)\s*x/i)
    return match ? parseFloat(match[1]) : 0
  }, [speed])

  // GPU utilisation: prefer measured telemetry from nvidia-smi, fall back to estimate
  const gpuTelemetry = job.gpu_telemetry
  const gpuUtil = useMemo(() => {
    // If we have measured telemetry from nvidia-smi, use it
    if (gpuTelemetry && typeof gpuTelemetry.utilization === 'number') {
      return gpuTelemetry.utilization
    }

    // Otherwise, estimate from FFmpeg telemetry
    if (speedMultiplier > 0) {
      // Very fast encode usually means lower stress; near-realtime usually higher.
      if (speedMultiplier >= 3) return 30
      if (speedMultiplier >= 2) return 45
      if (speedMultiplier >= 1.25) return 62
      if (speedMultiplier >= 1) return 75
      if (speedMultiplier >= 0.75) return 88
      return 96
    }

    const targetFps = Number(job.preset?.fps) || 60
    if (fps > 0 && targetFps > 0) {
      const ratio = fps / targetFps
      if (ratio >= 2) return 35
      if (ratio >= 1) return 60
      return Math.min(100, Math.round(100 - (ratio * 40)))
    }

    return 0
  }, [gpuTelemetry, speedMultiplier, fps, job.preset?.fps])

  const isGpuEncoder = job.encoder?.type === 'gpu'

  return (
    <div className="space-y-3">
      {/* Progress bar with percentage */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-medium text-accent">
              Encoding{job.preset?.name ? ` · ${job.preset.name}` : ''}
            </span>
          </div>
          <span className="text-xs font-mono text-text-primary">{pct.toFixed(1)}%</span>
        </div>
        <div className="w-full bg-bg-primary rounded-full h-2">
          <div
            className="bg-accent h-2 rounded-full transition-all duration-300"
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-3 gap-2">
        <DashMetric icon={Film} label="Progress" value={`${pct.toFixed(1)}%`} />
        <DashMetric icon={Clock} label="ETA" value={eta != null ? formatTime(eta) : '—'} />
        <DashMetric icon={Zap} label="FPS" value={fps > 0 ? fps.toFixed(0) : '—'} />
        <DashMetric icon={Activity} label="Speed" value={speed || '—'} />
        <DashMetric icon={HardDrive} label="Bitrate" value={bitrate || '—'} />
        <DashMetric icon={Timer} label="Elapsed" value={elapsed > 0 ? formatTime(elapsed) : '—'} />
      </div>

      {/* GPU Utilisation Gauge */}
      <div className="bg-bg-primary border border-border rounded-md p-3">
        <div className="flex items-center gap-2 mb-2">
          {isGpuEncoder ? (
            <Zap className="w-3.5 h-3.5 text-accent" />
          ) : (
            <Cpu className="w-3.5 h-3.5 text-text-tertiary" />
          )}
          <span className="text-xs font-medium text-text-primary">
            {isGpuEncoder ? 'GPU' : 'CPU'} Utilisation
            {gpuTelemetry && <span className="text-xxs text-text-tertiary ml-1">(measured)</span>}
          </span>
          <div className="flex-1" />
          <span className="text-xs font-mono text-text-secondary">{gpuUtil}%</span>
        </div>

        {/* Gauge bar */}
        <div className="w-full bg-bg-secondary rounded-full h-3 overflow-hidden">
          <div
            className={`h-3 rounded-full transition-all duration-500 ${
              gpuUtil > 85 ? 'bg-danger' :
              gpuUtil > 60 ? 'bg-warning' :
              'bg-accent'
            }`}
            style={{ width: `${gpuUtil}%` }}
          />
        </div>

        {/* GPU telemetry details */}
        {gpuTelemetry && (
          <div className="grid grid-cols-3 gap-2 mt-2 text-xxs">
            <div>
              <div className="text-text-tertiary">Memory</div>
              <div className="text-text-primary font-mono">
                {gpuTelemetry.memory_percent}%
              </div>
            </div>
            <div>
              <div className="text-text-tertiary">Temp</div>
              <div className="text-text-primary font-mono">
                {gpuTelemetry.temperature_c}°C
              </div>
            </div>
            {gpuTelemetry.power_draw_w !== null && (
              <div>
                <div className="text-text-tertiary">Power</div>
                <div className="text-text-primary font-mono">
                  {gpuTelemetry.power_draw_w.toFixed(1)}W
                </div>
              </div>
            )}
          </div>
        )}

        {/* Encoder info */}
        <div className="flex items-center justify-between mt-2">
          <span className="text-xxs text-text-tertiary">
            {job.encoder?.label || 'Unknown encoder'}
          </span>
          {gpuInfo?.gpu_vendors?.length > 0 && (
            <span className="text-xxs text-text-tertiary">
              {gpuInfo.gpu_vendors.join(', ')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}


function DashMetric({ icon: Icon, label, value }) {
  return (
    <div className="bg-bg-primary rounded-md px-2.5 py-2 border border-border">
      <div className="flex items-center gap-1 mb-0.5">
        <Icon className="w-3 h-3 text-text-disabled" />
        <span className="text-xxs text-text-tertiary">{label}</span>
      </div>
      <span className="text-sm font-mono text-text-primary leading-tight">{value}</span>
    </div>
  )
}
