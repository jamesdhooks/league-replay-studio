export function SettingGroup({ label, description, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-text-primary">{label}</label>
      {description && (
        <p className="text-xs text-text-tertiary">{description}</p>
      )}
      <div className="mt-1">{children}</div>
    </div>
  )
}
