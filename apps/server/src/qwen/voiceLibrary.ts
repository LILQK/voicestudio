import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { InputValidationError } from "./qwenErrors.js";

const ALLOWED_VOICE_EXTENSIONS = new Set([".pt", ".pth", ".bin"]);

const hasAllowedVoiceExtension = (fileName: string): boolean =>
  ALLOWED_VOICE_EXTENSIONS.has(path.extname(fileName).toLowerCase());

const normalizeVoiceName = (voiceName: string): string => path.basename(voiceName.trim());

const assertValidVoiceName = (voiceName: string): string => {
  const normalized = normalizeVoiceName(voiceName);
  if (!normalized || normalized !== voiceName.trim()) {
    throw new InputValidationError("Invalid voice preset name", { voiceName });
  }

  if (!hasAllowedVoiceExtension(normalized)) {
    throw new InputValidationError("Voice preset extension is not allowed", {
      voiceName: normalized,
      allowed: [...ALLOWED_VOICE_EXTENSIONS],
    });
  }

  return normalized;
};

export type VoicePresetItem = {
  name: string;
  size: number;
  mtimeMs: number;
};

export const ensureVoicesDir = async (): Promise<void> => {
  await fs.mkdir(config.voicesDir, { recursive: true });
};

const listVoiceFilesInDirectory = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && hasAllowedVoiceExtension(entry.name))
    .map((entry) => entry.name);
};

export const syncDefaultVoicesFromQwen = async (): Promise<string[]> => {
  await ensureVoicesDir();
  let copied: string[] = [];

  try {
    const sourceFiles = await listVoiceFilesInDirectory(config.qwenDir);
    for (const fileName of sourceFiles) {
      const sourcePath = path.join(config.qwenDir, fileName);
      const targetPath = path.join(config.voicesDir, fileName);
      try {
        await fs.access(targetPath);
      } catch {
        await fs.copyFile(sourcePath, targetPath);
        copied.push(fileName);
      }
    }
  } catch {
    // If qwen dir does not exist or cannot be read, we keep voices dir as-is.
  }

  return copied;
};

export const listVoicePresets = async (): Promise<VoicePresetItem[]> => {
  await ensureVoicesDir();
  await syncDefaultVoicesFromQwen();

  const entries = await fs.readdir(config.voicesDir, { withFileTypes: true });
  const files: VoicePresetItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !hasAllowedVoiceExtension(entry.name)) {
      continue;
    }
    const fullPath = path.join(config.voicesDir, entry.name);
    const stats = await fs.stat(fullPath);
    files.push({
      name: entry.name,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
};

export const loadVoicePresetAsUpload = async (
  voiceName: string,
  fieldName = "audio",
): Promise<Express.Multer.File> => {
  await ensureVoicesDir();
  const safeName = assertValidVoiceName(voiceName);
  const fullPath = path.join(config.voicesDir, safeName);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(fullPath);
  } catch {
    throw new InputValidationError("Voice preset not found", {
      voiceName: safeName,
      voicesDir: config.voicesDir,
    });
  }

  return {
    fieldname: fieldName,
    originalname: safeName,
    encoding: "7bit",
    mimetype: "application/octet-stream",
    size: buffer.length,
    destination: "",
    filename: safeName,
    path: fullPath,
    buffer,
    stream: Readable.from(buffer),
  } as Express.Multer.File;
};
