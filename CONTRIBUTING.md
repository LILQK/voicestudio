# Contributing to VoiceStudio

Thanks for your interest in improving VoiceStudio.

## Current Platform Status

At the moment, this project has only been tested on **Windows**.
Contributions for Linux/macOS compatibility are very welcome.

If you test VoiceStudio on another platform, please share:

- OS and version
- Node.js and npm versions
- Qwen setup/command used
- What worked and what failed
- Logs or screenshots when possible

## Ways to Contribute

- Report bugs
- Suggest features or UX improvements
- Improve docs and examples
- Submit fixes and refactors
- Validate and improve cross-platform support

## Reporting Issues

When opening an issue, include:

1. Clear title and short summary.
2. Reproduction steps.
3. Expected behavior vs actual behavior.
4. Environment details (OS, Node, npm, Qwen command).
5. Error logs/screenshots (if available).

## Development Setup

```bash
npm install
cp .env.example .env
npm run dev
```

PowerShell:

```powershell
Copy-Item .env.example .env
npm run dev
```

## Pull Request Guidelines

1. Keep PRs focused and small when possible.
2. Add/update docs for behavior changes.
3. Explain what changed and why.
4. Include test/validation notes in the PR description.
5. If your change targets Linux/macOS support, include platform test results.

## Code Style

- Follow existing project conventions.
- Avoid unrelated refactors in the same PR.
- Keep error messages and logs actionable.

## Community

Be respectful, constructive, and collaborative.
Every bug report, test result, and PR helps improve the project.
