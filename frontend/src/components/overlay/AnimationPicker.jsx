import { useState, useCallback } from 'react'
import { Sparkles, Copy, ChevronDown, Play } from 'lucide-react'

/**
 * AnimationPicker — CSS keyframe animation generator for overlays.
 *
 * Provides preset animations and a visual builder to generate
 * CSS keyframe code that can be inserted into the editor.
 */

const PRESET_ANIMATIONS = [
  {
    name: 'Fade In',
    category: 'entrance',
    css: `@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}`,
    usage: 'animation: fadeIn 0.5s ease-out forwards;',
  },
  {
    name: 'Fade Out',
    category: 'exit',
    css: `@keyframes fadeOut {
  from { opacity: 1; }
  to { opacity: 0; }
}`,
    usage: 'animation: fadeOut 0.5s ease-in forwards;',
  },
  {
    name: 'Slide In Left',
    category: 'entrance',
    css: `@keyframes slideInLeft {
  from { transform: translateX(-100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}`,
    usage: 'animation: slideInLeft 0.4s ease-out forwards;',
  },
  {
    name: 'Slide In Right',
    category: 'entrance',
    css: `@keyframes slideInRight {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}`,
    usage: 'animation: slideInRight 0.4s ease-out forwards;',
  },
  {
    name: 'Slide In Up',
    category: 'entrance',
    css: `@keyframes slideInUp {
  from { transform: translateY(100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}`,
    usage: 'animation: slideInUp 0.4s ease-out forwards;',
  },
  {
    name: 'Slide In Down',
    category: 'entrance',
    css: `@keyframes slideInDown {
  from { transform: translateY(-100%); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}`,
    usage: 'animation: slideInDown 0.4s ease-out forwards;',
  },
  {
    name: 'Scale In',
    category: 'entrance',
    css: `@keyframes scaleIn {
  from { transform: scale(0.8); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}`,
    usage: 'animation: scaleIn 0.3s ease-out forwards;',
  },
  {
    name: 'Bounce In',
    category: 'entrance',
    css: `@keyframes bounceIn {
  0% { transform: scale(0.3); opacity: 0; }
  50% { transform: scale(1.05); }
  70% { transform: scale(0.9); }
  100% { transform: scale(1); opacity: 1; }
}`,
    usage: 'animation: bounceIn 0.6s ease-out forwards;',
  },
  {
    name: 'Pulse',
    category: 'attention',
    css: `@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.05); }
}`,
    usage: 'animation: pulse 2s ease-in-out infinite;',
  },
  {
    name: 'Glow',
    category: 'attention',
    css: `@keyframes glow {
  0%, 100% { box-shadow: 0 0 5px rgba(59, 130, 246, 0.5); }
  50% { box-shadow: 0 0 20px rgba(59, 130, 246, 0.8); }
}`,
    usage: 'animation: glow 2s ease-in-out infinite;',
  },
  {
    name: 'Typewriter',
    category: 'text',
    css: `@keyframes typewriter {
  from { width: 0; }
  to { width: 100%; }
}`,
    usage: 'animation: typewriter 2s steps(20) forwards; overflow: hidden; white-space: nowrap;',
  },
  {
    name: 'Color Cycle',
    category: 'attention',
    css: `@keyframes colorCycle {
  0% { color: #3B82F6; }
  33% { color: #EF4444; }
  66% { color: #10B981; }
  100% { color: #3B82F6; }
}`,
    usage: 'animation: colorCycle 3s linear infinite;',
  },
]

const CATEGORIES = ['all', 'entrance', 'exit', 'attention', 'text']

export default function AnimationPicker({ onInsertAnimation }) {
  const [category, setCategory] = useState('all')
  const [copiedIdx, setCopiedIdx] = useState(null)
  const [previewIdx, setPreviewIdx] = useState(null)

  const filtered = category === 'all'
    ? PRESET_ANIMATIONS
    : PRESET_ANIMATIONS.filter(a => a.category === category)

  // ── Copy animation code ──────────────────────────────────────────────────
  const handleCopy = useCallback((idx, anim) => {
    const code = `<style>\n${anim.css}\n</style>\n\n<!-- Usage: style="${anim.usage}" -->`
    navigator.clipboard.writeText(code).catch(() => {})
    setCopiedIdx(idx)
    setTimeout(() => setCopiedIdx(null), 1500)

    if (onInsertAnimation) {
      onInsertAnimation(anim.css, anim.usage)
    }
  }, [onInsertAnimation])

  return (
    <div className="flex flex-col h-full bg-bg-primary border-t border-border">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <Sparkles className="w-4 h-4 text-purple-400" />
        <span className="text-xs font-medium text-text-secondary">Animations</span>
      </div>

      {/* ── Category filter ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border">
        {CATEGORIES.map(cat => (
          <button
            key={cat}
            onClick={() => setCategory(cat)}
            className={`text-[10px] px-2 py-0.5 rounded capitalize ${
              category === cat
                ? 'bg-purple-600 text-white'
                : 'text-text-tertiary hover:text-text-primary hover:bg-bg-secondary'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* ── Animation list ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.map((anim, idx) => (
          <div
            key={anim.name}
            className="group rounded-lg border border-border/50 mb-2 overflow-hidden hover:border-purple-500/40 transition-colors"
          >
            {/* Animation header */}
            <div className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary">{anim.name}</span>
                <span className="text-[10px] px-1 py-0.5 rounded bg-bg-secondary text-text-tertiary capitalize">
                  {anim.category}
                </span>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => setPreviewIdx(previewIdx === idx ? null : idx)}
                  className="p-1 rounded hover:bg-bg-secondary text-text-tertiary hover:text-text-primary"
                  title="Preview code"
                >
                  <ChevronDown className={`w-3 h-3 transition-transform ${previewIdx === idx ? 'rotate-180' : ''}`} />
                </button>
                <button
                  onClick={() => handleCopy(idx, anim)}
                  className="p-1 rounded hover:bg-bg-secondary text-text-tertiary hover:text-text-primary"
                  title="Copy & insert"
                >
                  {copiedIdx === idx ? (
                    <span className="text-[10px] text-green-400">✓</span>
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
              </div>
            </div>

            {/* Code preview */}
            {previewIdx === idx && (
              <div className="px-3 pb-2">
                <pre className="text-[10px] font-mono text-text-tertiary bg-bg-secondary rounded p-2 overflow-x-auto whitespace-pre-wrap">
                  {anim.css}
                </pre>
                <div className="mt-1.5 text-[10px] text-text-tertiary">
                  <span className="text-purple-400">Usage: </span>
                  <code className="text-blue-400">{anim.usage}</code>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
