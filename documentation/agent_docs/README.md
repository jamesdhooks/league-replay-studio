# Agent Documentation

This directory contains best practices, patterns, and conventions for AI agents and developers working on League Replay Studio.

## Purpose

These documents are **evergreen guidelines** that describe:
- How to work with system patterns
- Best practices and conventions
- Architectural patterns to follow
- Testing strategies
- Code organisation standards

## Guidelines vs Other Documentation

**This directory contains:**
- ✅ Agent operation protocols
- ✅ API conventions
- ✅ UI/UX conventions
- ✅ Testing guidelines and patterns
- ✅ Logging conventions
- ✅ Context system patterns
- ✅ Component and hook patterns
- ✅ Settings system guide

**This directory does NOT contain:**
- ❌ Feature specifications (see `documentation/master-plan.md`)
- ❌ Implementation summaries
- ❌ Change logs (see `CHANGELOG.md`)

## Creating New Guidelines

Follow the standards in `agent-doc.md`. Key principles:
1. Write for current and future use, not historical record
2. Focus on reusable patterns, not specific implementations
3. Provide code examples showing correct usage
4. Keep content streamlined and actionable

## Available Guidelines

### Core
- **[agent-doc.md](agent-doc.md)** — Documentation best practices (start here)
- **[riper-5.md](riper-5.md)** — Agent operational protocol (Research → Innovate → Plan → Execute → Review)

### API & Backend
- **[api-conventions-guide.md](api-conventions-guide.md)** — REST API field naming, Pydantic patterns, snake_case enforcement
- **[testing-guidelines.md](testing-guidelines.md)** — pytest, FastAPI TestClient, mocking strategies, in-memory SQLite
- **[logging-and-debugging-guide.md](logging-and-debugging-guide.md)** — Log levels, prefixes, what to log vs not log
- **[settings-system-guide.md](settings-system-guide.md)** — Configuration management patterns

### Frontend & UI
- **[ui-conventions.md](ui-conventions.md)** — Toast/modal system, animation patterns, dark theme, keyboard shortcuts
- **[context-system-guide.md](context-system-guide.md)** — React Context architecture, no prop drilling
- **[component-usage-guide.md](component-usage-guide.md)** — Reusable component patterns
- **[hooks-guide.md](hooks-guide.md)** — Custom hook patterns, localStorage, state management
