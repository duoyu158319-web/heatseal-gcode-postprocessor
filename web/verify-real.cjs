const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("C:/Users/86187/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip");

(async () => {
  const { generateGcode, getReplayCandidates, parseGcode } = await import("./core.mjs");
  const fixtures = [
    { file: "../yulu260811_V7参数兔儿测试_仅27层暂停后重走26层最外两圈.gcode.3mf", pause: 27, total: 27 },
    { file: "../yulu260811_鼎钰方法测试_24层双圈_Z2.47_F503.25_圈间抬高10mm_Z256等待30s和10s.gcode.3mf", pause: 25, total: 49 },
  ];
  for (const fixture of fixtures) {
    const zip = await JSZip.loadAsync(fs.readFileSync(path.resolve(__dirname, fixture.file)));
    const gcodePath = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name));
    const gcode = await zip.file(gcodePath).async("string"), parsed = parseGcode(gcode);
    assert.equal(parsed.totalLayers, fixture.total);
    const candidates = getReplayCandidates(parsed, fixture.pause);
    assert.ok(candidates.sourceLayer);
    assert.ok(candidates.tracks.length >= 2, `${fixture.file} should expose at least two wall tracks`);
    const result = generateGcode(gcode, [{ layerNumber: fixture.pause, replay: true, circles: 2, speedFactors: [.1, .2] }]);
    const block = result.text.match(/; HEATSEAL_POSTPROCESS_START[\s\S]*?; HEATSEAL_POSTPROCESS_END/)?.[0] ?? "";
    assert.doesNotMatch(block, /^G[123]\s.*(?:^|\s)E[-+]?\d/im);
    console.log(JSON.stringify({ file: path.basename(fixture.file), layers: parsed.totalLayers, objects: parsed.objectIds, sourceLayer: candidates.sourceLayer.number, closedWalls: candidates.tracks.length, replayZ: result.operations[0].replayZ }));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
