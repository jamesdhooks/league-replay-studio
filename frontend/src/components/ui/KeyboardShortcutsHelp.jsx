/**
 * KeyboardShortcutsHelp.jsx — Overlay listing all registered keyboard shortcuts
 *
 * Triggered by pressing "?" (shift+/) from anywhere in the app.
 */

import { useState } from 'react'
import { Keyboard, X } from 'lucide-react'
import { useHotkeys, useShortcutHelp, formatShortcut } from '../../hooks/useHotkeys'

const SCOPE_LABELS = {
  global: 'Global',
  timeline: 'Timeline',
  highlights: 'Highlights',
  preview: 'Preview',
  overlay: 'Overlay Editor',
}

export default function KeyboardShortcutsHelp() {
  const [isOpen, setIsOpen] = useState(false)
  const grouped = useShortcutHelp()

  useHotkeys('shift+/', () => setIsOpen((v) => !v), {
    description: 'Show keyboard shortcuts',
    scope: 'global',
  })

  useHotkeys('escape', () => setIsOpen(false), {
    description: 'Close dialogs',
    scope: 'global',
    enabled: isOpen,
  })

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-700">
          <div className="flex items-center gap-2 text-white font-semibold">
            <Keyboard className="w-5 h-5 text-blue-400" />
            Keyboard Shortcuts
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto px-5 py-3 flex-1">
          {Object.entries(grouped).map(([scope, shortcuts]) => (
            <div key={scope} className="mb-4">
              <h3 className="text-xs uppercase tracking-wider text-zinc-400 mb-2 font-medium">
                {SCOPE_LABELS[scope] || scope}
              </h3>
              <div className="space-y-1">
                {shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.id}
                    className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-zinc-800/50"
                  >
                    <span className="text-sm text-zinc-300">{shortcut.description}</span>
                    <kbd className="text-xs font-mono bg-zinc-800 text-zinc-300 px-2 py-0.5 rounded border border-zinc-600 min-w-[2rem] text-center">
                      {formatShortcut(shortcut.combo)}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {Object.keys(grouped).length === 0 && (
            <p className="text-sm text-zinc-500 text-center py-8">No shortcuts registered</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-700 text-center">
          <span className="text-xs text-zinc-500">
            Press <kbd className="bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-600">?</kbd> to toggle this overlay
          </span>
        </div>
      </div>
    </div>
  )
}
