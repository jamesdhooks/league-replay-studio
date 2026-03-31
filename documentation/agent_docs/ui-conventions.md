# UI Conventions

## Overview

UI/UX conventions for League Replay Studio. The application is a professional video editing tool — dark theme, keyboard-driven, minimal visual clutter.

## User Notifications & Dialogs

### ⚠️ NEVER Use Native Browser Dialogs

**Rule**: NEVER use `alert()`, `confirm()`, or `prompt()`.

### Use These Instead:

#### Confirmations (requires user decision)
```jsx
import { useModal } from '../hooks/useModal';

const { openModal } = useModal();

openModal('confirm-delete', 'confirmation', {
  title: 'Delete Project',
  message: 'Are you sure?\n\nThis will delete all project files.',
  variant: 'confirm',
  danger: true,
  confirmText: 'Delete',
  onConfirm: async () => await deleteProject(id)
});
```

#### Non-Blocking Messages
```jsx
import { useToast } from '../context/ToastContext';

const { showSuccess, showError, showWarning, showInfo } = useToast();

showSuccess('Export completed');
showError('FFmpeg encoding failed');
showWarning('No GPU detected — CPU fallback will be slow');
showInfo('Analysis running in background');
```

### Decision Matrix

| Scenario | Use |
|----------|-----|
| Requires user confirmation (Yes/No) | Confirmation Modal |
| Success message | Toast (success) |
| Error message | Toast (error) |
| Warning/validation | Toast (warning) |
| Informational | Toast (info) |
| Progress updates | Toast with progress or Progress component |
| Complex form/input | Custom Modal |

## Dark Theme

League Replay Studio uses a **dark theme by default** — standard for video editing applications (reduces eye strain during long sessions).

- Background: dark greys (not pure black)
- Text: light greys and whites
- Accent: brand colour for interactive elements
- Warnings: amber/yellow
- Errors: red
- Success: green
- All colour tokens defined in `tailwind.config.js`

## Animation Guidelines

All animations must respect the user's motion preference (`prefers-reduced-motion`).

### Pattern: Motion Wrapper
```jsx
import { m } from '../lib/motion';

// Cards with interactive elements — shadow only, no movement
<m.div whileHover={{ boxShadow: '0 20px 40px rgba(0,0,0,0.3)' }}>
  <button>Export</button>
</m.div>

// Informational cards — movement allowed
<m.div whileHover={{ y: -4, boxShadow: '0 20px 40px rgba(0,0,0,0.3)' }}>
  <span>Event info</span>
</m.div>

// Buttons
<m.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
  Go
</m.button>
```

### Rule: Cards with Buttons
Cards containing buttons or interactive elements should **NOT** animate upward on hover. Use only `boxShadow`. Upward movement interferes with click targets.

## Keyboard Shortcuts

Professional NLE shortcuts are **mandatory** — power users expect these:

| Action | Shortcut |
|--------|----------|
| Play/Pause | `Space` |
| Shuttle forward | `L` |
| Shuttle reverse | `J` |
| Stop | `K` |
| Set In point | `I` |
| Set Out point | `O` |
| Undo | `Ctrl+Z` |
| Redo | `Ctrl+Y` / `Ctrl+Shift+Z` |
| Save | `Ctrl+S` |
| Delete selection | `Delete` |
| Zoom in timeline | `Scroll wheel` |
| Pan timeline | `Middle mouse drag` |

All shortcuts must be configurable via Settings.

## Responsive Panels

- Sidebar, timeline, and inspector panels are **resizable** with drag handles
- Panel state (collapsed/expanded, size) persists via localStorage
- Minimum panel sizes prevent content from being unusable
- Double-click a drag handle to reset to default size

## Loading States

- Use skeleton loaders for content areas (not spinners)
- Show progress bars for deterministic operations (encoding, upload)
- Show indeterminate progress for unknown-duration operations (analysis)
- Never leave the user with a blank screen — always show feedback

## Forms and Inputs

- All form inputs use Tailwind CSS styling
- Dropdowns use a custom `<Dropdown>` component (not native `<select>`)
- Sliders use a custom `<Slider>` component for range inputs
- Toggle switches for boolean settings
- Number inputs with stepper buttons where appropriate
