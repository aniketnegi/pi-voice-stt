import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AudioStreamHandle, AudioStreamer } from "../audio/stream-recorder";
import type { OutputConfig, PluginConfig } from "../config/types";
import type { RealtimeStream, RealtimeStreamEvents } from "../providers/assemblyai-stream";
import type { Strings } from "../i18n/strings";
import type { DictationMode, DictationToast } from "./dictation-controller";
import { formatTranscriptForPrompt } from "./output";
import { applyReplacements } from "./replacements";

/** How long to wait for the server to finalize the in-flight turn on stop. */
const FINAL_TURN_GRACE_MS = 1500;

const FALLBACK_OUTPUT: OutputConfig = { appendTrailingSpace: true, submitOnStop: false, replacements: {} };

export type RealtimeControllerOptions = {
  strings: Strings;
  loadConfig(): Promise<PluginConfig>;
  createStreamer(config: PluginConfig): AudioStreamer;
  openStream(config: PluginConfig, events: RealtimeStreamEvents): Promise<RealtimeStream>;
  getEditorText(ctx: ExtensionContext): string;
  setEditorText(ctx: ExtensionContext, text: string): void;
  appendPrompt(ctx: ExtensionContext, text: string): Promise<unknown>;
  notify(ctx: ExtensionContext | undefined, toast: DictationToast): void;
  onModeChange?(mode: DictationMode, ctx?: ExtensionContext): void;
  onLive?(text: string | undefined): void;
  onError?(ctx: ExtensionContext | undefined, error: unknown): void;
};

/**
 * Streaming dictation controller.
 *
 * Lifecycle: idle -> connecting -> streaming -> stopping -> idle. Audio frames
 * flow from the capture process straight into the websocket; finalized turns
 * are appended to a committed buffer and the editor is rewritten as
 * `base + committed + live`, so words land as they are spoken and firm up when
 * the server punctuates a turn.
 *
 * The editor is only rewritten while it still holds what this controller last
 * wrote. The moment the user types (or pastes) during a session, the controller
 * detaches and stops touching the editor, keeping the transcript in the
 * committed buffer to append once the session stops. That way live partials
 * never eat keystrokes.
 */
export const createRealtimeController = (options: RealtimeControllerOptions) => {
  let mode: DictationMode = "idle";
  let session: RealtimeStream | undefined;
  let audio: AudioStreamHandle | undefined;
  let config: PluginConfig | undefined;
  let lastContext: ExtensionContext | undefined;
  let baseText = "";
  let committed = "";
  let lastWritten: string | undefined;
  let detached = false;
  let cancelled = false;
  let disposed = false;
  let operation: Promise<void> | undefined;
  const finalTurnWaiters = new Set<() => void>();

  const outputConfig = (): OutputConfig => config?.output ?? FALLBACK_OUTPUT;

  const remember = (ctx: ExtensionContext | undefined) => {
    if (ctx) lastContext = ctx;
  };

  const setMode = (next: DictationMode, ctx?: ExtensionContext) => {
    if (disposed && next !== "idle") return;
    remember(ctx);
    mode = next;
    options.onModeChange?.(next, ctx ?? lastContext);
  };

  const notify = (ctx: ExtensionContext | undefined, toast: DictationToast) => {
    if (!disposed) options.notify(ctx ?? lastContext, toast);
  };

  const releaseFinalTurnWaiters = () => {
    for (const resolve of [...finalTurnWaiters]) resolve();
  };

  const waitForFinalTurn = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        finalTurnWaiters.delete(finish);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      finalTurnWaiters.add(finish);
    });

  const writeEditor = (ctx: ExtensionContext, liveText: string, forceCommit: boolean) => {
    if (detached) return;
    const includeCommitted = forceCommit || config?.realtime.commitOnTurnEnd !== false;
    const desired = `${baseText}${includeCommitted ? committed : ""}${liveText}`;
    const current = options.getEditorText(ctx);
    if (lastWritten !== undefined && current !== lastWritten) {
      // The user edited the prompt mid-session: hand the editor back to them.
      detached = true;
      return;
    }
    options.setEditorText(ctx, desired);
    lastWritten = desired;
  };

  const commitTurn = (ctx: ExtensionContext, raw: string) => {
    const text = applyReplacements(raw, outputConfig().replacements);
    if (text.trim()) {
      committed += formatTranscriptForPrompt(text, outputConfig());
      options.onLive?.(undefined);
      writeEditor(ctx, "", false);
    }
    releaseFinalTurnWaiters();
  };

  const teardown = async () => {
    const handle = audio;
    const active = session;
    audio = undefined;
    session = undefined;
    await handle?.dispose().catch(() => {});
    active?.abort();
    releaseFinalTurnWaiters();
    options.onLive?.(undefined);
  };

  const start = async (ctx: ExtensionContext) => {
    if (disposed || mode !== "idle") return;
    if (!ctx.hasUI) {
      notify(ctx, { title: "Pi Voice STT", message: options.strings.toast.realtimeNeedsUi, variant: "warning" });
      return;
    }

    setMode("connecting", ctx);
    try {
      const loaded = await options.loadConfig();
      const realtime = loaded.realtime;
      if (!realtime.enabled) throw new Error(options.strings.toast.realtimeDisabled);

      config = loaded;
      committed = "";
      detached = false;
      lastWritten = undefined;
      cancelled = false;
      baseText = options.getEditorText(ctx);

      const opened = await options.openStream(loaded, {
        onPartial: (text) => {
          options.onLive?.(text);
          writeEditor(ctx, text, false);
        },
        onFinal: (text) => commitTurn(ctx, text),
        onError: (error) => options.onError?.(ctx, error),
      });
      session = opened;

      const handle = options.createStreamer(loaded).start();
      audio = handle;
      handle.onChunk((chunk) => session?.sendAudio(chunk));
      handle.onExit((reason, clean) => {
        if (mode !== "streaming" && mode !== "connecting") return;
        // A zero exit means the source ended on its own (a file input running
        // out); anything else is a real capture failure worth surfacing.
        if (!clean) options.onError?.(ctx, new Error(`Realtime capture stopped: ${reason}`));
        void stop(ctx);
      });

      setMode("streaming", ctx);
      notify(ctx, {
        title: "Pi Voice STT",
        message: options.strings.toast.realtimeStarted(realtime.keybind),
        variant: "info",
        duration: 5000,
      });
    } catch (error) {
      await teardown();
      setMode("idle", ctx);
      options.onError?.(ctx, error);
    }
  };

  const stop = async (ctx: ExtensionContext): Promise<void> => {
    remember(ctx);
    if (disposed || mode === "idle") return;
    if (operation) return operation;

    operation = (async () => {
      try {
        setMode("stopping", ctx);
        const handle = audio;
        audio = undefined;
        await handle?.stop().catch(() => {});

        const active = session;
        session = undefined;
        if (active) {
          active.forceEndpoint();
          await waitForFinalTurn(FINAL_TURN_GRACE_MS);
          await active.close().catch(() => {});
        }

        if (cancelled) return;
        options.onLive?.(undefined);

        const hasText = committed.trim().length > 0;
        if (detached) {
          // We stopped writing to the editor, so hand the transcript over
          // instead of overwriting whatever the user typed.
          if (hasText) await options.appendPrompt(ctx, formatTranscriptForPrompt(committed, outputConfig()));
        } else {
          writeEditor(ctx, "", true);
        }

        notify(ctx, {
          title: "Pi Voice STT",
          message: hasText ? options.strings.toast.realtimeStopped : options.strings.toast.realtimeEmpty,
          variant: hasText ? "success" : "warning",
        });
      } finally {
        await teardown();
        setMode("idle", ctx);
        operation = undefined;
      }
    })();

    return operation;
  };

  const cancel = async (ctx?: ExtensionContext): Promise<void> => {
    remember(ctx);
    if (disposed || mode === "idle") return;
    cancelled = true;
    const target = ctx ?? lastContext;
    if (target && !detached) options.setEditorText(target, baseText);
    await teardown();
    setMode("idle", target);
    notify(target, { title: "Pi Voice STT", message: options.strings.toast.realtimeCancelled, variant: "info" });
    cancelled = false;
  };

  const toggle = async (ctx: ExtensionContext): Promise<void> => {
    if (mode === "idle") {
      await start(ctx);
      return;
    }
    await stop(ctx);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    cancelled = true;
    await teardown();
    await operation?.catch(() => {});
    mode = "idle";
    options.onLive?.(undefined);
  };

  return {
    toggle,
    start,
    stop,
    cancel,
    dispose,
    getMode: () => mode,
    isActive: () => mode !== "idle",
  };
};
