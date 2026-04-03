# Contexto Actual VoiceStudio + Qwen (2026-04-03)

## Estado general

El flujo técnico está funcionando correctamente para `load_prompt_and_gen` con archivo `.pt` + texto a través del backend local.

Respuesta confirmada (real):

```json
{
  "data": [
    {
      "path": "C:\\Users\\ethan\\AppData\\Local\\Temp\\gradio\\bb1bdde42585bb1d06697571327143e24df11bff53f93e8723861cc89ad4ac6a\\audio.wav",
      "url": "http://127.0.0.1:8000/gradio_api/file=C:\\Users\\ethan\\AppData\\Local\\Temp\\gradio\\bb1bdde42585bb1d06697571327143e24df11bff53f93e8723861cc89ad4ac6a\\audio.wav",
      "size": null,
      "orig_name": "audio.wav",
      "mime_type": null,
      "is_stream": false,
      "meta": {
        "_type": "gradio.FileData"
      }
    },
    "Finished. (生成完成)"
  ],
  "upstreamStatus": 200,
  "elapsedMs": 8518,
  "transport": "gradio_call_api"
}
```

## Arquitectura implementada

- Frontend: React + Vite + TypeScript + shadcn/ui.
- Backend: Express + TypeScript.
- Qwen local: arrancado en `http://127.0.0.1:8000`.
- Proxy backend local: `http://127.0.0.1:8787`.

### Endpoints backend expuestos

- `GET /api/qwen/status`
- `POST /api/qwen/run_voice_clone`
- `POST /api/qwen/save_prompt`
- `POST /api/qwen/load_prompt_and_gen`

## Compatibilidad Gradio 6

Qwen actual expone `api_prefix: /gradio_api`.

El backend ya contempla este modo y usa transporte:

1. `POST /gradio_api/upload` (subida de archivo)
2. `POST /gradio_api/call/<api_name>` (crea `event_id`)
3. `GET /gradio_api/call/<api_name>/<event_id>` (SSE con `event: complete/error`)

El campo `transport` en respuestas indica el camino usado (`gradio_call_api`).

## Gestión de arranque y estado

- Detección de instancia existente de Qwen en `127.0.0.1:8000`.
- Si no existe, se lanza con:
  - `cmd /c start_qwen3_tts_web.bat Qwen/Qwen3-TTS-12Hz-1.7B-Base`
- Healthcheck + reintentos + timeout configurables.
- Estado expuesto para frontend: `starting | ready | error`.

## Validación de archivos

- Se acepta `.pt` aunque llegue como `application/octet-stream` para `save_prompt` y `load_prompt_and_gen`.
- Validación por tipo/tamaño en backend antes de reenviar.

## Puertos esperados

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:8787`
- Qwen/Gradio: `http://127.0.0.1:8000`

## Variables de entorno clave

- `QWEN_DIR`
- `QWEN_START_CMD`
- `QWEN_API_URL`
- `STARTUP_TIMEOUT_MS`
- `HEALTHCHECK_INTERVAL_MS`
- `BACKEND_PORT`
- `MAX_UPLOAD_MB`
- `ALLOWED_AUDIO_MIME`
- `ALLOWED_PROMPT_MIME`

## Archivos principales

- Backend app: `apps/server/src/app.ts`
- Qwen manager: `apps/server/src/qwen/qwenManager.ts`
- Proxy cliente Qwen: `apps/server/src/qwen/qwenProxyClient.ts`
- Rutas API: `apps/server/src/routes/qwenRoutes.ts`
- Frontend cliente API: `apps/web/src/lib/apiClient.ts`

## Notas operativas

- Si hay muchos procesos duplicados de `vite`/`tsx`/`concurrently`, limpiar procesos y relanzar una sola instancia por servicio.
- Cuando `load_prompt_and_gen` funciona, devuelve URL local del `audio.wav` generado por Gradio.
