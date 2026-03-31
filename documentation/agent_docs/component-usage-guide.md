# Component Usage Guide

## Overview

Patterns for building React components in League Replay Studio. All components are functional, use hooks for state, and Tailwind for styling.

## Component Structure

```
frontend/src/components/
├── layout/          # App shell, toolbar, sidebar, status bar
├── project/         # Project management, workflow, file browser
├── timeline/        # NLE timeline editor
├── preview/         # Video preview viewport
├── events/          # Event browser and inspector
├── cameras/         # Camera configuration
├── overlays/        # Overlay editor (Monaco + preview)
├── export/          # Export settings and progress
├── highlights/      # Highlight editing suite
├── youtube/         # YouTube integration
├── pipeline/        # Pipeline execution UI
├── settings/        # Settings panels
└── ui/              # Shared primitives (Toast, Modal, Slider, etc.)
```

## Component Rules

### Functional Components Only
```jsx
// ✅ Correct
function ProjectCard({ project }) {
  return <div className="...">{project.name}</div>;
}

// ❌ Wrong — no class components
class ProjectCard extends React.Component { ... }
```

### Tailwind for All Styling
```jsx
// ✅ Correct
<div className="flex items-center gap-2 p-4 bg-gray-800 rounded-lg">

// ❌ Wrong — no inline styles
<div style={{ display: 'flex', padding: '16px' }}>

// ❌ Wrong — no CSS modules
import styles from './ProjectCard.module.css';
```

### Co-locate Related Files
```
components/project/
├── ProjectCard.jsx
├── ProjectCard.test.jsx     # Optional: co-located test
├── ProjectManager.jsx
└── ProjectWorkflow.jsx
```

## Shared UI Primitives

All common UI elements live in `components/ui/`:

| Component | Purpose |
|-----------|---------|
| `Toast.jsx` | Toast notification system |
| `Modal.jsx` | Modal dialog system |
| `Slider.jsx` | Range slider (used for rule weights, volume, etc.) |
| `Dropdown.jsx` | Custom dropdown select |
| `Toggle.jsx` | Toggle switch for boolean settings |
| `Tooltip.jsx` | Tooltip on hover |
| `ProgressBar.jsx` | Progress bar with percentage |
| `LoadingSpinner.jsx` | Loading indicator |

### Using Shared Components
```jsx
import { Slider } from '../ui/Slider';
import { Dropdown } from '../ui/Dropdown';
import { Toggle } from '../ui/Toggle';

function HighlightConfig() {
  const [weight, setWeight] = useState(50);
  return (
    <Slider
      label="Incident Weight"
      min={0}
      max={100}
      value={weight}
      onChange={setWeight}
    />
  );
}
```

## Props Pattern

- Use destructuring for props
- Provide sensible defaults
- Use TypeScript or JSDoc for type documentation

```jsx
/**
 * @param {Object} props
 * @param {string} props.title - Event title
 * @param {string} props.type - Event type (incident, battle, overtake)
 * @param {number} [props.severity=5] - Severity 1-10
 */
function EventCard({ title, type, severity = 5 }) {
  return (
    <div className="flex items-center gap-3 p-3 bg-gray-800 rounded">
      <span className="font-medium">{title}</span>
      <span className="text-sm text-gray-400">{type}</span>
      <span className="text-sm">{severity}/10</span>
    </div>
  );
}
```

## Best Practices

1. **Single responsibility** — one component does one thing
2. **Extract logic into hooks** — components should be mostly JSX
3. **Memoize expensive computations** — use `useMemo` and `useCallback`
4. **Avoid deeply nested ternaries** — extract into helper functions or early returns
5. **Use semantic HTML** — `<button>` not `<div onClick>`, `<nav>` not `<div>`
