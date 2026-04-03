# VoiceStudio

VoiceStudio is a local text-to-speech workspace built around a React UI, an Express proxy server, and a local Qwen TTS runtime.

## What this project includes

- `apps/web`: React + Vite frontend (paragraph workflow, generation queue, playback timeline)
- `apps/server`: Express + TypeScript backend (Qwen health checks + proxy endpoints)
- Root workspace scripts for running frontend and backend together

## Important: Qwen is NOT included in this repository

The local `qwen/` runtime folder is intentionally excluded from Git.
You must install Qwen TTS separately (typically via Python package/CLI), then configure this project to launch it.

- Official Qwen3-TTS repo/docs: [https://github.com/QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)

## Requirements

- Node.js 20+
- npm 10+
- A local Qwen TTS setup running on your machine (or launchable from this project)

Typical Python setup example:

```bash
python -m venv .venv
.venv/bin/pip install qwen-tts
```

## Installation

From project root:

```bash
npm install
```

Create env files:

```bash
cp .env.example .env
```

(Use PowerShell `Copy-Item` on Windows if needed.)

## Configuration

Main server config is loaded from root `.env`.

Key variables:

- `QWEN_DIR`: working directory used when launching Qwen
- `QWEN_START_CMD`: required command used to launch Qwen (you can customize all runtime flags)
- `QWEN_API_URL`: Qwen API base URL (default `http://127.0.0.1:8000`)
- `BACKEND_PORT`: backend API port (default `8787`)
- `STARTUP_TIMEOUT_MS`: max wait time for Qwen readiness
- `HEALTHCHECK_INTERVAL_MS`: health probe interval
- `MAX_UPLOAD_MB`, `ALLOWED_AUDIO_MIME`, `ALLOWED_PROMPT_MIME`: upload limits

Example `QWEN_START_CMD`:

```bash
qwen-tts-demo Qwen/Qwen3-TTS-12Hz-1.7B-Base --device cuda:0 --dtype fp16 --no-flash-attn --ip 127.0.0.1 --port 8000
```

## Run

Start frontend + backend together:

```bash
npm run dev
```

Default URLs:

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:8787`

## How startup works

On backend startup:

1. It checks whether Qwen is already reachable at `QWEN_API_URL`.
2. If reachable, it reuses that running instance.
3. If not reachable, it launches Qwen in a terminal using `QWEN_START_CMD`.
4. It keeps probing until Qwen is ready or timeout is reached.

Note: The server does **not** kill/stop your Qwen terminal on shutdown.

## Backend endpoints

- `GET /api/qwen/status`
- `POST /api/qwen/run_voice_clone`
- `POST /api/qwen/save_prompt`
- `POST /api/qwen/load_prompt_and_gen`
- `GET /api/qwen/audio-file?url=...`

## Troubleshooting

### Process button is disabled

Check that:

- A model file is uploaded and selected
- At least one paragraph exists
- No generation is currently running

### Qwen not ready / startup timeout

- Verify `QWEN_DIR` and `QWEN_START_CMD`
- Verify your local Qwen installation works when started manually
- Increase `STARTUP_TIMEOUT_MS` if model boot is slow

### Port conflicts

If `QWEN_API_URL` port is already used by a non-Qwen process, change the port or free it.
