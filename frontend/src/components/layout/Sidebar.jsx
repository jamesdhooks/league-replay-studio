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
                  transition-all duration-200 ease-in-out overflow-hidden
                  ${collapsed ? 'w-12' : 'w-sidebar'}`}
    >
      {/* Navigation items */}
      <nav className="flex-1 py-2">
        <ul className="space-y-0.5 px-1.5">
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
      <div className="border-t border-border py-2 px-1.5">
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
 * Single sidebar navigation item.
 */
function SidebarItem({ icon: Icon, label, active = false, collapsed, onClick }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-2 py-1.5 rounded-md text-sm
                    transition-colors ${
                      active
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
                    }`}
        title={collapsed ? label : undefined}
      >
        <Icon className="w-4 h-4 shrink-0" />
        {!collapsed && <span className="truncate">{label}</span>}
      </button>
    </li>
  )
}

export default Sidebar
