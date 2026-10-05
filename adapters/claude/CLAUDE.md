## Erdem Design System

- The Erdem Design System (design language and AI development protocol) is available through the `/erdem` skill. Use it for UI, design, responsive, mobile and 3D/WebGL work and for design reviews. Do not use it for backend, database or other unrelated tasks.
- Project intelligence, when present, lives in `.ai/` (`AI_INDEX.md`, `TASK_STATE.md`, `HANDOFF.md`, `DECISIONS.md`, `graph/`). A session-start line summarizes its state; `/erdem context` verifies it.
- Load context progressively: the smallest sufficient context, search before reading, never the whole repository by default, never secrets.
- Indexes, summaries and graphs are navigation aids. Source code is authoritative.
