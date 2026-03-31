# React Context System Guide

## Overview

League Replay Studio uses React Context to eliminate prop drilling and centralise state management. Each context provider is independent and can function standalone.

## Context Providers

| Context | Hook | Purpose |
|---------|------|---------|
| `ProjectContext` | `useProject()` | Current project state + step workflow |
| `TimelineContext` | `useTimeline()` | Timeline zoom, position, selection |
| `IRacingContext` | `useIRacing()` | iRacing connection state |
| `SettingsContext` | `useSettings()` | Application settings |
| `PipelineContext` | `usePipeline()` | Pipeline execution state |
| `YouTubeContext` | `useYouTube()` | YouTube auth state + channel info |
| `ToastContext` | `useToast()` | Toast notification system |

## Key Principle: Independence

Each context provider is completely independent:

```jsx
// ✅ Standalone usage
<ProjectProvider projectId={42}>
  <ProjectEditor />
</ProjectProvider>

// ✅ Combined usage
<ProjectProvider projectId={42}>
  <TimelineProvider>
    <PipelineProvider>
      <ProjectView />
    </PipelineProvider>
  </TimelineProvider>
</ProjectProvider>
```

## Anti-Pattern: Prop Drilling

### ❌ What NOT to Do
```jsx
function ProjectView({ project, timeline, settings }) {
  return (
    <TimelineEditor
      project={project}
      zoom={timeline.zoom}
      settings={settings}
    />
  );
}
```

### ✅ What TO Do
```jsx
function ProjectView() {
  return (
    <ProjectProvider projectId={42}>
      <TimelineProvider>
        <TimelineEditor />
      </TimelineProvider>
    </ProjectProvider>
  );
}

function TimelineEditor() {
  const { project } = useProject();
  const { zoom, setZoom } = useTimeline();
  // Use context directly — no props needed
}
```

## Context Provider Pattern

```jsx
import { createContext, useContext, useState, useCallback } from 'react';

const ProjectContext = createContext(null);

export function ProjectProvider({ projectId, children }) {
  const [project, setProject] = useState(null);
  const [currentStep, setCurrentStep] = useState('setup');

  const advanceStep = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/step`, {
      method: 'PUT',
      body: JSON.stringify({ action: 'advance' })
    });
    const data = await response.json();
    setCurrentStep(data.current_step);
  }, [projectId]);

  return (
    <ProjectContext.Provider value={{ project, currentStep, advanceStep }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
}
```

## Best Practices

1. **One context per domain** — don't combine unrelated state
2. **Memoize context values** — use `useMemo` for object values to prevent unnecessary re-renders
3. **Throw on missing provider** — always validate context is available
4. **Keep providers close** — wrap only the components that need the context, not the entire app
5. **Use custom hooks** — never expose raw `useContext()` calls; wrap in named hooks
