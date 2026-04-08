/**
 * TabBar — Reusable tab navigation component.
 *
 * @param {{ tabs: Array<{id: string, label: string, icon?: React.ComponentType}>, activeTab: string, onChange: (id: string) => void, className?: string }} props
 */
export default function TabBar({ tabs, activeTab, onChange, className = '' }) {
  return (
    <div className={`flex gap-1 p-1 bg-surface-active rounded-lg ${className}`}>
      {tabs.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === id
              ? 'bg-bg-primary text-text-primary shadow-sm'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {Icon && <Icon className="w-3.5 h-3.5" />}
          {label}
        </button>
      ))}
    </div>
  )
}
