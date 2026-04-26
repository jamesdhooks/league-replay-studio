import React from 'react'

/**
 * Shared topbar used by overlay Preview / Design / Build tabs.
 * Renders section tabs on the left and context controls on the right.
 */
export default function OverlayWorkspaceTopbar({
  tabs = [],
  activeTab,
  onTabChange,
  contextControls = null,
  commonControls = null,
  rightControls = null,
}) {
  const contextControlItems = React.Children.toArray(contextControls).filter(Boolean)
  const commonControlItems = React.Children.toArray(commonControls).filter(Boolean)

  return (
    <div className="flex border-b border-border bg-bg-secondary shrink-0">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id

        return (
          <button
            key={tab.id}
            onClick={() => onTabChange?.(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors
              border-b-2 ${isActive
                ? 'border-accent text-accent bg-accent/5'
                : 'border-transparent text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
              }`}
          >
            {Icon ? (
              <Icon className={`w-3.5 h-3.5 ${isActive && tab.activeIconClass ? tab.activeIconClass : ''}`} />
            ) : null}
            {tab.label}
            {Number(tab.count || 0) > 0 && (
              <span className="ml-1 px-1.5 py-0 rounded-full text-xxs bg-bg-primary border border-border">
                {tab.count}
              </span>
            )}
          </button>
        )
      })}

      <div className="ml-auto flex items-center gap-2 px-3">
        {rightControls || (
          <>
            {contextControlItems.length > 0 ? (
              <div className="flex items-center gap-2">
                {contextControlItems}
              </div>
            ) : null}
            {contextControlItems.length > 0 && commonControlItems.length > 0 ? (
              <div className="h-5 w-px bg-border/80" aria-hidden="true" />
            ) : null}
            {commonControlItems.length > 0 ? (
              <div className="flex items-center gap-2">
                {commonControlItems}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
