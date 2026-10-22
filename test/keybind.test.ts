import test from "node:test";
import assert from "node:assert/strict";
import { kittyCtrlShiftLetterRegex } from "../src/utils/keybind";

test("kittyCtrlShiftLetterRegex matches the raw kitty encoding of ctrl+shift+r", () => {
  const re = kittyCtrlShiftLetterRegex("ctrl+shift+r");
  assert.ok(re);
  assert.equal(re.test("\u001b[114;6u"), true); // lowercase r, modifier 6 (shift+ctrl)
  assert.equal(re.test("\u001b[82;6u"), true); // uppercase R
  assert.equal(re.test("\u001b[114;5u"), false); // ctrl only, must not match
  assert.equal(re.test("\u001b[114;4u"), false); // shift only
  assert.equal(re.test("\u001b[114;7u"), false); // ctrl+alt
  assert.equal(re.test("\u001b[112;6u"), false); // ctrl+shift+p (different key)
  assert.equal(re.test("\u0012"), false); // legacy ctrl+r
  assert.equal(re.test("r"), false);
});

test("kittyCtrlShiftLetterRegex accepts alternate-key and event-type fields", () => {
  const re = kittyCtrlShiftLetterRegex("ctrl+shift+r");
  assert.ok(re);
  assert.equal(re.test("\u001b[114:82;6u"), true); // alternate keys (kitty flag 4)
  assert.equal(re.test("\u001b[114;6:1u"), true); // press event type
  assert.equal(re.test("\u001b[114:82;6:1u"), true); // both
  assert.equal(re.test("\u001b[114:82;5u"), false); // still ctrl-only
});

test("kittyCtrlShiftLetterRegex accepts the shift+ctrl modifier order", () => {
  const re = kittyCtrlShiftLetterRegex("shift+ctrl+p");
  assert.ok(re);
  assert.equal(re.test("\u001b[112;6u"), true);
  assert.equal(re.test("\u001b[114;6u"), false);
});

test("kittyCtrlShiftLetterRegex returns undefined for non ctrl+shift letter binds", () => {
  assert.equal(kittyCtrlShiftLetterRegex("alt+r"), undefined);
  assert.equal(kittyCtrlShiftLetterRegex("ctrl+r"), undefined);
  assert.equal(kittyCtrlShiftLetterRegex("ctrl+shift+enter"), undefined);
  assert.equal(kittyCtrlShiftLetterRegex(""), undefined);
});
