import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "../qwen/qwenErrors.js";
import { logger } from "../logger.js";

export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (error instanceof AppError) {
    logger.error(error.message, { code: error.code, details: error.details });
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    logger.error("Upload error", { code: error.code, field: error.field, message: error.message });
    res.status(400).json({
      error: {
        code: "UPLOAD_ERROR",
        message: error.message,
        details: {
          field: error.field,
          multerCode: error.code,
        },
      },
    });
    return;
  }

  const message = error instanceof Error ? error.message : "Unexpected server error";
  logger.error("Unexpected error", message);
  res.status(500).json({
    error: {
      code: "UNEXPECTED_ERROR",
      message,
    },
  });
};
