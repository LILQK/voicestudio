const now = (): string => new Date().toISOString();

const format = (level: string, message: string, details?: unknown): string => {
  const prefix = `[${now()}] [${level}] ${message}`;
  if (details === undefined) {
    return prefix;
  }
  return `${prefix} ${typeof details === "string" ? details : JSON.stringify(details)}`;
};

export const logger = {
  info: (message: string, details?: unknown): void => {
    console.log(format("INFO", message, details));
  },
  warn: (message: string, details?: unknown): void => {
    console.warn(format("WARN", message, details));
  },
  error: (message: string, details?: unknown): void => {
    console.error(format("ERROR", message, details));
  },
};
