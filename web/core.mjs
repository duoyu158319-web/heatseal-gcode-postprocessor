const NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)";
const val = (line, key) => {
  const m = line.match(new RegExp(`(?:^|\\s)${key}(${NUM})`, "i"));
  return m ? Number(m[1]) : undefined;
};
const code = (line) => line.trim().match(/^(G[0-3]|M8[23])(?:\s|$)/i)?.[1]?.toUpperCase();
const strip = (line, key) => line.replace(new RegExp(`\\s${key}${NUM}`, "ig"), "").trimEnd();
const round = (n, d = 3) => Number(n.toFixed(d));
const dist = (a, b) => !a || !b ? Infinity : Math.hypot(a.x - b.x, a.y - b.y);
const median = (xs) => {
  if (!xs.length) return 600;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const cross = (a, b) => a.x * b.y - a.y * b.x;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const scalePoint = (a, factor) => ({ x: a.x * factor, y: a.y * factor });
const signedArea = (points) => points.reduce((sum, point, index) => {
  const next = points[(index + 1) % points.length];
  return sum + point.x * next.y - next.x * point.y;
}, 0) / 2;

function sampleTrack(track, chord = .12) {
  const points = [{ ...track.start }];
  let current = { ...track.start };
  for (const line of track.commands) {
    const move = line.trim().match(/^(G[123])(?:\s|$)/i)?.[1]?.toUpperCase();
    if (!move) continue;
    const x = val(line, "X"), y = val(line, "Y"), end = { x: x ?? current.x, y: y ?? current.y };
    if (move === "G1") points.push(end);
    else {
      const i = val(line, "I"), j = val(line, "J");
      if (i === undefined || j === undefined) throw new Error("圆弧轨迹缺少 I/J 圆心参数，无法安全外扩。");
      const center = { x: current.x + i, y: current.y + j }, radius = dist(current, center);
      const startAngle = Math.atan2(current.y - center.y, current.x - center.x), endAngle = Math.atan2(end.y - center.y, end.x - center.x);
      let sweep = endAngle - startAngle;
      if (move === "G2") while (sweep >= 0) sweep -= Math.PI * 2;
      else while (sweep <= 0) sweep += Math.PI * 2;
      const steps = Math.max(2, Math.ceil(Math.abs(sweep) * radius / chord));
      for (let step = 1; step <= steps; step++) {
        const angle = startAngle + sweep * step / steps;
        points.push(step === steps ? end : { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
      }
    }
    current = end;
  }
  if (dist(points[0], points.at(-1)) <= 1.2) points[points.length - 1] = { ...points[0] };
  if (dist(points[0], points.at(-1)) > 1e-6) throw new Error("识别到的复走轨迹没有闭合，无法安全外扩。");
  points.pop();
  return points.filter((point, index, all) => !index || dist(point, all[index - 1]) > 1e-6);
}

function outwardNormal(direction, orientation) {
  const length = Math.hypot(direction.x, direction.y);
  return scalePoint({ x: direction.y / length, y: -direction.x / length }, orientation);
}

function roundedOffset(points, amount, arcStep = Math.PI / 36) {
  const area = signedArea(points), orientation = area > 0 ? 1 : -1, output = [];
  if (Math.abs(area) <= 1) throw new Error("复走轮廓面积过小，无法安全外扩。");
  points.forEach((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length], next = points[(index + 1) % points.length];
    const incoming = sub(point, previous), outgoing = sub(next, point), previousNormal = outwardNormal(incoming, orientation), nextNormal = outwardNormal(outgoing, orientation);
    const turn = cross(incoming, outgoing) * orientation;
    if (turn > 1e-9) {
      const startAngle = Math.atan2(previousNormal.y, previousNormal.x), endAngle = Math.atan2(nextNormal.y, nextNormal.x);
      let sweep = endAngle - startAngle;
      if (orientation > 0) while (sweep < 0) sweep += Math.PI * 2;
      else while (sweep > 0) sweep -= Math.PI * 2;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / arcStep));
      for (let step = 0; step <= steps; step++) {
        const angle = startAngle + sweep * step / steps;
        output.push(add(point, { x: amount * Math.cos(angle), y: amount * Math.sin(angle) }));
      }
    } else {
      const first = add(point, scalePoint(previousNormal, amount)), second = add(point, scalePoint(nextNormal, amount)), denominator = cross(incoming, outgoing);
      output.push(Math.abs(denominator) < 1e-9 ? scalePoint(add(first, second), .5) : add(first, scalePoint(incoming, cross(sub(second, first), outgoing) / denominator)));
    }
  });
  const cleaned = output.filter((point, index, all) => !index || dist(point, all[index - 1]) > 1e-5);
  if (Math.abs(signedArea(cleaned)) <= Math.abs(area)) throw new Error("复走轨迹外扩失败，已停止导出。");
  return cleaned;
}

export function offsetTrack(track, amount = .2) {
  if (Number(amount) === 0) return { start: { ...track.start }, points: null, commands: [...track.commands] };
  const points = roundedOffset(sampleTrack(track), Number(amount));
  return { start: points[0], points, commands: points.slice(1).concat(points[0]).map((point) => `G1 X${round(point.x)} Y${round(point.y)}`) };
}

function statesFor(lines) {
  const before = new Array(lines.length);
  let s = { x: undefined, y: undefined, z: undefined, feed: undefined, feature: "未标注路径", objectId: "未标注主体", axesAbsolute: true, extrusionRelative: true };
  lines.forEach((raw, i) => {
    const line = raw.trim();
    before[i] = { ...s };
    s.feature = line.match(/^;\s*FEATURE:\s*(.+)/i)?.[1]?.trim() ?? s.feature;
    s.objectId = line.match(/^;\s*OBJECT_ID:\s*(\S+)/i)?.[1] ?? s.objectId;
    const c = code(line);
    if (c === "G90") s.axesAbsolute = true;
    if (c === "G91") s.axesAbsolute = false;
    if (c === "M82") s.extrusionRelative = false;
    if (c === "M83") s.extrusionRelative = true;
    if (!c?.startsWith("G")) return;
    const x = val(line, "X"), y = val(line, "Y"), z = val(line, "Z"), f = val(line, "F");
    if (x !== undefined) s.x = s.axesAbsolute ? x : (s.x ?? 0) + x;
    if (y !== undefined) s.y = s.axesAbsolute ? y : (s.y ?? 0) + y;
    if (z !== undefined) s.z = s.axesAbsolute ? z : (s.z ?? 0) + z;
    if (f !== undefined) s.feed = f;
  });
  return before;
}

function rangesFor(lines, total) {
  const marks = [];
  lines.forEach((line, i) => {
    const m = line.match(/;\s*layer num\/total_layer_count:\s*(\d+)\/(\d+)/i);
    if (!m) return;
    let start = i, z;
    for (let j = i; j >= Math.max(0, i - 20); j--) if (/^;\s*CHANGE_LAYER/.test(lines[j])) { start = j; break; }
    for (let j = start; j <= Math.min(lines.length - 1, i + 4); j++) {
      const zMatch = lines[j].match(/;\s*Z_HEIGHT:\s*([\d.]+)/i);
      if (zMatch) z = Number(zMatch[1]);
    }
    marks.push({ number: Number(m[1]), total: Number(m[2]), start, marker: i, z });
  });
  if (marks.length && marks[0].number > 1) marks.unshift({ number: 1, total: marks[0].total, start: 0, marker: 0, z: undefined });
  return marks.map((m, i) => ({ ...m, total: m.total || total, end: marks[i + 1]?.start ?? lines.length }));
}

function finishTrack(t) {
  if (!t || t.commands.length < 2 || !t.start || !t.end) return null;
  const width = t.bounds.maxX - t.bounds.minX, height = t.bounds.maxY - t.bounds.minY;
  return { ...t, closed: dist(t.start, t.end) <= 1.2, areaScore: width * height, width: round(width), height: round(height), originalFeed: round(median(t.feeds), 2) };
}

function tracksFor(lines, states, layer) {
  const tracks = [];
  let active = null;
  const close = () => { const done = finishTrack(active); if (done) tracks.push(done); active = null; };
  for (let i = layer.start; i < layer.end; i++) {
    const line = lines[i].trim(), c = code(line), e = val(line, "E"), x = val(line, "X"), y = val(line, "Y");
    const planar = /^G[123]$/.test(c ?? "") && (x !== undefined || y !== undefined);
    if (planar && e !== undefined && e > 0) {
      const s = states[i];
      if (!active) active = { layerNumber: layer.number, objectId: s.objectId, feature: s.feature, start: s.x !== undefined && s.y !== undefined ? { x: s.x, y: s.y } : null, end: null, commands: [], feeds: [], bounds: { minX: s.x ?? Infinity, maxX: s.x ?? -Infinity, minY: s.y ?? Infinity, maxY: s.y ?? -Infinity } };
      const clean = strip(strip(line, "E"), "F");
      if (clean) active.commands.push(clean);
      const endX = x ?? s.x, endY = y ?? s.y;
      if (endX !== undefined && endY !== undefined) {
        active.end = { x: endX, y: endY };
        active.bounds.minX = Math.min(active.bounds.minX, endX); active.bounds.maxX = Math.max(active.bounds.maxX, endX);
        active.bounds.minY = Math.min(active.bounds.minY, endY); active.bounds.maxY = Math.max(active.bounds.maxY, endY);
      }
      const feed = val(line, "F") ?? s.feed; if (feed) active.feeds.push(feed);
    } else if (active && ((planar && e === undefined) || (e !== undefined && e <= 0))) close();
  }
  close();
  return tracks;
}

function insertionFor(lines, layer) {
  for (let i = layer.marker + 1; i < layer.end; i++) {
    if (/^;\s*OBJECT_ID:/.test(lines[i])) return i;
    if (/^G[123]\s/i.test(lines[i]) && (val(lines[i], "E") ?? 0) > 0) return i;
  }
  return Math.min(layer.end, layer.marker + 1);
}

export function parseGcode(text) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n", lines = text.split(/\r?\n/), states = statesFor(lines);
  const headerTotal = Number(text.match(/;\s*total layer number:\s*(\d+)/i)?.[1] ?? 0);
  const layers = rangesFor(lines, headerTotal).map((layer) => {
    const tracks = tracksFor(lines, states, layer), walls = tracks.filter((t) => /wall/i.test(t.feature) && t.closed), usable = walls.length ? walls : tracks.filter((t) => t.closed), byObject = {};
    usable.forEach((t) => (byObject[t.objectId] ??= []).push(t));
    Object.values(byObject).forEach((xs) => xs.sort((a, b) => b.areaScore - a.areaScore));
    const sequence = []; tracks.forEach((t) => { if (sequence.at(-1) !== t.objectId) sequence.push(t.objectId); });
    const insertionIndex = insertionFor(lines, layer);
    return { ...layer, z: layer.z ?? states[insertionIndex]?.z, tracks, wallTracks: usable, byObject, objectSequence: sequence, objectTransitions: Math.max(0, sequence.length - 1), insertionIndex, insertionState: states[insertionIndex], hasPause: /M400 U1/.test(lines.slice(layer.start, layer.end).join("\n")) };
  });
  const objectIds = [...new Set(layers.flatMap((l) => l.tracks.map((t) => t.objectId)))];
  const temps = [...text.matchAll(/^M10[49]\s+S([\d.]+)/gm)].map((m) => Number(m[1])).filter((n) => n > 180);
  return { text, newline, lines, states, layers, totalLayers: headerTotal || layers.at(-1)?.total || layers.length, objectIds, nozzleTemperature: temps.at(-1), printableHeight: Number(text.match(/;\s*printable_height\s*=\s*([\d.]+)/i)?.[1] ?? 256), preprocessed: /DRY_REPLAY_|HEATSEAL_POSTPROCESS_/i.test(text) };
}

export function parseObjectNames(sliceInfo = "", plateJson = "") {
  const names = {};
  for (const m of sliceInfo.matchAll(/<object[^>]*identify_id="([^"]+)"[^>]*name="([^"]*)"/g)) names[m[1]] = m[2] || `主体 ${m[1]}`;
  try { for (const o of JSON.parse(plateJson).bbox_objects ?? []) names[String(o.id)] ??= o.name || `主体 ${o.id}`; } catch {}
  return names;
}

export function md5Text(input) {
  const bytes = new TextEncoder().encode(input), words = [];
  for (let i = 0; i < bytes.length; i++) words[i >> 2] = (words[i >> 2] || 0) | bytes[i] << (i % 4 * 8);
  words[bytes.length >> 2] = (words[bytes.length >> 2] || 0) | 0x80 << (bytes.length % 4 * 8);
  words[(((bytes.length + 8) >> 6) + 1) * 16 - 2] = bytes.length * 8;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  const k = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296));
  const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  for (let offset = 0; offset < words.length; offset += 16) {
    const aa = a, bb = b, cc = c, dd = d;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const previousD = d, sum = (a + f + k[i] + (words[offset + g] || 0)) | 0;
      d = c; c = b; b = (b + ((sum << shifts[i]) | (sum >>> (32 - shifts[i])))) | 0; a = previousD;
    }
    a = (a + aa) | 0; b = (b + bb) | 0; c = (c + cc) | 0; d = (d + dd) | 0;
  }
  return [a,b,c,d].map((n) => [0,8,16,24].map((shift) => ((n >>> shift) & 255).toString(16).padStart(2, "0")).join("")).join("").toUpperCase();
}

export function getReplayCandidates(parsed, pauseLayerNumber, objectIds = []) {
  const sourceLayer = parsed.layers.find((l) => l.number === pauseLayerNumber - 1);
  if (!sourceLayer) return { sourceLayer: null, tracks: [] };
  const tracks = objectIds.length ? objectIds.flatMap((id) => sourceLayer.byObject[id] ?? []) : Object.values(sourceLayer.byObject).flat();
  return { sourceLayer, tracks: tracks.sort((a, b) => b.areaScore - a.areaScore) };
}

const coord = (n) => Number(n).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
function replayBlock(parsed, cfg, pauseLayer) {
  const { sourceLayer, tracks } = getReplayCandidates(parsed, cfg.layerNumber, cfg.objectIds ?? []), selected = tracks.slice(0, cfg.circles);
  if (!sourceLayer) throw new Error(`第 ${cfg.layerNumber} 层没有可用的下方层。`);
  if (cfg.replay && selected.length < cfg.circles) throw new Error(`第 ${sourceLayer.number} 层只识别到 ${selected.length} 条可复走闭合外墙，少于要求的 ${cfg.circles} 圈。`);
  const s = pauseLayer.insertionState ?? {}, safeZ = Math.min(parsed.printableHeight || 256, cfg.safeZ ?? 256), replayZ = round((sourceLayer.z ?? 0) + (cfg.clearance ?? .01)), liftZ = Math.min(safeZ, replayZ + (cfg.betweenLift ?? 10));
  const out = [`; HEATSEAL_POSTPROCESS_START layer=${cfg.layerNumber}`, "; PAUSE_PRINTING", "M400 U1"];
  if (cfg.replay) {
    out.push(`; Dry replay layer ${sourceLayer.number} at Z${coord(replayZ)}; ${selected.length} outer wall loop(s); no extrusion`, "G90", "M83", "M204 S10000", `G1 Z${coord(safeZ)} F1200`, `M400 S${cfg.waitBefore ?? 30}`);
    selected.forEach((t, i) => {
      const factor = cfg.speedFactors[i] ?? cfg.speedFactors.at(-1), offset = cfg.offsetDistances[i] ?? cfg.offsetDistances.at(-1), shifted = offsetTrack(t, offset);
      out.push(`; Replay loop ${i + 1}/${selected.length}; factor ${factor}; outward offset ${coord(offset)}mm`, `G1 X${coord(shifted.start.x)} Y${coord(shifted.start.y)} F42000`, `G1 Z${coord(replayZ)} F1200`, `G1 F${coord(Math.max(1, t.originalFeed * factor))}`, "M204 S800", ...shifted.commands);
      if (i < selected.length - 1) out.push("M204 S10000", `G1 Z${coord(liftZ)} F1200`);
    });
    out.push("M204 S10000", `G1 Z${coord(safeZ)} F1200`, `M400 S${cfg.waitAfter ?? 10}`, "; Restore pause state");
    if (s.x !== undefined && s.y !== undefined) out.push(`G1 X${coord(s.x)} Y${coord(s.y)} F42000`);
    if (s.z !== undefined) out.push(`G1 Z${coord(s.z)} F1200`);
    out.push(s.axesAbsolute === false ? "G91" : "G90", s.extrusionRelative === false ? "M82" : "M83");
  }
  out.push(`; HEATSEAL_POSTPROCESS_END layer=${cfg.layerNumber}`);
  return { lines: out, selected, sourceLayer, replayZ, safeZ };
}

export function generateGcode(text, configs) {
  const parsed = parseGcode(text), seen = new Set(), operations = [];
  if (!configs.length) throw new Error("请至少添加一个暂停层。 ");
  for (const raw of configs) {
    const speedFactors = Array.isArray(raw.speedFactors) && raw.speedFactors.length ? raw.speedFactors.map(Number) : [Number(raw.speedFactor ?? .1)];
    const offsetDistances = Array.isArray(raw.offsetDistances) && raw.offsetDistances.length ? raw.offsetDistances.map(Number) : [Number(raw.offsetDistance ?? .2)];
    const cfg = { ...raw, layerNumber: Number(raw.layerNumber), circles: Number(raw.circles), speedFactors, offsetDistances };
    if (!Number.isInteger(cfg.layerNumber) || cfg.layerNumber < 2 || cfg.layerNumber > parsed.totalLayers) throw new Error(`暂停层 ${raw.layerNumber} 无效；可选范围为 2–${parsed.totalLayers}。`);
    if (seen.has(cfg.layerNumber)) throw new Error(`第 ${cfg.layerNumber} 层配置了重复暂停。`); seen.add(cfg.layerNumber);
    if (cfg.replay && (!Number.isInteger(cfg.circles) || cfg.circles < 1)) throw new Error("复走圈数必须是大于 0 的整数。");
    for (let i = 0; cfg.replay && i < cfg.circles; i++) {
      const factor = cfg.speedFactors[i] ?? cfg.speedFactors.at(-1), onTenthStep = Math.abs(factor * 10 - Math.round(factor * 10)) < 1e-9;
      if (!(factor > 0 && factor <= 1 && onTenthStep)) throw new Error(`第 ${i + 1} 圈复走速度必须在 0.1–1.0 之间，并以 0.1 为步长；0 不能生成有效复走。`);
      const offset = cfg.offsetDistances[i] ?? cfg.offsetDistances.at(-1), validOffsetStep = Math.abs(offset * 10 - Math.round(offset * 10)) < 1e-9;
      if (!(offset >= 0 && offset <= .5 && validOffsetStep)) throw new Error(`第 ${i + 1} 圈外扩距离必须在 0–0.5 mm 之间，并以 0.1 mm 为步长。`);
    }
    const layer = parsed.layers.find((l) => l.number === cfg.layerNumber); if (!layer) throw new Error(`未找到第 ${cfg.layerNumber} 层。`);
    const built = replayBlock(parsed, cfg, layer);
    if (built.lines.some((line) => /^G[123]\s.*(?:^|\s)E[-+]?\d/i.test(line))) throw new Error("复走块仍包含挤出参数，已停止导出。 ");
    operations.push({ layerNumber: cfg.layerNumber, insertionIndex: layer.insertionIndex, ...built });
  }
  const output = [...parsed.lines];
  [...operations].sort((a, b) => b.insertionIndex - a.insertionIndex).forEach((o) => output.splice(o.insertionIndex, 0, ...o.lines));
  return { text: output.join(parsed.newline), operations: operations.sort((a, b) => a.layerNumber - b.layerNumber), parsed };
}

export const summarizeLayer = (layer) => ({ number: layer.number, z: layer.z, objects: Object.keys(layer.byObject).length, walls: layer.wallTracks.length, transitions: layer.objectTransitions, paused: layer.hasPause });
