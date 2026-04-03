import { spawn } from "node:child_process";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { PortOccupiedError, QwenProcessError, StartupTimeoutError } from "./qwenErrors.js";
import { checkQwenHealth, isPortOpen, parseApiUrl } from "./qwenHealth.js";
import { getPidByPort, killPidTree } from "./processUtils.js";

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
  private launchedPid: number | null = null;
  private shutdownInProgress = false;

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

  async shutdown(): Promise<void> {
    if (!this.state.launchedByApp || this.shutdownInProgress) {
      return;
    }

    this.shutdownInProgress = true;
    try {
      const { port } = parseApiUrl(config.qwenApiUrl);
      const pidFromPort = await getPidByPort(port);
      const pids = [...new Set([this.launchedPid, pidFromPort].filter((pid): pid is number => Boolean(pid)))];

      for (const pid of pids) {
        logger.info("Stopping Qwen process tree", { pid });
        try {
          await killPidTree(pid);
        } catch (error) {
          logger.warn("Unable to stop Qwen process tree", {
            pid,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.shutdownInProgress = false;
    }
  }

  private setError(message: string): void {
    this.state = {
      ...this.state,
      status: "error",
      lastError: message,
    };
  }

  private parseStartCommand(command: string): { file: string; args: string[] } {
    const normalized = command.trim();
    const cmdPrefix = /^cmd(\.exe)?\s+\/c\s+/i;
    const stripped = cmdPrefix.test(normalized) ? normalized.replace(cmdPrefix, "").trim() : normalized;

    return {
      file: "cmd.exe",
      // Open a visible terminal window and keep it open with /k.
      // Using argv tokens avoids fragile quoting/parsing issues on Windows.
      args: ["/d", "/c", "start", "", "cmd.exe", "/k", stripped],
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
      cwd: config.qwenDir,
      shell: false,
      detached: false,
      stdio: "ignore",
      windowsHide: false,
      env: process.env,
    });
    child.unref();
    this.launchedPid = child.pid ?? null;

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
        const pidFromPort = await getPidByPort(urlData.port);
        if (pidFromPort) {
          this.launchedPid = pidFromPort;
        }
        this.state = {
          ...this.state,
          status: "ready",
          lastError: null,
          startupElapsedMs: Date.now() - startupStart,
        };
        logger.info("Qwen is ready", {
          pid: this.launchedPid,
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
  const gracefulShutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down.`);
    await qwenManager.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });

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
