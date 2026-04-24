# LESSONS.md

Short log of mistakes that were found and corrected, so they are not repeated.

## How to use

1. Read this file before implementing new changes.
2. When an error is corrected, add one short entry.
3. Keep entries practical and action-oriented.

## Entry template

```md
## YYYY-MM-DD - Short title
- Context: What was being implemented.
- Mistake: What went wrong.
- Fix: What was changed.
- Prevention: Rule/check to avoid repeating it.
```

## Lessons

## 2026-04-24 - Recover stale generating state after interruptions
- Context: Queue generation could be interrupted by closing/restarting the backend or app.
- Mistake: Paragraphs in `generating` state were persisted/restored as-is, which could leave UI controls blocked after reopening.
- Fix: Added generation cancellation with request abort support and normalized interrupted `generating` paragraphs to `pending`/`ok` on save and restore.
- Prevention: Never persist long-running transient states as final session state; always recover interrupted jobs to a resumable UI state.

## 2026-04-24 - Close JSX map returns explicitly
- Context: Added selection-aware paragraph rendering with a block body in `paragraphs.map`.
- Mistake: Missed the closing `)` for `return (...)`, causing a TypeScript parse error.
- Fix: Added explicit `return (...)` closure before ending the map callback.
- Prevention: After converting implicit JSX returns to block bodies, run a quick syntax check/build before continuing.

## 2026-04-24 - Avoid storing generated audio blobs in active UI state
- Context: Long TTS generations (8+ minutes) could crash the browser tab with out-of-memory.
- Mistake: Generated clips were fetched as `Blob`, kept in React state, and persisted via autosave, multiplying memory pressure.
- Fix: Switched generation and playback flow to URL-first (`audioUrl` via backend proxy), stopped persisting blobs in project autosave, and kept blob usage only as fallback/export path.
- Prevention: For long-running media workflows, store references/URLs in state and fetch binary data lazily only at the point of use.

## 2026-04-03 - Timeline seek race conditions
- Context: Timeline seek + playback controls in the web footer.
- Mistake: Seeking while audio was playing could leave stale callbacks and overlapping audio.
- Fix: Added request invalidation/guards and pause/resume control during scrub.
- Prevention: For media seek features, always test rapid drag interactions and guard async callbacks.

## 2026-04-04 - Preserve paragraph metadata on re-segmentation
- Context: Added per-paragraph speaker assignment.
- Mistake: New paragraph splitting logic could recreate paragraph items without carrying speaker metadata.
- Fix: Initialized `speakerModelId`/`speakerOverridden` for new paragraphs and preserved previous items when text matches.
- Prevention: When adding paragraph-level features, audit all `setParagraphs` paths to ensure metadata survives edits and auto-split.

## 2026-04-04 - Avoid hydration re-segmentation on project restore
- Context: Added project persistence and loading from IndexedDB.
- Mistake: Restoring `inputText` + `paragraphs` could trigger the auto-split effect and overwrite hydrated paragraphs.
- Fix: Added a hydration guard ref to skip one split cycle immediately after loading a saved project.
- Prevention: Any state hydration path that touches text + derived blocks must explicitly guard reactive transformation effects.
