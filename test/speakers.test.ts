import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load-config";
import { readSpeakersState, writeProfileState, writeSpeakersState } from "../src/config/profiles";
import { formatUtterances } from "../src/providers/assemblyai";
import { buildStreamUrl } from "../src/providers/assemblyai-stream";

test("formatUtterances labels multi-speaker transcripts", () => {
  const payload = { utterances: [{ speaker: "A", text: "refactor auth" }, { speaker: "B", text: "tests first" }] };
  assert.equal(formatUtterances(payload), "Speaker A: refactor auth\nSpeaker B: tests first");
});

test("formatUtterances returns empty for a single speaker or no utterances", () => {
  assert.equal(formatUtterances({ utterances: [{ speaker: "A", text: "hi" }, { speaker: "A", text: "again" }] }), "");
  assert.equal(formatUtterances({ text: "hi" }), "");
});

test("speakers config: file key, profile override, runtime override, clamping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-voice-stt-speakers-"));
  const configPath = join(dir, "stt.json");
  await writeFile(configPath, JSON.stringify({
    speakers: 2,
    provider: { type: "assemblyai", apiKey: "k" },
    profiles: { call: { speakers: 3 } },
  }));
  try {
    const base = await loadConfig({ configPath });
    assert.equal(base.realtime.speakers, 2);
    assert.equal(base.provider.type === "assemblyai" && base.provider.speakers, 2);
    assert.equal((await loadConfig({ configPath, profile: "call" })).realtime.speakers, 3);
    assert.equal((await loadConfig({ configPath, speakers: 0 })).realtime.speakers, 0);
    assert.equal((await loadConfig({ configPath, speakers: 99 })).realtime.speakers, 10);

    const url = new URL(buildStreamUrl(base.realtime));
    assert.equal(url.searchParams.get("speaker_labels"), "true");
    assert.equal(url.searchParams.get("max_speakers"), "2");
    const off = new URL(buildStreamUrl((await loadConfig({ configPath, speakers: 0 })).realtime));
    assert.equal(off.searchParams.has("speaker_labels"), false);

    // speakers and profile share the sidecar state file without clobbering each other
    await writeSpeakersState(configPath, 3);
    await writeProfileState(configPath, "call");
    assert.equal(await readSpeakersState(configPath), 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
