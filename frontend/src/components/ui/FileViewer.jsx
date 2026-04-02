import { useState, useEffect } from 'react'
import { FileText, Image, Film, AlertCircle, FileCode } from 'lucide-react'
import LoadingSpinner from './LoadingSpinner'
import { formatFileSize } from '../../utils/format'

const TEXT_EXTENSIONS = new Set(['.log', '.txt', '.csv', '.ini', '.rpy', '.cfg', '.xml', '.html', '.css', '.js', '.py', '.md'])
const JSON_EXTENSIONS = new Set(['.json'])
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mkv', '.webm', '.mov'])

function getFileType(filename) {
  const ext = (filename || '').toLowerCase().match(/\.[^.]+$/)?.[0] || ''
  if (JSON_EXTENSIONS.has(ext)) return 'json'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'unknown'
}

/**
 * File viewer modal content — renders file preview based on type.
 *
 * @param {Object} props
 * @param {{ name: string, path: string, size_bytes: number, extension?: string }} props.file
 * @param {number} props.projectId
 */
function FileViewerModal({ file, projectId }) {
  const fileType = getFileType(file.name)

  switch (fileType) {
    case 'json':
      return <JsonViewer file={file} projectId={projectId} />
    case 'text':
      return <TextViewer file={file} projectId={projectId} />
    case 'image':
      return <ImageViewer file={file} projectId={projectId} />
    case 'video':
      return <VideoViewer file={file} projectId={projectId} />
    default:
      return <UnsupportedViewer file={file} />
  }
}

function JsonViewer({ file, projectId }) {
  const { content, loading, error } = useFetchContent(projectId, file.path)

  if (loading) return <ViewerLoading />
  if (error) return <ViewerError message={error} />

  let formatted = content
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    // Not valid JSON — show raw content
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileCode className="w-4 h-4 text-accent" />
        <span className="text-xs text-text-secondary">{file.name}</span>
        <span className="text-xxs text-text-disabled ml-auto">{formatFileSize(file.size_bytes)}</span>
      </div>
      <pre className="bg-bg-primary border border-border rounded-xl p-4 text-xs text-text-secondary
                      font-mono overflow-auto max-h-[60vh] leading-relaxed whitespace-pre-wrap break-words">
        {formatted}
      </pre>
    </div>
  )
}

function TextViewer({ file, projectId }) {
  const { content, loading, error } = useFetchContent(projectId, file.path)

  if (loading) return <ViewerLoading />
  if (error) return <ViewerError message={error} />

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileText className="w-4 h-4 text-text-tertiary" />
        <span className="text-xs text-text-secondary">{file.name}</span>
        <span className="text-xxs text-text-disabled ml-auto">{formatFileSize(file.size_bytes)}</span>
      </div>
      <pre className="bg-bg-primary border border-border rounded-xl p-4 text-xs text-text-secondary
                      font-mono overflow-auto max-h-[60vh] leading-relaxed whitespace-pre-wrap break-words">
        {content}
      </pre>
    </div>
  )
}

function ImageViewer({ file, projectId }) {
  const [imgError, setImgError] = useState(false)
  const src = `/api/projects/${projectId}/files/serve?path=${encodeURIComponent(file.path)}`

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Image className="w-4 h-4 text-success" />
        <span className="text-xs text-text-secondary">{file.name}</span>
        <span className="text-xxs text-text-disabled ml-auto">{formatFileSize(file.size_bytes)}</span>
      </div>
      {imgError ? (
        <ViewerError message="Failed to load image" />
      ) : (
        <div className="flex items-center justify-center bg-bg-primary border border-border rounded-xl p-4 max-h-[60vh] overflow-auto">
          <img
            src={src}
            alt={file.name}
            className="max-w-full max-h-[55vh] object-contain rounded-lg"
            onError={() => setImgError(true)}
          />
        </div>
      )}
    </div>
  )
}

function VideoViewer({ file, projectId }) {
  const [videoError, setVideoError] = useState(false)
  const src = `/api/projects/${projectId}/files/serve?path=${encodeURIComponent(file.path)}`

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Film className="w-4 h-4 text-warning" />
        <span className="text-xs text-text-secondary">{file.name}</span>
        <span className="text-xxs text-text-disabled ml-auto">{formatFileSize(file.size_bytes)}</span>
      </div>
      {videoError ? (
        <ViewerError message="Failed to load video" />
      ) : (
        <div className="flex items-center justify-center bg-bg-primary border border-border rounded-xl p-2 overflow-hidden">
          <video
            src={src}
            controls
            className="max-w-full max-h-[55vh] rounded-lg"
            onError={() => setVideoError(true)}
          />
        </div>
      )}
    </div>
  )
}

function UnsupportedViewer({ file }) {
  return (
    <div className="p-8 flex flex-col items-center justify-center text-center gap-3">
      <AlertCircle className="w-10 h-10 text-text-disabled" />
      <p className="text-sm text-text-secondary">Preview not available for this file type</p>
      <div className="text-xs text-text-tertiary space-y-1">
        <p><span className="text-text-secondary font-medium">{file.name}</span></p>
        <p>{formatFileSize(file.size_bytes)} &middot; {file.extension || 'unknown type'}</p>
      </div>
    </div>
  )
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function ViewerLoading() {
  return (
    <div className="flex items-center justify-center p-12">
      <LoadingSpinner size="md" />
    </div>
  )
}

function ViewerError({ message }) {
  return (
    <div className="p-8 flex flex-col items-center justify-center text-center gap-2">
      <AlertCircle className="w-8 h-8 text-danger" />
      <p className="text-sm text-text-secondary">{message}</p>
    </div>
  )
}

function useFetchContent(projectId, filePath) {
  const [content, setContent] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const url = `/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`

    setLoading(true)
    setError(null)

    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          const msg = await res.text().catch(() => res.statusText)
          throw new Error(msg || `Failed to load file (${res.status})`)
        }
        return res.text()
      })
      .then((text) => {
        if (!cancelled) {
          setContent(text)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message)
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [projectId, filePath])

  return { content, loading, error }
}

export default FileViewerModal
