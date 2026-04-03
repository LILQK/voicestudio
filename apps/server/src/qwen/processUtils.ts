import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const getPidByPort = async (port: number): Promise<number | null> => {
  try {
    const { stdout } = await execAsync(`netstat -ano -p tcp | findstr :${port}`);
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line.includes(`:${port}`) && line.includes("LISTENING"));

    if (!lines.length) {
      return null;
    }

    const last = lines[0].split(/\s+/);
    const pid = Number(last[last.length - 1]);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
};

export const killPidTree = async (pid: number): Promise<void> => {
  await execAsync(`taskkill /PID ${pid} /T /F`);
};
