import type { AssemblyAiProviderConfig } from "../config/types";
import { audioBlobFromPath, fetchJson, normalizeLanguage, objectAt, sleep, textAt } from "./helpers";
import type { SttProvider } from "./types";

/**
 * Build the `speech_models` preference list for AssemblyAI.
 *
 * The singular `speech_model` parameter is deprecated: it still accepts the
 * legacy `universal` alias (which the server resolves to universal-2) but
 * rejects current model names such as `universal-3-5-pro` with HTTP 400
 * (`speech_model is deprecated. Use "speech_models" instead`). Sending the
 * array form is the only way to select a modern model. A single configured
 * model gets universal-2 appended as the fallback tier, which is AssemblyAI's
 * recommended routing; a comma-separated list is passed through as-is.
 */
export const buildSpeechModels = (model: string): string[] => {
  const requested = model
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const mapped = (requested.length > 0 ? requested : ["universal"]).map((entry) =>
    entry.toLowerCase() === "universal" ? "universal-2" : entry,
  );
  const primary = mapped[0] as string;
  const withFallback = mapped.length === 1 && primary !== "universal-2" ? [primary, "universal-2"] : mapped;
  return [...new Set(withFallback)];
};

const authHeaders = (apiKey: string): Record<string, string> => ({
  Accept: "application/json",
  Authorization: apiKey,
});

const waitForTranscript = async (id: string, config: AssemblyAiProviderConfig, signal: AbortSignal): Promise<unknown> => {
  const deadline = Date.now() + config.timeoutSeconds * 1000;
  const url = `${config.transcriptEndpoint.replace(/\/$/, "")}/${id}`;

  while (Date.now() < deadline) {
    const payload = await fetchJson(
      url,
      {
        method: "GET",
        headers: authHeaders(config.apiKey),
        signal,
        redirect: "error",
      },
      "AssemblyAI transcript status",
    );

    const status = textAt(payload, "status").toLowerCase();
    if (status === "completed") return payload;
    if (status === "error") {
      const error = textAt(payload, "error") || textAt(objectAt(payload, "error"), "message") || "unknown AssemblyAI error";
      throw new Error(`AssemblyAI transcription failed: ${error}`);
    }

    await sleep(config.pollIntervalMs, signal);
  }

  throw new Error("AssemblyAI transcription timed out.");
};

export const createAssemblyAiProvider = (config: AssemblyAiProviderConfig): SttProvider => ({
  id: "assemblyai",
  async transcribe(input) {
    const uploadPayload = await fetchJson(
      config.uploadEndpoint,
      {
        method: "POST",
        headers: {
          ...authHeaders(config.apiKey),
          "Content-Type": "application/octet-stream",
        },
        body: await audioBlobFromPath(input.audioPath),
        signal: input.signal,
        redirect: "error",
      },
      "AssemblyAI audio upload",
    );

    const audioUrl = textAt(uploadPayload, "upload_url");
    if (!audioUrl) throw new Error("AssemblyAI upload response did not include upload_url.");

    // "auto" is not a language code: it means "let the provider detect it".
    // Send language_detection instead of silently falling back to the server
    // default (en_us), otherwise the model preference list never routes.
    const requestedLanguage = (input.language ?? config.language ?? "").trim();
    const language = normalizeLanguage(requestedLanguage);
    const body: Record<string, unknown> = {
      audio_url: audioUrl,
      speech_models: buildSpeechModels(config.model),
    };
    if (language) body.language_code = language;
    else if (requestedLanguage.toLowerCase() === "auto") body.language_detection = true;

    const transcriptPayload = await fetchJson(
      config.transcriptEndpoint,
      {
        method: "POST",
        headers: {
          ...authHeaders(config.apiKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: input.signal,
        redirect: "error",
      },
      "AssemblyAI transcript request",
    );

    const id = textAt(transcriptPayload, "id");
    if (!id) throw new Error("AssemblyAI transcript response did not include id.");

    const resultPayload = await waitForTranscript(id, config, input.signal);
    const text = textAt(resultPayload, "text");
    if (!text) throw new Error("AssemblyAI transcription response did not include text.");
    return { text };
  },
});
