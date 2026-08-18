import assert from "node:assert/strict";
import test from "node:test";
import { createFinalCutPreview, generateGcode, getReplayCandidates, md5Text, offsetTrack, parseGcode, sampleTrack } from "./core.mjs";

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
M400 U1
; OBJECT_ID: 7
G1 X0 Y0 F12000
G1 X10 Y0 E1 F800
`;

const insertBeforeThirdLayer = (commands) => fixture.replace("; CHANGE_LAYER\n; Z_HEIGHT: 0.4", `${commands}\n; CHANGE_LAYER\n; Z_HEIGHT: 0.4`);
const square = (min, max, feed = 800) => `G1 X${min} Y${min} F12000
G1 X${max} Y${min} E1 F${feed}
G1 X${max} Y${max} E1
G1 X${min} Y${max} E1
G1 X${min} Y${min} E1
G1 E-1`;
const configFor = (text, { selectedIndices, speedFactors = [], repeats = [], layerNumber = 3 } = {}) => {
  const tracks = getReplayCandidates(parseGcode(text), layerNumber).tracks, indices = selectedIndices ?? tracks.map((_, index) => index);
  return {
    layerNumber,
    pressDepth: .1,
    selectedTrackIds: indices.map((index) => tracks[index].trackId),
    trackSettings: Object.fromEntries(tracks.map((track, index) => [track.trackId, { speedFactor: speedFactors[index] ?? .1, repeats: repeats[index] ?? 1 }]))
  };
};
const heatSealBlock = (text) => text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? "";

test("parses layers and continuous extrusion tracks", () => {
  const parsed = parseGcode(fixture), candidates = getReplayCandidates(parsed, 3);
  assert.equal(parsed.totalLayers, 3);
  assert.equal(candidates.sourceLayer.number, 2);
  assert.equal(candidates.tracks.length, 1);
  assert.equal(candidates.tracks[0].closed, true);
  assert.equal(candidates.tracks[0].originalFeed, 800);
  assert.match(candidates.tracks[0].trackId, /^2:\d+-\d+$/);
});

test("parses modern Bambu layers without layer num markers", () => {
  const modern = fixture
    .replace("; layer num/total_layer_count: 1/3", "M991 S0 P0 ;notify layer change")
    .replace("; layer num/total_layer_count: 2/3", "M991 S0 P1 ;notify layer change")
    .replace("; layer num/total_layer_count: 3/3", "M991 S0 P2 ;notify layer change");
  const parsed = parseGcode(modern), candidates = getReplayCandidates(parsed, 3);
  assert.equal(parsed.totalLayers, 3);
  assert.deepEqual(parsed.layers.map((layer) => ({ number: layer.number, z: layer.z })), [{ number: 1, z: .2 }, { number: 2, z: .3 }, { number: 3, z: .4 }]);
  assert.equal(candidates.tracks.length, 1);
});

test("keeps the rounded outward-offset algorithm available for final cutting and future use", () => {
  const track = getReplayCandidates(parseGcode(fixture), 3).tracks[0], shifted = offsetTrack(track, .1), xs = shifted.points.map((point) => point.x), ys = shifted.points.map((point) => point.y);
  assert.ok(Math.abs(Math.min(...xs) + .1) < .001);
  assert.ok(Math.abs(Math.max(...xs) - 10.1) < .001);
  assert.ok(Math.abs(Math.min(...ys) + .1) < .001);
  assert.ok(Math.abs(Math.max(...ys) - 10.1) < .001);
});

test("uses an existing Bambu pause and inserts no duplicate pause or extrusion", () => {
  const result = generateGcode(fixture, [configFor(fixture)]), block = heatSealBlock(result.text);
  assert.doesNotMatch(block, /M400 U1/);
  assert.equal(result.text.match(/^M400 U1$/gm)?.length, 1);
  assert.ok(result.text.indexOf("M400 U1") < result.text.indexOf("; HEATSEAL_POSTPROCESS_START"));
  assert.match(block, /G1 Z0.2 F1200/);
  assert.match(block, /press depth 0.1mm/);
  assert.match(block, /G1 F80/);
  assert.doesNotMatch(block, /^G[123]\s.*(?:^|\s)E[-+]?\d/im);
});

test("supports per-pause heat-seal pressure depth in 0.01 mm steps", () => {
  const config = configFor(fixture); config.pressDepth = .27;
  const block = heatSealBlock(generateGcode(fixture, [config]).text);
  assert.match(block, /at Z0.03; press depth 0.27mm/);
  const tooSmall = configFor(fixture); tooSmall.pressDepth = .09;
  assert.throws(() => generateGcode(fixture, [tooSmall]), /0.10–0.50 mm/);
  const wrongStep = configFor(fixture); wrongStep.pressDepth = .155;
  assert.throws(() => generateGcode(fixture, [wrongStep]), /0.01 mm/);
});

test("lists every continuous extrusion line in G-code order without region classification", () => {
  const threeLines = insertBeforeThirdLayer(`${square(.2, 9.8)}\n${square(4, 6)}`), tracks = getReplayCandidates(parseGcode(threeLines), 3).tracks;
  assert.equal(tracks.length, 3);
  assert.deepEqual(tracks.map((track) => Number(track.areaScore.toFixed(2))), [100, 92.16, 4]);
  assert.deepEqual(tracks.map((track) => track.lineIndex), [0, 1, 2]);
  assert.ok(tracks.every((track) => !("region" in track)));
});

test("includes open extrusion lines as selectable heat-seal candidates", () => {
  const openLine = `G1 X20 Y20 F12000
G1 X24 Y20 E1 F600
G1 X26 Y22 E1
G1 E-1`;
  const text = insertBeforeThirdLayer(openLine), tracks = getReplayCandidates(parseGcode(text), 3).tracks;
  assert.equal(tracks.length, 2);
  assert.equal(tracks[1].closed, false);
  const block = heatSealBlock(generateGcode(text, [configFor(text, { selectedIndices: [1] })]).text);
  assert.match(block, /Replay line 2\/2/);
  assert.doesNotMatch(block, /^G[123]\s.*(?:^|\s)E[-+]?\d/im);
});

test("uses stable line IDs for manual selection and independent speeds", () => {
  const twoLines = insertBeforeThirdLayer(square(.2, 9.8)), config = configFor(twoLines, { selectedIndices: [0, 1], speedFactors: [.1, .5] }), block = heatSealBlock(generateGcode(twoLines, [config]).text);
  assert.match(block, /Replay line 1\/2;[\s\S]*?factor 0\.1[\s\S]*?G1 F80/);
  assert.match(block, /Replay line 2\/2;[\s\S]*?factor 0\.5[\s\S]*?G1 F400/);
});

test("generates only the lines selected by the user", () => {
  const threeLines = insertBeforeThirdLayer(`${square(.2, 9.8)}\n${square(4, 6)}`), config = configFor(threeLines, { selectedIndices: [1] }), block = heatSealBlock(generateGcode(threeLines, [config]).text);
  assert.equal(block.match(/; Replay line/g)?.length, 1);
  assert.match(block, /Replay line 2\/3/);
  assert.doesNotMatch(block, /Replay line 1\/3|Replay line 3\/3/);
});

test("repeats each selected line independently and has no pause-layer offset or auto-fill output", () => {
  const twoLines = insertBeforeThirdLayer(square(.2, 9.8)), config = configFor(twoLines, { repeats: [3, 2] }), block = heatSealBlock(generateGcode(twoLines, [config]).text);
  assert.equal(block.match(/Replay line 1\/2/g)?.length, 3);
  assert.equal(block.match(/Replay line 2\/2/g)?.length, 2);
  assert.doesNotMatch(block, /outward offset|Auto fill|auto-fill/i);
});

test("samples G2 and G3 arcs into preview points instead of showing only the chord", () => {
  const track = { start: { x: 0, y: 0 }, commands: ["G3 X2 Y0 I1 J0", "G3 X0 Y0 I-1 J0"] }, points = sampleTrack(track, .2);
  assert.ok(points.length > 10);
  assert.ok(points.some((point) => Math.abs(point.y) > .5));
});

test("inserts final film cutting after the last extrusion and before shutdown", () => {
  const printable = insertBeforeThirdLayer(`${square(.2, 9.8)}\n${square(4, 6)}`) + "\nM104 S0\nM84", parsed = parseGcode(printable), preview = createFinalCutPreview(parsed, { offset: 1, drop: .1 });
  assert.equal(preview.modelMaxZ, .3);
  assert.equal(preview.targetZ, .2);
  const output = generateGcode(printable, [], { enabled: true, offset: 1, drop: .1, speedFactor: .2, repeats: 2 }).text, block = output.match(/; HEATSEAL_FINAL_CUT_START[\s\S]*?; HEATSEAL_FINAL_CUT_END/)?.[0] ?? "";
  assert.ok(output.lastIndexOf(" E1") < output.indexOf("; HEATSEAL_FINAL_CUT_START"));
  assert.ok(output.indexOf("; HEATSEAL_FINAL_CUT_END") < output.indexOf("M104 S0"));
  assert.equal(block.match(/; Final film cut pass/g)?.length, 2);
  assert.doesNotMatch(block, /^G[123]\s.*(?:^|\s)E[-+]?\d/im);
});

test("rejects duplicate pause layers", () => {
  const config = configFor(fixture);
  assert.throws(() => generateGcode(fixture, [config, { ...config }]), /重复暂停/);
});

test("rejects heat sealing on a layer without a Bambu pause", () => {
  const config = configFor(fixture, { layerNumber: 2 });
  assert.throws(() => generateGcode(fixture, [config]), /不是 Bambu Studio 已有暂停层/);
});

test("rejects an empty line selection and invalid speed steps", () => {
  assert.throws(() => generateGcode(fixture, [{ ...configFor(fixture), selectedTrackIds: [] }]), /没有选择任何热封线/);
  const zero = configFor(fixture); zero.trackSettings[zero.selectedTrackIds[0]].speedFactor = 0;
  assert.throws(() => generateGcode(fixture, [zero]), /第 1 条线.*0.1–1.0/);
  const nonTenth = configFor(fixture); nonTenth.trackSettings[nonTenth.selectedTrackIds[0]].speedFactor = .15;
  assert.throws(() => generateGcode(fixture, [nonTenth]), /第 1 条线.*0.1–1.0/);
});

test("creates standard UTF-8 MD5 values", () => {
  assert.equal(md5Text("abc"), "900150983CD24FB0D6963F7D28E17F72");
  assert.equal(md5Text("热封"), "CF2C6657C705B0724F9D317E0EBA13FC");
});
