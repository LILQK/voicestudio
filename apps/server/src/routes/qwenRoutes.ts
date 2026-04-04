import axios from "axios";
import fs from "node:fs/promises";
import { Router } from "express";
import type { Request, Response } from "express";
import { logger } from "../logger.js";
import { upload, validateUploadedFiles } from "../middleware/uploadValidation.js";
import { config } from "../config.js";
import { InputValidationError, InferenceError } from "../qwen/qwenErrors.js";
import { assertReadyOrThrow, qwenManager } from "../qwen/qwenManager.js";
import { proxyToQwen } from "../qwen/qwenProxyClient.js";
import {
  deleteVoicePreset,
  listVoicePresets,
  loadVoicePresetAsUpload,
  renameVoicePreset,
  saveVoicePresetBuffer,
} from "../qwen/voiceLibrary.js";

const qwenRouter = Router();
const endpointChains = new Map<string, Promise<void>>();

const runSerial = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const previous = endpointChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  endpointChains.set(key, previous.then(() => current));

  await previous;
  try {
    return await task();
  } finally {
    release();
    if (endpointChains.get(key) === current) {
      endpointChains.delete(key);
    }
  }
};

const isAllowedQwenUrl = (targetUrl: string): boolean => {
  try {
    const base = new URL(config.qwenApiUrl);
    const target = new URL(targetUrl);
    return base.protocol === target.protocol && base.hostname === target.hostname && base.port === target.port;
  } catch {
    return false;
  }
};

const isPtCandidate = (value: string): boolean => value.trim().toLowerCase().includes(".pt");

const collectPtCandidates = (value: unknown): string[] => {
  if (typeof value === "string" && isPtCandidate(value)) {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPtCandidates(item));
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => collectPtCandidates(item));
  }

  return [];
};

const toCandidateUrl = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  if (trimmed.startsWith("/")) {
    return new URL(trimmed, config.qwenApiUrl).toString();
  }

  return null;
};

const resolvePromptBufferFromQwenResponse = async (qwenData: unknown): Promise<Buffer> => {
  const candidates = collectPtCandidates(qwenData);
  if (candidates.length === 0) {
    throw new InferenceError("Qwen did not return a voice prompt file");
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) {
      try {
        return await fs.readFile(candidate);
      } catch {
        // Ignore and continue with URL mode below.
      }
    }

    const candidateUrl = toCandidateUrl(candidate);
    if (!candidateUrl || !isAllowedQwenUrl(candidateUrl)) {
      continue;
    }

    const response = await axios.get<ArrayBuffer>(candidateUrl, {
      responseType: "arraybuffer",
      timeout: 120000,
      validateStatus: () => true,
    });

    if (response.status >= 200 && response.status < 300) {
      return Buffer.from(response.data);
    }
  }

  throw new InferenceError("Could not resolve generated voice prompt file from Qwen response", {
    candidates,
  });
};

const getParamAsString = (value: string | string[] | undefined, paramName: string): string => {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  throw new InputValidationError(`Missing or invalid route param: ${paramName}`);
};

qwenRouter.get("/status", (_req: Request, res: Response) => {
  res.json(qwenManager.getState());
});

qwenRouter.get("/voices", async (_req: Request, res: Response): Promise<void> => {
  const voices = await listVoicePresets();
  res.json({ voices, voicesDir: config.voicesDir });
});

qwenRouter.post("/voices", upload.any(), async (req: Request, res: Response): Promise<void> => {
  const voice = await runSerial("/voices:create", async () => {
    await assertReadyOrThrow();

    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      throw new InputValidationError("Reference audio is required");
    }

    const referenceAudio = files[0];
    validateUploadedFiles([referenceAudio], "/run_voice_clone");

    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const referenceText = typeof req.body.ref_txt === "string" ? req.body.ref_txt.trim() : "";

    if (!name) {
      throw new InputValidationError("Voice name is required");
    }

    if (!referenceText) {
      throw new InputValidationError("Reference transcript is required");
    }

    logger.info("Voice preset creation started", {
      file: referenceAudio.originalname,
      fileSize: referenceAudio.size,
    });

    const qwenResult = await proxyToQwen(
      "/save_prompt",
      {
        ref_txt: referenceText,
        use_xvec: false,
      },
      [referenceAudio],
    );

    const promptBuffer = await resolvePromptBufferFromQwenResponse((qwenResult as { data?: unknown }).data);
    const savedVoice = await saveVoicePresetBuffer(name, promptBuffer);

    logger.info("Voice preset creation finished", {
      voiceName: savedVoice.name,
      size: savedVoice.size,
    });

    return savedVoice;
  });

  res.status(201).json({ voice });
});

qwenRouter.patch("/voices/:voiceName", async (req: Request, res: Response): Promise<void> => {
  const nextName = typeof req.body.name === "string" ? req.body.name.trim() : "";
  if (!nextName) {
    throw new InputValidationError("New voice name is required");
  }

  const voiceName = getParamAsString(req.params.voiceName, "voiceName");
  const voice = await renameVoicePreset(voiceName, nextName);
  res.json({ voice });
});

qwenRouter.delete("/voices/:voiceName", async (req: Request, res: Response): Promise<void> => {
  const voiceName = getParamAsString(req.params.voiceName, "voiceName");
  await deleteVoicePreset(voiceName);
  res.json({ ok: true });
});

const runEndpoint = (endpoint: "/run_voice_clone" | "/save_prompt" | "/load_prompt_and_gen") =>
  async (req: Request, res: Response): Promise<void> => {
    const result = await runSerial(endpoint, async () => {
      const requestStart = Date.now();
      await assertReadyOrThrow();

      const body = { ...(req.body as Record<string, unknown>) };
      let files = (req.files as Express.Multer.File[]) ?? [];
      const voicePreset = typeof body.voicePreset === "string" ? body.voicePreset.trim() : "";
      if (files.length === 0 && voicePreset) {
        files = [await loadVoicePresetAsUpload(voicePreset)];
      }
      delete body.voicePreset;

      validateUploadedFiles(files, endpoint);

      logger.info("Proxy request started", {
        endpoint,
        fileCount: files.length,
      });

      const upstreamResult = await proxyToQwen(endpoint, body, files);

      logger.info("Proxy request finished", {
        endpoint,
        elapsedMs: Date.now() - requestStart,
      });

      return upstreamResult;
    });

    res.json(result);
  };

qwenRouter.get("/audio-file", async (req: Request, res: Response): Promise<void> => {
  await assertReadyOrThrow();

  const sourceUrl = typeof req.query.url === "string" ? req.query.url : "";
  if (!sourceUrl) {
    throw new InputValidationError("Missing required query param: url");
  }

  if (!isAllowedQwenUrl(sourceUrl)) {
    throw new InputValidationError("Audio URL is not allowed", {
      sourceUrl,
      expectedHost: config.qwenApiUrl,
    });
  }

  const response = await axios.get<ArrayBuffer>(sourceUrl, {
    responseType: "arraybuffer",
    timeout: 120000,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new InferenceError("Unable to fetch generated audio file", {
      status: response.status,
      sourceUrl,
    });
  }

  res.setHeader("Content-Type", response.headers["content-type"] ?? "audio/wav");
  res.setHeader("Cache-Control", "no-store");
  res.send(Buffer.from(response.data));
});

qwenRouter.delete("/audio-file", async (req: Request, res: Response): Promise<void> => {
  await assertReadyOrThrow();

  const sourceUrl = typeof req.query.url === "string" ? req.query.url : "";
  if (!sourceUrl) {
    throw new InputValidationError("Missing required query param: url");
  }

  if (!isAllowedQwenUrl(sourceUrl)) {
    throw new InputValidationError("Audio URL is not allowed", {
      sourceUrl,
      expectedHost: config.qwenApiUrl,
    });
  }

  const response = await axios.delete(sourceUrl, {
    timeout: 120000,
    validateStatus: () => true,
  });

  if (response.status >= 500) {
    throw new InferenceError("Unable to delete generated audio file", {
      status: response.status,
      sourceUrl,
    });
  }

  res.json({
    ok: true,
    deleted: response.status >= 200 && response.status < 300,
    upstreamStatus: response.status,
  });
});

qwenRouter.post("/run_voice_clone", upload.any(), runEndpoint("/run_voice_clone"));
qwenRouter.post("/save_prompt", upload.any(), runEndpoint("/save_prompt"));
qwenRouter.post("/load_prompt_and_gen", upload.any(), runEndpoint("/load_prompt_and_gen"));

export { qwenRouter };

