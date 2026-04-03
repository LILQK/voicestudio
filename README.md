# VoiceStudio + Qwen Local Auto Launcher

Proyecto local con:
- Backend `Express + TypeScript` para autoarranque y proxy de Qwen.
- Frontend `React + Vite + shadcn` para estado y pruebas basicas.

## Requisitos

- Windows + PowerShell
- Node.js 20+
- Qwen instalado localmente (este repo ya incluye una copia en `qwen/`)

## Instalacion

```powershell
cd C:\Users\ethan\OneDrive\Escritorio\voicestudio
npm install
```

Copiar variables de entorno:

```powershell
Copy-Item .env.example .env
Copy-Item apps\server\.env.example apps\server\.env
```

## Ejecucion (frontend + backend)

```powershell
npm run dev
```

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:8787`

## Flujo de arranque automatico

1. El backend arranca y ejecuta `ensureQwenReady()`.
2. Hace healthcheck a `QWEN_API_URL` (`/` y fallback `/config`).
3. Si Qwen ya esta activo, reutiliza instancia.
4. Si no existe instancia, lanza:
   - `cmd /c start_qwen3_tts_web.bat Qwen/Qwen3-TTS-12Hz-1.7B-Base`
   con `cwd=QWEN_DIR`.
5. Hace reintentos cada `HEALTHCHECK_INTERVAL_MS` hasta `STARTUP_TIMEOUT_MS`.
6. Expone estado en `GET /api/qwen/status`.

Estados:
- `starting`
- `ready`
- `error`

## Endpoints backend proxy

- `GET /api/qwen/status`
- `POST /api/qwen/run_voice_clone`
- `POST /api/qwen/save_prompt`
- `POST /api/qwen/load_prompt_and_gen`

El proxy acepta `multipart/form-data` y JSON. Para archivos valida tipo MIME y tamano maximo.

## Cliente interno frontend

`apps/web/src/lib/apiClient.ts` incluye:
- `getQwenStatus()`
- `runVoiceClone(...)`
- `savePrompt(...)`
- `loadPromptAndGen(...)`

## Variables de entorno

- `QWEN_DIR`
- `QWEN_START_CMD`
- `QWEN_API_URL`
- `STARTUP_TIMEOUT_MS`
- `HEALTHCHECK_INTERVAL_MS`
- `BACKEND_PORT`
- `MAX_UPLOAD_MB`
- `ALLOWED_AUDIO_MIME`
- `ALLOWED_PROMPT_MIME`

## Troubleshooting

### 1) Puerto 8000 ocupado

Sintoma: estado `error` con `PORT_OCCUPIED`.

Accion:
- cerrar el proceso que ocupa `127.0.0.1:8000`, o
- cambiar `QWEN_API_URL` a otro puerto valido.

### 2) Timeout de arranque

Sintoma: `STARTUP_TIMEOUT`.

Accion:
- subir `STARTUP_TIMEOUT_MS` (ej. `300000`),
- verificar GPU/entorno en `qwen/`,
- lanzar manualmente el `.bat` para validar.

### 3) Error de inferencia

Sintoma: `INFERENCE_ERROR`.

Accion:
- revisar logs backend,
- validar payload/campos,
- comprobar que endpoint exista en Qwen.

### 4) Proceso caido

Si Qwen cae, proxys siguientes devolveran error tecnico. Reiniciar `npm run dev` o levantar Qwen manualmente.

## Cierre limpio

Si el backend lanzo Qwen, al terminar backend intenta cerrar el PID escuchando en el puerto de Qwen (`taskkill /T /F`).
Si Qwen ya estaba abierto externamente, no se mata.
