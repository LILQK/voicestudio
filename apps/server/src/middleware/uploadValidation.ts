import multer from "multer";
import path from "node:path";
import { config } from "../config.js";
import { InputValidationError } from "../qwen/qwenErrors.js";

const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: {
    fileSize: config.maxUploadMb * 1024 * 1024,
  },
});

const dedupe = (items: string[]): string[] => [...new Set(items.map((item) => item.trim()).filter(Boolean))];

const allowedAudioMimes = dedupe(config.allowedAudioMime);
const allowedPromptMimes = dedupe(config.allowedPromptMime);
const allowedAudioExtensions = [".wav", ".mp3", ".flac", ".webm", ".m4a", ".ogg"];
const allowedPromptExtensions = [".pt", ".pth", ".bin", ".json", ".txt", ".wav"];

const endpointAllowsFile = (endpoint: string, file: Express.Multer.File): boolean => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (endpoint === "/run_voice_clone") {
    if (allowedAudioMimes.includes(file.mimetype)) {
      return true;
    }

    return file.mimetype === "application/octet-stream" && allowedAudioExtensions.includes(ext);
  }

  const isPromptEndpoint = endpoint === "/save_prompt" || endpoint === "/load_prompt_and_gen";
  if (!isPromptEndpoint) {
    return allowedAudioMimes.includes(file.mimetype) || allowedPromptMimes.includes(file.mimetype);
  }

  if (allowedPromptMimes.includes(file.mimetype)) {
    return true;
  }

  // Some clients send prompt/model files as octet-stream; allow only expected extensions.
  return file.mimetype === "application/octet-stream" && allowedPromptExtensions.includes(ext);
};

export const validateUploadedFiles = (
  files: Express.Multer.File[],
  endpoint: string,
): void => {
  for (const file of files) {
    if (!endpointAllowsFile(endpoint, file)) {
      throw new InputValidationError("File MIME type is not allowed", {
        endpoint,
        file: file.originalname,
        mime: file.mimetype,
        allowedAudioMimes,
        allowedPromptMimes,
        allowedPromptExtensions,
      });
    }
  }
};
