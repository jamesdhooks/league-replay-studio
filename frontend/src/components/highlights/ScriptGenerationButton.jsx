import { Download, Loader2 } from 'lucide-react'
import { useHighlight } from '../../context/HighlightContext'
import { useIRacing } from '../../context/IRacingContext'
import { useModal } from '../../context/ModalContext'
import { useScriptState } from '../../context/ScriptStateContext'
import { useToast } from '../../context/ToastContext'
import { formatDuration } from '../../utils/time'

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function IdList({ label, ids, tone = 'text-text-secondary' }) {
  if (!ids?.length) return null
  return (
    <div>
      <div className={`mb-1 text-xs font-medium ${tone}`}>{label} ({ids.length})</div>
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
        {ids.map((id) => (
          <span key={id} className="border border-border bg-bg-primary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
            {id}
          </span>
        ))}
      </div>
    </div>
  )
}

function ImpactReport({ impact }) {
  const hasCaptureLoss = (impact.invalidated || 0) > 0
  return (
    <div className="space-y-4 text-sm text-text-secondary">
      <p>
        The current script will be replaced. Captures that no longer match will be moved to the project Trash Bin.
      </p>

      <div className="grid grid-cols-2 gap-px overflow-hidden border border-border bg-border sm:grid-cols-3">
        {[
          ['Captured now', impact.captured_before || 0],
          ['Retained', impact.retained || 0],
          ['Discarded events', impact.invalidated || 0],
          ['Files archived', impact.discarded_clip_count || 0],
          ['New script events', impact.new_segment_ids?.length || 0],
          ['Capture required', impact.to_capture || 0],
        ].map(([label, value]) => (
          <div key={label} className="bg-bg-secondary px-3 py-2.5">
            <div className="text-lg font-semibold tabular-nums text-text-primary">{value}</div>
            <div className="text-[10px] uppercase tracking-wider text-text-disabled">{label}</div>
          </div>
        ))}
      </div>

      {hasCaptureLoss ? (
        <div className="space-y-3 border border-danger/30 bg-danger/5 p-3">
          <div>
            <div className="font-semibold text-danger">Captured work that will be archived</div>
            <div className="mt-0.5 text-xs text-text-tertiary">
              {formatDuration(impact.discarded_duration_seconds || 0)} across {impact.discarded_clip_count || 0} files · {formatBytes(impact.discarded_bytes)}
            </div>
          </div>
          <IdList label="Changed events" ids={impact.changed_segment_ids} tone="text-danger" />
          <IdList label="Removed events" ids={impact.removed_segment_ids} tone="text-danger" />
          <IdList label="Shared-file dependants" ids={impact.collateral_segment_ids} tone="text-warning" />
          {impact.discarded_clips?.length > 0 && (
            <div className="space-y-1.5">
              {impact.discarded_clips.map((clip) => (
                <div key={clip.clip_path} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-danger/20 pt-1.5 text-xs">
                  <div className="min-w-0 truncate font-mono text-text-secondary" title={clip.clip_path}>{clip.file_name}</div>
                  <div className="whitespace-nowrap tabular-nums text-text-disabled">
                    {clip.segment_ids?.length || 0} events · {formatDuration(clip.duration_seconds)} · {formatBytes(clip.size_bytes)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="border border-success/30 bg-success/5 px-3 py-2.5 text-xs text-success">
          No completed captures will be lost.
        </div>
      )}

      <IdList label="New events added" ids={impact.new_segment_ids} />
      <IdList label="Uncaptured events removed" ids={impact.removed_uncaptured_segment_ids} />
      <p className="text-xs text-text-disabled">
        Archived files are recoverable from the Trash Bin until it is emptied.
      </p>
    </div>
  )
}

export default function ScriptGenerationButton({ projectId, hasExistingScript }) {
  const { applyHighlights, generateVideoScript, serverScoring } = useHighlight()
  const { sessionData } = useIRacing()
  const { openModal } = useModal()
  const { fetchState } = useScriptState()
  const { showInfo, showSuccess, showError } = useToast()

  const commitGeneration = async () => {
    showInfo(hasExistingScript ? 'Re-generating race script...' : 'Generating race script...')
    const result = await generateVideoScript(projectId, {
      cameras: sessionData?.cameras,
      persist: true,
    })
    await fetchState(projectId)
    const archived = result.regeneration_impact?.archived_clip_count || 0
    showSuccess(archived > 0
      ? `Race script regenerated; ${archived} capture file${archived === 1 ? '' : 's'} archived`
      : 'Race script generated')
  }

  const handleGenerate = async () => {
    if (!projectId || serverScoring) return
    try {
      await applyHighlights(projectId)
      if (!hasExistingScript) {
        await commitGeneration()
        return
      }

      showInfo('Preparing regeneration impact...')
      const preview = await generateVideoScript(projectId, {
        cameras: sessionData?.cameras,
        persist: false,
      })
      const impact = preview.regeneration_impact || {}
      openModal(`regenerate-script-${projectId}`, 'confirm', {
        title: 'Re-Generate Script?',
        message: <ImpactReport impact={impact} />,
        danger: true,
        confirmText: (impact.discarded_clip_count || 0) > 0
          ? 'Archive Captures and Re-Generate'
          : 'Re-Generate Script',
        confirmingText: 'Re-Generating...',
        cancelText: 'Keep Current Script',
        onConfirm: async () => {
          try {
            await commitGeneration()
          } catch (error) {
            console.error('[Highlights] Script regeneration failed:', error)
            showError('Failed to regenerate race script')
            throw error
          }
        },
      })
    } catch (error) {
      console.error('[Highlights] Script generation failed:', error)
      showError(hasExistingScript ? 'Failed to prepare script regeneration' : 'Failed to generate race script')
    }
  }

  return (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={serverScoring}
      className="flex items-center gap-1.5 rounded bg-accent px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
    >
      {serverScoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      {serverScoring
        ? (hasExistingScript ? 'Preparing...' : 'Generating...')
        : (hasExistingScript ? 'Re-Generate Script' : 'Generate Script')}
    </button>
  )
}
