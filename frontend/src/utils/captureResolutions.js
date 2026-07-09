import captureResolutionConfig from '../../../shared/capture_resolutions.json'

export const DEFAULT_CAPTURE_RESOLUTION_ID = captureResolutionConfig.default || '1080p'

export const CAPTURE_RESOLUTION_OPTIONS = (captureResolutionConfig.presets || []).map((preset) => ({
  id: preset.id,
  label: preset.label || preset.id,
  width: Number(preset.width),
  height: Number(preset.height),
  detail: `${Number(preset.width)} x ${Number(preset.height)}`,
  description: preset.description || '',
}))

export function isCaptureResolutionId(value) {
  return CAPTURE_RESOLUTION_OPTIONS.some((preset) => preset.id === value)
}
