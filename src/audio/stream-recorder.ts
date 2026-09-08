import { spawn } from "node:child_process";
import type { RealtimeCaptureConfig } from "../config/types";
import { formatError, truncate } from "../utils/text";

const MAX_STDERR_BYTES = 24 * 1024;
const FORCE_KILL_MS = 3000;
const BYTES_PER_SAMPLE = 2; // pcm_s16le

const collectStderr = (stream: NodeJS.ReadableStream): (() => string) => {
  let stderr = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr, "utf8") > MAX_STDERR_BYTES) {
      stderr = stderr.slice(-MAX_STDERR_BYTES);
    }
  });
  return () => stderr;
};

export type AudioStreamHandle = {
  /** Register a handler for fixed-size PCM frames. */
  onChunk(handler: (chunk: Buffer) => void): void;
  /**
   * Called when the capture process exits on its own. `clean` is true for a
   * zero exit (a file source running out), false for a device loss or error.
   */
  onExit(handler: (reason: string, clean: boolean) => void): void;
  /** Stop capture and wait for the process to exit. */
  stop(): Promise<void>;
  /** Stop capture and release resources. Safe to call more than once. */
  dispose(): Promise<void>;
};

export type AudioStreamer = {
  start(): AudioStreamHandle;
};

/**
 * Stream raw PCM from a capture device (or file) instead of writing a wav.
 *
 * ffmpeg writes `pcm_s16le` mono to stdout, which is re-chunked here into
 * exact `chunkMs` frames because the streaming API bills and endpoints on
 * frame boundaries and prefers 50-1000ms frames. Audio is always downmixed to
 * mono: the wire format is mono PCM16 and a stereo stream would be misread as
 * twice the sample rate.
 *
 * `realtimeInput` adds `-re`, which makes ffmpeg read a file input at
 * wall-clock speed. That is what lets the streaming path be tested end to end
 * against a wav file with no microphone attached.
 */
export const createFfmpegStreamer = (config: RealtimeCaptureConfig): AudioStreamer => ({
  start() {
    const bytesPerChunk = Math.max(
      BYTES_PER_SAMPLE,
      Math.round((config.sampleRate * BYTES_PER_SAMPLE * config.chunkMs) / 1000),
    );
    const isDshow = config.inputFormat === "dshow";
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      ...(config.realtimeInput ? ["-re"] : []),
      "-f",
      config.inputFormat,
      ...(isDshow ? ["-audio_buffer_size", "20"] : []),
      "-i",
      config.input,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      String(config.sampleRate),
      "-ac",
      "1",
      "-f",
      "s16le",
      "-",
    ];
    const child = spawn(config.ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    const getStderr = collectStderr(child.stderr);

    const chunkHandlers: Array<(chunk: Buffer) => void> = [];
    const exitHandlers: Array<(reason: string, clean: boolean) => void> = [];
    let pending: Buffer = Buffer.alloc(0);
    let stopped = false;
    let exited = false;

    const emit = (frame: Buffer) => {
      for (const handler of chunkHandlers) {
        try {
          handler(frame);
        } catch (error) {
          console.warn(`Pi Voice STT realtime chunk handler failed: ${formatError(error)}`);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= bytesPerChunk) {
        emit(pending.subarray(0, bytesPerChunk));
        pending = pending.subarray(bytesPerChunk);
      }
    });

    child.stdout.on("end", () => {
      if (pending.length > 0) {
        emit(pending);
        pending = Buffer.alloc(0);
      }
    });

    const waitForExit = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        exited = true;
        const reason = `process error: ${formatError(error)}`;
        for (const handler of exitHandlers) handler(reason, false);
        resolve();
      });
      child.once("close", (code, signal) => {
        exited = true;
        if (!stopped) {
          const clean = code === 0 && !signal;
          const stderrText = truncate(getStderr());
          const reason = signal
            ? `signal ${signal}`
            : `exit ${code ?? "unknown"}${!clean && stderrText ? `: ${stderrText}` : ""}`;
          for (const handler of exitHandlers) handler(reason, clean);
        }
        resolve();
      });
    });

    const terminate = () => {
      if (child.exitCode !== null) return;
      // stdin is "ignore" here, so there is no graceful "q" path: SIGINT makes
      // ffmpeg flush and exit, SIGKILL is the fallback below.
      try {
        child.kill("SIGINT");
      } catch {
        /* already dead */
      }
    };

    const forceKill = () => {
      if (child.exitCode !== null) return;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    };

    const stop = async () => {
      if (!stopped) {
        stopped = true;
        terminate();
      }
      if (exited) return;
      const killTimer = setTimeout(forceKill, FORCE_KILL_MS);
      await waitForExit;
      clearTimeout(killTimer);
    };

    const dispose = async () => {
      await stop().catch((error: unknown) => {
        console.warn(`Pi Voice STT realtime capture cleanup failed: ${formatError(error)}`);
      });
      chunkHandlers.length = 0;
      exitHandlers.length = 0;
      child.stdout.removeAllListeners("data");
      child.stdout.removeAllListeners("end");
    };

    return {
      onChunk(handler) {
        chunkHandlers.push(handler);
      },
      onExit(handler) {
        exitHandlers.push(handler);
      },
      stop,
      dispose,
    } satisfies AudioStreamHandle;
  },
});
