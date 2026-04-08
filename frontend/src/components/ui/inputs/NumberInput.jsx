export function NumberInput({ value, onChange, min, max, placeholder }) {
  return (
    <input
      type="number"
      value={value ?? ''}
      onChange={(e) => {
        const v = parseInt(e.target.value, 10)
        if (!isNaN(v) && v >= min && v <= max) onChange(v)
        else if (e.target.value === '') onChange(min)
      }}
      min={min}
      max={max}
      placeholder={placeholder}
      className="w-full px-3 py-2 text-sm bg-bg-primary border border-border rounded-lg
                 text-text-primary placeholder:text-text-disabled
                 focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent
                 transition-colors"
    />
  )
}
