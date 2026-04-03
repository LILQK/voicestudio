import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from "react";
import {
  Download,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VoiceManagerDrawer } from "@/components/voice-manager-drawer";
import {
  createVoicePreset,
  deleteVoicePreset,
  extractGeneratedAudioUrl,
  fetchAudioViaProxy,
  getQwenStatus,
  getVoicePresets,
  loadPromptAndGen,
  renameVoicePreset as renameVoicePresetApi,
  type QwenState,
  type VoicePreset,
} from "@/lib/apiClient";
type ModelItem = {
  id: string;
  name: string;
  size: number;
  source: "preset" | "uploaded";
  file?: File;
  presetName?: string;
};

type ParagraphStatus = "pending" | "generating" | "ok" | "error";

type ParagraphItem = {
  id: string;
  text: string;
  status: ParagraphStatus;
  audioUrl?: string;
  audioBlob?: Blob;
  error?: string;
};

type GenerationStatus = "idle" | "running" | "completed" | "partial_error";

const MAX_SEGMENT_CHARACTERS = 320;
const AUTO_SPLIT_DELAY_MS = 1800;
const ACCEPTED_MODEL_EXTENSIONS = new Set([".pt", ".pth", ".bin"]);

const PRESET_MODEL_ID_PREFIX = "preset:";

const createId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }

  return `${(kb / 1024).toFixed(2)} MB`;
};

const buildPresetModelItems = (presets: { name: string; size: number }[]): ModelItem[] =>
  presets.map((preset) => ({
    id: `${PRESET_MODEL_ID_PREFIX}${preset.name}`,
    name: preset.name,
    size: preset.size,
    source: "preset",
    presetName: preset.name,
  }));

const splitOversizedBlock = (block: string, maxChars: number): string[] => {
  const cleaned = block.trim();
  if (cleaned.length <= maxChars) {
    return [cleaned];
  }

  const pieces: string[] = [];
  let cursor = cleaned;

  while (cursor.length > maxChars) {
    let splitIndex = -1;
    for (let index = maxChars; index < cursor.length; index += 1) {
      const char = cursor[index];
      if (char === "." || char === ";") {
        splitIndex = index;
        break;
      }
    }

    // Never break in the middle if no punctuation appears after the threshold.
    if (splitIndex === -1) {
      break;
    }

    pieces.push(cursor.slice(0, splitIndex + 1).trim());
    cursor = cursor.slice(splitIndex + 1).trim();
  }

  if (cursor) {
    pieces.push(cursor);
  }

  return pieces;
};

const splitTextIntoParagraphs = (text: string): string[] => {
  const baseBlocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return baseBlocks.flatMap((block) => splitOversizedBlock(block, MAX_SEGMENT_CHARACTERS));
};

const areParagraphTextsEqual = (paragraphs: ParagraphItem[], texts: string[]): boolean =>
  paragraphs.length === texts.length &&
  paragraphs.every((paragraph, index) => paragraph.text === texts[index]);

const paragraphStripClass: Record<ParagraphStatus, string> = {
  pending: "bg-muted-foreground/35",
  generating: "bg-muted-foreground/55",
  ok: "bg-blue-500",
  error: "bg-destructive",
};

const buildGenerationStatus = (paragraphs: ParagraphItem[]): GenerationStatus => {
  if (paragraphs.some((paragraph) => paragraph.status === "generating")) {
    return "running";
  }
  if (paragraphs.length > 0 && paragraphs.every((paragraph) => paragraph.status === "ok")) {
    return "completed";
  }
  if (paragraphs.some((paragraph) => paragraph.status === "error")) {
    return "partial_error";
  }
  return "idle";
};

const encodeWav = (buffer: AudioBuffer): Blob => {
  const channels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  const writeString = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = buffer.getChannelData(channel)[frame] ?? 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 32768 : clamped * 32767, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([wavBuffer], { type: "audio/wav" });
};

const resampleBuffer = async (buffer: AudioBuffer, targetRate: number): Promise<AudioBuffer> => {
  if (buffer.sampleRate === targetRate) {
    return buffer;
  }

  const offlineContext = new OfflineAudioContext(
    buffer.numberOfChannels,
    Math.ceil(buffer.duration * targetRate),
    targetRate,
  );

  const source = offlineContext.createBufferSource();
  source.buffer = buffer;
  source.connect(offlineContext.destination);
  source.start(0);

  return offlineContext.startRendering();
};

function App() {
  const [qwenState, setQwenState] = useState<QwenState | null>(null);
  const [inputText, setInputText] = useState("");
  const [voicePresets, setVoicePresets] = useState<VoicePreset[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [paragraphs, setParagraphs] = useState<ParagraphItem[]>([]);
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>("idle");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [activeParagraphId, setActiveParagraphId] = useState<string | null>(null);
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false);
  const [timelineCurrentIndex, setTimelineCurrentIndex] = useState<number | null>(null);
  const [isVoiceManagerOpen, setIsVoiceManagerOpen] = useState(false);

  const runIdRef = useRef(0);
  const paragraphsRef = useRef<ParagraphItem[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resegmentRequestedRef = useRef(false);
  const currentAudioUrlRef = useRef<string | null>(null);
  const playbackSourceRef = useRef<"manual" | "timeline" | null>(null);
  const timelinePlayingRef = useRef(false);

  const applyPresetModels = useCallback((presets: VoicePreset[]): void => {
    setVoicePresets(presets);
    setModels((previous) => {
      const uploaded = previous.filter((item) => item.source === "uploaded");
      const presetModels = buildPresetModelItems(presets);
      return [...presetModels, ...uploaded];
    });
  }, []);

  const refreshVoicePresets = useCallback(async (): Promise<void> => {
    const presets = await getVoicePresets();
    applyPresetModels(presets);
  }, [applyPresetModels]);

  useEffect(() => {
    paragraphsRef.current = paragraphs;
    setGenerationStatus(buildGenerationStatus(paragraphs));
  }, [paragraphs]);

  useEffect(() => {
    timelinePlayingRef.current = isTimelinePlaying;
  }, [isTimelinePlaying]);

  useEffect(() => {
    if (!activeParagraphId) {
      return;
    }

    if (!paragraphs.some((paragraph) => paragraph.id === activeParagraphId)) {
      setActiveParagraphId(null);
    }
  }, [paragraphs, activeParagraphId]);

  useEffect(() => {
    let active = true;

    const loadStatus = async (): Promise<void> => {
      try {
        const next = await getQwenStatus();
        if (active) {
          setQwenState(next);
        }
      } catch {
        if (active) {
          setQwenState({
            status: "error",
            launchedByApp: false,
            attempts: 0,
            startupElapsedMs: 0,
            apiUrl: "http://127.0.0.1:8000",
            lastError: "Could not connect to the local backend",
          });
        }
      }
    };

    void loadStatus();
    const interval = setInterval(() => {
      void loadStatus();
    }, 1500);

    return () => {
      active = false;
      clearInterval(interval);
      clearActiveAudio();
    };
  }, []);

  useEffect(() => {
    let active = true;

    const loadDefaultVoices = async (): Promise<void> => {
      try {
        const presets = await getVoicePresets();
        if (active) {
          applyPresetModels(presets);
        }
      } catch {
        if (active) {
          setGlobalError("Unable to load voice presets from /voices.");
        }
      }
    };

    void loadDefaultVoices();

    return () => {
      active = false;
    };
  }, [applyPresetModels]);

  const selectedModel = useMemo(() => {
    if (models.length === 0) {
      return null;
    }

    return models.find((item) => item.id === selectedModelId) ?? models[0];
  }, [models, selectedModelId]);
  const isQwenReady = (qwenState?.status ?? "").toLowerCase() === "ready";

  const canGenerate =
    Boolean(selectedModel) &&
    paragraphs.length > 0 &&
    generationStatus !== "running";

  useEffect(() => {
    if (models.length === 0) {
      if (selectedModelId) {
        setSelectedModelId("");
      }
      return;
    }

    const exists = models.some((model) => model.id === selectedModelId);
    if (!exists) {
      setSelectedModelId(models[0].id);
    }
  }, [models, selectedModelId]);

  const canExport =
    generationStatus !== "running" &&
    !isExporting &&
    paragraphs.length > 0 &&
    paragraphs.every((paragraph) => paragraph.status === "ok" && paragraph.audioBlob);

  const playableParagraphIndexes = useMemo(
    () =>
      paragraphs.reduce<number[]>((acc, paragraph, index) => {
        if (paragraph.status === "ok" && paragraph.audioBlob) {
          acc.push(index);
        }
        return acc;
      }, []),
    [paragraphs],
  );

  const hasPlayableTimeline = playableParagraphIndexes.length > 0;
  const timelineCurrentParagraph =
    timelineCurrentIndex !== null ? paragraphs[timelineCurrentIndex] ?? null : null;

  useEffect(() => {
    if (hasPlayableTimeline) {
      return;
    }

    if (playbackSourceRef.current === "timeline") {
      clearActiveAudio();
      playbackSourceRef.current = null;
    }

    setIsTimelinePlaying(false);
    setTimelineCurrentIndex(null);
  }, [hasPlayableTimeline]);

  useEffect(() => {
    if (generationStatus === "running") {
      return;
    }

    // When the user is already editing paragraph blocks, only re-segment if it was explicitly requested
    // by a deletion that emptied a paragraph (or all of them).
    if (paragraphsRef.current.length > 0 && !resegmentRequestedRef.current) {
      return;
    }

    const nextInput = inputText.trim();
    if (!nextInput) {
      setParagraphs([]);
      resegmentRequestedRef.current = false;
      return;
    }

    const timeout = setTimeout(() => {
      const nextTexts = splitTextIntoParagraphs(inputText);
      setParagraphs((previous) => {
        if (areParagraphTextsEqual(previous, nextTexts)) {
          return previous;
        }

        return nextTexts.map<ParagraphItem>((text, index) => {
          const previousItem = previous[index];
          if (previousItem && previousItem.text === text) {
            return previousItem;
          }

          return {
            id: createId(),
            text,
            status: "pending",
          };
        });
      });
      setGlobalError(null);
      resegmentRequestedRef.current = false;
    }, AUTO_SPLIT_DELAY_MS);

    return () => {
      clearTimeout(timeout);
    };
  }, [inputText, generationStatus]);

  const onAddModels = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    const validFiles = files.filter((file) => {
      const lowerName = file.name.toLowerCase();
      for (const extension of ACCEPTED_MODEL_EXTENSIONS) {
        if (lowerName.endsWith(extension)) {
          return true;
        }
      }
      return false;
    });

    if (validFiles.length === 0) {
      setGlobalError("Only .pt, .pth, or .bin model files are allowed.");
      return;
    }

    setModels((previous) => {
      const signatures = new Set(
        previous
          .filter((item) => item.source === "uploaded")
          .map((item) => `${item.name}-${item.size}`),
      );
      const additions = validFiles
        .filter((file) => !signatures.has(`${file.name}-${file.size}`))
        .map<ModelItem>((file) => ({
          id: createId(),
          file,
          name: file.name,
          size: file.size,
          source: "uploaded",
        }));

      const merged = [...previous, ...additions];
      if (!selectedModelId && merged.length > 0) {
        setSelectedModelId(merged[0].id);
      }
      return merged;
    });

    event.target.value = "";
  };

  const onCreateVoicePreset = async (payload: {
    name: string;
    transcript: string;
    file: File;
  }): Promise<void> => {
    const formData = new FormData();
    formData.append("name", payload.name);
    formData.append("ref_txt", payload.transcript);
    formData.append("audio", payload.file);
    await createVoicePreset(formData);
  };

  const onRenameVoicePreset = async (voiceName: string, newName: string): Promise<void> => {
    await renameVoicePresetApi(voiceName, newName);
  };

  const onDeleteVoicePreset = async (voiceName: string): Promise<void> => {
    await deleteVoicePreset(voiceName);
  };

  const updateParagraph = (id: string, updater: (item: ParagraphItem) => ParagraphItem): void => {
    setParagraphs((previous) => previous.map((item) => (item.id === id ? updater(item) : item)));
  };

  const generateSingleParagraph = async (id: string, runId: number): Promise<boolean> => {
    const activeModel = selectedModel;
    const target = paragraphsRef.current.find((item) => item.id === id);

    if (!activeModel || !target) {
      return false;
    }

    if (!target.text.trim()) {
      updateParagraph(id, (item) => ({
        ...item,
        status: "error",
        error: "This paragraph is empty.",
      }));
      return false;
    }

    updateParagraph(id, (item) => ({
      ...item,
      status: "generating",
      error: undefined,
    }));

    try {
      const formData = new FormData();
      formData.append("text", target.text);
      if (activeModel.source === "preset" && activeModel.presetName) {
        formData.append("voicePreset", activeModel.presetName);
      } else if (activeModel.file) {
        formData.append("audio", activeModel.file);
      } else {
        throw new Error("Selected voice model is invalid.");
      }

      const result = await loadPromptAndGen(formData);
      const audioUrl = extractGeneratedAudioUrl(result);

      if (!audioUrl) {
        throw new Error("No audio URL found in Qwen response.");
      }

      const audioBlob = await fetchAudioViaProxy(audioUrl);

      if (runId !== runIdRef.current) {
        return false;
      }

      updateParagraph(id, (item) => ({
        ...item,
        status: "ok",
        audioUrl,
        audioBlob,
        error: undefined,
      }));

      return true;
    } catch (error) {
      if (runId !== runIdRef.current) {
        return false;
      }

      updateParagraph(id, (item) => ({
        ...item,
        status: "error",
        audioBlob: undefined,
        error: error instanceof Error ? error.message : "Unknown error while generating audio.",
      }));
      return false;
    }
  };

  const runQueue = async (ids: string[]): Promise<void> => {
    const runId = Date.now();
    runIdRef.current = runId;
    setGlobalError(null);
    setGenerationStatus("running");

    let failed = false;

    for (const id of ids) {
      const success = await generateSingleParagraph(id, runId);
      if (!success) {
        failed = true;
      }
    }

    if (runId !== runIdRef.current) {
      return;
    }

    setGenerationStatus(failed ? "partial_error" : "completed");
  };

  const onGenerateAll = async (): Promise<void> => {
    if (!canGenerate) {
      return;
    }
    if (!isQwenReady) {
      setGlobalError("Qwen is not ready yet. Please wait a moment and try again.");
      return;
    }

    const ids = paragraphsRef.current.map((item) => item.id);
    await runQueue(ids);
  };

  const onRetryParagraph = async (id: string): Promise<void> => {
    if (!selectedModel || generationStatus === "running") {
      return;
    }

    const runId = Date.now();
    runIdRef.current = runId;
    setGenerationStatus("running");

    await generateSingleParagraph(id, runId);
    setGenerationStatus(buildGenerationStatus(paragraphsRef.current));
  };

  const onParagraphTextChange = (id: string, text: string): void => {
    setParagraphs((previous) => {
      const current = previous.find((item) => item.id === id);
      const isDeletion = Boolean(current) && text.length < (current?.text.length ?? 0);
      const paragraphBecameEmpty =
        isDeletion && Boolean(current?.text.trim()) && text.trim().length === 0;

      const next = previous.map((item) =>
        item.id === id
          ? {
              ...item,
              text,
              status: "pending" as const,
              error: undefined,
              audioUrl: undefined,
              audioBlob: undefined,
            }
          : item,
      );

      const allParagraphsEmpty = next.every((paragraph) => paragraph.text.trim().length === 0);
      resegmentRequestedRef.current = paragraphBecameEmpty || allParagraphsEmpty;

      setInputText(next.map((paragraph) => paragraph.text).join("\n\n"));
      return next;
    });
  };

  const onParagraphClick = (id: string, event: MouseEvent<HTMLTextAreaElement>): void => {
    setActiveParagraphId(id);
    event.currentTarget.select();
  };

  const clearActiveAudio = (): void => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }

    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current);
      currentAudioUrlRef.current = null;
    }
  };

  const findNextPlayableIndex = (startIndex: number): number => {
    for (let index = startIndex; index < paragraphsRef.current.length; index += 1) {
      const candidate = paragraphsRef.current[index];
      if (candidate?.status === "ok" && candidate.audioBlob) {
        return index;
      }
    }

    return -1;
  };

  const playTimelineFrom = (startIndex: number): void => {
    const targetIndex = findNextPlayableIndex(startIndex);

    if (targetIndex === -1) {
      setIsTimelinePlaying(false);
      setTimelineCurrentIndex(null);
      playbackSourceRef.current = null;
      return;
    }

    const target = paragraphsRef.current[targetIndex];
    if (!target?.audioBlob) {
      setIsTimelinePlaying(false);
      return;
    }

    clearActiveAudio();

    const objectUrl = URL.createObjectURL(target.audioBlob);
    const audio = new Audio(objectUrl);
    audioRef.current = audio;
    currentAudioUrlRef.current = objectUrl;
    playbackSourceRef.current = "timeline";
    setTimelineCurrentIndex(targetIndex);
    setActiveParagraphId(target.id);
    setIsTimelinePlaying(true);

    audio.onended = () => {
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
        currentAudioUrlRef.current = null;
      }

      if (audioRef.current === audio) {
        audioRef.current = null;
      }

      if (playbackSourceRef.current !== "timeline" || !timelinePlayingRef.current) {
        return;
      }

      playTimelineFrom(targetIndex + 1);
    };

    audio.onerror = () => {
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
        currentAudioUrlRef.current = null;
      }

      if (audioRef.current === audio) {
        audioRef.current = null;
      }

      if (playbackSourceRef.current === "timeline" && timelinePlayingRef.current) {
        playTimelineFrom(targetIndex + 1);
      }
    };

    void audio.play().catch(() => {
      setIsTimelinePlaying(false);
    });
  };

  const onTimelineToggle = (): void => {
    if (isTimelinePlaying) {
      if (playbackSourceRef.current === "timeline" && audioRef.current) {
        audioRef.current.pause();
      }
      setIsTimelinePlaying(false);
      return;
    }

    if (
      playbackSourceRef.current === "timeline" &&
      audioRef.current &&
      audioRef.current.paused &&
      timelineCurrentIndex !== null
    ) {
      setIsTimelinePlaying(true);
      void audioRef.current.play().catch(() => {
        setIsTimelinePlaying(false);
      });
      return;
    }

    const startIndex = timelineCurrentIndex ?? 0;
    playTimelineFrom(startIndex);
  };

  const onPlay = (item: ParagraphItem): void => {
    if (!item.audioBlob) {
      return;
    }

    const itemIndex = paragraphsRef.current.findIndex((paragraph) => paragraph.id === item.id);

    clearActiveAudio();
    playbackSourceRef.current = "manual";
    setIsTimelinePlaying(false);
    setTimelineCurrentIndex(itemIndex >= 0 ? itemIndex : null);

    const objectUrl = URL.createObjectURL(item.audioBlob);
    const audio = new Audio(objectUrl);
    audioRef.current = audio;
    currentAudioUrlRef.current = objectUrl;
    setActiveParagraphId(item.id);

    audio.onended = () => {
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
        currentAudioUrlRef.current = null;
      }

      if (audioRef.current === audio) {
        audioRef.current = null;
      }
    };

    audio.onerror = () => {
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
        currentAudioUrlRef.current = null;
      }
    };

    void audio.play();
  };

  const onExport = async (): Promise<void> => {
    if (!canExport) {
      return;
    }

    setIsExporting(true);
    setGlobalError(null);

    try {
      const prepared = paragraphsRef.current
        .map((item) => item.audioBlob)
        .filter((blob): blob is Blob => Boolean(blob));

      const audioContext = new AudioContext();
      const decoded = await Promise.all(
        prepared.map(async (blob) => audioContext.decodeAudioData(await blob.arrayBuffer())),
      );

      if (decoded.length === 0) {
        throw new Error("No audio clips available to export.");
      }

      const targetRate = decoded[0].sampleRate;
      const normalized = await Promise.all(decoded.map((buffer) => resampleBuffer(buffer, targetRate)));
      const channels = Math.max(...normalized.map((buffer) => buffer.numberOfChannels));
      const totalFrames = normalized.reduce((sum, buffer) => sum + buffer.length, 0);
      const merged = audioContext.createBuffer(channels, totalFrames, targetRate);

      let writeOffset = 0;
      for (const buffer of normalized) {
        for (let channel = 0; channel < channels; channel += 1) {
          const targetChannel = merged.getChannelData(channel);
          const sourceChannel =
            channel < buffer.numberOfChannels
              ? buffer.getChannelData(channel)
              : buffer.getChannelData(buffer.numberOfChannels - 1);
          targetChannel.set(sourceChannel, writeOffset);
        }
        writeOffset += buffer.length;
      }

      const wavBlob = encodeWav(merged);
      const downloadUrl = URL.createObjectURL(wavBlob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = "voicestudio-export.wav";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      await audioContext.close();
    } catch (error) {
      setGlobalError(error instanceof Error ? error.message : "Error exporting final audio.");
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="grid min-h-screen grid-cols-1 md:grid-cols-[320px_1fr]">
        <aside className="border-r border-border/80 bg-sidebar p-4 md:sticky md:top-0 md:h-screen md:overflow-y-auto md:p-5">
          <div className="space-y-4">
            <div>
              <p className="text-xs uppercase tracking-[0.15em] text-muted-foreground">VoiceStudio</p>
              <h1 className="mt-1 text-xl font-semibold">TTS Editor</h1>
            </div>

            <Button variant="outline" className="w-full" onClick={() => setIsVoiceManagerOpen(true)}>
              Create Voices
            </Button>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Audio model</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input type="file" accept=".pt,.pth,.bin" multiple onChange={onAddModels} />
                <Select
                  disabled={models.length === 0 || generationStatus === "running"}
                  value={selectedModelId}
                  onChange={(event) => setSelectedModelId(event.target.value)}
                >
                  <option value="" disabled>
                    Select a model
                  </option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </Select>
                {selectedModel ? (
                  <div className="rounded-md border border-border/80 bg-muted/60 p-2 text-xs">
                    <p className="font-medium">Active: {selectedModel.name}</p>
                    <p className="text-muted-foreground">
                      {formatBytes(selectedModel.size)} ·{" "}
                      {selectedModel.source === "preset" ? "Preset" : "Uploaded"}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No voices found in `/voices`. Upload one or add `.pt/.pth/.bin` files there.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Qwen status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span>Status</span>
                  <Badge variant={qwenState?.status === "ready" ? "default" : "secondary"}>
                    {qwenState?.status ?? "loading"}
                  </Badge>
                </div>
                <p className="text-muted-foreground">{qwenState?.apiUrl ?? "http://127.0.0.1:8000"}</p>
                {qwenState?.lastError ? <p className="text-destructive">{qwenState.lastError}</p> : null}
              </CardContent>
            </Card>
          </div>
        </aside>

        <section className="flex min-h-screen flex-col">
          <header className="sticky top-0 z-20 flex items-center justify-end border-b border-border/80 bg-background/95 px-4 py-3 backdrop-blur md:px-6">
            <Button onClick={() => void onExport()} disabled={!canExport}>
              {isExporting ? <Loader2 className="animate-spin" /> : <Download />}
              Export
            </Button>
          </header>

          <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-5 pb-28 md:px-6">
            {globalError ? (
              <Alert variant="destructive">
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{globalError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-3 border-0">
                <div className="flex justify-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button onClick={() => void onGenerateAll()} disabled={!canGenerate}>
                          {generationStatus === "running" ? <Loader2 className="animate-spin" /> : <Play />}
                          Process
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!selectedModel ? (
                      <TooltipContent>No model selected. Choose a voice preset to process.</TooltipContent>
                    ) : null}
                  </Tooltip>
                </div>

                <div>
                  {paragraphs.length === 0 ? (
                    <Textarea
                      className="min-h-56 resize-none border-0 bg-transparent px-0 shadow-none outline-none focus-visible:ring-0"
                      placeholder="Paste long text here... it will auto-split into paragraphs after a few seconds."
                      value={inputText}
                      onChange={(event) => setInputText(event.target.value)}
                      disabled={generationStatus === "running"}
                    />
                  ) : (
                    <div className="pr-1">
                      {paragraphs.map((item) => (
                        <Popover
                          key={item.id}
                          open={activeParagraphId === item.id}
                          onOpenChange={(open: boolean) => {
                            if (open) {
                              setActiveParagraphId(item.id);
                            } else if (activeParagraphId === item.id) {
                              setActiveParagraphId(null);
                            }
                          }}
                        >
                          <article className="relative py-1.5 pl-4 pr-1">
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                aria-hidden
                                tabIndex={-1}
                                className="pointer-events-none absolute right-4 top-3 h-0 w-0 opacity-0"
                              />
                            </PopoverTrigger>
                            <PopoverContent side="top" align="end" className="w-auto">
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={!item.audioBlob}
                                  onClick={() => onPlay(item)}
                                >
                                  <Play />
                                  Play
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={generationStatus === "running" || !selectedModel}
                                  onClick={() => void onRetryParagraph(item.id)}
                                >
                                  <RefreshCcw />
                                  Retry
                                </Button>
                                {!item.audioBlob ? (
                                  <span className="text-xs text-muted-foreground">No audio</span>
                                ) : null}
                              </div>
                            </PopoverContent>

                            <span
                              className={`pointer-events-none absolute bottom-2 left-0 top-2 w-[3px] rounded-full ${paragraphStripClass[item.status]}`}
                              aria-hidden
                            />
                            {item.status === "generating" ? (
                              <Loader2 className="absolute -left-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                            ) : null}

                            <Textarea
                              className={`min-h-16 resize-none border-0 bg-transparent px-0 pr-5 shadow-none outline-none selection:bg-sky-200 selection:text-foreground focus-visible:ring-0 ${
                                generationStatus === "running" && item.status === "ok"
                                  ? "cursor-pointer"
                                  : ""
                              }`}
                              value={item.text}
                              disabled={generationStatus === "running" && item.status !== "ok"}
                              readOnly={generationStatus === "running" && item.status === "ok"}
                              onChange={(event) => onParagraphTextChange(item.id, event.target.value)}
                              onClick={(event) => onParagraphClick(item.id, event)}
                            />
                            {item.error ? <p className="mt-2 text-xs text-destructive">{item.error}</p> : null}
                          </article>
                        </Popover>
                      ))}
                    </div>
                  )}
                </div>
            </div>
          </div>

          <footer className="fixed right-0 bottom-0 left-0 z-30 border-t border-border/80 bg-background/95 backdrop-blur md:left-[320px]">
            <div className="mx-auto grid w-full max-w-5xl grid-cols-[1fr_auto_1fr] items-center px-4 py-3 md:px-6">
              <div />
              <div className="flex justify-center">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasPlayableTimeline}
                  onClick={onTimelineToggle}
                  className="size-11 rounded-full p-0"
                  aria-label={isTimelinePlaying ? "Pause timeline" : "Play timeline"}
                >
                  {isTimelinePlaying ? <Pause className="size-5" /> : <Play className="size-5" />}
                </Button>
              </div>
              <p className="text-right text-xs text-muted-foreground">
                {timelineCurrentParagraph
                  ? `Paragraph ${timelineCurrentIndex !== null ? timelineCurrentIndex + 1 : ""}`
                  : `${playableParagraphIndexes.length} clip${playableParagraphIndexes.length === 1 ? "" : "s"}`}
              </p>
            </div>
          </footer>
        </section>
      </div>
      <VoiceManagerDrawer
        isOpen={isVoiceManagerOpen}
        isQwenReady={isQwenReady}
        voices={voicePresets}
        onClose={() => setIsVoiceManagerOpen(false)}
        onRefresh={refreshVoicePresets}
        onCreate={onCreateVoicePreset}
        onRename={onRenameVoicePreset}
        onDelete={onDeleteVoicePreset}
      />
    </main>
  );
}

export default App;











