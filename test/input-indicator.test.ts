import test from "node:test";
import assert from "node:assert/strict";
import { createInputIndicator, createVoiceEditorFactory } from "../src/ui/input-indicator";
import { resolveStrings } from "../src/i18n/strings";

test("voice editor wrapper proxies pi app-level handlers to the base editor", () => {
  const actionHandlers = new Map<string, () => void>();
  const base = {
    actionHandlers,
    render: () => [""],
    handleInput: () => {},
    invalidate: () => {},
    getText: () => "",
    setText: () => {},
  } as any;

  const factory = createVoiceEditorFactory(() => base, {
    keybind: "ctrl+r",
    profileKeybind: "alt+r",
    realtimeKeybind: "ctrl+shift+r",
    ctx: { ui: { theme: {} } } as any,
    getMode: () => "idle",
    renderLabel: () => "voice ctrl+r",
    renderLiveLine: () => undefined,
    onToggle: () => {},
    onCancel: () => {},
    onSend: () => {},
    onShowProfileMenu: () => {},
    onRealtimeToggle: () => {},
    attachTui: () => {},
  });

  const editor = factory({} as any, {} as any, {} as any) as any;
  const onEscape = () => {};
  const onCtrlD = () => {};
  const onPasteImage = () => {};
  const onExtensionShortcut = () => true;
  const clear = () => {};

  assert.equal(editor.actionHandlers, actionHandlers);
  editor.actionHandlers.set("app.clear", clear);
  assert.equal(base.actionHandlers.get("app.clear"), clear);

  editor.onEscape = onEscape;
  editor.onCtrlD = onCtrlD;
  editor.onPasteImage = onPasteImage;
  editor.onExtensionShortcut = onExtensionShortcut;

  assert.equal(base.onEscape, onEscape);
  assert.equal(base.onCtrlD, onCtrlD);
  assert.equal(base.onPasteImage, onPasteImage);
  assert.equal(base.onExtensionShortcut, onExtensionShortcut);
  assert.equal(editor.onExtensionShortcut("ctrl+x"), true);
});

const flatTheme = { fg: (_color: string, text: string) => text } as any;

test("input indicator idle label shows the active profile", () => {
  const indicator = createInputIndicator("ctrl+r", resolveStrings("en"));
  assert.equal(indicator.renderLabel(flatTheme), "voice ctrl+r");
  indicator.setProfile("local");
  assert.equal(indicator.renderLabel(flatTheme), "voice · local ctrl+r");
  indicator.setProfile("default");
  assert.equal(indicator.renderLabel(flatTheme), "voice ctrl+r");
});

test("voice editor wrapper opens the profile menu on the profile keybind", () => {
  let toggled = false;
  let menuOpened = false;
  const base = {
    actionHandlers: new Map<string, () => void>(),
    render: () => [""],
    handleInput: () => {},
    invalidate: () => {},
    getText: () => "",
    setText: () => {},
  } as any;

  const factory = createVoiceEditorFactory(() => base, {
    keybind: "ctrl+r",
    profileKeybind: "alt+r",
    realtimeKeybind: "ctrl+shift+r",
    ctx: { ui: { theme: {} } } as any,
    getMode: () => "idle",
    renderLabel: () => "voice ctrl+r",
    renderLiveLine: () => undefined,
    onToggle: () => { toggled = true; },
    onCancel: () => {},
    onSend: () => {},
    onShowProfileMenu: () => { menuOpened = true; },
    onRealtimeToggle: () => {},
    attachTui: () => {},
  });

  const editor = factory({} as any, {} as any, {} as any) as any;
  editor.handleInput("\u001br"); // legacy alt+r
  assert.equal(menuOpened, true);
  assert.equal(toggled, false);

  // ctrl+r keeps its recording toggle priority
  menuOpened = false;
  toggled = false;
  editor.handleInput("\u0012"); // legacy ctrl+r
  assert.equal(toggled, true);
  assert.equal(menuOpened, false);
});

const makeBorderBase = () => ({
  actionHandlers: new Map<string, () => void>(),
  render: () => [""],
  handleInput: () => {},
  invalidate: () => {},
  getText: () => "",
  setText: () => {},
} as any);

test("voice editor wrapper restores the default border color on idle instead of clearing it", () => {
  const defaultBorder = (str: string) => `[${str}]`;
  const base = makeBorderBase();
  const factory = createVoiceEditorFactory(() => base, {
    keybind: "ctrl+r",
    profileKeybind: "alt+r",
    realtimeKeybind: "ctrl+shift+r",
    ctx: { ui: { theme: {} } } as any,
    getMode: () => "idle",
    renderLabel: () => "voice ctrl+r",
    renderLiveLine: () => undefined,
    onToggle: () => {},
    onCancel: () => {},
    onSend: () => {},
    onShowProfileMenu: () => {},
    onRealtimeToggle: () => {},
    attachTui: () => {},
  });

  const editor = factory({} as any, { borderColor: defaultBorder } as any, {} as any) as any;
  editor.render(80);
  // Idle must never leave borderColor undefined: pi-tui calls it as a function
  // during render (issue #15).
  assert.equal(base.borderColor, defaultBorder);
});

test("voice editor wrapper tints the border while recording and restores the default on idle", () => {
  const defaultBorder = (str: string) => `[${str}]`;
  let mode = "idle";
  const base = makeBorderBase();
  const factory = createVoiceEditorFactory(() => base, {
    keybind: "ctrl+r",
    profileKeybind: "alt+r",
    realtimeKeybind: "ctrl+shift+r",
    ctx: { ui: { theme: {} } } as any,
    getMode: () => mode as any,
    renderLabel: () => "voice ctrl+r",
    renderLiveLine: () => undefined,
    onToggle: () => {},
    onCancel: () => {},
    onSend: () => {},
    onShowProfileMenu: () => {},
    onRealtimeToggle: () => {},
    attachTui: () => {},
  });

  const editor = factory({} as any, { borderColor: defaultBorder } as any, {} as any) as any;

  mode = "recording";
  editor.render(80);
  assert.equal(typeof base.borderColor, "function");
  assert.notEqual(base.borderColor, defaultBorder);

  mode = "idle";
  editor.render(80);
  assert.equal(base.borderColor, defaultBorder);
});

test("voice editor wrapper prefers the wrapper borderColor over the default on idle", () => {
  const defaultBorder = (str: string) => `[${str}]`;
  const wrapperBorder = (str: string) => `{${str}}`;
  const base = makeBorderBase();
  const factory = createVoiceEditorFactory(() => base, {
    keybind: "ctrl+r",
    profileKeybind: "alt+r",
    realtimeKeybind: "ctrl+shift+r",
    ctx: { ui: { theme: {} } } as any,
    getMode: () => "idle",
    renderLabel: () => "voice ctrl+r",
    renderLiveLine: () => undefined,
    onToggle: () => {},
    onCancel: () => {},
    onSend: () => {},
    onShowProfileMenu: () => {},
    onRealtimeToggle: () => {},
    attachTui: () => {},
  });

  const editor = factory({} as any, { borderColor: defaultBorder } as any, {} as any) as any;
  editor.borderColor = wrapperBorder;
  editor.render(80);
  assert.equal(base.borderColor, wrapperBorder);
});
