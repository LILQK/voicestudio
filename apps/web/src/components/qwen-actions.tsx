import { useMemo, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  loadPromptAndGen,
  runVoiceClone,
  savePrompt,
  type QwenState,
} from "@/lib/apiClient";

type Props = {
  state: QwenState | null;
};

export function QwenActions({ state }: Props) {
  const [text, setText] = useState("Hello from VoiceStudio");
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [response, setResponse] = useState<string>("No calls yet.");
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const disabled = useMemo(() => !state || state.status !== "ready" || isBusy, [state, isBusy]);

  const onTextChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(event.target.value);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    setAudioFile(event.target.files?.[0] ?? null);
  };

  const execute = async (action: "run" | "save" | "load"): Promise<void> => {
    setIsBusy(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("text", text);
      if (audioFile) {
        formData.append("audio", audioFile);
      }

      const result =
        action === "run"
          ? await runVoiceClone(formData)
          : action === "save"
            ? await savePrompt(formData)
            : await loadPromptAndGen(formData);

      setResponse(JSON.stringify(result, null, 2));
    } catch (apiError) {
      setError(apiError instanceof Error ? apiError.message : "Unknown error while calling endpoint");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Qwen Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="qwen-text">
            Test text
          </label>
          <Textarea id="qwen-text" value={text} onChange={onTextChange} />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="qwen-audio">
            Audio/prompt (optional)
          </label>
          <Input id="qwen-audio" type="file" onChange={onFileChange} />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={() => void execute("run")}>
            run_voice_clone
          </Button>
          <Button disabled={disabled} onClick={() => void execute("save")} variant="secondary">
            save_prompt
          </Button>
          <Button disabled={disabled} onClick={() => void execute("load")} variant="outline">
            load_prompt_and_gen
          </Button>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Technical error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm font-medium">Result</p>
          <pre className="max-h-72 overflow-auto rounded-md border bg-muted p-3 text-xs">{response}</pre>
        </div>
      </CardContent>
    </Card>
  );
}
