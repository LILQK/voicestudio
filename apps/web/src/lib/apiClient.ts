export type QwenStatus = "starting" | "ready" | "error";

export type QwenState = {
  status: QwenStatus;
  launchedByApp: boolean;
  attempts: number;
  startupElapsedMs: number;
  lastError: string | null;
  apiUrl: string;
};

export type ProxyResult = {
  data: unknown;
  upstreamStatus: number;
  elapsedMs: number;
  transport?: string;
};

export type VoicePreset = {
  name: string;
  size: number;
  mtimeMs: number;
};

const extractApiMessage = (json: unknown): string | null => {
  if (
    json &&
    typeof json === "object" &&
    "error" in json &&
    typeof (json as { error?: { message?: unknown } }).error?.message === "string"
  ) {
    return (json as { error: { message: string } }).error.message;
  }

  return null;
};

const asFormDataIfNeeded = (payload: FormData | Record<string, unknown>): BodyInit =>
  payload instanceof FormData ? payload : JSON.stringify(payload);

const headersForPayload = (
  payload: FormData | Record<string, unknown>,
): HeadersInit | undefined =>
  payload instanceof FormData ? undefined : { "Content-Type": "application/json" };

const postEndpoint = async (
  endpoint: string,
  payload: FormData | Record<string, unknown>,
): Promise<ProxyResult> => {
  const response = await fetch(`/api/qwen/${endpoint}`, {
    method: "POST",
    body: asFormDataIfNeeded(payload),
    headers: headersForPayload(payload),
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const apiMessage =
      typeof json === "object" &&
      json !== null &&
      "error" in json &&
      typeof (json as { error?: { message?: unknown } }).error?.message === "string"
        ? (json as { error: { message: string } }).error.message
        : null;
    throw new Error(apiMessage ?? `Request failed with status ${response.status}`);
  }

  if (!json || typeof json !== "object") {
    throw new Error("Unexpected empty or non-JSON response from backend");
  }

  return json as ProxyResult;
};

export const getQwenStatus = async (): Promise<QwenState> => {
  const response = await fetch("/api/qwen/status");
  const json = await response.json();
  if (!response.ok) {
    throw new Error("Unable to fetch Qwen status");
  }
  return json as QwenState;
};

export const runVoiceClone = async (
  payload: FormData | Record<string, unknown>,
): Promise<ProxyResult> => postEndpoint("run_voice_clone", payload);

export const savePrompt = async (
  payload: FormData | Record<string, unknown>,
): Promise<ProxyResult> => postEndpoint("save_prompt", payload);

export const loadPromptAndGen = async (
  payload: FormData | Record<string, unknown>,
): Promise<ProxyResult> => postEndpoint("load_prompt_and_gen", payload);

const hasUrl = (value: unknown): value is { url: string } =>
  Boolean(
    value &&
      typeof value === "object" &&
      "url" in value &&
      typeof (value as { url: unknown }).url === "string",
  );

const findAudioUrl = (value: unknown): string | null => {
  if (hasUrl(value)) {
    return value.url;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findAudioUrl(item);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const nestedValue of Object.values(value)) {
      const nested = findAudioUrl(nestedValue);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
};

export const extractGeneratedAudioUrl = (result: ProxyResult): string | null => findAudioUrl(result.data);

export const fetchAudioViaProxy = async (sourceUrl: string): Promise<Blob> => {
  const response = await fetch(`/api/qwen/audio-file?url=${encodeURIComponent(sourceUrl)}`);
  if (!response.ok) {
    throw new Error(`Unable to fetch generated audio (${response.status})`);
  }

  return response.blob();
};

export const getVoicePresets = async (): Promise<VoicePreset[]> => {
  const response = await fetch("/api/qwen/voices");
  const json = await response.json();
  if (!response.ok || !json || typeof json !== "object" || !Array.isArray((json as { voices?: unknown }).voices)) {
    throw new Error("Unable to fetch voice presets");
  }

  return (json as { voices: VoicePreset[] }).voices;
};

export const createVoicePreset = async (payload: FormData): Promise<VoicePreset> => {
  const response = await fetch("/api/qwen/voices", {
    method: "POST",
    body: payload,
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(extractApiMessage(json) ?? `Request failed with status ${response.status}`);
  }

  if (!json || typeof json !== "object" || !("voice" in json)) {
    throw new Error("Unable to create voice preset");
  }

  return (json as { voice: VoicePreset }).voice;
};

export const renameVoicePreset = async (voiceName: string, newName: string): Promise<VoicePreset> => {
  const response = await fetch(`/api/qwen/voices/${encodeURIComponent(voiceName)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: newName }),
  });

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    throw new Error(extractApiMessage(json) ?? `Request failed with status ${response.status}`);
  }

  if (!json || typeof json !== "object" || !("voice" in json)) {
    throw new Error("Unable to rename voice preset");
  }

  return (json as { voice: VoicePreset }).voice;
};

export const deleteVoicePreset = async (voiceName: string): Promise<void> => {
  const response = await fetch(`/api/qwen/voices/${encodeURIComponent(voiceName)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    throw new Error(extractApiMessage(json) ?? `Request failed with status ${response.status}`);
  }
};


