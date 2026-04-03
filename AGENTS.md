# AGENTS.md

Short guide to contribute to `voicestudio` without breaking the workflow.

## Project Goal

- Local voice workflow app on top of Qwen TTS.
- React/Vite frontend + Express/TypeScript backend.
- Optimized for long scripts: paragraph segmentation + timeline playback.

## Minimal Structure

- `apps/web`: main UI (React 19 + Vite).
- `apps/server`: API/proxy to Qwen + voice preset management.
- `voices/`: local `.pt` presets.
- `README.md`: main documentation.
- `CONTRIBUTING.md`, `CLA.md`, `LICENSE.md`: contribution and legal rules.

## Safety Rules

1. Do not change queue/generation logic without validating playback and export.
2. If you touch timeline/audio, test:
   1. global play/pause,
   2. paragraph play/pause,
   3. seek while dragging the timeline slider.
3. Never hardcode local paths or secrets.
4. Keep `.env` out of Git (use only `.env.example`).
5. Avoid mixing large unrelated changes in one PR (UI + backend + docs) unless required.
6. Do not delete/overwrite files in `voices/` unless explicitly requested.
7. UI must follow this **strict shadcn-first order**:
   1. Check `apps/web/src/components/ui` and reuse an existing component if available.
   2. If missing, install it via the shadcn CLI and use that generated component.
   3. Only if shadcn does not provide it, create a custom component inspired by existing shadcn patterns.
   - Always prefer importing/reusing existing components over creating one-off UI.
   - Avoid raw/native controls when a shadcn-style component is feasible.
8. Never mark a feature as done without validation:
   - Validate behavior with logs and/or runtime checks.
   - If Playwright MCP is available, use it for end-to-end validation.
   - For UI changes, visual validation in Playwright is required whenever possible.
   - Do not ask the user to manually test anything the agent can test directly.
9. Follow a self-improvement loop:
   - Read `LESSONS.md` before starting implementation.
   - When a mistake is found and corrected, append a short lesson to `LESSONS.md`.
   - Use lessons to avoid repeating known errors in future changes.

## Quick Pre-Merge Checklist

1. Frontend build passes:
   - `npm run build --workspace apps/web`
2. If backend changed, backend build passes:
   - `npm run build --workspace apps/server`
3. Validate the feature behavior (logs, runtime checks, or Playwright MCP when available).
4. For UI changes, confirm visual behavior in Playwright whenever possible.
5. Check browser console for obvious runtime errors.
6. Keep README/CONTRIBUTING aligned with behavior changes.
7. Update `LESSONS.md` with any corrected mistakes and insights.

## Practical Conventions

- Prefer small, atomic, reversible changes.
- Use clear names for audio/timeline handlers and state.
- Keep UI consistent with shadcn-style components in `apps/web/src/components/ui`.
- Before custom UI, follow the 3-step shadcn-first order above.
- If custom UI is required, create a reusable component in `apps/web/src/components/ui` instead of one-off inline markup.
- Start by reviewing `LESSONS.md`, and end by updating it if new lessons were learned.

## Platform Notes

- Project is primarily validated on Windows.
- If you test on Linux/macOS, report results in an issue or PR.
