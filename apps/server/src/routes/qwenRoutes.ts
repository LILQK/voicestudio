import axios from "axios";
import { Router } from "express";
import type { Request, Response } from "express";
import { logger } from "../logger.js";
import { upload, validateUploadedFiles } from "../middleware/uploadValidation.js";
import { config } from "../config.js";
import { InputValidationError, InferenceError } from "../qwen/qwenErrors.js";
import { assertReadyOrThrow, qwenManager } from "../qwen/qwenManager.js";
import { proxyToQwen } from "../qwen/qwenProxyClient.js";
import { listVoicePresets, loadVoicePresetAsUpload } from "../qwen/voiceLibrary.js";

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

qwenRouter.get("/status", (_req: Request, res: Response) => {
  res.json(qwenManager.getState());
});

qwenRouter.get("/voices", async (_req: Request, res: Response): Promise<void> => {
  const voices = await listVoicePresets();
  res.json({ voices, voicesDir: config.voicesDir });
});

const runEndpoint = (endpoint: "/run_voice_clone" | "/save_prompt" | "/load_prompt_and_gen") =>
  async (req: Request, res: Response): Promise<void> => {
    const result = await runSerial(endpoint, async () => {
      const requestStart = Date.now();
      await assertReadyOrThrow();

      let files = (req.files as Express.Multer.File[]) ?? [];
      const voicePreset = typeof req.body.voicePreset === "string" ? req.body.voicePreset.trim() : "";
      if (files.length === 0 && voicePreset) {
        files = [await loadVoicePresetAsUpload(voicePreset)];
      }
      validateUploadedFiles(files, endpoint);

      logger.info("Proxy request started", {
        endpoint,
        fileCount: files.length,
      });

      const result = await proxyToQwen(endpoint, req.body as Record<string, unknown>, files);

      logger.info("Proxy request finished", {
        endpoint,
        elapsedMs: Date.now() - requestStart,
      });

      return result;
    });

    res.json(result);
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

qwenRouter.post("/run_voice_clone", upload.any(), runEndpoint("/run_voice_clone"));
qwenRouter.post("/save_prompt", upload.any(), runEndpoint("/save_prompt"));
qwenRouter.post("/load_prompt_and_gen", upload.any(), runEndpoint("/load_prompt_and_gen"));

export { qwenRouter };

