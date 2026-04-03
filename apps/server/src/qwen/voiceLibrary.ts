import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { config } from "../config.js";
import { InputValidationError } from "./qwenErrors.js";

const ALLOWED_VOICE_EXTENSIONS = new Set([".pt", ".pth", ".bin"]);
const DEFAULT_VOICE_EXTENSION = ".pt";

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

const sanitizeVoiceBaseName = (value: string): string => {
  const withoutExtension = path.basename(value).replace(/\.[^.]+$/, "");
  const cleaned = withoutExtension
    .replace(/[^a-zA-Z0-9 _-]+/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .trim()
    .replace(/^_+|_+$/g, "");

  if (!cleaned) {
    throw new InputValidationError("Voice name is required");
  }

  return cleaned;
};

export const normalizeVoiceTargetName = (value: string): string =>
  `${sanitizeVoiceBaseName(value)}${DEFAULT_VOICE_EXTENSION}`;

export type VoicePresetItem = {
  name: string;
  size: number;
  mtimeMs: number;
};

export const ensureVoicesDir = async (): Promise<void> => {
  await fs.mkdir(config.voicesDir, { recursive: true });
};

const resolveVoicePath = (fileName: string): string => path.join(config.voicesDir, fileName);

const ensureUniqueVoicePath = async (requestedFileName: string): Promise<{ fullPath: string; fileName: string }> => {
  const parsed = path.parse(requestedFileName);
  let attempt = 1;

  while (attempt <= 9999) {
    const candidateName =
      attempt === 1 ? `${parsed.name}${parsed.ext}` : `${parsed.name}_${attempt}${parsed.ext}`;
    const candidatePath = resolveVoicePath(candidateName);

    try {
      await fs.access(candidatePath);
      attempt += 1;
    } catch {
      return { fullPath: candidatePath, fileName: candidateName };
    }
  }

  throw new InputValidationError("Unable to generate a unique voice preset name");
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

export const saveVoicePresetBuffer = async (
  requestedName: string,
  content: Buffer,
): Promise<VoicePresetItem> => {
  await ensureVoicesDir();
  const normalizedName = normalizeVoiceTargetName(requestedName);
  const { fullPath, fileName } = await ensureUniqueVoicePath(normalizedName);
  await fs.writeFile(fullPath, content);
  const stats = await fs.stat(fullPath);

  return {
    name: fileName,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
};

export const renameVoicePreset = async (
  currentVoiceName: string,
  nextVoiceName: string,
): Promise<VoicePresetItem> => {
  await ensureVoicesDir();
  const safeCurrentName = assertValidVoiceName(currentVoiceName);
  const sourcePath = resolveVoicePath(safeCurrentName);

  try {
    await fs.access(sourcePath);
  } catch {
    throw new InputValidationError("Voice preset not found", {
      voiceName: safeCurrentName,
    });
  }

  const normalizedTarget = normalizeVoiceTargetName(nextVoiceName);
  const { fullPath: targetPath, fileName } = await ensureUniqueVoicePath(normalizedTarget);
  await fs.rename(sourcePath, targetPath);
  const stats = await fs.stat(targetPath);

  return {
    name: fileName,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
};

export const deleteVoicePreset = async (voiceName: string): Promise<void> => {
  await ensureVoicesDir();
  const safeName = assertValidVoiceName(voiceName);
  const targetPath = resolveVoicePath(safeName);

  try {
    await fs.unlink(targetPath);
  } catch {
    throw new InputValidationError("Voice preset not found", {
      voiceName: safeName,
    });
  }
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

