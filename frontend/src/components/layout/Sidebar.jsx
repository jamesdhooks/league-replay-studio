import {
  FolderOpen,
  Film,
  BarChart3,
  Scissors,
  Upload,
  Layers,
  Settings,
} from 'lucide-react'

/**
 * Collapsible left sidebar with navigation items.
 * Larger items, accent indicator bar, professional hover states.
 *
 * @param {Object} props
 * @param {boolean} props.collapsed - Whether the sidebar is collapsed
 * @param {() => void} [props.onOpenSettings] - Callback to open settings panel
 */
function Sidebar({ collapsed, onOpenSettings }) {
  const navItems = [
    { icon: FolderOpen, label: 'Projects', id: 'projects', active: true },
    { icon: Film, label: 'Capture', id: 'capture' },
    { icon: BarChart3, label: 'Analysis', id: 'analysis' },
    { icon: Scissors, label: 'Editing', id: 'editing' },
    { icon: Layers, label: 'Overlays', id: 'overlays' },
    { icon: Upload, label: 'Export', id: 'export' },
  ]

  return (
    <aside
      className={`flex flex-col bg-bg-secondary border-r border-border shrink-0
                  transition-all duration-250 ease-in-out overflow-hidden
                  ${collapsed ? 'w-[60px]' : 'w-sidebar'}`}
    >
      {/* Navigation items */}
      <nav className="flex-1 py-3">
        <ul className="space-y-1 px-2">
          {navItems.map((item) => (
            <SidebarItem
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={item.active}
              collapsed={collapsed}
            />
          ))}
        </ul>
      </nav>

      {/* Bottom section */}
      <div className="border-t border-border py-3 px-2">
        <SidebarItem
          icon={Settings}
          label="Settings"
          collapsed={collapsed}
          onClick={onOpenSettings}
        />
      </div>
    </aside>
  )
}

/**
 * Single sidebar navigation item — larger (44px), with accent indicator bar.
 */
function SidebarItem({ icon: Icon, label, active = false, collapsed, onClick }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`relative w-full flex items-center gap-3.5 rounded-xl text-sm font-medium
                    transition-all duration-150 cursor-pointer
                    ${collapsed ? 'px-0 py-2.5 justify-center' : 'px-3 py-2.5'}
                    ${active
                      ? 'bg-accent/10 text-accent shadow-glow-sm'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                    }`}
        title={collapsed ? label : undefined}
      >
        {/* Active indicator bar */}
        {active && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-accent rounded-r-full" />
        )}
        <Icon className={`shrink-0 ${collapsed ? 'w-5 h-5' : 'w-[18px] h-[18px]'}`} />
        {!collapsed && <span className="truncate">{label}</span>}
      </button>
    </li>
  )
}

export default Sidebar
