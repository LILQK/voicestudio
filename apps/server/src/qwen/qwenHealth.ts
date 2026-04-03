import axios from "axios";
import net from "node:net";

export type HealthResult = {
  isReachable: boolean;
  isQwenGradio: boolean;
  statusCode?: number;
  latencyMs: number;
  source?: "root" | "config";
  error?: string;
};

const isGradioResponse = (body: unknown): boolean => {
  if (typeof body === "string") {
    const text = body.toLowerCase();
    return text.includes("gradio") || text.includes("qwen") || text.includes("/run_voice_clone");
  }
  if (body && typeof body === "object") {
    const serialized = JSON.stringify(body).toLowerCase();
    return serialized.includes("dependencies") || serialized.includes("gradio");
  }
  return false;
};

export const parseApiUrl = (apiUrl: string): { host: string; port: number } => {
  const parsed = new URL(apiUrl);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 80),
  };
};

export const isPortOpen = async (host: string, port: number, timeoutMs = 900): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, host);
  });

export const checkQwenHealth = async (apiUrl: string): Promise<HealthResult> => {
  const start = Date.now();

  try {
    const rootResponse = await axios.get(apiUrl, {
      timeout: 1500,
      validateStatus: () => true,
    });

    const latencyMs = Date.now() - start;
    return {
      isReachable: true,
      isQwenGradio: isGradioResponse(rootResponse.data),
      statusCode: rootResponse.status,
      latencyMs,
      source: "root",
    };
  } catch {
    try {
      const configResponse = await axios.get(`${apiUrl}/config`, {
        timeout: 1500,
        validateStatus: () => true,
      });
      const latencyMs = Date.now() - start;
      return {
        isReachable: true,
        isQwenGradio: isGradioResponse(configResponse.data),
        statusCode: configResponse.status,
        latencyMs,
        source: "config",
      };
    } catch (error) {
      return {
        isReachable: false,
        isQwenGradio: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : "Unknown healthcheck error",
      };
    }
  }
};
