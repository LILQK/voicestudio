import { spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { PortOccupiedError, QwenProcessError, StartupTimeoutError } from "./qwenErrors.js";
import { checkQwenHealth, isPortOpen, parseApiUrl } from "./qwenHealth.js";

export type QwenStatus = "starting" | "ready" | "error";

export type QwenState = {
  status: QwenStatus;
  launchedByApp: boolean;
  attempts: number;
  startupElapsedMs: number;
  lastError: string | null;
  apiUrl: string;
};

class QwenManager {
  private state: QwenState = {
    status: "starting",
    launchedByApp: false,
    attempts: 0,
    startupElapsedMs: 0,
    lastError: null,
    apiUrl: config.qwenApiUrl,
  };

  private startupPromise: Promise<void> | null = null;

  getState(): QwenState {
    return this.state;
  }

  async ensureQwenReady(): Promise<void> {
    if (this.state.status === "ready") {
      return;
    }
    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.startupPromise = this.startupInternal();
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  private setError(message: string): void {
    this.state = {
      ...this.state,
      status: "error",
      lastError: message,
    };
  }

  private parseStartCommand(command: string): { file: string; args: string[]; cwd?: string } {
    const normalized = command.trim();
    if (process.platform === "win32") {
      const cmdPrefix = /^cmd(\.exe)?\s+\/c\s+/i;
      const stripped = cmdPrefix.test(normalized) ? normalized.replace(cmdPrefix, "").trim() : normalized;
      return {
        file: "cmd.exe",
        // Open a visible terminal window and keep it open with /k.
        args: ["/d", "/c", "start", "", "cmd.exe", "/k", stripped],
      };
    }

    const escapedDir = config.qwenDir.replace(/"/g, '\\"');
    const escapedCmd = normalized.replace(/"/g, '\\"');
    const shellLine = `cd "${escapedDir}"; ${escapedCmd}`;

    if (process.platform === "darwin") {
      const appleScript = `tell application "Terminal" to do script "${shellLine.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
      return {
        file: "osascript",
        args: ["-e", appleScript],
      };
    }

    // Linux / other Unix-like: prefer system terminal launcher.
    return {
      file: "x-terminal-emulator",
      args: ["-e", "bash", "-lc", `${shellLine}; exec bash`],
    };
  }

  private async startupInternal(): Promise<void> {
    const startupStart = Date.now();
    this.state = {
      ...this.state,
      status: "starting",
      attempts: 0,
      startupElapsedMs: 0,
      lastError: null,
    };

    const urlData = parseApiUrl(config.qwenApiUrl);
    const health = await checkQwenHealth(config.qwenApiUrl);
    if (health.isReachable && health.isQwenGradio) {
      this.state = {
        ...this.state,
        status: "ready",
        launchedByApp: false,
        startupElapsedMs: Date.now() - startupStart,
      };
      logger.info("Reusing existing Qwen instance", {
        source: health.source,
        latencyMs: health.latencyMs,
      });
      return;
    }

    const portOpen = await isPortOpen(urlData.host, urlData.port);
    if (portOpen && !health.isQwenGradio) {
      const error = new PortOccupiedError(urlData.port);
      this.setError(error.message);
      throw error;
    }

    logger.info("Starting Qwen", {
      cwd: config.qwenDir,
      command: config.qwenStartCmd,
    });

    const launch = this.parseStartCommand(config.qwenStartCmd);
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd ?? config.qwenDir,
      shell: false,
      detached: false,
      stdio: "ignore",
      windowsHide: false,
      env: process.env,
    });
    child.unref();

    child.on("error", (error) => {
      this.setError(error.message);
      logger.error("Qwen launcher child process error", error.message);
    });

    this.state = {
      ...this.state,
      launchedByApp: true,
      status: "starting",
    };

    const deadline = Date.now() + config.startupTimeoutMs;
    while (Date.now() < deadline) {
      this.state.attempts += 1;
      const probeStart = Date.now();
      const probe = await checkQwenHealth(config.qwenApiUrl);
      const probeLatency = Date.now() - probeStart;
      this.state.startupElapsedMs = Date.now() - startupStart;
      logger.info("Qwen readiness probe", {
        attempt: this.state.attempts,
        reachable: probe.isReachable,
        isQwenGradio: probe.isQwenGradio,
        latencyMs: probeLatency,
      });

      if (probe.isReachable && probe.isQwenGradio) {
        this.state = {
          ...this.state,
          status: "ready",
          lastError: null,
          startupElapsedMs: Date.now() - startupStart,
        };
        logger.info("Qwen is ready", {
          startupElapsedMs: this.state.startupElapsedMs,
        });
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, config.healthcheckIntervalMs));
    }

    const timeoutError = new StartupTimeoutError(config.startupTimeoutMs);
    this.setError(timeoutError.message);
    throw timeoutError;
  }
}

export const qwenManager = new QwenManager();

export const registerProcessHooks = (): void => {
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", error.message);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", String(reason));
  });
};

export const assertReadyOrThrow = async (): Promise<void> => {
  try {
    await qwenManager.ensureQwenReady();
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new QwenProcessError("Unknown error ensuring Qwen readiness");
  }
};
