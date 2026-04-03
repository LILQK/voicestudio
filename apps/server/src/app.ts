import cors from "cors";
import express from "express";
import morgan from "morgan";
import { config } from "./config.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { logger } from "./logger.js";
import { qwenRouter } from "./routes/qwenRoutes.js";
import { qwenManager, registerProcessHooks } from "./qwen/qwenManager.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  morgan("tiny", {
    stream: {
      write: (message) => logger.info(message.trim()),
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "voicestudio-server" });
});

app.use("/api/qwen", qwenRouter);
app.use(errorHandler);

const start = async (): Promise<void> => {
  registerProcessHooks();

  app.listen(config.backendPort, async () => {
    logger.info("Server listening", {
      port: config.backendPort,
      qwenApiUrl: config.qwenApiUrl,
    });

    try {
      await qwenManager.ensureQwenReady();
    } catch (error) {
      logger.error("Qwen startup failed", error instanceof Error ? error.message : String(error));
    }
  });
};

void start();
