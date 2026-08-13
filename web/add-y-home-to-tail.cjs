const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("C:/Users/86187/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip");

const source = process.argv[2];
const outputDirectory = process.argv[3] || process.cwd();
if (!source) throw new Error("Usage: node add-y-home-to-tail.cjs <offset-tail.3mf> [output-directory]");

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  const gcodePath = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name));
  assert.ok(gcodePath, "3MF package has no Metadata/plate_*.gcode");
  const original = await zip.file(gcodePath).async("string"), newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/), marker = lines.indexOf("; STANDALONE_TAIL_CONTINUATION_START");
  assert.ok(marker >= 0, "Standalone continuation marker not found");
  const heatSealStart = lines.indexOf("; HEATSEAL_POSTPROCESS_START layer=33");
  assert.ok(heatSealStart > marker, "Final heat-seal block not found");
  const motorEnable = lines.findIndex((line, index) => index > marker && index < heatSealStart && line.trim() === "M17");
  assert.ok(motorEnable > marker, "Motor-enable command not found in preamble");

  lines[marker + 2] = "; REQUIRES: original job completed normally, same powered session, plate/model retained, X and Z not moved";
  lines[marker + 3] = "; Y carriage may have been pushed; this file lifts Z 5mm and homes Y only";
  lines.splice(motorEnable + 1, 0,
    "; Y_AXIS_RECOVERY_START",
    "G91",
    "G1 Z5 F1200 ; relative safety lift before moving the bed",
    "G90",
    "G28 Y ; home the moved bed axis only; never home Z over the retained model",
    "M400",
    "; Y_AXIS_RECOVERY_END"
  );

  const output = lines.join(newline), standalone = output.slice(output.indexOf("; STANDALONE_TAIL_CONTINUATION_START"));
  const heatSeal = output.match(/; HEATSEAL_POSTPROCESS_START layer=33[\s\S]*?; HEATSEAL_POSTPROCESS_END layer=33/)?.[0] || "";
  const afterHeatSeal = output.slice(output.indexOf("; HEATSEAL_POSTPROCESS_END layer=33"));
  const homing = [...standalone.matchAll(/^G28(?:\s+([^;\r\n]+))?/gm)].map((match) => (match[1] || "").trim());
  assert.deepEqual(homing, ["Y"], "Standalone section must home Y exactly once and must not home X/Z");
  assert.match(standalone, /M17\r?\n; Y_AXIS_RECOVERY_START\r?\nG91\r?\nG1 Z5 F1200/);
  assert.equal((heatSeal.match(/OUTWARD_OFFSET=0\.2mm/g) || []).length, 2, "Expected two corrected 0.2mm offset loops");
  assert.doesNotMatch(heatSeal, /^G[123]\s[^\r\n]*\bE[-+]?(?:\d|\.)/im, "Heat-seal block unexpectedly extrudes");
  assert.match(afterHeatSeal, /^G[123]\s[^\r\n]*\bE[-+]?(?:\d|\.)/im, "Layer 33 continuation has no extrusion");
  assert.match(heatSeal, /^G1 F412\.2$/m, "Replay speed changed unexpectedly");

  const md5 = crypto.createHash("md5").update(Buffer.from(output, "utf8")).digest("hex").toUpperCase();
  zip.file(gcodePath, output);
  zip.file(gcodePath.replace(/\.gcode$/i, ".gcode.md5"), md5);
  const stem = "wdy260812_兔子耳朵_最终热封后续打_Y轴归零_两圈外扩0.2mm";
  const packageOutput = path.join(outputDirectory, `${stem}.gcode.3mf`), plainOutput = path.join(outputDirectory, `${stem}.gcode`);
  fs.writeFileSync(plainOutput, output, "utf8");
  fs.writeFileSync(packageOutput, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  console.log(JSON.stringify({ packageOutput, plainOutput, gcodeBytes: Buffer.byteLength(output), md5, yHomeCount: homing.length, safetyLift: 5, replayLoops: 2, offset: 0.2, replayFeed: 412.2 }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
