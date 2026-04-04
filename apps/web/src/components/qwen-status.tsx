import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { QwenState } from "@/lib/apiClient";

type Props = {
  state: QwenState | null;
};

const statusVariant: Record<QwenState["status"], "default" | "secondary" | "destructive"> = {
  ready: "default",
  starting: "secondary",
  error: "destructive",
};

export function QwenStatusCard({ state }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Qwen Status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {state ? (
          <>
            <div className="flex items-center gap-2">
              <span className="font-medium">Status:</span>
              <Badge variant={statusVariant[state.status]}>{state.status}</Badge>
            </div>
            <p>API: {state.apiUrl}</p>
            <p>Launched by app: {state.launchedByApp ? "yes" : "no"}</p>
            <p>Retries: {state.attempts}</p>
            <p>Startup time: {state.startupElapsedMs} ms</p>
            {state.lastError ? (
              <p className="text-destructive">Last error: {state.lastError}</p>
            ) : null}
          </>
        ) : (
          <p>Loading status...</p>
        )}
      </CardContent>
    </Card>
  );
}
