# Agent Documentation Best Practices

## Purpose

Standards for creating and maintaining documentation in the League Replay Studio project.

## Core Principles

### 1. Documentation Location

| Type | Location | Purpose |
|------|----------|---------|
| **Agent Guidelines** | `documentation/agent_docs/` | Patterns, conventions, best practices |
| **Architecture & Specs** | `documentation/master-plan.md` | Complete system design and feature specs |
| **Changelog** | `CHANGELOG.md` | Release history |
| **README** | `README.md` | User-facing project overview |

### 2. Content Focus

- Focus on the system, not what was achieved
- Write for current and future use, not historical record
- Be concise and actionable
- Provide code examples showing correct usage

### 3. Naming Convention

All files in `documentation/agent_docs/` use **kebab-case**:
- ✅ `api-conventions-guide.md`, `testing-guidelines.md`
- ❌ `API_CONVENTIONS_GUIDE.md`, `ApiConventionsGuide.md`

Exception: `README.md`

### 4. Agent Guideline Format

**Structure:**
- Clear, descriptive title
- Purpose/Overview section
- Organised sections with practical patterns
- Code examples (✅ correct, ❌ anti-patterns)
- Best practices bullet points

**Style:**
- Use imperative language ("Do this", "Use this pattern")
- Provide concrete code examples
- Use ✅ and ❌ for correct/incorrect patterns
- Keep explanations brief and technical
- Focus on "how" and "why"

### 5. Keep Guidelines Evergreen

- No references to "we implemented" or "this was done"
- Reflect the current state of the system
- Update when patterns change
- Cover a specific domain or pattern

## Summary

Agent documentation should be: **Logical** (stored appropriately), **Streamlined** (no fluff), **Practical** (reusable patterns), **Current** (reflects present system), **Evergreen** (timeless guidance).
