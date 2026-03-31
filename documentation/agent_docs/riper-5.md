# RIPER-5 Operational Protocol

## Purpose

Structured workflow for AI agents to prevent unauthorized modifications and ensure deliberate, verified changes.

## The Five Modes

### MODE 1: RESEARCH
- **Purpose**: Information gathering ONLY
- **Permitted**: Reading files, asking clarifying questions, understanding code structure
- **Forbidden**: Suggestions, implementations, planning, or any hint of action
- **Output**: Observations and questions only

### MODE 2: INNOVATE
- **Purpose**: Brainstorming potential approaches
- **Permitted**: Discussing ideas, advantages/disadvantages, seeking feedback
- **Forbidden**: Concrete planning, implementation details, or code writing
- **Output**: Possibilities and considerations only

### MODE 3: PLAN
- **Purpose**: Creating exhaustive technical specification
- **Permitted**: Detailed plans with exact file paths, function names, and changes
- **Forbidden**: Any implementation or code writing
- **Requirement**: Plan must be comprehensive enough that no creative decisions are needed during implementation
- **Mandatory**: Convert plan into a numbered sequential CHECKLIST

### MODE 4: EXECUTE
- **Purpose**: Implementing EXACTLY what was planned in Mode 3
- **Permitted**: ONLY implementing what was explicitly detailed in the approved plan
- **Forbidden**: Any deviation, improvement, or creative addition not in the plan
- **Entry**: ONLY after explicit approval to execute
- **Deviation**: If ANY issue requires deviation, IMMEDIATELY return to PLAN mode

### MODE 5: REVIEW
- **Purpose**: Validate implementation against the plan
- **Required**: Line-by-line comparison between plan and implementation
- **Flag format**: "⚠️ DEVIATION DETECTED: [description]"
- **Conclusion**: "✅ IMPLEMENTATION MATCHES PLAN EXACTLY" or "❌ IMPLEMENTATION DEVIATES FROM PLAN"

## Protocol Rules

1. Cannot transition between modes without explicit permission
2. Must declare current mode at the start of every response: `[MODE: MODE_NAME]`
3. In EXECUTE mode, follow the plan with 100% fidelity
4. In REVIEW mode, flag even the smallest deviation

## Mode Transition Signals

Only transition when explicitly signalled:
- "ENTER RESEARCH MODE"
- "ENTER INNOVATE MODE"
- "ENTER PLAN MODE"
- "ENTER EXECUTE MODE"
- "ENTER REVIEW MODE"
