import { useMemo } from 'react'
import { CheckCircle2, XCircle, Zap, Cpu, RefreshCw } from 'lucide-react'

/**
 * GPUStatus — displays GPU detection results, FFmpeg availability,
 * best encoder info, and a refresh button.
 *
 * @param {Object}   props
 * @param {Object|null} props.gpuInfo   - GPU detection result from backend
 * @param {Function} props.onRefresh    - callback to re-run GPU detection
 */
export default function GPUStatus({ gpuInfo, onRefresh }) {
  const bestEncoder = useMemo(() => {
    if (!gpuInfo) return null
    return gpuInfo.best_h264 || null
  }, [gpuInfo])

  if (!gpuInfo) {
    return <div className="text-xs text-text-tertiary italic">Detecting GPU capabilities…</div>
  }

  return (
    <div className="space-y-2">
      {/* FFmpeg status */}
      <div className="flex items-center gap-2 px-3 py-2 bg-bg-primary border border-border rounded-md">
        {gpuInfo.ffmpeg_available ? (
          <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
        ) : (
          <XCircle className="w-4 h-4 text-danger shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-text-primary">
            FFmpeg {gpuInfo.ffmpeg_available ? 'Available' : 'Not Found'}
          </div>
          {gpuInfo.ffmpeg_version && (
            <div className="text-xxs text-text-tertiary font-mono truncate">
              v{gpuInfo.ffmpeg_version}
            </div>
          )}
        </div>
      </div>

      {/* Best encoder */}
      {bestEncoder && (
        <div className={`flex items-center gap-2 px-3 py-2 rounded-md border
          ${bestEncoder.type === 'gpu'
            ? 'bg-accent/5 border-accent/30'
            : 'bg-bg-primary border-border'
          }`}>
          {bestEncoder.type === 'gpu' ? (
            <Zap className="w-4 h-4 text-accent shrink-0" />
          ) : (
            <Cpu className="w-4 h-4 text-text-tertiary shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-text-primary">{bestEncoder.label}</div>
            <div className="text-xxs text-text-tertiary">
              {bestEncoder.type === 'gpu' ? 'Hardware accelerated' : 'CPU fallback'}
              {' · '}{bestEncoder.ffmpeg_codec}
            </div>
          </div>
        </div>
      )}

      {/* Available encoders summary */}
      {gpuInfo.encoders && (
        <div className="text-xxs text-text-tertiary">
          {gpuInfo.encoders.filter(e => e.available).length} encoder(s) available
          {gpuInfo.gpu_vendors?.length > 0 && ` · GPU: ${gpuInfo.gpu_vendors.join(', ')}`}
        </div>
      )}

      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 px-2 py-1 rounded text-xxs text-text-secondary
                   hover:text-text-primary hover:bg-bg-hover transition-colors"
      >
        <RefreshCw className="w-3 h-3" />
        Refresh
      </button>
    </div>
  )
}
