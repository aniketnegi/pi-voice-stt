/**
 * Raw-key helper for ctrl+shift+<letter> shortcuts.
 *
 * Kitty encodes a key as CSI `codepoint:shifted-codepoint; modifiers:event-type u`,
 * where modifiers is `1 + bitmask(shift=1, alt=2, ctrl=4, super=8)`. ctrl+shift
 * is therefore modifier 6 (`1 + 1 + 4`), and the plain semicolon form is
 * `\x1b[114;6u`. pi-tui's parser handles that correctly, so this raw matcher is
 * a fallback for terminals that forward the protocol but still need the keybind
 * matched from the raw terminal stream (inside tmux this needs
 * `set -s extended-keys on`).
 */

/**
 * Build a regex matching the raw Kitty CSI-u encoding of
 * `ctrl+shift+<letter>`. Accepts the alternate-key group
 * (`\x1b[114:82;6u`, sent when the terminal reports shifted key variants) and
 * the event-type suffix (`\x1b[114;6:1u`). Returns undefined when the keybind
 * is not a ctrl+shift+letter combo.
 */
export const kittyCtrlShiftLetterRegex = (keybind: string): RegExp | undefined => {
  const parts = keybind.toLowerCase().split("+");
  if (parts.length !== 3 || !parts.includes("ctrl") || !parts.includes("shift")) return undefined;
  const letter = parts.find((part) => /^[a-z]$/.test(part));
  if (!letter) return undefined;
  const lower = letter.charCodeAt(0);
  const upper = lower - 32;
  return new RegExp(`^\\x1b\\[(?:${lower}|${upper})(?::\\d+)?;6(?::\\d+)?u$`);
};
