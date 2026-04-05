/**
 * RaceStory — AI-generated editorial race write-up.
 *
 * Renders a summary paragraph and a grid of sub-stories with icons,
 * headlines, and short descriptions. Fetches/generates the story
 * on mount via the LLM context, with deduplication (one per project).
 */

import { useEffect, useCallback, useRef } from 'react'
import {
  Trophy,
  Flag,
  Flame,
  Zap,
  Swords,
  ArrowUpDown,
  Timer,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Star,
  Shield,
  Target,
  Rocket,
  ThumbsDown,
  RefreshCw,
  Crown,
  Users,
  Sparkles,
  Loader2,
  RotateCcw,
  BookOpen,
} from 'lucide-react'
import { useLLM } from '../../context/LLMContext'

// ── Icon map ────────────────────────────────────────────────────────────────

const ICON_MAP = {
  Trophy,
  Flag,
  Flame,
  Zap,
  Swords,
  ArrowUpDown,
  Timer,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Star,
  Shield,
  Target,
  Rocket,
  ThumbsDown,
  RefreshCw,
  Crown,
  Users,
}

const ICON_COLORS = {
  Trophy: 'text-yellow-400',
  Flag: 'text-white',
  Flame: 'text-orange-400',
  Zap: 'text-yellow-300',
  Swords: 'text-red-400',
  ArrowUpDown: 'text-blue-400',
  Timer: 'text-cyan-400',
  AlertTriangle: 'text-amber-400',
  TrendingUp: 'text-emerald-400',
  TrendingDown: 'text-red-400',
  Star: 'text-yellow-400',
  Shield: 'text-blue-300',
  Target: 'text-green-400',
  Rocket: 'text-purple-400',
  ThumbsDown: 'text-gray-400',
  RefreshCw: 'text-teal-400',
  Crown: 'text-yellow-500',
  Users: 'text-indigo-400',
}

// ── Sub-story card ──────────────────────────────────────────────────────────

function SubStoryCard({ icon, headline, description }) {
  const IconComponent = ICON_MAP[icon] || Star
  const colorClass = ICON_COLORS[icon] || 'text-accent'

  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-bg-secondary/60 border border-border/50
                    hover:bg-bg-secondary transition-colors">
      <div className={`flex-shrink-0 mt-0.5 ${colorClass}`}>
        <IconComponent className="w-5 h-5" />
      </div>
      <div className="min-w-0">
        <h4 className="text-sm font-semibold text-text-primary leading-tight">
          {headline}
        </h4>
        <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">
          {description}
        </p>
      </div>
    </div>
  )
}

// ── Main component ──────────────────────────────────────────────────────────

export default function RaceStory({ projectId, compact = false }) {
  const {
    raceStory,
    raceStoryLoading,
    fetchRaceStory,
    generateRaceStory,
    isAvailable,
  } = useLLM()

  // Auto-fetch on mount — returns cached if exists
  const fetchedRef = useRef(null)
  useEffect(() => {
    if (projectId && fetchedRef.current !== projectId) {
      fetchedRef.current = projectId
      fetchRaceStory(projectId)
    }
  }, [projectId, fetchRaceStory])

  const handleGenerate = useCallback(() => {
    if (projectId) {
      generateRaceStory(projectId, false)
    }
  }, [projectId, generateRaceStory])

  const handleRegenerate = useCallback(() => {
    if (projectId) {
      generateRaceStory(projectId, true)
    }
  }, [projectId, generateRaceStory])

  // Loading state
  if (raceStoryLoading) {
    return (
      <div className="flex items-center justify-center gap-3 py-8 text-text-secondary">
        <Loader2 className="w-5 h-5 animate-spin text-accent" />
        <span className="text-sm">Generating race story…</span>
      </div>
    )
  }

  // No story yet — show generate button
  if (!raceStory) {
    if (!isAvailable()) {
      return null // Don't show anything if LLM is not configured
    }
    return (
      <div className="flex flex-col items-center gap-3 py-6">
        <Sparkles className="w-8 h-8 text-accent/60" />
        <p className="text-sm text-text-secondary text-center">
          Generate an AI-powered race story with key moments and analysis.
        </p>
        <button
          onClick={handleGenerate}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white
                     text-sm font-medium hover:bg-accent/90 transition-colors"
        >
          <BookOpen className="w-4 h-4" />
          Generate Race Story
        </button>
      </div>
    )
  }

  const { summary, sub_stories: subStories = [] } = raceStory

  // Compact rendering (for compound/embed views)
  if (compact) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-bold text-text-primary uppercase tracking-wider">
            Race Story
          </h3>
        </div>
        <p className="text-sm text-text-secondary leading-relaxed">{summary}</p>
        <div className="grid grid-cols-1 gap-2">
          {subStories.map((story, i) => (
            <SubStoryCard key={i} {...story} />
          ))}
        </div>
      </div>
    )
  }

  // Full rendering
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-accent" />
          <h3 className="text-base font-bold text-text-primary uppercase tracking-wider">
            Race Story
          </h3>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent font-medium">
            AI
          </span>
        </div>
        <button
          onClick={handleRegenerate}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-tertiary
                     hover:text-text-primary hover:bg-bg-secondary transition-colors"
          title="Regenerate race story"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Regenerate
        </button>
      </div>

      {/* Summary */}
      <p className="text-sm text-text-secondary leading-relaxed border-l-2 border-accent/40 pl-3">
        {summary}
      </p>

      {/* Sub-stories grid */}
      {subStories.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {subStories.map((story, i) => (
            <SubStoryCard key={i} {...story} />
          ))}
        </div>
      )}

      {/* Meta */}
      {raceStory.model_used && (
        <p className="text-[10px] text-text-disabled text-right">
          Generated by {raceStory.model_used}
        </p>
      )}
    </div>
  )
}
