import {
  Mic,
  Pencil,
  RotateCw,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { VoicePreset } from "@/lib/apiClient";
import { cn } from "@/lib/utils";

type CreateVoicePayload = {
  name: string;
  transcript: string;
  file: File;
};

type VoiceManagerDrawerProps = {
  isOpen: boolean;
  isQwenReady: boolean;
  voices: VoicePreset[];
  selectedVoiceModelId: string;
  onSelectVoicePreset: (voiceName: string) => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onUploadModels: (files: File[]) => void;
  onCreate: (payload: CreateVoicePayload) => Promise<void>;
  onRename: (voiceName: string, newName: string) => Promise<void>;
  onDelete: (voiceName: string) => Promise<void>;
};

export function VoiceManagerDrawer({
  isOpen,
  isQwenReady,
  voices,
  selectedVoiceModelId,
  onSelectVoicePreset,
  onClose,
  onRefresh,
  onUploadModels,
  onCreate,
  onRename,
  onDelete,
}: VoiceManagerDrawerProps) {
  const [activeTab, setActiveTab] = useState<"voices" | "new">("voices");
  const [searchTerm, setSearchTerm] = useState("");
  const [voiceName, setVoiceName] = useState("");
  const [transcript, setTranscript] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const [editingVoiceName, setEditingVoiceName] = useState<string | null>(null);
  const [editingTargetName, setEditingTargetName] = useState("");
  const [busyVoiceName, setBusyVoiceName] = useState<string | null>(null);
  const [managerError, setManagerError] = useState<string | null>(null);

  const [isRecording, setIsRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const modelUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [modelUploadInfo, setModelUploadInfo] = useState<string | null>(null);

  const selectedFileLabel = useMemo(() => {
    if (!selectedFile) {
      return "No reference audio selected";
    }

    return selectedFile.name;
  }, [selectedFile]);

  const stopStreamTracks = (): void => {
    if (!streamRef.current) {
      return;
    }

    for (const track of streamRef.current.getTracks()) {
      track.stop();
    }
    streamRef.current = null;
  };

  const stopRecordingIfNeeded = (): void => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }

    if (recorder.state === "recording") {
      recorder.stop();
    }

    mediaRecorderRef.current = null;
    stopStreamTracks();
    setIsRecording(false);
  };

  useEffect(() => {
    if (isOpen) {
      setActiveTab("voices");
      setSearchTerm("");
      return;
    }

    stopRecordingIfNeeded();
  }, [isOpen]);

  const filteredVoices = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) {
      return voices;
    }
    return voices.filter((voice) => voice.name.toLowerCase().includes(query));
  }, [voices, searchTerm]);

  useEffect(() => {
    return () => {
      stopRecordingIfNeeded();
    };
  }, []);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setCreateError(null);
    setCreateSuccess(null);
  };

  const onModelFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    onUploadModels(files);
    if (files.length > 0) {
      setModelUploadInfo(
        files.length === 1
          ? `Uploaded model: ${files[0].name}`
          : `Uploaded ${files.length} model files.`,
      );
    }
    event.target.value = "";
  };

  const onStartRecording = async (): Promise<void> => {
    setCreateError(null);
    setCreateSuccess(null);

    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCreateError("Audio recording is not supported in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recordingChunksRef.current = [];

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(recordingChunksRef.current, { type: "audio/webm" });
        if (blob.size > 0) {
          const file = new File([blob], `recorded_reference_${Date.now()}.webm`, {
            type: "audio/webm",
          });
          setSelectedFile(file);
          setCreateSuccess("Recorded audio attached as reference.");
        }

        stopStreamTracks();
        setIsRecording(false);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to start recording.");
      stopStreamTracks();
    }
  };

  const onStopRecording = (): void => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") {
      return;
    }

    recorder.stop();
  };

  const onCreateVoice = async (): Promise<void> => {
    const trimmedName = voiceName.trim();
    const trimmedTranscript = transcript.trim();

    if (!trimmedName) {
      setCreateError("Voice name is required.");
      return;
    }

    if (!trimmedTranscript) {
      setCreateError("Reference transcript is required.");
      return;
    }

    if (!selectedFile) {
      setCreateError("Reference audio is required.");
      return;
    }

    setCreateError(null);
    setCreateSuccess(null);
    setIsCreating(true);

    try {
      await onCreate({
        name: trimmedName,
        transcript: trimmedTranscript,
        file: selectedFile,
      });

      await onRefresh();
      setCreateSuccess("Voice preset created successfully.");
      setVoiceName("");
      setTranscript("");
      setSelectedFile(null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Unable to create voice preset.");
    } finally {
      setIsCreating(false);
    }
  };

  const onRenameStart = (voice: VoicePreset): void => {
    setEditingVoiceName(voice.name);
    setEditingTargetName(voice.name.replace(/\.[^.]+$/, ""));
    setManagerError(null);
  };

  const onRenameSave = async (voiceNameToRename: string): Promise<void> => {
    const trimmed = editingTargetName.trim();
    if (!trimmed) {
      setManagerError("New name is required.");
      return;
    }

    setBusyVoiceName(voiceNameToRename);
    setManagerError(null);

    try {
      await onRename(voiceNameToRename, trimmed);
      await onRefresh();
      setEditingVoiceName(null);
      setEditingTargetName("");
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Unable to rename voice preset.");
    } finally {
      setBusyVoiceName(null);
    }
  };

  const onDeleteClick = async (voiceNameToDelete: string): Promise<void> => {
    const confirmed = window.confirm(`Delete voice preset \"${voiceNameToDelete}\"?`);
    if (!confirmed) {
      return;
    }

    setBusyVoiceName(voiceNameToDelete);
    setManagerError(null);

    try {
      await onDelete(voiceNameToDelete);
      await onRefresh();
      if (editingVoiceName === voiceNameToDelete) {
        setEditingVoiceName(null);
        setEditingTargetName("");
      }
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : "Unable to delete voice preset.");
    } finally {
      setBusyVoiceName(null);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close voice manager backdrop"
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-black/30 transition-opacity",
          isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          "fixed top-0 right-0 bottom-0 z-40 flex w-full max-w-[420px] flex-col border-l border-border bg-background shadow-xl transition-transform",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">Voice Manager</h2>
            <p className="text-xs text-muted-foreground">Select, create, rename, and delete preset voices.</p>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose}>
            <X />
          </Button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-2 rounded-md border border-border p-1">
            <Button
              type="button"
              variant={activeTab === "voices" ? "default" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("voices")}
            >
              Voices
            </Button>
            <Button
              type="button"
              variant={activeTab === "new" ? "default" : "ghost"}
              size="sm"
              onClick={() => setActiveTab("new")}
            >
              New Voice
            </Button>
          </div>

          {activeTab === "voices" ? (
            <section className="space-y-3 pb-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Voice Presets</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => void onRefresh()}>
                  <RotateCw />
                  Refresh
                </Button>
              </div>

              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search voices..."
              />

              {managerError ? (
                <Alert variant="destructive">
                  <AlertTitle>Operation failed</AlertTitle>
                  <AlertDescription>{managerError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-2">
                {filteredVoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No voice presets found.</p>
                ) : (
                  filteredVoices.map((voice) => {
                    const isEditing = editingVoiceName === voice.name;
                    const isBusy = busyVoiceName === voice.name;
                    const isSelected = selectedVoiceModelId === `preset:${voice.name}`;

                    return (
                      <article
                        key={voice.name}
                        className={cn(
                          "rounded-lg border border-border bg-muted/40 p-3 transition-colors transition-shadow",
                          !isEditing ? "hover:border-primary/50 hover:bg-accent/40 hover:shadow-sm" : "",
                          isSelected ? "border-primary/70 bg-primary/5" : "",
                        )}
                      >
                        {!isEditing ? (
                          <div className="space-y-2">
                            <button
                              type="button"
                              className="w-full cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => {
                                onSelectVoicePreset(voice.name);
                                onClose();
                              }}
                            >
                              <p className="text-sm font-medium">{voice.name}</p>
                              <p className="text-xs text-muted-foreground">{(voice.size / 1024).toFixed(1)} KB</p>
                            </button>
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={isBusy}
                                onClick={() => onRenameStart(voice)}
                              >
                                <Pencil />
                                Rename
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={isBusy}
                                onClick={() => void onDeleteClick(voice.name)}
                              >
                                <Trash2 />
                                Delete
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Input
                              value={editingTargetName}
                              onChange={(event) => setEditingTargetName(event.target.value)}
                              disabled={isBusy}
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                disabled={isBusy}
                                onClick={() => void onRenameSave(voice.name)}
                              >
                                {isBusy ? <RotateCw className="animate-spin" /> : <Pencil />}
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={isBusy}
                                onClick={() => {
                                  setEditingVoiceName(null);
                                  setEditingTargetName("");
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          ) : (
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Create Voice Preset</h3>

              {!isQwenReady ? (
                <Alert variant="destructive">
                  <AlertTitle>Qwen not ready</AlertTitle>
                  <AlertDescription>Wait for Qwen to be ready before creating voices.</AlertDescription>
                </Alert>
              ) : null}

              {createError ? (
                <Alert variant="destructive">
                  <AlertTitle>Create failed</AlertTitle>
                  <AlertDescription>{createError}</AlertDescription>
                </Alert>
              ) : null}

              {createSuccess ? (
                <Alert>
                  <AlertTitle>Done</AlertTitle>
                  <AlertDescription>{createSuccess}</AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="voice-name">
                  Voice Name
                </label>
                <Input
                  id="voice-name"
                  value={voiceName}
                  onChange={(event) => setVoiceName(event.target.value)}
                  placeholder="James default english"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="voice-transcript">
                  Reference Transcript
                </label>
                <Textarea
                  id="voice-transcript"
                  className="min-h-24"
                  value={transcript}
                  onChange={(event) => setTranscript(event.target.value)}
                  placeholder="Type exactly what the reference audio says"
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="voice-audio-file">
                  Reference Audio
                </label>
                <Input
                  id="voice-audio-file"
                  type="file"
                  accept="audio/*,.wav,.mp3,.flac,.webm,.m4a,.ogg"
                  onChange={onFileChange}
                />
                <p className="text-xs text-muted-foreground">Selected: {selectedFileLabel}</p>

                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" onClick={() => void onStartRecording()} disabled={isRecording}>
                    <Mic />
                    Record
                  </Button>
                  <Button type="button" variant="outline" onClick={onStopRecording} disabled={!isRecording}>
                    <Square />
                    Stop
                  </Button>
                </div>
              </div>

              <Button
                type="button"
                className="w-full"
                disabled={isCreating || !isQwenReady}
                onClick={() => void onCreateVoice()}
              >
                {isCreating ? <RotateCw className="animate-spin" /> : <Upload />}
                Create Voice
              </Button>

              <div className="relative my-2 py-2">
                <div className="h-px w-full bg-border" />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs uppercase tracking-wide text-muted-foreground">
                  or
                </span>
              </div>

              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Upload Voice Model</h3>
                <input
                  ref={modelUploadInputRef}
                  type="file"
                  accept=".pt,.pth,.bin"
                  multiple
                  className="hidden"
                  onChange={onModelFileChange}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => modelUploadInputRef.current?.click()}
                >
                  <Upload />
                  Upload model (.pt/.pth/.bin)
                </Button>
                {modelUploadInfo ? <p className="text-xs text-muted-foreground">{modelUploadInfo}</p> : null}
              </section>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

