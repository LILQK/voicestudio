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

## 2026-04-03 - Timeline seek race conditions
- Context: Timeline seek + playback controls in the web footer.
- Mistake: Seeking while audio was playing could leave stale callbacks and overlapping audio.
- Fix: Added request invalidation/guards and pause/resume control during scrub.
- Prevention: For media seek features, always test rapid drag interactions and guard async callbacks.
