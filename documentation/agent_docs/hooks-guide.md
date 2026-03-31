# React Hooks Guide

## Overview

Custom hook patterns for League Replay Studio. Hooks encapsulate reusable logic and keep components clean.

## Custom Hooks

### `useProject()` — Project State & Workflow
```jsx
const { project, currentStep, advanceStep, setStep } = useProject();
```
- Wraps `ProjectContext`
- Provides current project data, step navigation, step advancement

### `useTimeline()` — Timeline Interaction
```jsx
const { zoom, setZoom, position, setPosition, selection, setSelection } = useTimeline();
```
- Zoom level, playhead position, range selection
- Keyboard shortcut integration (J/K/L shuttle, I/O in/out)

### `usePreview()` — Video Preview
```jsx
const { frame, isLoading, requestFrame, startStream, stopStream } = usePreview();
```
- Fetches decoded frames from backend
- Manages WebSocket binary frame stream

### `useHighlights()` — Highlight Editing Suite
```jsx
const { weights, setWeight, metrics, events, reprocess, toggleOverride } = useHighlights();
```
- Rule weight management
- Reprocess trigger
- Live metrics (duration, event counts, coverage)

### `useWebSocket()` — WebSocket Connection
```jsx
const { isConnected, send, subscribe, unsubscribe } = useWebSocket();
```
- Auto-reconnect on disconnect
- Event subscription pattern

### `usePipeline()` — Pipeline Execution
```jsx
const { status, currentStep, start, pause, resume, cancel, retryStep } = usePipeline();
```
- Pipeline lifecycle management
- Real-time status via WebSocket

### `useYouTube()` — YouTube Integration
```jsx
const { isConnected, channel, startAuth, disconnect, upload, uploadStatus } = useYouTube();
```
- OAuth flow management
- Upload with progress tracking

### `useLocalStorage(key, defaultValue)` — Persistent State
```jsx
const [sidebarWidth, setSidebarWidth] = useLocalStorage('sidebar_width', 280);
```
- Persists UI state across sessions
- Auto-serializes JSON
- Type-safe with generics

## Hook Pattern

```jsx
import { useState, useCallback, useEffect } from 'react';

export function useLocalStorage(key, defaultValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const setStoredValue = useCallback((newValue) => {
    setValue(prev => {
      const resolved = typeof newValue === 'function' ? newValue(prev) : newValue;
      localStorage.setItem(key, JSON.stringify(resolved));
      return resolved;
    });
  }, [key]);

  return [value, setStoredValue];
}
```

## WebSocket Subscription Pattern

```jsx
function AnalysisProgress({ projectId }) {
  const { subscribe, unsubscribe } = useWebSocket();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const handler = (data) => setProgress(data.percent);
    subscribe('analysis:progress', handler);
    return () => unsubscribe('analysis:progress', handler);
  }, [subscribe, unsubscribe]);

  return <ProgressBar value={progress} />;
}
```

## Best Practices

1. **Prefix with `use`** — React convention: `useProject`, `useTimeline`
2. **One concern per hook** — don't combine unrelated logic
3. **Return objects, not arrays** — unless it's a simple `[value, setter]` pair
4. **Handle cleanup** — return cleanup functions in `useEffect`
5. **Memoize callbacks** — use `useCallback` for functions passed as props or deps
6. **Error boundaries** — throw from hooks; let error boundaries catch
