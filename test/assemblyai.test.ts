import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSpeechModels } from "../src/providers/assemblyai";

test("buildSpeechModels maps the legacy universal alias to universal-2", () => {
  assert.deepEqual(buildSpeechModels("universal"), ["universal-2"]);
});

test("buildSpeechModels appends universal-2 as the fallback tier", () => {
  assert.deepEqual(buildSpeechModels("universal-3-5-pro"), ["universal-3-5-pro", "universal-2"]);
});

test("buildSpeechModels passes a comma-separated preference list through", () => {
  assert.deepEqual(buildSpeechModels("universal-3-5-pro, universal-2"), ["universal-3-5-pro", "universal-2"]);
});

test("buildSpeechModels trims entries and drops empties", () => {
  assert.deepEqual(buildSpeechModels("  universal-3-5-pro ,, "), ["universal-3-5-pro", "universal-2"]);
});

test("buildSpeechModels does not duplicate universal-2", () => {
  assert.deepEqual(buildSpeechModels("universal-2"), ["universal-2"]);
  assert.deepEqual(buildSpeechModels("universal-2, universal"), ["universal-2"]);
});

test("buildSpeechModels falls back to universal-2 for an empty model", () => {
  assert.deepEqual(buildSpeechModels(""), ["universal-2"]);
});
