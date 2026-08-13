const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("C:/Users/86187/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip");

(async () => {
  const { generateGcode, md5Text } = await import("./core.mjs");
  const input = path.resolve(__dirname, "../yulu260811_V7参数兔儿测试_仅27层暂停后重走26层最外两圈.gcode.3mf");
  const zip = await JSZip.loadAsync(fs.readFileSync(input));
  const gcodePath = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name));
  const original = await zip.file(gcodePath).async("string");
  const result = generateGcode(original, [{ layerNumber: 27, replay: true, circles: 2, speedFactors: [.1, .2] }]);
  const digest = md5Text(result.text);
  assert.equal(digest, crypto.createHash("md5").update(result.text, "utf8").digest("hex").toUpperCase());
  zip.file(gcodePath, result.text);
  zip.file(gcodePath.replace(/\.gcode$/i, ".gcode.md5"), digest);
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const reopened = await JSZip.loadAsync(archive);
  const packedGcode = await reopened.file(gcodePath).async("string");
  const packedDigest = await reopened.file(gcodePath.replace(/\.gcode$/i, ".gcode.md5")).async("string");
  assert.equal(packedGcode, result.text);
  assert.equal(packedDigest, digest);
  assert.match(packedGcode, /HEATSEAL_POSTPROCESS_START layer=27/);
  console.log(JSON.stringify({ archiveBytes: archive.length, gcodeBytes: Buffer.byteLength(packedGcode), md5: packedDigest, pauseLayer: 27, replayLayer: 26, replayLoops: 2 }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
