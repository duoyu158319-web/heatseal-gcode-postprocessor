const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("C:/Users/86187/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip");

const source = process.argv[2];
const outputDirectory = process.argv[3] || process.cwd();
if (!source) throw new Error("Usage: node create-tail-continuation.cjs <source.3mf> [output-directory]");

const packageName = "wdy260812_兔子耳朵_最终热封后续打.gcode.3mf";
const gcodeName = "wdy260812_兔子耳朵_最终热封后续打.gcode";

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  const gcodePath = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name));
  assert.ok(gcodePath, "3MF package has no Metadata/plate_*.gcode");
  const original = await zip.file(gcodePath).async("string");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const executableStart = lines.findIndex((line) => /EXECUTABLE_BLOCK_START/.test(line));
  const tailStart = lines.map((line) => line.trim()).lastIndexOf("; HEATSEAL_POSTPROCESS_START layer=33");
  assert.ok(executableStart >= 0, "EXECUTABLE_BLOCK_START not found");
  assert.ok(tailStart > executableStart, "Final layer-33 heat-seal block not found");

  const preamble = [
    "; STANDALONE_TAIL_CONTINUATION_START",
    "; Bambu Lab A1 / TPU / source bed 45C / source nozzle 235C",
    "; REQUIRES: original job completed normally, same powered session, plate/model/toolhead not moved",
    "; DO NOT RUN after power cycle, homing, manual axis movement, or plate removal",
    "M17",
    "G90",
    "M83",
    "M1002 set_filament_type:TPU",
    "T1000 ; restore external-spool tool selected by the source job",
    "M220 S100",
    "M221 S100",
    "M201.2 K1.0",
    "M73.2 R1.0",
    "M106 S0",
    "M106 P2 S0",
    "M106 P3 S0",
    "M140 S45",
    "M104 S235",
    "M190 S45",
    "M109 S235",
    "G29.2 S1",
    "M73 P97 R0",
    "M73 L33",
    "; STANDALONE_TAIL_CONTINUATION_READY",
  ];

  const outputLines = [...lines.slice(0, executableStart + 1), ...preamble, ...lines.slice(tailStart)];
  const output = outputLines.join(newline);
  const heatSealBlock = output.match(/; HEATSEAL_POSTPROCESS_START layer=33[\s\S]*?; HEATSEAL_POSTPROCESS_END layer=33/)?.[0] || "";
  assert.ok(heatSealBlock, "Heat-seal block missing from output");
  assert.equal((heatSealBlock.match(/; Replay loop \d+\/2/g) || []).length, 2, "Expected two dry replay loops");
  const extrusionMove = /^G[123]\s[^\r\n]*\bE[-+]?(?:\d|\.)/im;
  assert.doesNotMatch(heatSealBlock, extrusionMove, "Heat-seal block unexpectedly extrudes");
  assert.match(output.slice(output.indexOf("; HEATSEAL_POSTPROCESS_END layer=33")), extrusionMove, "Continuation has no extrusion moves");
  assert.equal((output.match(/EXECUTABLE_BLOCK_START/g) || []).length, 1);
  assert.equal((output.match(/EXECUTABLE_BLOCK_END/g) || []).length, 1);
  assert.match(output.slice(output.indexOf("; STANDALONE_TAIL_CONTINUATION_START"), output.indexOf("; HEATSEAL_POSTPROCESS_START layer=33")), /^T1000\b/m, "External-spool TPU tool is not restored");
  assert.doesNotMatch(output.slice(output.indexOf("; STANDALONE_TAIL_CONTINUATION_START")), /^G28(?:\s|$)/m, "Standalone continuation must not home over the retained model");

  const md5 = crypto.createHash("md5").update(Buffer.from(output, "utf8")).digest("hex").toUpperCase();
  zip.file(gcodePath, output);
  zip.file(gcodePath.replace(/\.gcode$/i, ".gcode.md5"), md5);
  const packageOutput = path.join(outputDirectory, packageName);
  const plainOutput = path.join(outputDirectory, gcodeName);
  fs.writeFileSync(plainOutput, output, "utf8");
  fs.writeFileSync(packageOutput, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  console.log(JSON.stringify({ packageOutput, plainOutput, gcodeBytes: Buffer.byteLength(output), md5, tailStartLine: tailStart + 1, replayLoops: 2 }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
