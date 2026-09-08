import type { RealtimeConfig } from "../config/types";
import { formatError } from "../utils/text";
import { normalizeLanguage, objectAt, textAt } from "./helpers";

/** Node's WebSocket accepts an init object with headers; the DOM type does not. */
type WebSocketWithInit = new (url: string, init?: { headers?: Record<string, string> }) => WebSocket;
const NodeWebSocket = WebSocket as unknown as WebSocketWithInit;

const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 4_000;
/** Above this, the socket is not draining and audio is dropped instead of queued. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const numberAt = (value: unknown, key: string): number => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "number" && Number.isFinite(child) ? child : 0;
};

const buildStreamUrl = (config: RealtimeConfig): string => {
  const params = new URLSearchParams({
    sample_rate: String(config.capture.sampleRate),
    encoding: "pcm_s16le",
    speech_model: config.model,
  });
  if (config.mode) params.set("mode", config.mode);
  if (config.formatTurns) params.set("format_turns", "true");
  if (config.inactivitySeconds > 0) params.set("inactivity_timeout", String(config.inactivitySeconds));
  // Both of these are JSON-encoded arrays on the wire, not repeated params:
  // the server rejects a bare value with "Invalid 'keyterms_prompt': Value
  // error, Invalid JSON array".
  const language = normalizeLanguage(config.language);
  if (language) {
    const languages = language
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (languages.length > 0) params.set("language_codes", JSON.stringify(languages));
  }
  if (config.keyterms.length > 0) params.set("keyterms_prompt", JSON.stringify(config.keyterms));
  return `${config.endpoint}?${params.toString()}`;
};

export type RealtimeStreamEvents = {
  onReady?(info: { id: string; model: string; mode: string }): void;
  onSpeechStarted?(): void;
  onPartial?(text: string): void;
  onFinal?(text: string): void;
  onError?(error: Error): void;
  onClosed?(info: { audioSeconds: number; sessionSeconds: number } | null): void;
};

export type RealtimeStream = {
  /** Queue a PCM frame. Dropped frames are counted, never buffered forever. */
  sendAudio(chunk: Buffer): void;
  /** Ask the server to end the current turn immediately. */
  forceEndpoint(): void;
  /** Send Terminate and resolve once the session is closed. */
  close(): Promise<void>;
  /** Tear the socket down without waiting for a graceful termination. */
  abort(): void;
  readonly droppedChunks: number;
};

/**
 * Open an AssemblyAI v3 streaming session.
 *
 * Auth is the raw API key in the `Authorization` header (no `Bearer`). Node's
 * global WebSocket accepts a `{ headers }` init object even though the DOM
 * type does not declare it, which is why no `ws` dependency is needed.
 * Resolves on the server's `Begin` message, so callers know the session is
 * live before audio starts flowing.
 */
export const openAssemblyAiStream = (
  config: RealtimeConfig,
  events: RealtimeStreamEvents,
  signal?: AbortSignal,
): Promise<RealtimeStream> => {
  if (!config.apiKey) {
    throw new Error(
      "Realtime dictation needs an AssemblyAI API key. Set realtime.apiKeyFile (or apiKeyEnv) in the STT config.",
    );
  }
  if (signal?.aborted) throw new Error("Realtime session was cancelled.");

  const socket = new NodeWebSocket(buildStreamUrl(config), { headers: { Authorization: config.apiKey } });
  let closedByUs = false;
  let droppedChunks = 0;
  let termination: { audioSeconds: number; sessionSeconds: number } | null = null;

  const sendJson = (payload: Record<string, unknown>): void => {
    if (socket.readyState !== 1) return; // WebSocket.OPEN
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      events.onError?.(new Error(`AssemblyAI stream send failed: ${formatError(error)}`));
    }
  };

  const stream: RealtimeStream = {
    get droppedChunks() {
      return droppedChunks;
    },
    sendAudio(chunk) {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        droppedChunks += 1;
        return;
      }
      try {
        socket.send(new Uint8Array(chunk));
      } catch (error) {
        events.onError?.(new Error(`AssemblyAI audio send failed: ${formatError(error)}`));
      }
    },
    forceEndpoint() {
      sendJson({ type: "ForceEndpoint" });
    },
    close() {
      closedByUs = true;
      sendJson({ type: "Terminate" });
      return new Promise<void>((resolve) => {
        if (socket.readyState === 3) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          try {
            socket.close();
          } catch {
            /* already closing */
          }
          resolve();
        }, CLOSE_TIMEOUT_MS);
        socket.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    },
    abort() {
      closedByUs = true;
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
  };

  return new Promise<RealtimeStream>((resolve, reject) => {
    let settled = false;
    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.abort();
      reject(new Error("AssemblyAI stream did not start within 10s."));
    }, CONNECT_TIMEOUT_MS);

    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(error);
        return;
      }
      events.onError?.(error);
    };

    const onAbort = () => {
      stream.abort();
      fail(new Error("Realtime session was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.addEventListener("message", (event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }

      switch (textAt(payload, "type")) {
        case "Begin": {
          const configuration = objectAt(payload, "configuration");
          if (!settled) {
            settled = true;
            clearTimeout(connectTimer);
            signal?.removeEventListener("abort", onAbort);
            events.onReady?.({
              id: textAt(payload, "id"),
              model: textAt(configuration, "model"),
              mode: textAt(configuration, "mode"),
            });
            resolve(stream);
          }
          return;
        }
        case "SpeechStarted":
          events.onSpeechStarted?.();
          return;
        case "Turn": {
          const transcript = textAt(payload, "transcript");
          if (!transcript) return;
          if (payload && typeof payload === "object" && (payload as Record<string, unknown>).end_of_turn === true) {
            events.onFinal?.(transcript);
          } else {
            events.onPartial?.(transcript);
          }
          return;
        }
        case "Termination":
          termination = {
            audioSeconds: numberAt(payload, "audio_duration_seconds"),
            sessionSeconds: numberAt(payload, "session_duration_seconds"),
          };
          return;
        case "Error":
          fail(
            new Error(
              `AssemblyAI stream error: ${textAt(payload, "error") || textAt(payload, "message") || "unknown error"}`,
            ),
          );
          return;
        default:
          return;
      }
    });

    socket.addEventListener("error", () => {
      fail(new Error("AssemblyAI stream connection failed. Check the API key and network."));
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(connectTimer);
      signal?.removeEventListener("abort", onAbort);
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `AssemblyAI stream closed before it was ready (${event.code}${event.reason ? ` ${event.reason}` : ""}).`,
          ),
        );
        return;
      }
      events.onClosed?.(termination);
      if (!closedByUs && event.code !== 1000) {
        events.onError?.(
          new Error(`AssemblyAI stream closed unexpectedly (${event.code}${event.reason ? ` ${event.reason}` : ""}).`),
        );
      }
    });
  });
};
