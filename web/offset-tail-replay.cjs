const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("C:/Users/86187/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/jszip");

const source = process.argv[2];
const outputDirectory = process.argv[3] || process.cwd();
const offsetDistance = Number(process.argv[4] ?? 0.2);
if (!source || !(offsetDistance > 0)) throw new Error("Usage: node offset-tail-replay.cjs <tail.3mf> [output-directory] [offset-mm]");

const value = (line, key) => Number(line.match(new RegExp(`(?:^|\\s)${key}([-+]?(?:\\d+\\.?\\d*|\\.\\d+))`, "i"))?.[1]);
const format = (number) => Number(number).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
const cross = (a, b) => a.x * b.y - a.y * b.x;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a, factor) => ({ x: a.x * factor, y: a.y * factor });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const signedArea = (points) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;

function samplePath(start, commands, chord = 0.12) {
  const points = [{ ...start }];
  let current = { ...start };
  for (const line of commands) {
    const code = line.trim().match(/^(G[123])(?:\s|$)/i)?.[1]?.toUpperCase();
    if (!code) continue;
    const parsedX = value(line, "X"), parsedY = value(line, "Y");
    const end = { x: Number.isFinite(parsedX) ? parsedX : current.x, y: Number.isFinite(parsedY) ? parsedY : current.y };
    if (code === "G1") {
      points.push(end);
    } else {
      const i = value(line, "I"), j = value(line, "J");
      assert.ok(Number.isFinite(i) && Number.isFinite(j), `Arc has no I/J center: ${line}`);
      const center = { x: current.x + i, y: current.y + j }, radius = distance(current, center);
      let startAngle = Math.atan2(current.y - center.y, current.x - center.x);
      let endAngle = Math.atan2(end.y - center.y, end.x - center.x), sweep = endAngle - startAngle;
      if (code === "G2") { while (sweep >= 0) sweep -= Math.PI * 2; }
      else { while (sweep <= 0) sweep += Math.PI * 2; }
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) * radius / chord));
      for (let step = 1; step <= steps; step++) {
        const angle = startAngle + sweep * step / steps;
        points.push(step === steps ? end : { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
      }
    }
    current = end;
  }
  if (distance(points[0], points.at(-1)) <= 1.2) points[points.length - 1] = { ...points[0] };
  assert.ok(distance(points[0], points.at(-1)) < 1e-6, "Replay path is not closed");
  points.pop();
  return points.filter((point, index, array) => !index || distance(point, array[index - 1]) > 1e-6);
}

function outwardOffset(points, amount) {
  const area = signedArea(points);
  assert.ok(Math.abs(area) > 1, "Replay polygon area is too small");
  const orientation = area > 0 ? 1 : -1;
  const shifted = points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length], next = points[(index + 1) % points.length];
    const previousDirection = sub(point, previous), nextDirection = sub(next, point);
    const previousLength = Math.hypot(previousDirection.x, previousDirection.y), nextLength = Math.hypot(nextDirection.x, nextDirection.y);
    const previousNormal = scale({ x: previousDirection.y / previousLength, y: -previousDirection.x / previousLength }, orientation * amount);
    const nextNormal = scale({ x: nextDirection.y / nextLength, y: -nextDirection.x / nextLength }, orientation * amount);
    const first = add(point, previousNormal), second = add(point, nextNormal), denominator = cross(previousDirection, nextDirection);
    if (Math.abs(denominator) < 1e-8) return scale(add(first, second), .5);
    const intersection = add(first, scale(previousDirection, cross(sub(second, first), nextDirection) / denominator));
    if (distance(point, intersection) > amount * 6) {
      const average = add(previousNormal, nextNormal), length = Math.hypot(average.x, average.y);
      return add(point, length ? scale(average, amount / length) : previousNormal);
    }
    return intersection;
  });
  assert.ok(Math.abs(signedArea(shifted)) > Math.abs(area), "Offset polygon did not expand outward");
  return shifted;
}

function outwardNormal(direction, orientation) {
  const length = Math.hypot(direction.x, direction.y);
  return scale({ x: direction.y / length, y: -direction.x / length }, orientation);
}

function outwardOffsetRounded(points, amount, arcStep = Math.PI / 36) {
  const area = signedArea(points), orientation = area > 0 ? 1 : -1, output = [];
  assert.ok(Math.abs(area) > 1, "Replay polygon area is too small");
  points.forEach((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length], next = points[(index + 1) % points.length];
    const incoming = sub(point, previous), outgoing = sub(next, point), previousNormal = outwardNormal(incoming, orientation), nextNormal = outwardNormal(outgoing, orientation);
    const turn = cross(incoming, outgoing) * orientation;
    if (turn > 1e-9) {
      let startAngle = Math.atan2(previousNormal.y, previousNormal.x), endAngle = Math.atan2(nextNormal.y, nextNormal.x), sweep = endAngle - startAngle;
      if (orientation > 0) while (sweep < 0) sweep += Math.PI * 2;
      else while (sweep > 0) sweep -= Math.PI * 2;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep));
      for (let step = 0; step <= steps; step++) {
        const angle = startAngle + sweep * step / steps;
        output.push(add(point, { x: amount * Math.cos(angle), y: amount * Math.sin(angle) }));
      }
    } else {
      const first = add(point, scale(previousNormal, amount)), second = add(point, scale(nextNormal, amount));
      const denominator = cross(incoming, outgoing);
      if (Math.abs(denominator) < 1e-9) output.push(scale(add(first, second), .5));
      else output.push(add(first, scale(incoming, cross(sub(second, first), outgoing) / denominator)));
    }
  });
  const cleaned = output.filter((point, index, array) => !index || distance(point, array[index - 1]) > 1e-5);
  assert.ok(Math.abs(signedArea(cleaned)) > Math.abs(area), "Rounded offset polygon did not expand outward");
  return cleaned;
}

function bounds(points) {
  return points.reduce((box, point) => ({ minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x), minY: Math.min(box.minY, point.y), maxY: Math.max(box.maxY, point.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}

function pointSegmentDistance(point, start, end) {
  const segment = sub(end, start), lengthSquared = segment.x * segment.x + segment.y * segment.y;
  const ratio = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * segment.x + (point.y - start.y) * segment.y) / lengthSquared)) : 0;
  return distance(point, add(start, scale(segment, ratio)));
}

function nearestBoundaryDistance(point, polygon) {
  let minimum = Infinity;
  for (let index = 0; index < polygon.length; index++) minimum = Math.min(minimum, pointSegmentDistance(point, polygon[index], polygon[(index + 1) % polygon.length]));
  return minimum;
}

function quantile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function properIntersection(firstStart, firstEnd, secondStart, secondEnd) {
  const first = sub(firstEnd, firstStart), second = sub(secondEnd, secondStart);
  const a = cross(first, sub(secondStart, firstStart)), b = cross(first, sub(secondEnd, firstStart));
  const c = cross(second, sub(firstStart, secondStart)), d = cross(second, sub(firstEnd, secondStart));
  const tolerance = 1e-8;
  return ((a > tolerance && b < -tolerance) || (a < -tolerance && b > tolerance)) && ((c > tolerance && d < -tolerance) || (c < -tolerance && d > tolerance));
}

function countSelfIntersections(polygon) {
  let count = 0;
  for (let first = 0; first < polygon.length; first++) {
    const firstEnd = (first + 1) % polygon.length;
    for (let second = first + 1; second < polygon.length; second++) {
      const secondEnd = (second + 1) % polygon.length;
      if (first === second || firstEnd === second || secondEnd === first) continue;
      if (properIntersection(polygon[first], polygon[firstEnd], polygon[second], polygon[secondEnd])) count++;
    }
  }
  return count;
}

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  const gcodePath = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name));
  assert.ok(gcodePath, "3MF package has no Metadata/plate_*.gcode");
  const original = await zip.file(gcodePath).async("string"), newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/), reports = [];
  const replayComments = lines.map((line, index) => {
    const match = line.match(/^; Replay loop (\d+)\/(\d+);/);
    return match ? { index, loop: Number(match[1]), total: Number(match[2]) } : null;
  }).filter(Boolean);
  assert.ok(replayComments.length, "No dry replay loops found");
  assert.equal(lines.some((line) => /OUTWARD_OFFSET=/.test(line)), false, "Source already contains an offset replay; refusing to offset it again");
  for (const replay of replayComments.reverse()) {
    const { index: commentIndex, loop, total } = replay;
    const travelIndex = commentIndex + 1, pathStart = commentIndex + 5;
    const pathEnd = lines.findIndex((line, index) => index >= pathStart && /^M204\s+S10000\b/.test(line.trim()));
    assert.ok(pathEnd > pathStart, `Replay loop ${loop}/${total} path end not found`);
    const start = { x: value(lines[travelIndex], "X"), y: value(lines[travelIndex], "Y") };
    assert.ok(Number.isFinite(start.x) && Number.isFinite(start.y), `Replay loop ${loop}/${total} start XY missing`);
    const sampled = samplePath(start, lines.slice(pathStart, pathEnd)), offset = outwardOffsetRounded(sampled, offsetDistance);
    const offsetMoves = offset.slice(1).concat(offset[0]).map((point) => `G1 X${format(point.x)} Y${format(point.y)}`);
    lines[commentIndex] += `; OUTWARD_OFFSET=${format(offsetDistance)}mm`;
    lines[travelIndex] = `G1 X${format(offset[0].x)} Y${format(offset[0].y)} F42000`;
    lines.splice(pathStart, pathEnd - pathStart, ...offsetMoves);
    const actualOffsets = offset.map((point) => nearestBoundaryDistance(point, sampled));
    const reverseOffsets = sampled.map((point) => nearestBoundaryDistance(point, offset));
    const selfIntersections = countSelfIntersections(offset);
    assert.ok(Math.max(...actualOffsets) <= offsetDistance + .003, `Loop ${loop}/${total} exceeds requested offset: ${Math.max(...actualOffsets).toFixed(4)} mm`);
    assert.equal(selfIntersections, 0, `Loop ${loop}/${total} offset path self-intersects`);
    reports.unshift({ loop, total, sourcePoints: sampled.length, outputMoves: offsetMoves.length, sourceArea: Math.abs(signedArea(sampled)), offsetArea: Math.abs(signedArea(offset)), sourceBounds: bounds(sampled), offsetBounds: bounds(offset), actualOffset: { minimum: Math.min(...actualOffsets), median: quantile(actualOffsets, .5), p95: quantile(actualOffsets, .95), maximum: Math.max(...actualOffsets) }, reverseOffset: { minimum: Math.min(...reverseOffsets), median: quantile(reverseOffsets, .5), p95: quantile(reverseOffsets, .95), maximum: Math.max(...reverseOffsets) }, selfIntersections });
  }
  const output = lines.join(newline), heatSealBlocks = [...output.matchAll(/; HEATSEAL_POSTPROCESS_START layer=(\d+)[\s\S]*?; HEATSEAL_POSTPROCESS_END layer=\1/g)].map((match) => match[0]).filter((block) => /; Dry replay layer /.test(block));
  assert.equal((output.match(new RegExp(`OUTWARD_OFFSET=${format(offsetDistance).replace(".", "\\.")}mm`, "g")) || []).length, replayComments.length);
  heatSealBlocks.forEach((block) => assert.doesNotMatch(block, /^G[123]\s[^\r\n]*\bE[-+]?(?:\d|\.)/im, "Offset heat-seal block unexpectedly extrudes"));
  const md5 = crypto.createHash("md5").update(Buffer.from(output, "utf8")).digest("hex").toUpperCase();
  zip.file(gcodePath, output);
  zip.file(gcodePath.replace(/\.gcode$/i, ".gcode.md5"), md5);
  const sourceStem = path.basename(source).replace(/\.gcode\.3mf$/i, "").replace(/\.3mf$/i, "");
  const stem = `${sourceStem}_无挤出复走均外扩${format(offsetDistance)}mm`;
  const packageOutput = path.join(outputDirectory, `${stem}.gcode.3mf`), plainOutput = path.join(outputDirectory, `${stem}.gcode`);
  fs.writeFileSync(plainOutput, output, "utf8");
  fs.writeFileSync(packageOutput, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  console.log(JSON.stringify({ packageOutput, plainOutput, gcodeBytes: Buffer.byteLength(output), md5, offsetDistance, replayLoops: replayComments.length, heatSealBlocks: heatSealBlocks.length, reports }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
