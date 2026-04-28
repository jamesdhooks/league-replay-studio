const PADDING_TYPE_ALIASES = {
  race_start: 'first_lap',
  race_finish: 'last_lap',
}

function normalizeEventTypeKey(eventType) {
  if (!eventType) return ''
  return String(eventType).trim().toLowerCase().replace(/[\s-]+/g, '_')
}

function uniqueKeys(keys) {
  const out = []
  const seen = new Set()
  for (const key of keys) {
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function getPaddingLookupKeys(eventType) {
  const normalized = normalizeEventTypeKey(eventType)
  const alias = PADDING_TYPE_ALIASES[normalized]
  return uniqueKeys([eventType, normalized, alias])
}

/**
 * Resolve per-type padding settings, supporting normalized and aliased keys.
 *
 * Returns shape: { before, after, sourceType }
 */
export function resolveTypePadding(params, eventType) {
  const pbt = params?.paddingByType || {}
  for (const key of getPaddingLookupKeys(eventType)) {
    const settings = pbt?.[key]
    if (settings && (settings.before != null || settings.after != null)) {
      return {
        before: settings.before ?? null,
        after: settings.after ?? null,
        sourceType: key,
      }
    }
  }
  return { before: null, after: null, sourceType: null }
}
