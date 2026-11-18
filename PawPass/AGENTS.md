# PawPass repository guide

- `frontend/` contains the React, TypeScript and Vite app. `backend/` contains the FastAPI routes, SQLite persistence and Gemini transcription client.
- Follow [README.md](README.md) for installation, startup and test commands. For an end-to-end check or release handoff, use [verify-pawpass](.agents/skills/verify-pawpass/SKILL.md).
- Keep each vaccination scoped to its pet. The personal and fictional demo workspaces use separate SQLite files. Keep date-only fields in ISO format across the API and compute reminders from saved due dates.
- Treat Gemini output as draft transcription. Leave missing or ambiguous values blank, preserve manual entry and save only after user review. Keep validation errors attached to their fields and preserve the user's input on failure.
- Keep Gemini credentials server-side. A source archive should contain the dependency manifests, lockfile and blank `.env.example`. Exclude local environment files, credentials, SQLite databases, installed dependencies, build outputs and test caches.
