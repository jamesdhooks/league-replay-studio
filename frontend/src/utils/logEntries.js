export function normalizePipelineLogEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry, idx) => ({
    id: entry.id || `pipeline-${idx}`,
    ts: Number(entry.ts || 0),
    level: entry.level || 'info',
    step: entry.step || 'pipeline',
    message: entry.message || '',
    detail: entry.detail || '',
  }))
}

export function normalizeAnalysisLogEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry, idx) => ({
    id: entry.id || `analysis-${idx}`,
    ts: Number(entry.ts || 0) > 1e12 ? Number(entry.ts) / 1000 : Number(entry.ts || 0),
    level: entry.level || 'info',
    step: 'analysis',
    message: entry.message || '',
    detail: entry.detail || '',
  }))
}

export function normalizeCaptureLogEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry, idx) => ({
    id: `capture-${entry.timestamp || idx}-${entry.segment_id || ''}-${entry.action || ''}`,
    ts: Number(entry.timestamp || 0),
    level: entry.success === false ? 'error' : (entry.action === 'retry' ? 'warning' : 'info'),
    step: 'capture',
    message: entry.detail || entry.action || 'Capture update',
    detail: [entry.segment_id, entry.attempt > 1 ? `attempt ${entry.attempt}` : ''].filter(Boolean).join(' · '),
  }))
}

export function normalizeCompositionLogEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry, idx) => ({
    id: `compose-${entry.timestamp || idx}-${entry.step_name || ''}`,
    ts: Number(entry.timestamp || 0),
    level: entry.success === false ? 'error' : (String(entry.step_name || '').toLowerCase() === 'complete' ? 'success' : 'info'),
    step: 'compose',
    message: entry.detail || entry.step_name || 'Compose update',
    detail: entry.segment_id || '',
  }))
}

export function normalizeEncodingLogEntries(entries = []) {
  return (Array.isArray(entries) ? entries : []).map((entry, idx) => ({
    id: `export-${entry.ts || idx}`,
    ts: Number(entry.ts || 0),
    level: entry.level || 'info',
    step: 'export',
    message: entry.message || '',
    detail: entry.detail || '',
  }))
}

export function normalizeUploadEntries(activeUpload, history = []) {
  const entries = []
  const pick = activeUpload || (Array.isArray(history) ? history[0] : null)
  if (!pick) return entries

  const progress = pick.progress ?? pick.percentage ?? pick.progress_percent
  const state = pick.state || pick.status || 'uploading'
  const detailParts = []

  if (progress != null) detailParts.push(`${Math.round(Number(progress) || 0)}%`)
  if (pick.video_id) detailParts.push(`video ${pick.video_id}`)

  entries.push({
    id: `upload-${pick.job_id || pick.video_id || 'latest'}`,
    ts: Number(pick.updated_at || pick.started_at || Date.now() / 1000),
    level: state === 'error' ? 'error' : state === 'completed' ? 'success' : 'info',
    step: 'upload',
    message: pick.message || `Upload ${state}`,
    detail: detailParts.join(' · '),
  })

  return entries
}
