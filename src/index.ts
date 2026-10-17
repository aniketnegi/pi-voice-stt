import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { checkBridgeRecorderHealth } from "./audio/bridge-recorder";
import { createRecorder } from "./audio/factory";
import { loadConfig, readConfigFile } from "./config/load-config";
import { resolveStartupOptions } from "./config/startup";
import {
  DEFAULT_PROFILE,
  isKnownProfile,
  listProfileNames,
  readSpeakersState,
  resolveEffectiveProfile,
  writeProfileState,
  writeSpeakersState,
} from "./config/profiles";
import {
  createDictationController,
  type DictationToast,
} from "./core/dictation-controller";
import { createRealtimeController } from "./core/realtime-controller";
import { createFfmpegStreamer } from "./audio/stream-recorder";
import { openAssemblyAiStream } from "./providers/assemblyai-stream";
import { DEFAULT_MODE, isKnownMode, listModeNames } from "./core/modes";
import { createProvider } from "./providers/factory";
import { createCleanup } from "./cleanup/factory";
import { assertProviderReady } from "./providers/readiness";
import {
  createInputIndicator,
  createVoiceEditorFactory,
} from "./ui/input-indicator";
import { resolveStrings } from "./i18n/strings";
import { formatError } from "./utils/text";
import { textFrom } from "./utils/coerce";
import { kittyCtrlShiftLetterRegex } from "./utils/keybind";
import type { KeyId } from "@earendil-works/pi-tui";

const toastType = (
  variant: DictationToast["variant"],
): "info" | "warning" | "error" => {
  if (variant === "error") return "error";
  if (variant === "warning") return "warning";
  return "info";
};

const notify = (
  ctx: ExtensionContext | undefined,
  toast: DictationToast,
): void => {
  if (!ctx?.hasUI) return;
  const message = toast.title
    ? `${toast.title}: ${toast.message}`
    : toast.message;
  ctx.ui.notify(message, toastType(toast.variant));
};

const reportError = (
  ctx: ExtensionContext | undefined,
  error: unknown,
): void => {
  notify(ctx, {
    title: "Pi Voice STT",
    message: formatError(error),
    variant: "error",
  });
};

export default function piVoiceSttExtension(pi: ExtensionAPI) {
  const startup = resolveStartupOptions();
  const keybind = startup.keybind;
  const profileKeybind = startup.profileKeybind;
  const strings = resolveStrings(startup.locale);
  const inputIndicator = createInputIndicator(keybind, strings);
  let activeMode = startup.mode || DEFAULT_MODE;
  let activeProfile = startup.profile;
  // Runtime `/stt speakers` choice; undefined = use the config's `speakers` key.
  let activeSpeakers: number | undefined;
  void readSpeakersState(startup.configPath)
    .then((value) => {
      if (activeSpeakers === undefined) activeSpeakers = value;
    })
    .catch(() => {});
  const terminalInputCleanup: Array<() => void> = [];

  // Apply the persisted last-selection (sidecar state) once loaded; env and
  // the config `profile` key are already folded into startup.profile.
  void (async () => {
    const fileConfig = await readConfigFile(startup.configPath).catch(
      () => ({}),
    );
    const effective = await resolveEffectiveProfile({
      configPath: startup.configPath,
      envProfile: textFrom(process.env.PI_STT_PROFILE),
      configProfile: startup.profile,
    });
    const safe = isKnownProfile(fileConfig, effective)
      ? effective
      : isKnownProfile(fileConfig, startup.profile)
        ? startup.profile
        : DEFAULT_PROFILE;
    if (safe !== activeProfile) {
      activeProfile = safe;
      inputIndicator.setProfile(activeProfile);
    }
  })().catch(() => {});

  const getConfig = () =>
    loadConfig({
      configPath: startup.configPath,
      mode: activeMode,
      profile: activeProfile,
      speakers: activeSpeakers,
    });

  const speakersLabel = (value: number) => (value > 0 ? `up to ${value}` : "off");

  const setSpeakers = async (ctx: ExtensionContext, value: number) => {
    activeSpeakers = value;
    await writeSpeakersState(startup.configPath, value).catch(() =>
      ctx.ui.notify("Pi Voice STT: could not persist the speakers choice.", "warning"),
    );
    ctx.ui.notify(`Pi Voice STT speakers: ${speakersLabel(value)}.`, "info");
  };

  const controller = createDictationController({
    keybind,
    strings,
    loadConfig: getConfig,
    createRecorder: (config) => createRecorder(config.capture),
    createProvider: (config) => createProvider(config.provider),
    createCleanup: (config) => createCleanup(config.cleanup),
    appendPrompt: async (ctx, text) => {
      const current = ctx.ui.getEditorText();
      ctx.ui.setEditorText(`${current}${text}`);
    },
    submitPrompt: async (ctx) => {
      const prompt = ctx.ui.getEditorText().trimEnd();
      if (!prompt) {
        notify(ctx, {
          title: "Pi Voice STT",
          message: strings.toast.emptyTranscript,
          variant: "warning",
        });
        return;
      }

      ctx.ui.setEditorText("");
      if (ctx.isIdle()) pi.sendUserMessage(prompt);
      else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
    notify,
    onModeChange: (mode) => inputIndicator.setMode(mode),
    onError: reportError,
  });

  const realtime = createRealtimeController({
    strings,
    loadConfig: getConfig,
    createStreamer: (config) => createFfmpegStreamer(config.realtime.capture),
    openStream: (config, events, signal) =>
      openAssemblyAiStream(config.realtime, events, signal),
    getEditorText: (ctx) => ctx.ui.getEditorText(),
    setEditorText: (ctx, text) => ctx.ui.setEditorText(text),
    insertPrompt: (ctx, text, position) => {
      if (position === "end")
        ctx.ui.setEditorText(`${ctx.ui.getEditorText()}${text}`);
      else ctx.ui.pasteToEditor(text);
    },
    notify,
    onModeChange: (mode) => inputIndicator.setMode(mode),
    onLive: (text) => inputIndicator.setLive(text),
    onError: reportError,
  });

  const switchProfile = async (
    ctx: ExtensionContext,
    next: string,
  ): Promise<void> => {
    if (controller.getMode() === "processing") {
      notify(ctx, {
        title: "Pi Voice STT",
        message: strings.profile.busy,
        variant: "warning",
      });
      return;
    }
    activeProfile = next;
    inputIndicator.setProfile(next);
    try {
      await writeProfileState(startup.configPath, next);
    } catch {
      notify(ctx, {
        title: "Pi Voice STT",
        message: strings.profile.persistFailed,
        variant: "warning",
      });
    }
    notify(ctx, {
      title: "Pi Voice STT",
      message: strings.profile.set(next),
      variant: "success",
    });
  };

  const showProfileMenu = async (ctx: ExtensionContext): Promise<void> => {
    const fileConfig = await readConfigFile(startup.configPath).catch(
      () => ({}),
    );
    const names = listProfileNames(fileConfig);
    if (names.length <= 1) {
      notify(ctx, {
        title: "Pi Voice STT",
        message: strings.profile.none,
        variant: "warning",
      });
      return;
    }
    const labels = names.map((name) =>
      name === activeProfile
        ? `${name} (${strings.profile.activeMarker})`
        : name,
    );
    const byLabel = new Map(
      labels.map((label, index) => [label, names[index] ?? ""]),
    );
    const chosen = await ctx.ui.select(strings.profile.menuTitle, labels);
    if (!chosen) return;
    const next = byLabel.get(chosen) ?? "";
    if (!next || next === activeProfile) return;
    if (!isKnownProfile(fileConfig, next)) {
      notify(ctx, {
        title: "Pi Voice STT",
        message: strings.profile.unknown(next),
        variant: "error",
      });
      return;
    }
    await switchProfile(ctx, next);
  };

  pi.registerCommand("stt", {
    description:
      "Voice dictation controls: start, stop, send, cancel, mode, profile, speakers, status, doctor.",
    getArgumentCompletions: (prefix) => {
      const commands = [
        "start",
        "stop",
        "send",
        "cancel",
        "mode",
        "profile",
        "speakers",
        "realtime",
        "status",
        "doctor",
      ];
      return commands
        .filter((command) => command.startsWith(prefix.trim().toLowerCase()))
        .map((command) => ({ value: command, label: command }));
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [first, ...rest] = trimmed.split(/\s+/);
      const action = (first || "status").toLowerCase();
      const param = rest.join(" ").trim();

      if (action === "start") {
        if (realtime.isActive()) {
          ctx.ui.notify(
            "Pi Voice STT realtime session is active; finish or cancel it first.",
            "warning",
          );
          return;
        }
        if (controller.getMode() === "idle")
          await controller
            .toggle(ctx)
            .catch((error: unknown) => reportError(ctx, error));
        else
          ctx.ui.notify(
            `Pi Voice STT is already ${controller.getMode()}.`,
            "warning",
          );
        return;
      }

      if (action === "stop") {
        await controller
          .stop(ctx)
          .catch((error: unknown) => reportError(ctx, error));
        return;
      }

      if (action === "send") {
        await controller
          .stopAndSubmit(ctx)
          .catch((error: unknown) => reportError(ctx, error));
        return;
      }

      if (action === "cancel") {
        await controller
          .cancel(ctx)
          .catch((error: unknown) => reportError(ctx, error));
        return;
      }

      if (action === "realtime") {
        const sub = param.toLowerCase();
        if (!sub || sub === "status") {
          ctx.ui.notify(
            `Pi Voice STT realtime: ${realtime.getMode()} · keybind ${startup.realtimeKeybind}`,
            "info",
          );
          return;
        }
        if (sub === "start") {
          await realtime
            .start(ctx)
            .catch((error: unknown) => reportError(ctx, error));
          return;
        }
        if (sub === "stop" || sub === "send") {
          await realtime
            .stop(ctx)
            .catch((error: unknown) => reportError(ctx, error));
          return;
        }
        if (sub === "cancel") {
          await realtime
            .cancel(ctx)
            .catch((error: unknown) => reportError(ctx, error));
          return;
        }
        ctx.ui.notify(
          "Usage: /stt realtime [start|stop|cancel|status]",
          "error",
        );
        return;
      }

      if (action === "mode") {
        const fileConfig = await readConfigFile(startup.configPath).catch(
          () => ({}),
        );
        const names = listModeNames(fileConfig);
        if (!param) {
          ctx.ui.notify(
            `Pi Voice STT mode: ${activeMode} · available: ${names.join(", ")}`,
            "info",
          );
          return;
        }
        const next = param.toLowerCase();
        if (!isKnownMode(fileConfig, next)) {
          ctx.ui.notify(
            `Unknown mode "${next}". Available: ${names.join(", ")}`,
            "error",
          );
          return;
        }
        activeMode = next;
        ctx.ui.notify(`Pi Voice STT mode set to "${activeMode}".`, "info");
        return;
      }

      if (action === "profile") {
        const fileConfig = await readConfigFile(startup.configPath).catch(
          () => ({}),
        );
        const names = listProfileNames(fileConfig);
        if (!param) {
          ctx.ui.notify(strings.profile.list(activeProfile, names), "info");
          return;
        }
        const next = param.toLowerCase();
        if (!isKnownProfile(fileConfig, next)) {
          ctx.ui.notify(strings.profile.unknown(next), "error");
          return;
        }
        if (next === activeProfile) {
          ctx.ui.notify(
            `Pi Voice STT profile is already "${activeProfile}".`,
            "info",
          );
          return;
        }
        await switchProfile(ctx, next);
        return;
      }

      if (action === "speakers") {
        const current = (await getConfig()).realtime.speakers;
        let choice = param.toLowerCase();
        if (!choice) {
          const options = ["off", "2", "3", "4", "5"].map((value) =>
            value === String(current) || (value === "off" && current === 0)
              ? `${value} (active)`
              : value,
          );
          choice = ((await ctx.ui.select("Speakers in the audio", options)) ?? "").split(" ")[0] ?? "";
          if (!choice) return;
        }
        const value = choice === "off" ? 0 : Number(choice);
        if (!Number.isInteger(value) || value < 0 || value > 10) {
          ctx.ui.notify("Usage: /stt speakers [off|1-10]", "error");
          return;
        }
        await setSpeakers(ctx, value);
        return;
      }

      if (action === "doctor") {
        try {
          const config = await getConfig();
          assertProviderReady(config.provider);
          if (config.capture.type === "bridge") {
            await checkBridgeRecorderHealth(config.capture);
          } else {
            const ffmpeg = await pi.exec(
              config.capture.ffmpegPath,
              ["-version"],
              { timeout: 5000 },
            );
            if (ffmpeg.code !== 0)
              throw new Error(
                `ffmpeg check failed: ${ffmpeg.stderr || ffmpeg.stdout}`,
              );
          }
          if (config.realtime.enabled) {
            if (!config.realtime.apiKey) {
              throw new Error(
                "Realtime dictation is enabled but no AssemblyAI API key resolved (set realtime.apiKeyFile or realtime.apiKeyEnv).",
              );
            }
            const streamFfmpeg = await pi.exec(
              config.realtime.capture.ffmpegPath,
              ["-version"],
              { timeout: 5000 },
            );
            if (streamFfmpeg.code !== 0)
              throw new Error(
                `Realtime ffmpeg check failed: ${streamFfmpeg.stderr || streamFfmpeg.stdout}`,
              );
            ctx.ui.notify(
              `Pi Voice STT realtime ready (${config.realtime.model}/${config.realtime.mode}, ${config.realtime.capture.inputFormat}:${config.realtime.capture.input}).`,
              "info",
            );
          }
          ctx.ui.notify(
            `Pi Voice STT ready (${config.capture.type}, ${config.provider.type}/${config.provider.model}).`,
            "info",
          );
        } catch (error) {
          reportError(ctx, error);
        }
        return;
      }

      if (action !== "status") {
        ctx.ui.notify(
          "Usage: /stt [start|stop|send|cancel|mode <name>|profile <name>|speakers [off|N]|status|doctor]",
          "error",
        );
        return;
      }

      const configPath =
        startup.configPath ||
        "defaults only (set PI_STT_CONFIG or ~/.pi/agent/stt.json)";
      ctx.ui.notify(
        `Pi Voice STT: ${controller.getMode()} · mode ${activeMode} · profile ${activeProfile} · speakers ${speakersLabel((await getConfig().catch(() => undefined))?.realtime.speakers ?? 0)} · keybind ${keybind} · config ${configPath}`,
        "info",
      );
    },
  });

  pi.registerShortcut(startup.profileKeybind as KeyId, {
    description: "Pi Voice STT: switch profile",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await showProfileMenu(ctx).catch((error: unknown) =>
        reportError(ctx, error),
      );
    },
  });

  pi.registerShortcut(startup.realtimeKeybind as KeyId, {
    description: "Pi Voice STT: start or finish realtime streaming dictation",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await realtime
        .toggle(ctx)
        .catch((error: unknown) => reportError(ctx, error));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Raw Kitty CSI-u fallback for ctrl+shift+<letter> keybinds: pi-tui's key
    // parser misreads Kitty modifier 5 (shift+ctrl) as ctrl-only, so match the
    // raw sequence here. Works when the terminal (and tmux, with
    // `set -s extended-keys on`) forwards the Kitty keyboard protocol.
    const kittyRegex = kittyCtrlShiftLetterRegex(profileKeybind);
    const unsubscribeTerminal = kittyRegex
      ? ctx.ui.onTerminalInput((data) => {
          if (kittyRegex.test(data)) {
            void showProfileMenu(ctx).catch((error: unknown) =>
              reportError(ctx, error),
            );
            return { consume: true };
          }
          return undefined;
        })
      : undefined;
    if (unsubscribeTerminal) terminalInputCleanup.push(unsubscribeTerminal);

    const realtimeKittyRegex = kittyCtrlShiftLetterRegex(
      startup.realtimeKeybind,
    );
    const unsubscribeRealtime = realtimeKittyRegex
      ? ctx.ui.onTerminalInput((data) => {
          if (realtimeKittyRegex.test(data)) {
            void realtime
              .toggle(ctx)
              .catch((error: unknown) => reportError(ctx, error));
            return { consume: true };
          }
          return undefined;
        })
      : undefined;
    if (unsubscribeRealtime) terminalInputCleanup.push(unsubscribeRealtime);

    // SAFETY: Optional editor APIs are checked for callable values before use.
    const uiRecord = ctx.ui as unknown as Record<string, unknown> | undefined;
    const getEditorFn =
      typeof uiRecord?.getEditorComponent === "function"
        ? (uiRecord.getEditorComponent as () => unknown)
        : undefined;
    const previousEditor = getEditorFn ? getEditorFn() : undefined;
    const setEditorFn =
      typeof uiRecord?.setEditorComponent === "function"
        ? (uiRecord.setEditorComponent as (factory: unknown) => void)
        : undefined;

    if (setEditorFn) {
      const previousFactory =
        typeof previousEditor === "function"
          ? (previousEditor as Parameters<typeof createVoiceEditorFactory>[0])
          : undefined;
      setEditorFn(
        createVoiceEditorFactory(previousFactory, {
          keybind,
          profileKeybind,
          realtimeKeybind: startup.realtimeKeybind,
          ctx,
          getMode: () =>
            realtime.isActive() ? realtime.getMode() : controller.getMode(),
          renderLabel: (theme) => inputIndicator.renderLabel(theme),
          renderLiveLine: (theme, width) =>
            inputIndicator.renderLiveLine(theme, width),
          attachTui: (tui) => inputIndicator.attach(tui),
          onToggle: (handlerCtx) => {
            void (async () => {
              if (realtime.isActive()) {
                await realtime.stop(handlerCtx);
                return;
              }
              if (controller.getMode() === "idle") {
                await controller.toggle(handlerCtx);
                return;
              }
              const submitOnStop = await getConfig()
                .then((config) => config.output.submitOnStop)
                .catch(() => false);
              if (submitOnStop) await controller.stopAndSubmit(handlerCtx);
              else await controller.toggle(handlerCtx);
            })().catch((error: unknown) => reportError(handlerCtx, error));
          },
          onCancel: (handlerCtx) => {
            void (async () => {
              if (realtime.isActive()) {
                await realtime.cancel(handlerCtx);
                return;
              }
              await controller.cancel(handlerCtx);
            })().catch((error: unknown) => reportError(handlerCtx, error));
          },
          onSend: (handlerCtx) => {
            void controller
              .stopAndSubmit(handlerCtx)
              .catch((error: unknown) => reportError(handlerCtx, error));
          },
          onShowProfileMenu: (handlerCtx) => {
            void showProfileMenu(handlerCtx).catch((error: unknown) =>
              reportError(handlerCtx, error),
            );
          },
          onRealtimeToggle: (handlerCtx) => {
            void realtime
              .toggle(handlerCtx)
              .catch((error: unknown) => reportError(handlerCtx, error));
          },
        }),
      );
    } else {
      console.warn(
        "Pi Voice STT voice editor UI skipped: host ExtensionUI has no setEditorComponent.",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    for (const unsubscribe of terminalInputCleanup) unsubscribe();
    terminalInputCleanup.length = 0;
    await realtime.dispose();
    await controller.dispose();
    inputIndicator.dispose();
  });
}
