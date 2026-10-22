import { textFrom } from "../utils/coerce";

export const isLoopbackHostname = (hostname: string): boolean => {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
};

export const secureEndpointFrom = (value: unknown, fallback: string): string => {
  const endpoint = textFrom(value, fallback);

  try {
    const url = new URL(endpoint);
    if (url.username || url.password) throw new Error("credentials");
    if (url.protocol === "https:") return endpoint;
    if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return endpoint;
  } catch (error) {
    if (error instanceof Error && error.message === "credentials") {
      throw new Error("STT endpoint must not include credentials. Use apiKeyEnv or Keychain instead.");
    }
    throw new Error(`Invalid STT endpoint: ${endpoint}`);
  }

  throw new Error("STT endpoint must use HTTPS unless it points to localhost.");
};

/**
 * WebSocket counterpart of secureEndpointFrom. Streaming endpoints use the
 * ws/wss schemes, which secureEndpointFrom rejects, so they need their own
 * validation with the same policy: encrypted by default, plain ws only for
 * loopback, and never inline credentials.
 */
export const secureWebSocketEndpointFrom = (value: unknown, fallback: string): string => {
  const endpoint = textFrom(value, fallback);

  try {
    const url = new URL(endpoint);
    if (url.username || url.password) throw new Error("credentials");
    if (url.protocol === "wss:") return endpoint;
    if (url.protocol === "ws:" && isLoopbackHostname(url.hostname)) return endpoint;
  } catch (error) {
    if (error instanceof Error && error.message === "credentials") {
      throw new Error("STT endpoint must not include credentials. Use apiKeyEnv or Keychain instead.");
    }
    throw new Error(`Invalid STT websocket endpoint: ${endpoint}`);
  }

  throw new Error("STT websocket endpoint must use WSS unless it points to localhost.");
};

export const endpointRequiresAuth = (endpoint: string): boolean => {
  const url = new URL(endpoint);
  return !(url.protocol === "http:" && isLoopbackHostname(url.hostname));
};
