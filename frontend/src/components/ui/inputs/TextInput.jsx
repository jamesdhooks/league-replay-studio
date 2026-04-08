export function TextInput({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                 text-text-primary placeholder:text-text-disabled
                 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                 transition-colors"
    />
  )
}
