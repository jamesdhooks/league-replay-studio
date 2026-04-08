import {
  Youtube,
  Eye,
  ThumbsUp,
  MessageCircle,
  ChevronDown,
} from 'lucide-react'

/**
 * VideoBrowser — paginated list of uploaded YouTube videos.
 *
 * Each entry shows a thumbnail, title link, view / like / comment
 * counts, and a privacy badge.
 */
function VideoBrowser({ videos, nextPage, onLoadMore }) {
  if (videos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-center">
        <Youtube className="w-8 h-8 text-text-disabled mb-2" />
        <p className="text-sm text-text-tertiary">No uploaded videos found</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {videos.map(video => (
        <div
          key={video.video_id}
          className="flex gap-3 p-3 bg-surface rounded-lg hover:bg-surface-hover transition-colors"
        >
          {video.thumbnail && (
            <img
              src={video.thumbnail}
              alt=""
              className="w-32 h-18 rounded object-cover shrink-0"
            />
          )}
          <div className="flex-1 min-w-0">
            <a
              href={video.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-text-primary hover:text-accent line-clamp-2"
            >
              {video.title}
            </a>
            <div className="flex items-center gap-3 mt-1 text-xs text-text-tertiary">
              <span className="flex items-center gap-1">
                <Eye className="w-3 h-3" /> {formatCount(video.view_count)}
              </span>
              <span className="flex items-center gap-1">
                <ThumbsUp className="w-3 h-3" /> {formatCount(video.like_count)}
              </span>
              <span className="flex items-center gap-1">
                <MessageCircle className="w-3 h-3" /> {formatCount(video.comment_count)}
              </span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-medium ${
                video.privacy === 'public' ? 'bg-green-500/10 text-green-400' :
                video.privacy === 'unlisted' ? 'bg-yellow-500/10 text-yellow-400' :
                'bg-red-500/10 text-red-400'
              }`}>
                {video.privacy}
              </span>
            </div>
          </div>
        </div>
      ))}

      {nextPage && (
        <button
          onClick={onLoadMore}
          className="flex items-center justify-center gap-1 w-full py-2 text-sm text-text-secondary
                     hover:text-text-primary hover:bg-surface-hover rounded-lg transition-colors"
        >
          <ChevronDown className="w-4 h-4" />
          Load more
        </button>
      )}
    </div>
  )
}

function formatCount(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}

export default VideoBrowser
