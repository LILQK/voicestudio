export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class StartupTimeoutError extends AppError {
  constructor(timeoutMs: number) {
    super(504, "STARTUP_TIMEOUT", `Qwen did not become ready within ${timeoutMs}ms.`);
  }
}

export class PortOccupiedError extends AppError {
  constructor(port: number) {
    super(
      409,
      "PORT_OCCUPIED",
      `Port ${port} is in use by a non-Qwen service. Stop the process or change QWEN_API_URL.`,
    );
  }
}

export class QwenProcessError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, "QWEN_PROCESS_ERROR", message, details);
  }
}

export class InputValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, "INPUT_VALIDATION_ERROR", message, details);
  }
}

export class InferenceError extends AppError {
  constructor(message: string, details?: unknown) {
    super(502, "INFERENCE_ERROR", message, details);
  }
}
