# Testing Guidelines

## Overview

Testing standards for League Replay Studio. Backend uses pytest + FastAPI; frontend uses Vitest + React Testing Library.

## Backend Testing

### Framework
- **pytest** with FastAPI test utilities
- **In-memory SQLite** for database tests
- **pytest-asyncio** for async test functions
- **pytest-cov** for coverage reporting

### Test Client Setup
```python
import pytest
from fastapi.testclient import TestClient
from app import create_app

@pytest.fixture
def client():
    """FastAPI test client with test database."""
    app = create_app(testing=True)
    with TestClient(app) as c:
        yield c
```

### Database Mocking
```python
import sqlite3

@pytest.fixture
def db():
    """In-memory SQLite database for testing."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    # Run schema creation
    with open("backend/server/schema.sql") as f:
        conn.executescript(f.read())
    yield conn
    conn.close()
```

### Service Mocking

Mock external services at the service boundary — never mock internal Python functions:

```python
from unittest.mock import Mock, patch

# ✅ Good: Mock the external boundary
@patch('server.services.iracing_bridge.irsdk.IRSDK')
def test_iracing_connection(mock_irsdk):
    mock_irsdk.return_value.startup.return_value = True
    bridge = IRacingBridge()
    assert bridge.connect() is True

# ✅ Good: Mock FFmpeg subprocess
@patch('subprocess.run')
def test_encoding(mock_run):
    mock_run.return_value.returncode = 0
    engine = EncodingEngine()
    result = engine.encode(project_id=1, preset="youtube_1080p")
    assert result.success is True

# ❌ Bad: Mocking internal implementation details
@patch('server.services.encoding_engine.EncodingEngine._build_ffmpeg_args')
def test_encoding_bad(mock_build):
    ...
```

### What to Mock
| External Dependency | Mock Strategy |
|---|---|
| iRacing SDK (`irsdk`) | Mock `IRSDK` class — no iRacing needed for tests |
| FFmpeg | Mock `subprocess.run` — no FFmpeg binary needed |
| OBS/ShadowPlay | Mock hotkey sender — no capture software needed |
| YouTube API | Mock `googleapiclient` — no OAuth needed |
| Playwright | Mock `OverlayRenderer` — no Chromium needed |
| File system (large files) | Use temp directories with small test fixtures |

### Test Organisation
```
backend/
├── tests/
│   ├── conftest.py           # Shared fixtures
│   ├── test_projects.py      # Project CRUD
│   ├── test_analysis.py      # Analysis engine
│   ├── test_detectors.py     # Event detectors
│   ├── test_encoding.py      # FFmpeg encoding
│   ├── test_pipeline.py      # Pipeline engine
│   ├── test_youtube.py       # YouTube integration
│   └── test_api/
│       ├── test_api_projects.py
│       ├── test_api_youtube.py
│       └── test_api_pipeline.py
```

## Frontend Testing

### Framework
- **Vitest** for test runner
- **React Testing Library** for component tests
- **MSW (Mock Service Worker)** for API mocking

### Component Test Pattern
```jsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ProjectCard } from '../components/project/ProjectCard';

describe('ProjectCard', () => {
  it('renders project name and current step', () => {
    render(<ProjectCard project={{ id: 1, name: 'Daytona 500', current_step: 'editing' }} />);
    expect(screen.getByText('Daytona 500')).toBeInTheDocument();
    expect(screen.getByText('editing')).toBeInTheDocument();
  });
});
```

### What to Test
- **Components**: Renders correctly, user interactions, conditional rendering
- **Hooks**: State changes, side effects, error handling
- **Services**: API calls return expected data shapes
- **Context**: Provider values propagate correctly

## Best Practices

1. Test behaviour, not implementation
2. One assertion per test when practical
3. Use descriptive test names: `test_create_project_with_replay_file`
4. Test error cases and edge cases, not just happy paths
5. Keep tests fast — no network calls, no disk I/O (except temp files)
6. Run tests before every commit
