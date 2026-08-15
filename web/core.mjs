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

const pointInPolygon = (point, polygon) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};
const orientation = (a, b, c) => cross(sub(b, a), sub(c, a));
const onSegment = (a, b, p, tolerance) => Math.abs(orientation(a, b, p)) <= tolerance && p.x >= Math.min(a.x, b.x) - tolerance && p.x <= Math.max(a.x, b.x) + tolerance && p.y >= Math.min(a.y, b.y) - tolerance && p.y <= Math.max(a.y, b.y) + tolerance;
const segmentsTouch = (a, b, c, d, tolerance) => {
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d), o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return onSegment(a, b, c, tolerance) || onSegment(a, b, d, tolerance) || onSegment(c, d, a, tolerance) || onSegment(c, d, b, tolerance);
};
const expandedBoundsOverlap = (a, b, tolerance) => a.minX <= b.maxX + tolerance && a.maxX + tolerance >= b.minX && a.minY <= b.maxY + tolerance && a.maxY + tolerance >= b.minY;
const polygonsTouch = (a, b, tolerance) => {
  if (!expandedBoundsOverlap(a.bounds, b.bounds, tolerance)) return false;
  for (let i = 0; i < a.points.length; i++) {
    const a1 = a.points[i], a2 = a.points[(i + 1) % a.points.length];
    for (let j = 0; j < b.points.length; j++) if (segmentsTouch(a1, a2, b.points[j], b.points[(j + 1) % b.points.length], tolerance)) return true;
  }
  return false;
};

export function analyzeLayerGeometry(layer, tolerance = .05) {
  const contours = layer.wallTracks.filter((track) => track.closed).map((track, index) => {
    const points = sampleTrack(track, .5), area = Math.abs(signedArea(points));
    return { index, track, points, area, bounds: track.bounds, objectId: track.objectId, feature: track.feature, parent: null, depth: 0, component: null };
  });
  contours.forEach((inner) => {
    const containers = contours.filter((outer) => outer !== inner && outer.area > inner.area && outer.bounds.minX <= inner.bounds.minX && outer.bounds.maxX >= inner.bounds.maxX && outer.bounds.minY <= inner.bounds.minY && outer.bounds.maxY >= inner.bounds.maxY && pointInPolygon(inner.points[0], outer.points));
    inner.parent = containers.sort((a, b) => a.area - b.area)[0]?.index ?? null;
  });
  const byIndex = new Map(contours.map((contour) => [contour.index, contour]));
  const depthOf = (contour, seen = new Set()) => contour.parent === null || seen.has(contour.index) ? 0 : 1 + depthOf(byIndex.get(contour.parent), new Set([...seen, contour.index]));
  contours.forEach((contour) => contour.depth = depthOf(contour));
  const parent = contours.map((_, index) => index), find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x])), join = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  contours.forEach((contour) => { if (contour.parent !== null) join(contour.index, contour.parent); });
  const contacts = [];
  for (let i = 0; i < contours.length; i++) for (let j = i + 1; j < contours.length; j++) {
    if (!polygonsTouch(contours[i], contours[j], tolerance)) continue;
    join(i, j); contacts.push({ a: i, b: j, crossObject: contours[i].objectId !== contours[j].objectId });
  }
  const roots = new Map();
  contours.forEach((contour) => { const root = find(contour.index); if (!roots.has(root)) roots.set(root, roots.size + 1); contour.component = roots.get(root); });
  const crossObjectRelations = [];
  contours.forEach((contour) => {
    if (contour.parent === null) return;
    const outer = byIndex.get(contour.parent);
    if (outer.objectId !== contour.objectId) crossObjectRelations.push({ type: "nested", inner: contour.index, outer: outer.index, innerObjectId: contour.objectId, outerObjectId: outer.objectId });
  });
  contacts.filter((contact) => contact.crossObject).forEach((contact) => crossObjectRelations.push({ type: "contact", a: contact.a, b: contact.b, aObjectId: contours[contact.a].objectId, bObjectId: contours[contact.b].objectId }));
  const components = [...roots.values()].map((id) => {
    const members = contours.filter((contour) => contour.component === id), objectIds = [...new Set(members.map((contour) => contour.objectId))];
    return { id, contourIndices: members.map((contour) => contour.index), objectIds, maxDepth: Math.max(0, ...members.map((contour) => contour.depth)), crossObject: objectIds.length > 1 };
  });
  return { layerNumber: layer.number, z: layer.z, contours, components, contacts, crossObjectRelations, maxDepth: Math.max(0, ...contours.map((contour) => contour.depth)) };
}

export function classifyLayerRegions(layer) {
  const analysis = analyzeLayerGeometry(layer), usable = analysis.contours.filter((contour) => contour.area > 1).sort((a, b) => b.area - a.area);
  const outer = usable[0] ?? null;
  const isInsideOuter = (contour) => {
    let current = contour, seen = new Set();
    while (current?.parent !== null && !seen.has(current.index)) {
      seen.add(current.index);
      current = analysis.contours[current.parent];
      if (current === outer) return true;
    }
    return false;
  };
  const innerBoundary = outer ? usable.filter((contour) => contour !== outer && contour.area >= outer.area * .6 && isInsideOuter(contour)).sort((a, b) => b.area - a.area)[0] ?? null : null;
  const peripheralContours = [innerBoundary, outer].filter(Boolean).sort((a, b) => a.area - b.area), peripheralSet = new Set(peripheralContours.map((contour) => contour.track));
  const peripheralWallTracks = peripheralContours.map((contour) => contour.track);
  const skeletonTracks = layer.tracks.filter((track) => !peripheralSet.has(track));
  const skeletonWallTracks = layer.wallTracks.filter((track) => track.closed && !peripheralSet.has(track));
  return { analysis, wallDetected: Boolean(outer), pairedWallDetected: Boolean(innerBoundary), peripheralWallTracks, skeletonTracks, skeletonWallTracks, innermostTrack: innerBoundary?.track ?? outer?.track ?? null, outermostTrack: outer?.track ?? null };
}

const perimeter = (points) => points.reduce((sum, point, index) => sum + dist(point, points[(index + 1) % points.length]), 0);
const boundsForPoints = (points) => points.reduce((bounds, point) => ({ minX: Math.min(bounds.minX, point.x), maxX: Math.max(bounds.maxX, point.x), minY: Math.min(bounds.minY, point.y), maxY: Math.max(bounds.maxY, point.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
const selfIntersects = (points) => {
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (Math.abs(i - j) <= 1 || (i === 0 && j === points.length - 1)) continue;
    if (segmentsTouch(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length], 1e-6)) return true;
  }
  return false;
};
const syntheticTrack = (points, source, feature) => {
  const bounds = boundsForPoints(points), commands = points.slice(1).concat(points[0]).map((point) => `G1 X${round(point.x)} Y${round(point.y)}`);
  return { ...source, feature, start: { ...points[0] }, end: { ...points[0] }, points, commands, closed: true, bounds, width: round(bounds.maxX - bounds.minX), height: round(bounds.maxY - bounds.minY), areaScore: round((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)) };
};

export function createAutoFillTrack(layer) {
  const regions = classifyLayerRegions(layer), [inner, outer] = regions.peripheralWallTracks;
  if (!regions.pairedWallDetected || !inner || !outer) return null;
  const innerPoints = sampleTrack(inner), outerPoints = sampleTrack(outer), averagePerimeter = (perimeter(innerPoints) + perimeter(outerPoints)) / 2, bandWidth = (Math.abs(signedArea(outerPoints)) - Math.abs(signedArea(innerPoints))) / averagePerimeter;
  if (!(bandWidth > .05)) return null;
  const shifted = offsetTrack(inner, bandWidth / 2), points = shifted.points ?? sampleTrack(shifted);
  if (selfIntersects(points) || points.some((point) => !pointInPolygon(point, outerPoints))) return null;
  return { ...syntheticTrack(points, inner, "Auto fill"), region: "auto-fill", generated: true, bandWidth: round(bandWidth), offsetDistance: round(bandWidth / 2) };
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
    for (let j = i; j >= Math.max(0, i - 20); j--) if (/^;\s*CHANGE_LAYER/i.test(lines[j])) { start = j; break; }
    for (let j = start; j <= Math.min(lines.length - 1, i + 4); j++) {
      const zMatch = lines[j].match(/;\s*Z_HEIGHT:\s*([\d.]+)/i);
      if (zMatch) z = Number(zMatch[1]);
    }
    marks.push({ number: Number(m[1]), total: Number(m[2]), start, marker: i, z });
  });
  if (!marks.length) {
    const starts = lines.flatMap((line, index) => /^;\s*CHANGE_LAYER\s*$/i.test(line) ? [index] : []);
    starts.forEach((start, index) => {
      const end = starts[index + 1] ?? lines.length;
      let z;
      for (let j = start + 1; j < Math.min(end, start + 20); j++) {
        const zMatch = lines[j].match(/;\s*Z_HEIGHT:\s*([-+]?\d+(?:\.\d+)?)/i);
        if (zMatch) { z = Number(zMatch[1]); break; }
      }
      marks.push({ number: index + 1, total: total || starts.length, start, marker: start, z });
    });
  }
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
    Object.values(byObject).forEach((xs) => xs.sort((a, b) => a.areaScore - b.areaScore));
    const sequence = []; tracks.forEach((t) => { if (sequence.at(-1) !== t.objectId) sequence.push(t.objectId); });
    const pauseOffset = lines.slice(layer.start, layer.end).findIndex((line) => /^\s*M400\s+U1(?:\s|;|$)/i.test(line)), pauseIndex = pauseOffset < 0 ? null : layer.start + pauseOffset;
    const insertionIndex = pauseIndex === null ? insertionFor(lines, layer) : pauseIndex + 1;
    return { ...layer, z: layer.z ?? states[insertionIndex]?.z, tracks, wallTracks: usable, byObject, objectSequence: sequence, objectTransitions: Math.max(0, sequence.length - 1), pauseIndex, insertionIndex, insertionState: states[insertionIndex], hasPause: pauseIndex !== null };
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
  const ids = new Set(objectIds.length ? objectIds : Object.keys(sourceLayer.byObject)), classified = classifyLayerRegions(sourceLayer);
  const candidates = classified.peripheralWallTracks.filter((track) => track.closed && ids.has(track.objectId));
  const tracks = candidates.map((track, innerIndex) => ({ ...track, region: "peripheral-wall", regionIndex: innerIndex, regionLoopCount: candidates.length, innerIndex, loopCount: candidates.length, isOutermost: innerIndex === candidates.length - 1 }));
  return { sourceLayer, tracks, regions: classified, autoFillTrack: createAutoFillTrack(sourceLayer) };
}

const coord = (n) => Number(n).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
function replayBlock(parsed, cfg, pauseLayer) {
  const { sourceLayer, tracks, autoFillTrack } = getReplayCandidates(parsed, cfg.layerNumber, cfg.objectIds ?? []), selected = tracks.slice(0, cfg.circles), fillTrack = cfg.autoFill ? autoFillTrack : null;
  if (!sourceLayer) throw new Error(`第 ${cfg.layerNumber} 层没有可用的下方层。`);
  if (cfg.replay && selected.length < cfg.circles) throw new Error(`第 ${sourceLayer.number} 层只识别到 ${selected.length} 条外围墙体轨迹，少于要求的 ${cfg.circles} 圈。`);
  if (cfg.autoFill && !fillTrack) throw new Error(`第 ${sourceLayer.number} 层无法生成安全的自动填缝路径。`);
  const s = pauseLayer.insertionState ?? {}, safeZ = Math.min(parsed.printableHeight || 256, cfg.safeZ ?? 256), replayZ = round((sourceLayer.z ?? 0) + (cfg.clearance ?? .01)), liftZ = Math.min(safeZ, replayZ + (cfg.betweenLift ?? 10));
  const out = [`; HEATSEAL_POSTPROCESS_START layer=${cfg.layerNumber}`, "; Uses existing Bambu Studio pause above; no new pause inserted"];
  if (cfg.replay) {
    const passes = selected.flatMap((track, trackIndex) => Array.from({ length: track.isOutermost ? cfg.outerRepeat : 1 }, (_, passIndex) => ({ track, trackIndex, passIndex, repeatCount: track.isOutermost ? cfg.outerRepeat : 1, autoFill: false })));
    if (fillTrack) passes.push({ track: fillTrack, trackIndex: 0, passIndex: 0, repeatCount: 1, autoFill: true });
    out.push(`; Dry replay layer ${sourceLayer.number} at Z${coord(replayZ)}; ${selected.length} unique loop(s), ${passes.length} heat-seal pass(es); no extrusion`, "G90", "M83", "M204 S10000", `G1 Z${coord(safeZ)} F1200`, `M400 S${cfg.waitBefore ?? 30}`);
    passes.forEach(({ track: t, trackIndex: i, passIndex, repeatCount, autoFill }, executionIndex) => {
      const factor = autoFill ? Math.min(...cfg.speedFactors) : cfg.speedFactors[i] ?? cfg.speedFactors.at(-1), offset = autoFill ? 0 : cfg.offsetDistances[i] ?? cfg.offsetDistances.at(-1), shifted = autoFill ? t : offsetTrack(t, offset), label = autoFill ? "Auto fill" : `Replay loop ${i + 1}/${selected.length}`;
      out.push(`; ${label}; region ${t.region}; pass ${passIndex + 1}/${repeatCount}; factor ${factor}; outward offset ${coord(offset)}mm`, `G1 X${coord(shifted.start.x)} Y${coord(shifted.start.y)} F42000`, `G1 Z${coord(replayZ)} F1200`, `G1 F${coord(Math.max(1, t.originalFeed * factor))}`, "M204 S800", ...shifted.commands);
      if (executionIndex < passes.length - 1) out.push("M204 S10000", `G1 Z${coord(liftZ)} F1200`);
    });
    out.push("M204 S10000", `G1 Z${coord(safeZ)} F1200`, `M400 S${cfg.waitAfter ?? 10}`, "; Restore pause state");
    if (s.x !== undefined && s.y !== undefined) out.push(`G1 X${coord(s.x)} Y${coord(s.y)} F42000`);
    if (s.z !== undefined) out.push(`G1 Z${coord(s.z)} F1200`);
    out.push(s.axesAbsolute === false ? "G91" : "G90", s.extrusionRelative === false ? "M82" : "M83");
  }
  out.push(`; HEATSEAL_POSTPROCESS_END layer=${cfg.layerNumber}`);
  return { lines: out, selected, sourceLayer, replayZ, safeZ, autoFillTrack: fillTrack, passCount: selected.reduce((sum, track) => sum + (track.isOutermost ? cfg.outerRepeat : 1), 0) + (fillTrack ? 1 : 0) };
}

const convexHull = (points) => {
  const unique = [...new Map(points.map((point) => [`${round(point.x, 4)},${round(point.y, 4)}`, point])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (unique.length < 3) return unique;
  const build = (list) => { const hull = []; for (const point of list) { while (hull.length >= 2 && cross(sub(hull.at(-1), hull.at(-2)), sub(point, hull.at(-1))) <= 0) hull.pop(); hull.push(point); } return hull; };
  return build(unique).slice(0, -1).concat(build([...unique].reverse()).slice(0, -1));
};

export function createFinalCutPreview(parsed, options = {}) {
  const sourceTracks = parsed.layers.map((layer) => classifyLayerRegions(layer).outermostTrack).filter(Boolean), skeletonLayers = parsed.layers.filter((layer) => classifyLayerRegions(layer).skeletonWallTracks.length);
  if (!sourceTracks.length) throw new Error("没有识别到可用于最终切膜的外围墙体。");
  const ranked = sourceTracks.map((track) => ({ track, points: sampleTrack(track) })).sort((a, b) => Math.abs(signedArea(b.points)) - Math.abs(signedArea(a.points))), chosen = ranked[0];
  const containsAll = ranked.every(({ points }) => points.every((point) => pointInPolygon(point, chosen.points) || chosen.points.some((candidate) => dist(candidate, point) < .05))), envelopePoints = containsAll ? chosen.points : convexHull(ranked.flatMap((item) => item.points));
  const envelope = syntheticTrack(envelopePoints, chosen.track, "Peripheral envelope"), offset = Number(options.offset ?? 1), shifted = offsetTrack(envelope, offset), cutTrack = syntheticTrack(shifted.points, envelope, "Final film cut");
  if (selfIntersects(cutTrack.points)) throw new Error("最终切膜外扩路径发生自交，无法安全生成。");
  const skeletonMaxZ = Math.max(0, ...skeletonLayers.map((layer) => Number(layer.z) || 0)), drop = Number(options.drop ?? 0), targetZ = round(skeletonMaxZ - drop);
  if (targetZ < 0) throw new Error("最终切膜目标 Z 低于打印平台，请减小向下距离。");
  return { envelope, track: cutTrack, cutTrack, skeletonMaxZ: round(skeletonMaxZ), targetZ, offset };
}

const finalCutInsertionIndex = (parsed) => {
  let lastExtrusion = -1;
  parsed.lines.forEach((line, index) => { if (/^G[123](?:\s|$)/i.test(line.trim()) && (val(line, "E") ?? 0) > 0) lastExtrusion = index; });
  if (lastExtrusion < 0) throw new Error("未找到最后一条模型挤出路径，无法定位最终切膜位置。");
  const shutdown = parsed.lines.findIndex((line, index) => index > lastExtrusion && (/^M10[49]\s+S0(?:\s|;|$)/i.test(line.trim()) || /^M140\s+S0(?:\s|;|$)/i.test(line.trim()) || /^M84(?:\s|;|$)/i.test(line.trim())));
  if (shutdown < 0) throw new Error("未找到打印结束前的安全插入点，无法添加最终切膜走线。");
  return shutdown;
};

function finalCutBlock(parsed, options) {
  const preview = createFinalCutPreview(parsed, options), insertionIndex = finalCutInsertionIndex(parsed), factor = Number(options.speedFactor ?? .1), repeats = Number(options.repeats ?? 1), current = parsed.states[insertionIndex] ?? {}, maxZ = Math.max(0, ...parsed.layers.map((layer) => Number(layer.z) || 0)), safeZ = round(Math.min(parsed.printableHeight || 256, Math.max(maxZ, preview.skeletonMaxZ) + 10)), feed = Math.max(1, preview.envelope.originalFeed * factor), lines = ["; HEATSEAL_FINAL_CUT_START", `; Full-model peripheral envelope; outward offset ${coord(preview.offset)}mm; target Z${coord(preview.targetZ)}; ${repeats} pass(es); no extrusion`, "M400", "G90", "M83", "M204 S10000", `G1 Z${coord(safeZ)} F1200`];
  for (let pass = 0; pass < repeats; pass++) {
    lines.push(`G1 X${coord(preview.track.start.x)} Y${coord(preview.track.start.y)} F42000`, `G1 Z${coord(preview.targetZ)} F1200`, `G1 F${coord(feed)}`, "M204 S800", `; Final film cut pass ${pass + 1}/${repeats}`, ...preview.track.commands, "M204 S10000", `G1 Z${coord(safeZ)} F1200`);
  }
  lines.push("M400", current.axesAbsolute === false ? "G91" : "G90", current.extrusionRelative === false ? "M82" : "M83", "; HEATSEAL_FINAL_CUT_END");
  return { ...preview, lines, insertionIndex, repeats, speedFactor: factor, safeZ };
}

export function generateGcode(text, configs, finalCut = {}) {
  const parsed = parseGcode(text), seen = new Set(), operations = [];
  if (!configs.length && !finalCut.enabled) throw new Error("请至少添加一个暂停层或开启最终切膜走线。 ");
  for (const raw of configs) {
    const speedFactors = Array.isArray(raw.speedFactors) && raw.speedFactors.length ? raw.speedFactors.map(Number) : [Number(raw.speedFactor ?? .1)];
    const offsetDistances = Array.isArray(raw.offsetDistances) && raw.offsetDistances.length ? raw.offsetDistances.map(Number) : [Number(raw.offsetDistance ?? 0)];
    const cfg = { ...raw, replay: raw.replay !== false, layerNumber: Number(raw.layerNumber), circles: Number(raw.circles), outerRepeat: Number(raw.outerRepeat ?? 1), autoFill: Boolean(raw.autoFill), speedFactors, offsetDistances };
    if (!Number.isInteger(cfg.layerNumber) || cfg.layerNumber < 2 || cfg.layerNumber > parsed.totalLayers) throw new Error(`暂停层 ${raw.layerNumber} 无效；可选范围为 2–${parsed.totalLayers}。`);
    if (seen.has(cfg.layerNumber)) throw new Error(`第 ${cfg.layerNumber} 层配置了重复暂停。`); seen.add(cfg.layerNumber);
    if (!Number.isInteger(cfg.outerRepeat) || cfg.outerRepeat < 1 || cfg.outerRepeat > 3) throw new Error("最外圈热封遍数只能选择 1、2 或 3。");
    if (cfg.replay && (!Number.isInteger(cfg.circles) || cfg.circles < 1)) throw new Error("复走圈数必须是大于 0 的整数。");
    for (let i = 0; cfg.replay && i < cfg.circles; i++) {
      const factor = cfg.speedFactors[i] ?? cfg.speedFactors.at(-1), onTenthStep = Math.abs(factor * 10 - Math.round(factor * 10)) < 1e-9;
      if (!(factor > 0 && factor <= 1 && onTenthStep)) throw new Error(`第 ${i + 1} 圈复走速度必须在 0.1–1.0 之间，并以 0.1 为步长；0 不能生成有效复走。`);
      const offset = cfg.offsetDistances[i] ?? cfg.offsetDistances.at(-1), validOffsetStep = Math.abs(offset * 10 - Math.round(offset * 10)) < 1e-9;
      if (!(offset >= 0 && offset <= .5 && validOffsetStep)) throw new Error(`第 ${i + 1} 圈外扩距离必须在 0–0.5 mm 之间，并以 0.1 mm 为步长。`);
    }
    const layer = parsed.layers.find((l) => l.number === cfg.layerNumber); if (!layer) throw new Error(`未找到第 ${cfg.layerNumber} 层。`);
    if (!layer.hasPause) throw new Error(`第 ${cfg.layerNumber} 层不是 Bambu Studio 已有暂停层，不能添加热封操作。`);
    const built = replayBlock(parsed, cfg, layer);
    if (built.lines.some((line) => /^G[123]\s.*(?:^|\s)E[-+]?\d/i.test(line))) throw new Error("复走块仍包含挤出参数，已停止导出。 ");
    operations.push({ layerNumber: cfg.layerNumber, insertionIndex: layer.insertionIndex, ...built });
  }
  let cutOperation = null;
  if (finalCut.enabled) {
    const offset = Number(finalCut.offset), drop = Number(finalCut.drop), speedFactor = Number(finalCut.speedFactor), repeats = Number(finalCut.repeats), tenth = (value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-9;
    if (!(offset >= 1 && offset <= 5 && tenth(offset))) throw new Error("最终切膜外扩距离必须在 1.0–5.0 mm 之间，并以 0.1 mm 为步长。");
    if (!(drop >= 0 && drop <= 5 && tenth(drop))) throw new Error("最终切膜向下距离必须在 0–5.0 mm 之间，并以 0.1 mm 为步长。");
    if (!(speedFactor >= .1 && speedFactor <= 1 && tenth(speedFactor))) throw new Error("最终切膜速度必须在 0.1–1.0 之间，并以 0.1 为步长。");
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("最终切膜遍数只能选择 1–5。");
    cutOperation = finalCutBlock(parsed, { offset, drop, speedFactor, repeats });
    if (cutOperation.lines.some((line) => /^G[123]\s.*(?:^|\s)E[-+]?\d/i.test(line))) throw new Error("最终切膜块仍包含挤出参数，已停止导出。");
  }
  const output = [...parsed.lines];
  [...operations, ...(cutOperation ? [cutOperation] : [])].sort((a, b) => b.insertionIndex - a.insertionIndex).forEach((o) => output.splice(o.insertionIndex, 0, ...o.lines));
  return { text: output.join(parsed.newline), operations: operations.sort((a, b) => a.layerNumber - b.layerNumber), finalCut: cutOperation, parsed };
}

export const summarizeLayer = (layer) => ({ number: layer.number, z: layer.z, objects: Object.keys(layer.byObject).length, walls: layer.wallTracks.length, transitions: layer.objectTransitions, paused: layer.hasPause });
