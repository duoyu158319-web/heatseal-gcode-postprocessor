import assert from "node:assert/strict";
import test from "node:test";
import { analyzeLayerGeometry, classifyLayerRegions, createAutoFillTrack, createFinalCutPreview, generateGcode, getReplayCandidates, md5Text, offsetTrack, parseGcode } from "./core.mjs";
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
test("parses layers, objects and closed wall tracks", () => { const p = parseGcode(fixture), c = getReplayCandidates(p, 3); assert.equal(p.totalLayers, 3); assert.deepEqual(p.objectIds, ["7"]); assert.equal(c.sourceLayer.number, 2); assert.equal(c.tracks.length, 1); assert.equal(c.tracks[0].closed, true); assert.equal(c.tracks[0].originalFeed, 800); });
test("parses modern Bambu layers without layer num markers", () => {
  const modern = fixture
    .replace("; layer num/total_layer_count: 1/3", "M991 S0 P0 ;notify layer change")
    .replace("; layer num/total_layer_count: 2/3", "M991 S0 P1 ;notify layer change")
    .replace("; layer num/total_layer_count: 3/3", "M991 S0 P2 ;notify layer change");
  const parsed = parseGcode(modern), candidates = getReplayCandidates(parsed, 3);
  assert.equal(parsed.totalLayers, 3);
  assert.deepEqual(parsed.layers.map((layer) => ({ number: layer.number, z: layer.z })), [
    { number: 1, z: .2 },
    { number: 2, z: .3 },
    { number: 3, z: .4 }
  ]);
  assert.deepEqual(parsed.objectIds, ["7"]);
  assert.equal(candidates.sourceLayer.number, 2);
  assert.equal(candidates.tracks.length, 1);
});
test("supports an exact 0.1 mm rounded outward offset", () => { const track = getReplayCandidates(parseGcode(fixture), 3).tracks[0], shifted = offsetTrack(track, .1), xs = shifted.points.map((p) => p.x), ys = shifted.points.map((p) => p.y); assert.ok(Math.abs(Math.min(...xs) + .1) < .001); assert.ok(Math.abs(Math.max(...xs) - 10.1) < .001); assert.ok(Math.abs(Math.min(...ys) + .1) < .001); assert.ok(Math.abs(Math.max(...ys) - 10.1) < .001); });
test("supports zero offset without changing the source path", () => { const track = getReplayCandidates(parseGcode(fixture), 3).tracks[0], shifted = offsetTrack(track, 0); assert.deepEqual(shifted.start, track.start); assert.deepEqual(shifted.commands, track.commands); const block = generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactors: [.1], offsetDistances: [0] }]).text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? ""; assert.match(block, /outward offset 0mm/); });
test("uses an existing Bambu pause and inserts no duplicate pause", () => { const r = generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactor: .1 }]), b = r.text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? ""; assert.doesNotMatch(b, /M400 U1/); assert.equal(r.text.match(/^M400 U1$/gm)?.length, 1); assert.ok(r.text.indexOf("M400 U1") < r.text.indexOf("; HEATSEAL_POSTPROCESS_START")); assert.match(b, /G1 Z0.31 F1200/); assert.match(b, /G1 F80/); assert.doesNotMatch(b, /^G[123]\s.*(?:^|\s)E[-+]?\d/im); });
test("applies independent speeds to peripheral wall loops from inside to outside", () => {
  const twoLoops = fixture.replace("; CHANGE_LAYER\n; Z_HEIGHT: 0.4", `G1 X0.2 Y0.2 F12000
G1 X9.8 Y0.2 E1 F800
G1 X9.8 Y9.8 E1
G1 X0.2 Y9.8 E1
G1 X0.2 Y0.2 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.4`);
  const candidates = getReplayCandidates(parseGcode(twoLoops), 3);
  assert.equal(candidates.tracks.length, 2);
  assert.deepEqual(candidates.tracks.map((track) => Number(track.areaScore.toFixed(2))), [92.16, 100]);
  assert.deepEqual(candidates.tracks.map((track) => track.innerIndex), [0, 1]);
  assert.deepEqual(candidates.tracks.map((track) => track.loopCount), [2, 2]);
  const block = generateGcode(twoLoops, [{ layerNumber: 3, replay: true, circles: 2, speedFactors: [.1, .5] }]).text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? "";
  assert.match(block, /Replay loop 1\/2;[\s\S]*?factor 0\.1[\s\S]*?G1 F80/);
  assert.match(block, /Replay loop 2\/2;[\s\S]*?factor 0\.5[\s\S]*?G1 F400/);
});
test("rejects duplicate layers", () => assert.throws(() => generateGcode(fixture, [{ layerNumber: 3, replay: false, circles: 1, speedFactor: .1 }, { layerNumber: 3, replay: false, circles: 1, speedFactor: .1 }]), /重复暂停/));
test("analyzes connectivity and contour nesting by geometry", () => {
  const twoLoops = fixture.replace("; CHANGE_LAYER\n; Z_HEIGHT: 0.4", `G1 X2 Y2 F12000
G1 X8 Y2 E1 F800
G1 X8 Y8 E1
G1 X2 Y8 E1
G1 X2 Y2 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.4`);
  const layer = parseGcode(twoLoops).layers.find((item) => item.number === 2), analysis = analyzeLayerGeometry(layer);
  assert.equal(analysis.contours.length, 2);
  assert.equal(analysis.components.length, 1);
  assert.equal(analysis.maxDepth, 1);
});
test("separates a merged model into skeleton and peripheral-wall regions", () => {
  const threeLoops = fixture.replace("; CHANGE_LAYER\n; Z_HEIGHT: 0.4", `G1 X0.2 Y0.2 F12000
G1 X9.8 Y0.2 E1 F800
G1 X9.8 Y9.8 E1
G1 X0.2 Y9.8 E1
G1 X0.2 Y0.2 E1
G1 E-1
G1 X4 Y4 F12000
G1 X6 Y4 E1 F800
G1 X6 Y6 E1
G1 X4 Y6 E1
G1 X4 Y4 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.4`);
  const parsed = parseGcode(threeLoops), source = parsed.layers.find((layer) => layer.number === 2), regions = classifyLayerRegions(source), candidates = getReplayCandidates(parsed, 3);
  assert.equal(regions.pairedWallDetected, true);
  assert.equal(regions.peripheralWallTracks.length, 2);
  assert.equal(regions.skeletonWallTracks.length, 1);
  assert.deepEqual(candidates.tracks.map((track) => track.region), ["peripheral-wall", "peripheral-wall"]);
  assert.equal(candidates.tracks.at(-1).isOutermost, true);
  const output = generateGcode(threeLoops, [{ layerNumber: 3, replay: true, circles: 2, outerRepeat: 2, speedFactors: [.1], offsetDistances: [0] }]).text;
  const block = output.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? "";
  assert.equal(block.match(/; Replay loop/g)?.length, 3);
  assert.match(block, /region peripheral-wall; pass 1\/2/);
  assert.match(block, /region peripheral-wall; pass 2\/2/);
});
test("adds automatic gap fill as one generated path without counting it as a wall loop", () => {
  const threeLoops = fixture.replace("; CHANGE_LAYER\n; Z_HEIGHT: 0.4", `G1 X0.2 Y0.2 F12000
G1 X9.8 Y0.2 E1 F800
G1 X9.8 Y9.8 E1
G1 X0.2 Y9.8 E1
G1 X0.2 Y0.2 E1
G1 E-1
G1 X4 Y4 F12000
G1 X6 Y4 E1 F800
G1 X6 Y6 E1
G1 X4 Y6 E1
G1 X4 Y4 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.4`);
  const parsed = parseGcode(threeLoops), fill = createAutoFillTrack(parsed.layers.find((layer) => layer.number === 2));
  assert.ok(fill);
  assert.equal(getReplayCandidates(parsed, 3).tracks.length, 2);
  const block = generateGcode(threeLoops, [{ layerNumber: 3, circles: 2, outerRepeat: 1, autoFill: true, speedFactors: [.1], offsetDistances: [0] }]).text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? "";
  assert.equal(block.match(/; Replay loop/g)?.length, 2);
  assert.equal(block.match(/; Auto fill/g)?.length, 1);
  assert.doesNotMatch(block, /^G[123]\s.*(?:^|\s)E[-+]?\d/im);
});
test("inserts final film cutting after the last extrusion and before shutdown", () => {
  const printable = fixture.replace("; CHANGE_LAYER\n; Z_HEIGHT: 0.4", `G1 X0.2 Y0.2 F12000
G1 X9.8 Y0.2 E1 F800
G1 X9.8 Y9.8 E1
G1 X0.2 Y9.8 E1
G1 X0.2 Y0.2 E1
G1 E-1
G1 X4 Y4 F12000
G1 X6 Y4 E1 F800
G1 X6 Y6 E1
G1 X4 Y6 E1
G1 X4 Y4 E1
G1 E-1
; CHANGE_LAYER
; Z_HEIGHT: 0.4`) + "\nM104 S0\nM84";
  const parsed = parseGcode(printable), preview = createFinalCutPreview(parsed, { offset: 1, drop: .1 });
  assert.equal(preview.targetZ, .2);
  const output = generateGcode(printable, [], { enabled: true, offset: 1, drop: .1, speedFactor: .2, repeats: 2 }).text;
  const block = output.match(/; HEATSEAL_FINAL_CUT_START[\s\S]*?; HEATSEAL_FINAL_CUT_END/)?.[0] ?? "";
  assert.ok(output.lastIndexOf(" E1") < output.indexOf("; HEATSEAL_FINAL_CUT_START"));
  assert.ok(output.indexOf("; HEATSEAL_FINAL_CUT_END") < output.indexOf("M104 S0"));
  assert.equal(block.match(/; Final film cut pass/g)?.length, 2);
  assert.doesNotMatch(block, /^G[123]\s.*(?:^|\s)E[-+]?\d/im);
});
test("rejects heat sealing on a layer without a Bambu pause", () => assert.throws(() => generateGcode(fixture, [{ layerNumber: 2, replay: true, circles: 1, speedFactors: [.1] }]), /不是 Bambu Studio 已有暂停层/));
test("rejects zero and non-tenth replay speeds", () => { assert.throws(() => generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactors: [0] }]), /第 1 圈.*0.1–1.0/); assert.throws(() => generateGcode(fixture, [{ layerNumber: 3, replay: true, circles: 1, speedFactors: [.15] }]), /第 1 圈.*0.1–1.0/); });
test("creates standard UTF-8 MD5 values", () => { assert.equal(md5Text("abc"), "900150983CD24FB0D6963F7D28E17F72"); assert.equal(md5Text("热封"), "CF2C6657C705B0724F9D317E0EBA13FC"); });
