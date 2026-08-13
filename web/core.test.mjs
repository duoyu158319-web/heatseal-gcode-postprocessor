import assert from "node:assert/strict";
import test from "node:test";
import { generateGcode, getReplayCandidates, md5Text, offsetTrack, parseGcode } from "./core.mjs";
const fixture = `; total layer number: 3
; printable_height = 256
M83
G90
; CHANGE_LAYER
; Z_HEIGHT: 0.2
; layer num/total_layer_count: 1/3
; OBJECT_ID: 7
; FEATURE: Outer wall
G1 X0 Y0 F12000
G1 X10 Y0 E1 F800
G1 X10 Y10 E1
G1 X0 Y10 E1
G1 X0 Y0 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.3
; layer num/total_layer_count: 2/3
; OBJECT_ID: 7
G1 X0 Y0 F12000
G1 X10 Y0 E1 F800
G1 X10 Y10 E1
G1 X0 Y10 E1
G1 X0 Y0 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.4
; layer num/total_layer_count: 3/3
; OBJECT_ID: 7
G1 X0 Y0 F12000
G1 X10 Y0 E1 F800
`;
test("parses layers, objects and closed wall tracks", () => { const p = parseGcode(fixture), c = getReplayCandidates(p, 3); assert.equal(p.totalLayers, 3); assert.deepEqual(p.objectIds, ["7"]); assert.equal(c.sourceLayer.number, 2); assert.equal(c.tracks.length, 1); assert.equal(c.tracks[0].closed, true); assert.equal(c.tracks[0].originalFeed, 800); });
test("supports an exact 0.1 mm rounded outward offset", () => { const track = getReplayCandidates(parseGcode(fixture), 3).tracks[0], shifted = offsetTrack(track, .1), xs = shifted.points.map((p) => p.x), ys = shifted.points.map((p) => p.y); assert.ok(Math.abs(Math.min(...xs) + .1) < .001); assert.ok(Math.abs(Math.max(...xs) - 10.1) < .001); assert.ok(Math.abs(Math.min(...ys) + .1) < .001); assert.ok(Math.abs(Math.max(...ys) - 10.1) < .001); });
test("supports zero offset without changing the source path", () => { const track = getReplayCandidates(parseGcode(fixture), 3).tracks[0], shifted = offsetTrack(track, 0); assert.deepEqual(shifted.start, track.start); assert.deepEqual(shifted.commands, track.commands); const block = generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactors: [.1], offsetDistances: [0] }]).text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? ""; assert.match(block, /outward offset 0mm/); });
test("inserts pause and no-extrusion replay", () => { const r = generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactor: .1 }]), b = r.text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? ""; assert.match(b, /M400 U1/); assert.match(b, /G1 Z0.31 F1200/); assert.match(b, /G1 F80/); assert.doesNotMatch(b, /^G[123]\s.*(?:^|\s)E[-+]?\d/im); });
test("applies independent speeds to the first and second loops", () => {
  const twoLoops = fixture.replace("; CHANGE_LAYER\n; Z_HEIGHT: 0.4", `G1 X2 Y2 F12000
G1 X8 Y2 E1 F800
G1 X8 Y8 E1
G1 X2 Y8 E1
G1 X2 Y2 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.4`);
  const candidates = getReplayCandidates(parseGcode(twoLoops), 3);
  assert.equal(candidates.tracks.length, 2);
  const block = generateGcode(twoLoops, [{ layerNumber: 3, replay: true, circles: 2, speedFactors: [.1, .5] }]).text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? "";
  assert.match(block, /Replay loop 1\/2; factor 0\.1[\s\S]*?G1 F80/);
  assert.match(block, /Replay loop 2\/2; factor 0\.5[\s\S]*?G1 F400/);
});
test("rejects duplicate layers", () => assert.throws(() => generateGcode(fixture, [{ layerNumber: 3, replay: false, circles: 1, speedFactor: .1 }, { layerNumber: 3, replay: false, circles: 1, speedFactor: .1 }]), /重复暂停/));
test("rejects zero and non-tenth replay speeds", () => { assert.throws(() => generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactors: [0] }]), /第 1 圈.*0.1–1.0/); assert.throws(() => generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactors: [.15] }]), /第 1 圈.*0.1–1.0/); });
test("creates standard UTF-8 MD5 values", () => { assert.equal(md5Text("abc"), "900150983CD24FB0D6963F7D28E17F72"); assert.equal(md5Text("热封"), "CF2C6657C705B0724F9D317E0EBA13FC"); });
