import { useState, useRef, useCallback } from 'react'
import { apiPost } from '../services/api'

/**
 * Shared hook for AI HTML modification workflow with approval pattern
 * Used by both OverlayDesignWizard and OverlayEditor
 *
 * @param {string} currentHtml - Current HTML content
 * @param {string} presetId - Preset/template ID
 * @param {object} options - Configuration
 * @param {string} options.section - Current section being modified
 * @param {string} options.scopeMode - Scope of modification (e.g., 'all_sections')
 * @param {string} options.workspacePath - Path context ('design' or 'build')
 * @param {function} options.onHtmlChange - Callback when HTML is updated
 * @param {function} options.onPendingChange - Callback when pending state changes
 * @param {function} options.appendUpdate - Function to append AI update messages
 * @param {function} options.showSuccess - Toast success callback
 * @param {function} options.showWarning - Toast warning callback
 * @param {function} options.showInfo - Toast info callback
 * @param {function} options.updateHtmlContent - Function to persist HTML to backend
 * @returns {object} - { handleModify, hasPendingAiChange, showAiBefore, handleAccept, handleReject, setShowAiBefore }
 */
export const useAiModifyHandler = (
  currentHtml,
  presetId,
  {
    section = 'race',
    scopeMode = 'all_sections',
    workspacePath = 'design',
    onHtmlChange,
    onPendingChange,
    appendUpdate,
    showSuccess,
    showWarning,
    showInfo,
    updateHtmlContent,
  } = {},
) => {
  const [prompt, setPrompt] = useState('')
  const [hasPendingAiChange, setHasPendingAiChange] = useState(false)
  const [showAiBefore, setShowAiBefore] = useState(false)
  const [isModifying, setIsModifying] = useState(false)
  const [error, setError] = useState(null)
  
  const beforeAiChangeRef = useRef('')
  const modifyRequestVersionRef = useRef(0)

  const handleModify = useCallback(async (customPrompt = null) => {
    const promptText = (customPrompt || prompt).trim()
    if (!promptText || isModifying || !currentHtml || !presetId) return

    setError(null)
    setIsModifying(true)
    const requestVersion = ++modifyRequestVersionRef.current

    try {
      appendUpdate?.({ stage: 'submitting_edit', message: 'Sending modification request to AI' })

      const result = await apiPost('/llm/overlay/edit-html', {
        prompt: promptText,
        html_content: currentHtml,
        request_id: `ai-${Date.now()}`,
        section,
        scope_mode: scopeMode,
        workspace_path: workspacePath,
        template_id: presetId,
      }, {
        timeoutMs: 120_000,
        retries: 0,
      })

      if (requestVersion !== modifyRequestVersionRef.current) return

      const updatedHtml = result?.html
      if (!updatedHtml) throw new Error('AI did not return updated HTML')

      appendUpdate?.({ stage: 'parsing_html', message: 'Parsing AI-generated HTML' })

      // Cache before state, show updated HTML for preview
      beforeAiChangeRef.current = currentHtml
      onHtmlChange?.(updatedHtml)
      setShowAiBefore(false)
      setHasPendingAiChange(true)
      onPendingChange?.(true)

      if (!customPrompt) {
        setPrompt('')
      }

      appendUpdate?.({ stage: 'ready_for_approval', message: 'AI changes ready for approval' })
      showInfo?.('AI changes ready. Click Accept to save or Reject to discard.')
    } catch (err) {
      if (requestVersion !== modifyRequestVersionRef.current) return
      setHasPendingAiChange(false)
      onPendingChange?.(false)
      const errorMsg = err?.message || err?.detail?.detail || 'Failed to apply AI modification'
      setError(errorMsg)
      showWarning?.(errorMsg)
    } finally {
      setIsModifying(false)
    }
  }, [
    prompt,
    isModifying,
    currentHtml,
    presetId,
    section,
    scopeMode,
    workspacePath,
    appendUpdate,
    onHtmlChange,
    onPendingChange,
    showInfo,
    showWarning,
  ])

  const handleAccept = useCallback(() => {
    if (!hasPendingAiChange || !currentHtml) return

    beforeAiChangeRef.current = currentHtml
    setHasPendingAiChange(false)
    onPendingChange?.(false)
    setShowAiBefore(false)
    appendUpdate?.({ stage: 'completed', message: 'AI changes accepted' })
  }, [
    hasPendingAiChange,
    currentHtml,
    appendUpdate,
    onPendingChange,
  ])

  const handleReject = useCallback(() => {
    if (!hasPendingAiChange) return

    const revertedHtml = beforeAiChangeRef.current
    onHtmlChange?.(revertedHtml)
    setHasPendingAiChange(false)
    onPendingChange?.(false)
    setShowAiBefore(false)
    appendUpdate?.({ stage: 'rejected', message: 'AI changes discarded' })
    showInfo?.('AI changes discarded')
    return revertedHtml
  }, [
    hasPendingAiChange,
    appendUpdate,
    onHtmlChange,
    onPendingChange,
    showInfo,
  ])

  const handleCancel = useCallback(() => {
    modifyRequestVersionRef.current += 1
    setIsModifying(false)
  }, [])

  return {
    prompt,
    setPrompt,
    handleModify,
    handleAccept,
    handleReject,
    handleCancel,
    hasPendingAiChange,
    showAiBefore,
    setShowAiBefore,
    previewHtmlForMode: hasPendingAiChange && showAiBefore
      ? beforeAiChangeRef.current
      : currentHtml,
    isModifying,
    error,
    setError,
  }
}
