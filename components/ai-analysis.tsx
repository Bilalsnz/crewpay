"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, Label, Note } from "@/components/ui";

/**
 * The Groq analysis panel.
 *
 * Two things it refuses to do:
 *
 *   - It never invents an analysis. When the deployment has no `GROQ_API_KEY`
 *     it says so and stays off, rather than printing something that reads like
 *     an analysis and is not one.
 *   - It never sends the numbers. It sends pool ids; the server re-reads the
 *     data from the source before prompting. A page that posted its own data to
 *     a language model could be made to describe numbers nobody ever measured.
 *
 * The feature is always compiled in and always reachable — it is configuration
 * that turns it on, not a flag in the code.
 */

type Config = { state: "checking" } | { state: "ready"; model: string } | { state: "missing"; error: string };

interface Analysis {
  text: string;
}

export function AiAnalysis({ poolIds }: { poolIds: string[] }) {
  const [config, setConfig] = useState<Config>({ state: "checking" });
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = poolIds.join(",");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/analyze", { headers: { accept: "application/json" } })
      .then((response) => response.json())
      .then((body: { ok?: boolean; configured?: boolean; model?: string; error?: string }) => {
        if (cancelled) return;
        if (body?.configured) setConfig({ state: "ready", model: body.model ?? "unknown" });
        else setConfig({ state: "missing", error: body?.error ?? "The AI analysis service is not configured on this deployment." });
      })
      .catch(() => {
        if (!cancelled) setConfig({ state: "missing", error: "FlowPay could not reach its own analysis endpoint." });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const analyse = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ poolIds }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; text?: string; error?: string }
        | null;
      if (!response.ok || !body?.ok || typeof body.text !== "string") {
        // The provider's own error text can name models, keys and endpoints, so
        // it stays on the server. A reader gets one sentence they can act on.
        setError("The analysis could not be generated. Try again in a moment.");
        return;
      }
      setAnalysis({ text: body.text });
    } catch {
      setError("The analysis could not be generated. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }, [poolIds]);

  if (poolIds.length === 0) return null;

  return (
    <Card edge="mint">
      <Label>AI Analysis</Label>

      {config.state === "checking" ? <p className="pt-2 text-sm text-muted">Checking…</p> : null}

      {config.state === "missing" ? <p className="pt-2 text-sm text-ink">AI analysis is currently unavailable.</p> : null}

      {config.state === "ready" ? (
        <>
          <p className="pt-2 text-sm text-muted">
            Get an AI-powered explanation of this opportunity, including yield and key risks.
          </p>
          <div className="pt-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void analyse()}
              className="w-full rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Analysing…" : analysis ? "Run the analysis again" : "Analyse with AI"}
            </button>
          </div>
        </>
      ) : null}

      {error ? (
        <div className="pt-3">
          <Note tone="bad">{error}</Note>
        </div>
      ) : null}

      {analysis ? (
        <div className="pt-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{analysis.text}</p>
        </div>
      ) : null}

      <p className="pt-3 text-xs text-muted">Your wallet information is not sent to the AI service.</p>
    </Card>
  );
}
