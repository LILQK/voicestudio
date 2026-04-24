import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  ChevronRight,
  MoreHorizontal,
  Download,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Square,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SpeakerAvatar } from "@/components/ui/speaker-avatar";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VoiceManagerDrawer } from "@/components/voice-manager-drawer";
import {
  buildAudioProxyUrl,
  createVoicePreset,
  deleteGeneratedAudioViaProxy,
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
import {
  deleteProject as deleteStoredProject,
  getProject,
  listProjects,
  renameProject as renameStoredProject,
  upsertProject,
  type StoredParagraph,
  type StoredParagraphStatus,
  type StoredProject,
} from "@/lib/projectsStore";
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
  speakerModelId: string;
  speakerOverridden: boolean;
  status: ParagraphStatus;
  audioUrl?: string;
  audioBlob?: Blob;
  error?: string;
};

type GenerationStatus = "idle" | "running" | "completed" | "partial_error";
type ProjectHistoryItem = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};
type DisplayProjectItem = ProjectHistoryItem & { isTransient?: boolean };

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

const formatDurationLabel = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const twoDigits = (value: number): string => value.toString().padStart(2, "0");

const buildProjectName = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  return `Project ${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
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

const normalizeGeneratingStatus = (
  status: ParagraphStatus | StoredParagraphStatus,
  hasAudio: boolean,
): ParagraphStatus => {
  if (status !== "generating") {
    return status;
  }

  return hasAudio ? "ok" : "pending";
};

const recoverInterruptedParagraph = (
  paragraph: ParagraphItem,
  reason: "cancelled" | "restored",
): ParagraphItem => {
  if (paragraph.status !== "generating") {
    return paragraph;
  }

  const hasAudio = hasParagraphAudio(paragraph);
  return {
    ...paragraph,
    status: normalizeGeneratingStatus(paragraph.status, hasAudio),
    error: hasAudio ? undefined : reason === "cancelled" ? "Generation cancelled." : undefined,
  };
};

const hasParagraphAudio = (paragraph: ParagraphItem): boolean =>
  Boolean(paragraph.audioUrl || paragraph.audioBlob);

const getParagraphAudioSource = (
  paragraph: ParagraphItem,
): { src: string; cleanup?: () => void } | null => {
  if (paragraph.audioUrl) {
    return { src: buildAudioProxyUrl(paragraph.audioUrl) };
  }

  if (paragraph.audioBlob) {
    const objectUrl = URL.createObjectURL(paragraph.audioBlob);
    return {
      src: objectUrl,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  }

  return null;
};

const sortProjectHistory = (items: ProjectHistoryItem[]): ProjectHistoryItem[] =>
  [...items].sort((left, right) => right.updatedAt - left.updatedAt);

const toHistoryItem = (project: StoredProject): ProjectHistoryItem => ({
  id: project.id,
  name: project.name,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});

const upsertHistoryItem = (
  previous: ProjectHistoryItem[],
  item: ProjectHistoryItem,
): ProjectHistoryItem[] =>
  sortProjectHistory([item, ...previous.filter((project) => project.id !== item.id)]);

const hasMeaningfulSessionData = (inputText: string, paragraphs: ParagraphItem[]): boolean => {
  if (inputText.trim().length > 0) {
    return true;
  }

  return paragraphs.some(
    (paragraph) => paragraph.text.trim().length > 0 || hasParagraphAudio(paragraph),
  );
};

const buildProjectContentSignature = (
  inputText: string,
  selectedModelId: string,
  paragraphs: ParagraphItem[],
): string =>
  JSON.stringify({
    inputText,
    selectedModelId,
    paragraphs: paragraphs.map((paragraph) => ({
      id: paragraph.id,
      text: paragraph.text,
      speakerModelId: paragraph.speakerModelId,
      speakerOverridden: paragraph.speakerOverridden,
      status: paragraph.status,
      error: paragraph.error ?? "",
      audioUrl: paragraph.audioUrl ?? "",
      audioSize: paragraph.audioBlob?.size ?? 0,
      audioType: paragraph.audioBlob?.type ?? "",
    })),
  });

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
  const initialProjectTimestampRef = useRef<number>(Date.now());
  const [qwenState, setQwenState] = useState<QwenState | null>(null);
  const [inputText, setInputText] = useState("");
  const [projects, setProjects] = useState<ProjectHistoryItem[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>(() => createId());
  const [activeProjectName, setActiveProjectName] = useState<string>(() =>
    buildProjectName(initialProjectTimestampRef.current),
  );
  const [isProjectsReady, setIsProjectsReady] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState("");
  const [voicePresets, setVoicePresets] = useState<VoicePreset[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [paragraphs, setParagraphs] = useState<ParagraphItem[]>([]);
  const [generationStatus, setGenerationStatus] = useState<GenerationStatus>("idle");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [activeParagraphId, setActiveParagraphId] = useState<string | null>(null);
  const [selectedParagraphIds, setSelectedParagraphIds] = useState<string[]>([]);
  const [playingParagraphId, setPlayingParagraphId] = useState<string | null>(null);
  const [paragraphDurations, setParagraphDurations] = useState<Record<string, number>>({});
  const [timelinePositionSec, setTimelinePositionSec] = useState(0);
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false);
  const [timelineCurrentIndex, setTimelineCurrentIndex] = useState<number | null>(null);
  const [isVoiceManagerOpen, setIsVoiceManagerOpen] = useState(false);

  const runIdRef = useRef(0);
  const generationAbortControllerRef = useRef<AbortController | null>(null);
  const paragraphsRef = useRef<ParagraphItem[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const resegmentRequestedRef = useRef(false);
  const currentAudioCleanupRef = useRef<(() => void) | null>(null);
  const durationCacheRef = useRef<WeakMap<Blob, number>>(new WeakMap());
  const durationByUrlCacheRef = useRef<Map<string, number>>(new Map());
  const playbackSourceRef = useRef<"manual" | "timeline" | null>(null);
  const seekRequestIdRef = useRef(0);
  const shouldResumeAfterSeekRef = useRef(false);
  const isTimelineScrubbingRef = useRef(false);
  const timelinePlayingRef = useRef(false);
  const paragraphSelectionAnchorIndexRef = useRef<number | null>(null);
  const activeProjectCreatedAtRef = useRef<number>(initialProjectTimestampRef.current);
  const hydratingProjectRef = useRef(false);
  const lastPersistedProjectSignatureRef = useRef<string | null>(null);

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

  const onSelectVoicePreset = (voiceName: string): void => {
    setSelectedModelId(`${PRESET_MODEL_ID_PREFIX}${voiceName}`);
  };

  useEffect(() => {
    let active = true;

    void listProjects()
      .then((storedProjects) => {
        if (!active) {
          return;
        }
        setProjects(sortProjectHistory(storedProjects.map((project) => toHistoryItem(project))));
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setGlobalError("Unable to read project history from local storage.");
      })
      .finally(() => {
        if (active) {
          setIsProjectsReady(true);
        }
      });

    return () => {
      active = false;
    };
  }, []);

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
    setSelectedParagraphIds((previous) => {
      if (previous.length === 0) {
        return previous;
      }

      const availableIds = new Set(paragraphs.map((paragraph) => paragraph.id));
      const next = previous.filter((id) => availableIds.has(id));
      return next.length === previous.length ? previous : next;
    });
  }, [paragraphs]);

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
      generationAbortControllerRef.current?.abort();
      generationAbortControllerRef.current = null;
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
  const sidebarProjects = useMemo<DisplayProjectItem[]>(() => {
    const activeInHistory = projects.find((project) => project.id === activeProjectId);
    if (activeInHistory) {
      return projects;
    }

    return [
      {
        id: activeProjectId,
        name: activeProjectName,
        createdAt: activeProjectCreatedAtRef.current,
        updatedAt: Date.now(),
        isTransient: true,
      },
      ...projects,
    ];
  }, [projects, activeProjectId, activeProjectName]);

  const canGenerate =
    Boolean(selectedModel) &&
    paragraphs.length > 0 &&
    generationStatus !== "running";
  const selectedParagraphIdSet = useMemo(
    () => new Set(selectedParagraphIds),
    [selectedParagraphIds],
  );
  const orderedSelectedParagraphIds = useMemo(
    () =>
      paragraphs
        .filter((paragraph) => selectedParagraphIdSet.has(paragraph.id))
        .map((paragraph) => paragraph.id),
    [paragraphs, selectedParagraphIdSet],
  );

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

  useEffect(() => {
    if (!selectedModelId) {
      return;
    }

    setParagraphs((previous) => {
      let changed = false;
      const next = previous.map((item) => {
        if (item.speakerModelId) {
          return item;
        }

        changed = true;
        return {
          ...item,
          speakerModelId: selectedModelId,
          speakerOverridden: false,
        };
      });

      return changed ? next : previous;
    });
  }, [selectedModelId]);

  useEffect(() => {
    if (!isProjectsReady || !activeProjectId) {
      return;
    }

    if (!hasMeaningfulSessionData(inputText, paragraphs)) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      const currentSignature = buildProjectContentSignature(inputText, selectedModelId, paragraphs);
      if (currentSignature === lastPersistedProjectSignatureRef.current) {
        return;
      }

      const now = Date.now();
      const storedParagraphs: StoredParagraph[] = paragraphs.map((paragraph) => ({
        id: paragraph.id,
        text: paragraph.text,
        speakerModelId: paragraph.speakerModelId,
        speakerOverridden: paragraph.speakerOverridden,
        status: normalizeGeneratingStatus(paragraph.status, hasParagraphAudio(paragraph)),
        audioUrl: paragraph.audioUrl,
        error: paragraph.error,
      }));

      const payload: StoredProject = {
        id: activeProjectId,
        name: activeProjectName.trim() || buildProjectName(activeProjectCreatedAtRef.current),
        createdAt: activeProjectCreatedAtRef.current,
        updatedAt: now,
        inputText,
        selectedModelId,
        paragraphs: storedParagraphs,
      };

      void upsertProject(payload)
        .then(() => {
          if (cancelled) {
            return;
          }
          lastPersistedProjectSignatureRef.current = currentSignature;
          setProjects((previous) => upsertHistoryItem(previous, toHistoryItem(payload)));
        })
        .catch(() => {
          if (!cancelled) {
            setGlobalError("Unable to save project session to local storage.");
          }
        });
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    isProjectsReady,
    activeProjectId,
    activeProjectName,
    inputText,
    paragraphs,
    selectedModelId,
  ]);

  const canExport =
    generationStatus !== "running" &&
    !isExporting &&
    paragraphs.length > 0 &&
    paragraphs.every((paragraph) => paragraph.status === "ok" && hasParagraphAudio(paragraph));

  const playableParagraphIndexes = useMemo(
    () =>
      paragraphs.reduce<number[]>((acc, paragraph, index) => {
        if (paragraph.status === "ok" && hasParagraphAudio(paragraph)) {
          acc.push(index);
        }
        return acc;
      }, []),
    [paragraphs],
  );

  const timelineSegments = useMemo(() => {
    let cursor = 0;
    return playableParagraphIndexes.map((paragraphIndex) => {
      const paragraph = paragraphs[paragraphIndex];
      const duration = Math.max(paragraphDurations[paragraph?.id ?? ""] ?? 0, 0);
      const segment = {
        paragraphIndex,
        paragraphId: paragraph?.id ?? "",
        start: cursor,
        end: cursor + duration,
        duration,
      };
      cursor += duration;
      return segment;
    });
  }, [playableParagraphIndexes, paragraphs, paragraphDurations]);

  const timelineSegmentByParagraphIndex = useMemo(() => {
    const map = new Map<number, (typeof timelineSegments)[number]>();
    for (const segment of timelineSegments) {
      map.set(segment.paragraphIndex, segment);
    }
    return map;
  }, [timelineSegments]);

  const totalTimelineDuration =
    timelineSegments.length > 0 ? timelineSegments[timelineSegments.length - 1].end : 0;

  const hasPlayableTimeline = playableParagraphIndexes.length > 0;
  const timelineCurrentParagraph =
    timelineCurrentIndex !== null ? paragraphs[timelineCurrentIndex] ?? null : null;

  useEffect(() => {
    let cancelled = false;

    const playableParagraphs = paragraphs.filter(
      (paragraph) => paragraph.status === "ok" && hasParagraphAudio(paragraph),
    );

    if (playableParagraphs.length === 0) {
      setParagraphDurations((previous) => (Object.keys(previous).length === 0 ? previous : {}));
      return;
    }

    const knownIds = new Set(playableParagraphs.map((paragraph) => paragraph.id));
    setParagraphDurations((previous) => {
      const nextEntries = Object.entries(previous).filter(([id]) => knownIds.has(id));
      const next = Object.fromEntries(nextEntries);
      const previousKeys = Object.keys(previous);
      const nextKeys = Object.keys(next);
      const isSame =
        previousKeys.length === nextKeys.length &&
        nextKeys.every((key) => previous[key] === next[key]);
      return isSame ? previous : next;
    });

    const pending = playableParagraphs.filter((paragraph) => paragraphDurations[paragraph.id] === undefined);
    if (pending.length === 0) {
      return;
    }

    const readDuration = async (paragraph: ParagraphItem): Promise<number> => {
      if (paragraph.audioUrl) {
        const cached = durationByUrlCacheRef.current.get(paragraph.audioUrl);
        if (cached !== undefined) {
          return cached;
        }

        const audio = new Audio();
        audio.preload = "metadata";
        audio.src = buildAudioProxyUrl(paragraph.audioUrl);
        const duration = await new Promise<number>((resolve) => {
          const done = (value: number) => {
            audio.onloadedmetadata = null;
            audio.onerror = null;
            resolve(Number.isFinite(value) && value > 0 ? value : 0);
          };

          audio.onloadedmetadata = () => done(audio.duration);
          audio.onerror = () => done(0);
        });

        durationByUrlCacheRef.current.set(paragraph.audioUrl, duration);
        return duration;
      }

      const blob = paragraph.audioBlob;
      if (!blob) {
        return 0;
      }

      const cached = durationCacheRef.current.get(blob);
      if (cached !== undefined) {
        return cached;
      }

      const objectUrl = URL.createObjectURL(blob);
      const audio = new Audio();
      audio.preload = "metadata";
      audio.src = objectUrl;

      const duration = await new Promise<number>((resolve) => {
        const done = (value: number) => {
          audio.onloadedmetadata = null;
          audio.onerror = null;
          URL.revokeObjectURL(objectUrl);
          resolve(Number.isFinite(value) && value > 0 ? value : 0);
        };

        audio.onloadedmetadata = () => done(audio.duration);
        audio.onerror = () => done(0);
      });

      durationCacheRef.current.set(blob, duration);
      return duration;
    };

    void Promise.all(
      pending.map(async (paragraph) => {
        const duration = await readDuration(paragraph);
        return { id: paragraph.id, duration };
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }

      setParagraphDurations((previous) => {
        const next = { ...previous };
        for (const item of results) {
          next[item.id] = item.duration;
        }
        const previousKeys = Object.keys(previous);
        const nextKeys = Object.keys(next);
        const isSame =
          previousKeys.length === nextKeys.length &&
          nextKeys.every((key) => previous[key] === next[key]);
        return isSame ? previous : next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [paragraphs, paragraphDurations]);

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
    setTimelinePositionSec(0);
  }, [hasPlayableTimeline]);

  useEffect(() => {
    if (timelineCurrentIndex === null) {
      return;
    }

    const syncPosition = (): void => {
      if (isTimelineScrubbingRef.current) {
        return;
      }

      const audio = audioRef.current;
      const segment = timelineSegmentByParagraphIndex.get(timelineCurrentIndex);
      if (!audio || !segment) {
        return;
      }

      const nextPosition = Math.min(totalTimelineDuration, segment.start + audio.currentTime);
      setTimelinePositionSec(nextPosition);
    };

    syncPosition();
    const intervalId = window.setInterval(syncPosition, 120);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [timelineCurrentIndex, timelineSegmentByParagraphIndex, totalTimelineDuration]);

  useEffect(() => {
    if (hydratingProjectRef.current) {
      hydratingProjectRef.current = false;
      return;
    }

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
            speakerModelId: selectedModelId,
            speakerOverridden: false,
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
  }, [inputText, generationStatus, selectedModelId]);

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

  const onUploadVoiceModels = (files: File[]): void => {
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

  const generateSingleParagraph = async (
    id: string,
    runId: number,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const target = paragraphsRef.current.find((item) => item.id === id);
    if (!target) {
      return false;
    }

    const assignedModel = models.find((item) => item.id === target.speakerModelId);
    const activeModel = assignedModel ?? selectedModel;

    if (!activeModel) {
      updateParagraph(id, (item) => ({
        ...item,
        status: "error",
        error: "No valid voice model is available for this paragraph.",
      }));
      return false;
    }

    if (!assignedModel && target.speakerModelId) {
      updateParagraph(id, (item) => ({
        ...item,
        speakerModelId: activeModel.id,
        speakerOverridden: false,
      }));
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
      audioUrl: undefined,
      audioBlob: undefined,
      error: undefined,
    }));
    setParagraphDurations((previous) => {
      if (!(id in previous)) {
        return previous;
      }
      const next = { ...previous };
      delete next[id];
      return next;
    });

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

      const result = await loadPromptAndGen(formData, { signal });
      const audioUrl = extractGeneratedAudioUrl(result);

      if (!audioUrl) {
        throw new Error("No audio URL found in Qwen response.");
      }

      if (runId !== runIdRef.current) {
        return false;
      }

      updateParagraph(id, (item) => ({
        ...item,
        status: "ok",
        audioUrl,
        audioBlob: undefined,
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
        audioUrl: undefined,
        audioBlob: undefined,
        error: error instanceof Error ? error.message : "Unknown error while generating audio.",
      }));
      return false;
    }
  };

  const runQueue = async (ids: string[]): Promise<void> => {
    const runId = Date.now();
    const abortController = new AbortController();
    runIdRef.current = runId;
    generationAbortControllerRef.current = abortController;
    setGlobalError(null);
    setGenerationStatus("running");

    let failed = false;

    try {
      for (const id of ids) {
        if (runId !== runIdRef.current || abortController.signal.aborted) {
          break;
        }

        const success = await generateSingleParagraph(id, runId, abortController.signal);
        if (runId !== runIdRef.current || abortController.signal.aborted) {
          break;
        }

        if (!success) {
          failed = true;
        }
      }

      if (runId !== runIdRef.current || abortController.signal.aborted) {
        return;
      }

      setGenerationStatus(failed ? "partial_error" : "completed");
    } finally {
      if (generationAbortControllerRef.current === abortController) {
        generationAbortControllerRef.current = null;
      }
    }
  };

  const onCancelGeneration = (): void => {
    runIdRef.current = Date.now();
    generationAbortControllerRef.current?.abort();
    generationAbortControllerRef.current = null;
    setParagraphs((previous) => {
      const next = previous.map((paragraph) => recoverInterruptedParagraph(paragraph, "cancelled"));
      setGenerationStatus(buildGenerationStatus(next));
      return next;
    });
  };

  const generateParagraphBatch = async (ids: string[]): Promise<void> => {
    if (ids.length === 0 || generationStatus === "running") {
      return;
    }
    if (!selectedModel) {
      setGlobalError("No model selected. Choose a voice preset to process.");
      return;
    }
    if (!isQwenReady) {
      setGlobalError("Qwen is not ready yet. Please wait a moment and try again.");
      return;
    }

    setSelectedParagraphIds(ids);
    await runQueue(ids);
  };

  const onGenerateAll = async (): Promise<void> => {
    if (!canGenerate) {
      return;
    }

    const ids = paragraphsRef.current.map((item) => item.id);
    await generateParagraphBatch(ids);
  };

  const onGenerateFromParagraph = async (paragraphId: string): Promise<void> => {
    const startIndex = paragraphsRef.current.findIndex((item) => item.id === paragraphId);
    if (startIndex < 0) {
      return;
    }

    const ids = paragraphsRef.current.slice(startIndex).map((item) => item.id);
    await generateParagraphBatch(ids);
  };

  const onGenerateSelectedParagraphs = async (): Promise<void> => {
    await generateParagraphBatch(orderedSelectedParagraphIds);
  };

  const onRetryParagraph = async (id: string): Promise<void> => {
    if (!selectedModel || generationStatus === "running") {
      return;
    }

    const runId = Date.now();
    const abortController = new AbortController();
    runIdRef.current = runId;
    generationAbortControllerRef.current = abortController;
    setGenerationStatus("running");

    try {
      await generateSingleParagraph(id, runId, abortController.signal);
      if (runId === runIdRef.current && !abortController.signal.aborted) {
        setGenerationStatus(buildGenerationStatus(paragraphsRef.current));
      }
    } finally {
      if (generationAbortControllerRef.current === abortController) {
        generationAbortControllerRef.current = null;
      }
    }
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

  const onParagraphSpeakerChange = (id: string, modelId: string): void => {
    setParagraphs((previous) =>
      previous.map((item) =>
        item.id === id
          ? {
              ...item,
              speakerModelId: modelId,
              speakerOverridden: modelId !== selectedModelId,
              status: "pending" as const,
              error: undefined,
              audioUrl: undefined,
              audioBlob: undefined,
            }
          : item,
      ),
    );
  };

  const onParagraphClick = (id: string, event: MouseEvent<HTMLTextAreaElement>): void => {
    const clickedIndex = paragraphsRef.current.findIndex((paragraph) => paragraph.id === id);
    if (clickedIndex === -1) {
      return;
    }

    const isToggleSelection = event.ctrlKey || event.metaKey;
    const isRangeSelection = event.shiftKey;
    const isMultiSelectionClick = selectedParagraphIds.length > 1 && selectedParagraphIdSet.has(id);
    const isSingleSelectionClick = selectedParagraphIds.length === 1 && selectedParagraphIdSet.has(id);

    if (isRangeSelection) {
      event.preventDefault();
      const anchor = paragraphSelectionAnchorIndexRef.current ?? clickedIndex;
      const [start, end] = anchor <= clickedIndex ? [anchor, clickedIndex] : [clickedIndex, anchor];
      const ids = paragraphsRef.current.slice(start, end + 1).map((paragraph) => paragraph.id);
      setSelectedParagraphIds(ids);
      setActiveParagraphId(id);
      return;
    }

    if (isToggleSelection) {
      event.preventDefault();
      setSelectedParagraphIds((previous) => {
        const exists = previous.includes(id);
        if (exists) {
          return previous.filter((selectedId) => selectedId !== id);
        }
        return [...previous, id];
      });
      paragraphSelectionAnchorIndexRef.current = clickedIndex;
      setActiveParagraphId(id);
      return;
    }

    if (!isMultiSelectionClick) {
      if (isSingleSelectionClick) {
        setSelectedParagraphIds([]);
        paragraphSelectionAnchorIndexRef.current = null;
      } else {
        setSelectedParagraphIds([id]);
        paragraphSelectionAnchorIndexRef.current = clickedIndex;
      }
    }

    setActiveParagraphId(id);
    event.currentTarget.select();
  };

  const releaseCurrentAudioSource = (): void => {
    currentAudioCleanupRef.current?.();
    currentAudioCleanupRef.current = null;
  };

  const clearActiveAudio = (): void => {
    seekRequestIdRef.current += 1;
    setPlayingParagraphId(null);

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.onloadedmetadata = null;
      audioRef.current = null;
    }

    releaseCurrentAudioSource();
  };

  const resetSessionPlaybackState = (): void => {
    clearActiveAudio();
    playbackSourceRef.current = null;
    shouldResumeAfterSeekRef.current = false;
    isTimelineScrubbingRef.current = false;
    setPlayingParagraphId(null);
    setActiveParagraphId(null);
    setParagraphDurations({});
    setIsTimelinePlaying(false);
    setTimelineCurrentIndex(null);
    setTimelinePositionSec(0);
  };

  const onCreateNewProject = (): void => {
    const timestamp = Date.now();
    generationAbortControllerRef.current?.abort();
    generationAbortControllerRef.current = null;
    runIdRef.current = timestamp;
    resetSessionPlaybackState();
    setGlobalError(null);
    setInputText("");
    setParagraphs([]);
    setSelectedParagraphIds([]);
    paragraphSelectionAnchorIndexRef.current = null;
    setGenerationStatus("idle");
    resegmentRequestedRef.current = false;
    activeProjectCreatedAtRef.current = timestamp;
    lastPersistedProjectSignatureRef.current = null;
    setActiveProjectId(createId());
    setActiveProjectName(buildProjectName(timestamp));
  };

  const onOpenProject = async (projectId: string): Promise<void> => {
    try {
      const project = await getProject(projectId);
      if (!project) {
        return;
      }

      generationAbortControllerRef.current?.abort();
      generationAbortControllerRef.current = null;
      runIdRef.current = Date.now();
      resetSessionPlaybackState();
      resegmentRequestedRef.current = false;
      hydratingProjectRef.current = true;

      const hydratedParagraphs: ParagraphItem[] = project.paragraphs.map((paragraph) =>
        recoverInterruptedParagraph(
          {
            id: paragraph.id,
            text: paragraph.text,
            speakerModelId: paragraph.speakerModelId,
            speakerOverridden: paragraph.speakerOverridden,
            status: paragraph.status,
            audioUrl: paragraph.audioUrl,
            audioBlob: paragraph.audioUrl ? undefined : paragraph.audioBlob,
            error: paragraph.error,
          },
          "restored",
        ),
      );

      setInputText(project.inputText);
      setParagraphs(hydratedParagraphs);
      setSelectedParagraphIds([]);
      paragraphSelectionAnchorIndexRef.current = null;
      setSelectedModelId(project.selectedModelId);
      setGenerationStatus(buildGenerationStatus(hydratedParagraphs));
      setGlobalError(null);
      setActiveProjectId(project.id);
      setActiveProjectName(project.name);
      activeProjectCreatedAtRef.current = project.createdAt;
      lastPersistedProjectSignatureRef.current = buildProjectContentSignature(
        project.inputText,
        project.selectedModelId,
        hydratedParagraphs,
      );
    } catch {
      setGlobalError("Unable to open the selected project.");
    }
  };

  const onRenameProject = (projectId: string): void => {
    const current = sidebarProjects.find((project) => project.id === projectId);
    if (!current) {
      return;
    }
    setEditingProjectId(projectId);
    setEditingProjectName(current.name);
  };

  const onCommitProjectRename = async (projectId: string): Promise<void> => {
    const current = sidebarProjects.find((project) => project.id === projectId);
    const nextName = editingProjectName.trim();
    setEditingProjectId(null);
    setEditingProjectName("");

    if (!current || !nextName || nextName === current.name) {
      return;
    }

    if (current.isTransient) {
      if (projectId === activeProjectId) {
        setActiveProjectName(nextName);
      }
      return;
    }

    try {
      const renamed = await renameStoredProject(projectId, nextName);
      if (!renamed) {
        return;
      }

      if (projectId === activeProjectId) {
        setActiveProjectName(nextName);
      }

      setProjects((previous) => upsertHistoryItem(previous, toHistoryItem(renamed)));
    } catch {
      setGlobalError("Unable to rename project.");
    }
  };

  const onDeleteProject = async (projectId: string): Promise<void> => {
    const current = sidebarProjects.find((project) => project.id === projectId);
    if (!current) {
      return;
    }

    const accepted = window.confirm(`Delete "${current.name}"?`);
    if (!accepted) {
      return;
    }

    if (current.isTransient) {
      if (projectId === activeProjectId) {
        onCreateNewProject();
      }
      return;
    }

    try {
      const stored = await getProject(projectId);
      const linkedAudioUrls = Array.from(
        new Set(
          (stored?.paragraphs ?? [])
            .map((paragraph) => paragraph.audioUrl)
            .filter((url): url is string => Boolean(url)),
        ),
      );

      await Promise.all(
        linkedAudioUrls.map(async (url) => {
          try {
            await deleteGeneratedAudioViaProxy(url);
          } catch {
            // Best effort cleanup; some files may no longer exist upstream.
          }
        }),
      );

      await deleteStoredProject(projectId);
      setProjects((previous) => previous.filter((project) => project.id !== projectId));

      if (projectId === activeProjectId) {
        onCreateNewProject();
      }
    } catch {
      setGlobalError("Unable to delete project.");
    }
  };

  const findNextPlayableIndex = (startIndex: number): number => {
    for (let index = startIndex; index < paragraphsRef.current.length; index += 1) {
      const candidate = paragraphsRef.current[index];
      if (candidate?.status === "ok" && hasParagraphAudio(candidate)) {
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
    const targetSource = target ? getParagraphAudioSource(target) : null;
    if (!targetSource || !target) {
      setIsTimelinePlaying(false);
      return;
    }

    const segment = timelineSegmentByParagraphIndex.get(targetIndex);
    const baseOffset = segment?.start ?? 0;

    clearActiveAudio();

    const audio = new Audio(targetSource.src);
    audioRef.current = audio;
    currentAudioCleanupRef.current = targetSource.cleanup ?? null;
    playbackSourceRef.current = "timeline";
    setTimelineCurrentIndex(targetIndex);
    setActiveParagraphId(target.id);
    setPlayingParagraphId(target.id);
    setTimelinePositionSec(baseOffset);
    setIsTimelinePlaying(true);

    audio.onended = () => {
      setPlayingParagraphId(null);
      releaseCurrentAudioSource();

      if (audioRef.current === audio) {
        audioRef.current = null;
      }

      if (playbackSourceRef.current !== "timeline" || !timelinePlayingRef.current) {
        return;
      }

      playTimelineFrom(targetIndex + 1);
    };

    audio.onerror = () => {
      setPlayingParagraphId(null);
      releaseCurrentAudioSource();

      if (audioRef.current === audio) {
        audioRef.current = null;
      }

      if (playbackSourceRef.current === "timeline" && timelinePlayingRef.current) {
        playTimelineFrom(targetIndex + 1);
      }
    };

    void audio.play().catch(() => {
      setPlayingParagraphId(null);
      setIsTimelinePlaying(false);
    });
  };

  const onTimelineSeek = (requested: number, forceResume = false): void => {
    if (!Number.isFinite(requested) || timelineSegments.length === 0) {
      return;
    }

    const clamped = Math.max(0, Math.min(requested, totalTimelineDuration));
    setTimelinePositionSec(clamped);

    const targetSegment =
      timelineSegments.find((segment) => clamped <= segment.end) ?? timelineSegments[timelineSegments.length - 1];
    if (!targetSegment) {
      return;
    }

    const targetParagraph = paragraphsRef.current[targetSegment.paragraphIndex];
    const targetSource = targetParagraph ? getParagraphAudioSource(targetParagraph) : null;
    if (!targetParagraph || !targetSource) {
      return;
    }

    const currentAudio = audioRef.current;
    const wasPlaying =
      forceResume ||
      (playbackSourceRef.current === "timeline" && isTimelinePlaying) ||
      (playbackSourceRef.current === "timeline" && currentAudio !== null && !currentAudio.paused);
    const offsetInSegment = Math.max(0, clamped - targetSegment.start);

    clearActiveAudio();

    const audio = new Audio(targetSource.src);
    const seekRequestId = seekRequestIdRef.current;
    audioRef.current = audio;
    currentAudioCleanupRef.current = targetSource.cleanup ?? null;
    playbackSourceRef.current = "timeline";
    setTimelineCurrentIndex(targetSegment.paragraphIndex);
    setActiveParagraphId(targetParagraph.id);
    setPlayingParagraphId(wasPlaying ? targetParagraph.id : null);
    setIsTimelinePlaying(wasPlaying);

    audio.onended = () => {
      setPlayingParagraphId(null);
      releaseCurrentAudioSource();

      if (audioRef.current === audio) {
        audioRef.current = null;
      }

      if (playbackSourceRef.current !== "timeline" || !timelinePlayingRef.current) {
        return;
      }

      playTimelineFrom(targetSegment.paragraphIndex + 1);
    };

    audio.onerror = () => {
      setPlayingParagraphId(null);
      releaseCurrentAudioSource();

      if (audioRef.current === audio) {
        audioRef.current = null;
      }
    };

    const applyOffset = (): void => {
      const seekTarget = Math.max(0, Math.min(offsetInSegment, Math.max((audio.duration || 0) - 0.01, 0)));
      if (!Number.isFinite(seekTarget)) {
        return;
      }

      try {
        audio.currentTime = seekTarget;
      } catch {
        // Ignore browser-level seek errors while metadata loads.
      }
    };

    audio.onloadedmetadata = () => {
      if (audioRef.current !== audio || seekRequestId !== seekRequestIdRef.current) {
        return;
      }

      applyOffset();
      if (wasPlaying) {
        void audio.play().catch(() => {
          setPlayingParagraphId(null);
          setIsTimelinePlaying(false);
        });
      }
    };

    if (!wasPlaying) {
      applyOffset();
    }
  };

  const onTimelineScrubStart = (): void => {
    isTimelineScrubbingRef.current = true;

    const audio = audioRef.current;
    const isTimelineAudioActive = playbackSourceRef.current === "timeline" && Boolean(audio);
    const wasPlaying = isTimelineAudioActive && audio !== null && !audio.paused;

    shouldResumeAfterSeekRef.current = wasPlaying;
    if (wasPlaying && audio) {
      audio.pause();
      setPlayingParagraphId(null);
      setIsTimelinePlaying(false);
    }
  };

  const onTimelineScrubEnd = (): void => {
    // Keep locked until onValueCommitted runs; fallback unlock below covers cancellations.
    window.setTimeout(() => {
      if (isTimelineScrubbingRef.current) {
        isTimelineScrubbingRef.current = false;
      }
    }, 50);
  };

  const onTimelineToggle = (): void => {
    if (isTimelinePlaying) {
      if (playbackSourceRef.current === "timeline" && audioRef.current) {
        audioRef.current.pause();
      }
      setPlayingParagraphId(null);
      setIsTimelinePlaying(false);
      return;
    }

    if (
      playbackSourceRef.current === "timeline" &&
      audioRef.current &&
      audioRef.current.paused &&
      timelineCurrentIndex !== null
    ) {
      const currentParagraph = paragraphsRef.current[timelineCurrentIndex];
      setPlayingParagraphId(currentParagraph?.id ?? null);
      setIsTimelinePlaying(true);
      void audioRef.current.play().catch(() => {
        setPlayingParagraphId(null);
        setIsTimelinePlaying(false);
      });
      return;
    }

    const startIndex = timelineCurrentIndex ?? 0;
    playTimelineFrom(startIndex);
  };

  const onParagraphPlaybackToggle = (item: ParagraphItem): void => {
    if (!hasParagraphAudio(item)) {
      return;
    }

    const selectedTimelineParagraph =
      timelineCurrentIndex !== null ? paragraphsRef.current[timelineCurrentIndex] : null;
    const isCurrentAudioItem =
      selectedTimelineParagraph?.id === item.id &&
      playbackSourceRef.current !== null &&
      Boolean(audioRef.current);

    if (isCurrentAudioItem && audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setPlayingParagraphId(null);
      if (playbackSourceRef.current === "timeline") {
        setIsTimelinePlaying(false);
      }
      return;
    }

    if (isCurrentAudioItem && audioRef.current && audioRef.current.paused) {
      setPlayingParagraphId(item.id);
      if (playbackSourceRef.current === "timeline") {
        setIsTimelinePlaying(true);
      }
      void audioRef.current.play().catch(() => {
        setPlayingParagraphId(null);
        if (playbackSourceRef.current === "timeline") {
          setIsTimelinePlaying(false);
        }
      });
      return;
    }

    onPlay(item);
  };

  const onPlay = (item: ParagraphItem): void => {
    const source = getParagraphAudioSource(item);
    if (!source) {
      return;
    }

    const itemIndex = paragraphsRef.current.findIndex((paragraph) => paragraph.id === item.id);

    clearActiveAudio();
    playbackSourceRef.current = "manual";
    setIsTimelinePlaying(false);
    setTimelineCurrentIndex(itemIndex >= 0 ? itemIndex : null);
    if (itemIndex >= 0) {
      const segment = timelineSegmentByParagraphIndex.get(itemIndex);
      setTimelinePositionSec(segment?.start ?? 0);
    }

    const audio = new Audio(source.src);
    audioRef.current = audio;
    currentAudioCleanupRef.current = source.cleanup ?? null;
    setActiveParagraphId(item.id);
    setPlayingParagraphId(item.id);

    audio.onended = () => {
      setPlayingParagraphId(null);
      releaseCurrentAudioSource();

      if (audioRef.current === audio) {
        audioRef.current = null;
      }
    };

    audio.onerror = () => {
      setPlayingParagraphId(null);
      releaseCurrentAudioSource();
    };

    void audio.play().catch(() => {
      setPlayingParagraphId(null);
    });
  };

  const onExport = async (): Promise<void> => {
    if (!canExport) {
      return;
    }

    setIsExporting(true);
    setGlobalError(null);

    try {
      const prepared: Blob[] = [];
      for (const item of paragraphsRef.current) {
        if (item.status !== "ok") {
          continue;
        }

        if (item.audioBlob) {
          prepared.push(item.audioBlob);
          continue;
        }

        if (item.audioUrl) {
          prepared.push(await fetchAudioViaProxy(item.audioUrl));
        }
      }

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

            <Card className="gap-0">
              <CardHeader className="pb-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">Projects</CardTitle>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onCreateNewProject}
                    aria-label="Create new project"
                  >
                    <Plus />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-1">
                  {!isProjectsReady ? (
                    <p className="text-xs text-muted-foreground">Loading project history...</p>
                  ) : sidebarProjects.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No saved projects yet.</p>
                  ) : (
                    sidebarProjects.map((project) => (
                      <div
                        key={project.id}
                        className="group/item flex items-center gap-1 transition-colors hover:bg-muted/50"
                      >
                        <button
                          type="button"
                          onClick={() => void onOpenProject(project.id)}
                          className="min-w-0 flex-1 py-1.5 text-left"
                        >
                          {editingProjectId === project.id ? (
                            <Input
                              value={editingProjectName}
                              autoFocus
                              className="h-8"
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => setEditingProjectName(event.target.value)}
                              onBlur={() => void onCommitProjectRename(project.id)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void onCommitProjectRename(project.id);
                                }
                                if (event.key === "Escape") {
                                  setEditingProjectId(null);
                                  setEditingProjectName("");
                                }
                              }}
                            />
                          ) : (
                            <p
                              className={`line-clamp-1 text-sm ${
                                project.id === activeProjectId
                                  ? "inline-block -ml-2 rounded-md bg-muted px-2 py-0.5 font-semibold text-foreground"
                                  : "font-normal text-foreground/85"
                              }`}
                            >
                              {project.name}
                            </p>
                          )}
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="mr-1 size-7 shrink-0 opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100"
                              aria-label={`Project actions for ${project.name}`}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem onSelect={() => onRenameProject(project.id)}>
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onSelect={() => void onDeleteProject(project.id)}
                            >
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Audio model</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-between font-normal"
                  onClick={() => setIsVoiceManagerOpen(true)}
                >
                  <span className="truncate">{selectedModel?.name ?? "Select voice model"}</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </Button>
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
                    No voices found in `/voices`. Open the voice panel to create one.
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
                <div className="flex justify-center gap-2">
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
                  {generationStatus === "running" ? (
                    <Button type="button" variant="destructive" onClick={onCancelGeneration}>
                      <Square />
                      Cancel
                    </Button>
                  ) : null}
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
                      {paragraphs.map((item) => {
                        const isSelected = selectedParagraphIdSet.has(item.id);
                        const hasMultiSelectionContext = isSelected && orderedSelectedParagraphIds.length > 1;

                        return (
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
                          <article
                            className={`relative py-1.5 pl-4 pr-1 ${
                              isSelected ? "rounded-md bg-muted/40" : ""
                            }`}
                          >
                            <PopoverTrigger asChild>
                              <button
                                type="button"
                                aria-hidden
                                tabIndex={-1}
                                className="pointer-events-none absolute right-4 top-3 h-0 w-0 opacity-0"
                              />
                            </PopoverTrigger>
                            <PopoverContent side="top" align="end" className="w-auto">
                              {hasMultiSelectionContext ? (
                                <div className="space-y-2">
                                  <p className="text-xs text-muted-foreground">
                                    {orderedSelectedParagraphIds.length} paragraphs selected
                                  </p>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={generationStatus === "running" || !selectedModel}
                                    onClick={() => void onGenerateSelectedParagraphs()}
                                  >
                                    <RefreshCcw />
                                    Regenerate selection
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex flex-wrap items-center gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!hasParagraphAudio(item)}
                                    onClick={() => onParagraphPlaybackToggle(item)}
                                  >
                                    {playingParagraphId === item.id ? <Pause /> : <Play />}
                                    {playingParagraphId === item.id ? "Pause" : "Play"}
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
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={generationStatus === "running" || !selectedModel}
                                    onClick={() => void onGenerateFromParagraph(item.id)}
                                  >
                                    <Play />
                                    Generate from here
                                  </Button>
                                  {!hasParagraphAudio(item) ? (
                                    <span className="text-xs text-muted-foreground">No audio</span>
                                  ) : null}
                                </div>
                              )}
                            </PopoverContent>

                            <div className="absolute -left-10 top-1/2 z-10 -translate-y-1/2">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    type="button"
                                    disabled={generationStatus === "running" || models.length === 0}
                                    className="rounded-full transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50"
                                    aria-label="Change paragraph speaker"
                                  >
                                    <SpeakerAvatar
                                      name={
                                        models.find((model) => model.id === item.speakerModelId)?.name ??
                                        selectedModel?.name ??
                                        "Voice"
                                      }
                                    />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent side="right" align="start" className="w-56">
                                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                                    Paragraph speaker
                                  </DropdownMenuLabel>
                                  <DropdownMenuRadioGroup
                                    value={
                                      models.some((model) => model.id === item.speakerModelId)
                                        ? item.speakerModelId
                                        : selectedModel?.id ?? ""
                                    }
                                    onValueChange={(nextValue: string) =>
                                      onParagraphSpeakerChange(item.id, nextValue)
                                    }
                                  >
                                    {models.map((model) => (
                                      <DropdownMenuRadioItem key={model.id} value={model.id}>
                                        {model.name}
                                      </DropdownMenuRadioItem>
                                    ))}
                                  </DropdownMenuRadioGroup>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>

                            <span
                              className={`pointer-events-none absolute bottom-2 left-0 top-2 w-[3px] rounded-full ${paragraphStripClass[item.status]}`}
                              aria-hidden
                            />
                            {item.status === "generating" ? (
                              <Loader2 className="absolute -left-4 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                            ) : null}

                            <Textarea
                              className={`min-h-16 resize-none border-0 bg-transparent px-0 pr-5 pl-7 shadow-none outline-none selection:bg-sky-200 selection:text-foreground focus-visible:ring-0 ${
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
                        );
                      })}
                    </div>
                  )}
                </div>
            </div>
          </div>

          <footer className="fixed right-0 bottom-0 left-0 z-30 border-t border-border/80 bg-background/95 backdrop-blur md:left-[320px]">
            <div className="mx-auto w-full max-w-5xl px-4 py-3 md:px-6">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center">
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

              <div className="mt-2 flex items-center gap-3">
                <span className="w-10 text-xs tabular-nums text-muted-foreground">
                  {formatDurationLabel(timelinePositionSec)}
                </span>
                <Slider
                  min={0}
                  max={Math.max(totalTimelineDuration, 0)}
                  step={0.01}
                  value={[Math.min(timelinePositionSec, Math.max(totalTimelineDuration, 0))]}
                  onValueChange={(nextValue) => {
                    const next = nextValue[0] ?? 0;
                    const clamped = Math.max(0, Math.min(next, totalTimelineDuration));
                    setTimelinePositionSec(clamped);
                  }}
                  onValueCommitted={(nextValue) => {
                    const shouldResume = shouldResumeAfterSeekRef.current;
                    shouldResumeAfterSeekRef.current = false;
                    isTimelineScrubbingRef.current = false;
                    onTimelineSeek(nextValue[0] ?? 0, shouldResume);
                  }}
                  onScrubStart={onTimelineScrubStart}
                  onScrubEnd={onTimelineScrubEnd}
                  disabled={!hasPlayableTimeline || totalTimelineDuration <= 0}
                  aria-label="Timeline seek"
                />
                <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
                  {formatDurationLabel(totalTimelineDuration)}
                </span>
              </div>
            </div>
          </footer>
        </section>
      </div>
      <VoiceManagerDrawer
        isOpen={isVoiceManagerOpen}
        isQwenReady={isQwenReady}
        voices={voicePresets}
        selectedVoiceModelId={selectedModelId}
        onSelectVoicePreset={onSelectVoicePreset}
        onClose={() => setIsVoiceManagerOpen(false)}
        onRefresh={refreshVoicePresets}
        onUploadModels={onUploadVoiceModels}
        onCreate={onCreateVoicePreset}
        onRename={onRenameVoicePreset}
        onDelete={onDeleteVoicePreset}
      />
    </main>
  );
}

export default App;













