import { formatTime } from '../../utils/time'
import {
  Clock, Trash2, Film, Square, Zap, HardDrive, Layers,
} from 'lucide-react'

/**
 * JobQueue — renders queued and other-project active encoding jobs
 * with progress bars and cancel controls.
 *
 * @param {Object}   props
 * @param {Array}    props.activeJobs  - all active encoding jobs
 * @param {Array}    props.queuedJobs  - waiting jobs
 * @param {number}   props.projectId   - current project (excluded from "other active")
 * @param {Function} props.onCancel    - (jobId) => void
 */
export default function JobQueue({ activeJobs, queuedJobs, projectId, onCancel }) {
  const otherActiveJobs = activeJobs.filter(j => j.project_id !== projectId)

  if (queuedJobs.length === 0 && otherActiveJobs.length === 0) return null

  return (
    <>
      {/* Queued jobs */}
      {queuedJobs.length > 0 && (
        <Section icon={Layers} title={`Queue (${queuedJobs.length})`}>
          <div className="space-y-1.5">
            {queuedJobs.map(job => (
              <div key={job.job_id} className="flex items-center gap-2 px-3 py-2 bg-bg-primary border border-border rounded-md">
                <Clock className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-text-secondary truncate">
                    {job.preset?.name || 'Custom'} · {job.job_type}
                  </div>
                </div>
                <button
                  onClick={() => onCancel(job.job_id)}
                  className="p-1 rounded hover:bg-bg-hover text-text-tertiary hover:text-danger transition-colors"
                  title="Cancel"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Other active encodes */}
      {otherActiveJobs.length > 0 && (
        <Section icon={Film} title="Other Active Encodes">
          <div className="space-y-2">
            {otherActiveJobs.map(job => (
              <JobProgress key={job.job_id} job={job} onCancel={onCancel} compact />
            ))}
          </div>
        </Section>
      )}
    </>
  )
}


// ── Local helpers (mirror the originals from EncodingPanel) ────────────────

function Section({ icon: Icon, title, children }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5 text-text-tertiary" />
        <h3 className="text-xxs font-semibold text-text-tertiary uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function MetricBox({ icon: Icon, label, value }) {
  return (
    <div className="bg-bg-secondary rounded px-2.5 py-1.5">
      <div className="flex items-center gap-1 mb-0.5">
        <Icon className="w-3 h-3 text-text-disabled" />
        <span className="text-xxs text-text-tertiary">{label}</span>
      </div>
      <span className="text-sm font-mono text-text-primary">{value}</span>
    </div>
  )
}

function JobProgress({ job, onCancel, compact = false }) {
  const progress = job.progress || {}
  const pct = progress.percentage || 0
  const eta = progress.eta_seconds
  const fps = progress.fps || 0
  const speed = progress.speed || ''

  return (
    <div className="bg-bg-primary border border-border rounded-md p-3 space-y-2">
      {/* Status */}
      <div className="flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse" />
        <span className="text-xs font-medium text-accent">
          Encoding{job.preset?.name ? ` · ${job.preset.name}` : ''}
        </span>
        <div className="flex-1" />
        {job.encoder?.label && (
          <span className="text-xxs text-text-tertiary">{job.encoder.label}</span>
        )}
      </div>

      {/* Progress bar */}
      <div className="w-full bg-bg-secondary rounded-full h-1.5">
        <div
          className="bg-accent h-1.5 rounded-full transition-all duration-300"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>

      {/* Metrics */}
      {!compact && (
        <div className="grid grid-cols-2 gap-2">
          <MetricBox icon={Film} label="Progress" value={`${pct.toFixed(1)}%`} />
          <MetricBox icon={Clock} label="ETA" value={eta != null ? formatTime(eta) : '—'} />
          <MetricBox icon={Zap} label="FPS" value={fps > 0 ? fps.toFixed(0) : '—'} />
          <MetricBox icon={HardDrive} label="Speed" value={speed || '—'} />
        </div>
      )}

      {compact && (
        <div className="flex items-center gap-3 text-xxs text-text-tertiary">
          <span>{pct.toFixed(1)}%</span>
          {eta != null && <span>ETA {formatTime(eta)}</span>}
          {fps > 0 && <span>{fps.toFixed(0)} fps</span>}
        </div>
      )}

      {/* Cancel button */}
      <button
        onClick={() => onCancel(job.job_id)}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs
          font-medium bg-danger hover:bg-danger/90 text-white transition-colors"
      >
        <Square className="w-3.5 h-3.5" />
        Cancel Encoding
      </button>
    </div>
  )
}
