import axios, { AxiosError } from "axios";
import FormData from "form-data";
import { config } from "../config.js";
import { InferenceError } from "./qwenErrors.js";

const endpointPath = (endpoint: string): string =>
  endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

const endpointName = (endpoint: string): string => endpoint.replace(/^\//, "");

type QwenApiMode = "legacy" | "gradio6";
let cachedApiMode: QwenApiMode | null = null;

const toBoolean = (value: unknown, fallback: boolean): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const detectApiMode = async (): Promise<QwenApiMode> => {
  if (cachedApiMode) {
    return cachedApiMode;
  }

  try {
    const response = await axios.get(`${config.qwenApiUrl}/config`, {
      timeout: 2500,
      validateStatus: () => true,
    });
    const prefix = response.data?.api_prefix;
    if (typeof prefix === "string" && prefix.includes("/gradio_api")) {
      cachedApiMode = "gradio6";
      return cachedApiMode;
    }
    cachedApiMode = "legacy";
    return cachedApiMode;
  } catch {
    // Do not cache fallback on transient failures.
    return "legacy";
  }
};

const appendFiles = (form: FormData, files: Express.Multer.File[]): void => {
  for (const file of files) {
    form.append(file.fieldname, file.buffer, {
      filename: file.originalname,
      contentType: file.mimetype,
      knownLength: file.size,
    });
  }
};

const appendFields = (form: FormData, body: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value) || typeof value === "object") {
      form.append(key, JSON.stringify(value));
      continue;
    }
    form.append(key, String(value));
  }
};

const uploadFileToGradio = async (file: Express.Multer.File): Promise<{ path: string; meta: { _type: string } }> => {
  const form = new FormData();
  form.append("files", file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype,
    knownLength: file.size,
  });

  const response = await axios.post(`${config.qwenApiUrl}/gradio_api/upload`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });

  const uploadedPath = Array.isArray(response.data) ? response.data[0] : null;
  if (typeof uploadedPath !== "string" || !uploadedPath) {
    throw new InferenceError("Invalid upload response from Gradio", {
      uploadResponse: response.data,
    });
  }

  return {
    path: uploadedPath,
    meta: { _type: "gradio.FileData" },
  };
};

const buildGradioData = async (
  endpoint: string,
  body: Record<string, unknown>,
  files: Express.Multer.File[],
): Promise<unknown[]> => {
  const firstFile = files[0] ? await uploadFileToGradio(files[0]) : null;

  switch (endpointName(endpoint)) {
    case "run_voice_clone": {
      return [
        firstFile,
        asString(body.ref_txt ?? body.referenceText ?? body.promptText, ""),
        toBoolean(body.use_xvec ?? body.useXvec, false),
        asString(body.text ?? body.targetText, ""),
        asString(body.lang_disp ?? body.language, "Auto"),
      ];
    }
    case "save_prompt": {
      return [
        firstFile,
        asString(body.ref_txt ?? body.referenceText ?? body.text, ""),
        toBoolean(body.use_xvec ?? body.useXvec, false),
      ];
    }
    case "load_prompt_and_gen": {
      return [
        firstFile,
        asString(body.text ?? body.targetText, ""),
        asString(body.lang_disp ?? body.language, "Auto"),
      ];
    }
    default:
      return [];
  }
};

const waitForSseCompletion = async (
  url: string,
  timeoutMs = 180000,
): Promise<{ event: "complete" | "error"; data: unknown }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new InferenceError("Qwen inference request failed", {
        status: response.status,
        message: `Gradio result stream returned status ${response.status}`,
      });
    }

    const sseText = await response.text();
    const chunks = sseText.split(/\n\n+/).map((chunk) => chunk.trim()).filter(Boolean);

    for (const chunk of chunks) {
      const eventMatch = chunk.match(/^event:\s*(.+)$/m);
      const dataMatch = chunk.match(/^data:\s*(.+)$/m);
      if (!eventMatch || !dataMatch) {
        continue;
      }

      const eventName = eventMatch[1].trim();
      let parsedData: unknown = dataMatch[1].trim();
      try {
        parsedData = JSON.parse(String(parsedData));
      } catch {
        // keep as text
      }

      if (eventName === "complete") {
        return { event: "complete", data: parsedData };
      }
      if (eventName === "error") {
        return { event: "error", data: parsedData };
      }
    }

    throw new InferenceError("Qwen inference request failed", { message: "No complete/error event found in SSE stream" });
  } catch (error) {
    if (error instanceof InferenceError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new InferenceError("Qwen inference request failed", { message: "SSE result timeout" });
    }

    throw new InferenceError("Qwen inference request failed", {
      message: error instanceof Error ? error.message : "Unknown SSE stream error",
    });
  } finally {
    clearTimeout(timer);
  }
};

const callGradioQueuedApi = async (
  endpoint: string,
  body: Record<string, unknown>,
  files: Express.Multer.File[],
): Promise<{ data: unknown; upstreamStatus: number; transport: string }> => {
  const dataArray = await buildGradioData(endpoint, body, files);
  const apiName = endpointName(endpoint);

  const callResponse = await axios.post(
    `${config.qwenApiUrl}/gradio_api/call/${apiName}`,
    {
      data: dataArray,
    },
    {
      timeout: 120000,
      headers: {
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    },
  );

  if (callResponse.status >= 400) {
    throw new InferenceError("Qwen inference request failed", {
      endpoint,
      status: callResponse.status,
      upstreamData: callResponse.data,
      message: `Gradio call API returned status ${callResponse.status}`,
    });
  }

  const eventId = callResponse.data?.event_id as string | undefined;
  if (!eventId) {
    throw new InferenceError("Gradio call API did not return event_id", {
      endpoint,
      callResponse: callResponse.data,
    });
  }

  const parsed = await waitForSseCompletion(`${config.qwenApiUrl}/gradio_api/call/${apiName}/${eventId}`);

  if (parsed.event === "error") {
    throw new InferenceError("Qwen inference request failed", {
      endpoint,
      message: "Gradio returned error event",
      upstreamData: parsed.data,
    });
  }

  return {
    data: parsed.data,
    upstreamStatus: 200,
    transport: "gradio_call_api",
  };
};

export const proxyToQwen = async (
  endpoint: string,
  body: Record<string, unknown>,
  files: Express.Multer.File[],
): Promise<unknown> => {
  const requestStart = Date.now();
  const mode = await detectApiMode();

  try {
    if (mode === "gradio6") {
      const fallback = await callGradioQueuedApi(endpoint, body, files);
      return {
        data: fallback.data,
        upstreamStatus: fallback.upstreamStatus,
        elapsedMs: Date.now() - requestStart,
        transport: fallback.transport,
      };
    }

    if (files.length > 0) {
      const form = new FormData();
      appendFields(form, body);
      appendFiles(form, files);

      const response = await axios.post(`${config.qwenApiUrl}${endpointPath(endpoint)}`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
      });

      return {
        data: response.data,
        upstreamStatus: response.status,
        elapsedMs: Date.now() - requestStart,
      };
    }

    const response = await axios.post(`${config.qwenApiUrl}${endpointPath(endpoint)}`, body, {
      timeout: 120000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    return {
      data: response.data,
      upstreamStatus: response.status,
      elapsedMs: Date.now() - requestStart,
    };
  } catch (error) {
    if (error instanceof InferenceError) {
      throw error;
    }

    const axiosError = error as AxiosError;

    if (axiosError.response?.status === 404) {
      const fallback = await callGradioQueuedApi(endpoint, body, files);
      return {
        data: fallback.data,
        upstreamStatus: fallback.upstreamStatus,
        elapsedMs: Date.now() - requestStart,
        transport: fallback.transport,
      };
    }

    throw new InferenceError("Qwen inference request failed", {
      endpoint,
      status: axiosError.response?.status,
      upstreamData: axiosError.response?.data,
      message: axiosError.message,
      elapsedMs: Date.now() - requestStart,
    });
  }
};
