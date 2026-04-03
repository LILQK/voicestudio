import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const splitCsv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const config = {
  backendPort: toNumber(process.env.BACKEND_PORT, 8787),
  qwenDir:
    process.env.QWEN_DIR ??
    "C:\\Users\\ethan\\OneDrive\\Escritorio\\voicestudio\\qwen",
  qwenStartCmd:
    process.env.QWEN_START_CMD ??
    "cmd /c start_qwen3_tts_web.bat Qwen/Qwen3-TTS-12Hz-1.7B-Base",
  qwenApiUrl: process.env.QWEN_API_URL ?? "http://127.0.0.1:8000",
  startupTimeoutMs: toNumber(process.env.STARTUP_TIMEOUT_MS, 180000),
  healthcheckIntervalMs: toNumber(process.env.HEALTHCHECK_INTERVAL_MS, 1500),
  maxUploadMb: toNumber(process.env.MAX_UPLOAD_MB, 25),
  allowedAudioMime: splitCsv(
    process.env.ALLOWED_AUDIO_MIME ??
      "audio/wav,audio/x-wav,audio/mpeg,audio/mp3,audio/flac,audio/webm",
  ),
  allowedPromptMime: splitCsv(
    process.env.ALLOWED_PROMPT_MIME ??
      "text/plain,application/json,audio/wav,audio/x-wav",
  ),
};

export type AppConfig = typeof config;
