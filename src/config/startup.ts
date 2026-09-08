import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { objectFrom, textFrom } from "../utils/coerce";
import { resolvePath } from "../utils/path";
import { DEFAULT_PROFILE } from "./profiles";

export type StartupOptions = {
  configPath: string;
  keybind: string;
  profileKeybind: string;
  realtimeKeybind: string;
  locale: string;
  mode: string;
  profile: string;
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "stt.json");

const readJsonIfPresent = (path: string): Record<string, unknown> => {
  if (!path || !existsSync(path)) return {};
  return objectFrom(JSON.parse(readFileSync(path, "utf8")));
};

export const resolveStartupOptions = (): StartupOptions => {
  const envConfigPath = textFrom(process.env.PI_STT_CONFIG);
  const configPath = envConfigPath ? resolvePath(envConfigPath) : existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : "";
  const config = readJsonIfPresent(configPath);
  const keybind = textFrom(process.env.PI_STT_KEYBIND, textFrom(config.keybind, "ctrl+r"));
  const locale = textFrom(process.env.PI_STT_LOCALE, textFrom(config.locale, "en"));
  const mode = textFrom(process.env.PI_STT_MODE, textFrom(config.mode, "default"));
  const profileKeybind = textFrom(process.env.PI_STT_PROFILE_KEYBIND, textFrom(config.profileKeybind, "alt+r"));
  const profile = textFrom(process.env.PI_STT_PROFILE, textFrom(config.profile, DEFAULT_PROFILE));
  const realtimeKeybind = textFrom(
    process.env.PI_STT_REALTIME_KEYBIND,
    textFrom(objectFrom(config.realtime).keybind, "ctrl+shift+r"),
  );

  return { configPath, keybind, profileKeybind, realtimeKeybind, locale, mode, profile };
};
