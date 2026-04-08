export function Select({ value, onChange, options }) {
  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                 text-text-primary
                 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                 transition-colors appearance-none cursor-pointer"
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
