import { createFinalCutPreview, generateGcode, getReplayCandidates, md5Text, parseGcode, sampleTrack, summarizeLayer } from "./core.mjs";

const $ = (query) => document.querySelector(query);
const notice = $("#notice"), configs = $("#config-list"), fileInput = $("#file-input"), drop = $("#dropzone");
const state = {
  file: null, gcode: "", path: "", parsed: null, configs: [],
  finalCut: { enabled: false, offset: 1, drop: 0, speedFactor: .1, repeats: 1 }
};
const colors = ["#ef6a3a", "#176b51", "#b98b2f", "#445e97", "#8c4fa8", "#208aa0"];
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(resolve));
const msg = (text, kind = "info") => { notice.textContent = text; notice.className = `notice is-${kind}`; notice.hidden = false; };
const hideMsg = () => notice.hidden = true;
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const mmPerSecond = (feed) => Number(feed || 0) / 60;
const lineName = (track) => `第${track.lineIndex + 1}条线`;

function pointsFor(track) {
  if (track.points?.length) return track.closed ? track.points.concat(track.points[0]) : track.points;
  try {
    const points = sampleTrack(track, .12);
    return track.closed ? points.concat(points[0]) : points;
  } catch {
    const points = [{ ...track.start }], current = { ...track.start };
    track.commands.forEach((command) => {
      const x = command.match(/(?:^|\s)X([-+.\d]+)/i)?.[1], y = command.match(/(?:^|\s)Y([-+.\d]+)/i)?.[1];
      if (x !== undefined) current.x = Number(x);
      if (y !== undefined) current.y = Number(y);
      if (x !== undefined || y !== undefined) points.push({ ...current });
    });
    if (track.closed && points.length > 1) points.push({ ...points[0] });
    return points;
  }
}

const pathLength = (track) => {
  const points = pointsFor(track);
  return points.slice(1).reduce((sum, point, index) => {
    const previous = points[index];
    return sum + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0);
};

function candidatesFor(cfg) {
  return getReplayCandidates(state.parsed, Number(cfg.layerNumber));
}

function ensureConfig(cfg, tracks) {
  cfg.trackSettings ??= {};
  cfg.selectedTrackIds ??= [];
  cfg.selectedTrackIds = cfg.selectedTrackIds.filter((id) => tracks.some((track) => track.trackId === id));
  tracks.forEach((track) => cfg.trackSettings[track.trackId] ??= { speedFactor: .1, repeats: 1 });
  if (!tracks.some((track) => track.trackId === cfg.activeTrackId)) cfg.activeTrackId = cfg.selectedTrackIds[0] ?? tracks[0]?.trackId ?? null;
}

function newConfig(layerNumber) {
  const tracks = getReplayCandidates(state.parsed, layerNumber).tracks;
  return {
    id: crypto.randomUUID(), layerNumber, selectedTrackIds: [], activeTrackId: tracks[0]?.trackId ?? null,
    trackSettings: Object.fromEntries(tracks.map((track) => [track.trackId, { speedFactor: .1, repeats: 1 }])), pressDepth: .1,
    safeZ: Math.min(256, state.parsed.printableHeight || 256), waitBefore: 30, waitAfter: 10, betweenLift: 10
  };
}

function layerRows() {
  let previousZ = 0;
  return state.parsed.layers.map((layer) => {
    const row = summarizeLayer(layer), z = Number(row.z ?? previousZ), thickness = Math.max(0, z - previousZ);
    previousZ = z;
    return { ...row, thickness };
  });
}

function renderTimeline() {
  const rows = layerRows(), max = Math.max(.01, ...rows.map((row) => row.thickness));
  $("#timeline").innerHTML = [...rows].reverse().map((row) => {
    const width = Math.max(3, row.thickness / max * 100), thickness = row.thickness.toFixed(2);
    const title = row.paused ? "可选择：Bambu 已在此层暂停" : "不可选择：此层没有 Bambu 暂停";
    return `<button class="layer-tick ${row.paused ? "has-pause" : ""}" data-layer="${row.number}" ${row.paused ? "" : "disabled"} title="${title} · 第${row.number}层 · 层厚 ${thickness} mm"><span class="layer-position"><b>第${row.number}层</b></span><span class="wall-bar"><i style="width:${width}%">${row.paused ? "<em>暂停</em>" : ""}</i></span><strong>${thickness} mm</strong></button>`;
  }).join("");
}

function drawPaths(canvas, paths, emptyText = "没有可显示的轨迹") {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1, ctx = canvas.getContext("2d");
  canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); ctx.scale(dpr, dpr);
  const valid = paths.filter((path) => path.points?.length > 1);
  canvas._hitPaths = [];
  if (!valid.length) { ctx.fillStyle = "#8c938e"; ctx.font = "13px sans-serif"; ctx.fillText(emptyText, 18, 30); return; }
  const all = valid.flatMap((path) => path.points), bounds = all.reduce((b, point) => ({ minX: Math.min(b.minX, point.x), maxX: Math.max(b.maxX, point.x), minY: Math.min(b.minY, point.y), maxY: Math.max(b.maxY, point.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const pad = 24, width = Math.max(1, bounds.maxX - bounds.minX), height = Math.max(1, bounds.maxY - bounds.minY), scale = Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height), offsetX = (rect.width - width * scale) / 2, offsetY = (rect.height - height * scale) / 2;
  const project = (point) => ({ x: offsetX + (point.x - bounds.minX) * scale, y: rect.height - offsetY - (point.y - bounds.minY) * scale });
  canvas._hitPaths = valid.map((path) => {
    const points = path.points.map(project), xs = points.map((point) => point.x), ys = points.map((point) => point.y);
    return { trackId: path.trackId, points, bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) } };
  }).filter((path) => path.trackId);
  [...valid].sort((a, b) => Number(Boolean(a.active)) - Number(Boolean(b.active))).forEach((path) => {
    const projected = path.points.map(project), first = projected[0]; ctx.beginPath(); ctx.moveTo(first.x, first.y);
    projected.slice(1).forEach((next) => ctx.lineTo(next.x, next.y));
    ctx.strokeStyle = path.color; ctx.lineWidth = path.width ?? 1.5; ctx.setLineDash(path.dash ?? []); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  });
  ctx.setLineDash([]);
}

const pointSegmentDistance = (point, start, end) => {
  const dx = end.x - start.x, dy = end.y - start.y, lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
};

function hitTrack(canvas, event, threshold = 10) {
  const rect = canvas.getBoundingClientRect(), point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  let nearest = null, nearestDistance = Infinity;
  for (const path of canvas._hitPaths ?? []) {
    const { bounds } = path;
    if (point.x < bounds.minX - threshold || point.x > bounds.maxX + threshold || point.y < bounds.minY - threshold || point.y > bounds.maxY + threshold) continue;
    for (let index = 1; index < path.points.length; index++) {
      const distance = pointSegmentDistance(point, path.points[index - 1], path.points[index]);
      if (distance < nearestDistance) { nearest = path.trackId; nearestDistance = distance; }
    }
  }
  return nearestDistance <= threshold ? nearest : null;
}

function wireCanvasSelection(canvas, cfg) {
  canvas.onclick = (event) => {
    const trackId = hitTrack(canvas, event);
    if (!trackId) return;
    cfg.activeTrackId = trackId;
    renderConfigs();
  };
  canvas.onmousemove = (event) => {
    const trackId = hitTrack(canvas, event);
    canvas.style.cursor = trackId ? "pointer" : "crosshair";
    canvas.title = trackId ? `点击选择${lineName(candidatesFor(cfg).tracks.find((track) => track.trackId === trackId))}` : "点击轨迹可选择对应打印线";
  };
  canvas.onmouseleave = () => { canvas.style.cursor = "crosshair"; canvas.title = "点击轨迹可选择对应打印线"; };
}

function drawConfig(cfg) {
  requestAnimationFrame(() => {
    const canvas = document.querySelector(`[data-canvas="${cfg.id}"]`), { tracks } = candidatesFor(cfg), selected = new Set(cfg.selectedTrackIds);
    const paths = tracks.map((track, index) => {
      const active = track.trackId === cfg.activeTrackId, enabled = selected.has(track.trackId);
      return { trackId: track.trackId, points: pointsFor(track), color: active || enabled ? colors[index % colors.length] : "rgba(111,120,114,.28)", width: active ? 3.6 : enabled ? 1.9 : 1.1, dash: active || enabled ? [] : [4, 5], active };
    });
    drawPaths(canvas, paths, "该暂停点下方一层没有连续挤出打印线");
    wireCanvasSelection(canvas, cfg);
  });
}

const speedScale = (factor) => Array.from({ length: 10 }, (_, index) => {
  const value = (index + 1) / 10;
  return `<span class="${Math.abs(value - factor) < .001 ? "is-current" : ""}">${value.toFixed(1)}</span>`;
}).join("");

function lineList(cfg, tracks) {
  const selected = new Set(cfg.selectedTrackIds);
  return tracks.map((track, index) => {
    const enabled = selected.has(track.trackId), active = track.trackId === cfg.activeTrackId;
    return `<div class="track-row ${active ? "is-active" : ""} ${enabled ? "" : "is-muted"}"><label class="track-check" title="${enabled ? "取消热封" : "加入热封"}"><input type="checkbox" data-field="trackEnabled" data-track-id="${track.trackId}" ${enabled ? "checked" : ""}><span aria-hidden="true"></span></label><button type="button" data-action="selectTrack" data-track-id="${track.trackId}"><i style="background:${colors[index % colors.length]}"></i><span><b>${lineName(track)}</b><small>${track.closed ? "闭合" : "开放"} · ${pathLength(track).toFixed(1)} mm · ${mmPerSecond(track.originalFeed).toFixed(1)} mm/s</small></span></button></div>`;
  }).join("");
}

function settingsPanel(cfg, active, enabled) {
  if (!active) return `<div class="settings-empty"><b>没有连续挤出打印线</b><p>请选择其他暂停层，或检查下方一层是否包含挤出走线。</p></div>`;
  const settings = cfg.trackSettings[active.trackId] ??= { speedFactor: .1, repeats: 1 };
  const factor = Number(settings.speedFactor ?? .1), repeats = Number(settings.repeats ?? 1), sourceSpeed = mmPerSecond(active.originalFeed), outputSpeed = sourceSpeed * factor;
  if (!enabled) return `<div class="line-settings" data-track-settings="${active.trackId}"><div class="settings-title"><span>当前查看</span><h4>${lineName(active)}</h4><p>${active.closed ? "闭合轨迹" : "开放轨迹"} · ${pathLength(active).toFixed(1)} mm</p></div><div class="settings-note"><b>这条线尚未加入热封</b><p>先在中间勾选，或点击下方按钮，再调整速度与遍数。</p></div><button class="secondary-button add-line-button" type="button" data-action="enableActive" data-track-id="${active.trackId}">加入热封并调整</button></div>`;
  return `<div class="line-settings" data-track-settings="${active.trackId}"><div class="settings-title"><span>当前调整</span><h4>${lineName(active)}</h4><p>已加入热封 · ${active.closed ? "闭合轨迹" : "开放轨迹"} · ${pathLength(active).toFixed(1)} mm</p></div><div class="field-label speed-label"><span>热封速度</span><output>${factor.toFixed(1)} × · ${Math.round(factor * 100)}%</output></div><div class="speed-control"><input class="speed-slider" type="range" min="0.1" max="1" step="0.1" value="${factor}" data-field="lineSpeedFactor" data-track-id="${active.trackId}"><div class="speed-scale">${speedScale(factor)}</div><p class="speed-note">原路径 ${sourceSpeed.toFixed(1)} mm/s，热封 ${outputSpeed.toFixed(1)} mm/s</p></div><div class="field-label repeat-label">热封遍数</div><div class="segmented three line-repeat">${[1, 2, 3].map((value) => `<label><input type="radio" name="line-repeat-${cfg.id}-${active.lineIndex}" data-field="lineRepeats" data-track-id="${active.trackId}" value="${value}" ${repeats === value ? "checked" : ""}><span>${value}遍</span></label>`).join("")}</div></div>`;
}

function pressDepthControl(cfg, sourceLayer) {
  const depth = Number(cfg.pressDepth ?? .1), sourceZ = Number(sourceLayer?.z), targetZ = Number.isFinite(sourceZ) ? sourceZ - depth : NaN;
  return `<div class="press-depth-control"><div class="field-label speed-label"><span>本层热封下压深度</span><output>${depth.toFixed(2)} mm</output></div><input class="press-depth-slider" type="range" min="0.10" max="0.50" step="0.01" value="${depth.toFixed(2)}" data-field="pressDepth" aria-label="第${cfg.layerNumber}层热封下压深度"><div class="press-depth-scale"><span>0.10</span><span>0.30</span><span>0.50 mm</span></div><div class="press-depth-summary"><span>下层表面 <b>${Number.isFinite(sourceZ) ? `Z${sourceZ.toFixed(2)}` : "—"}</b></span><span>热封目标 <b data-press-target>${Number.isFinite(targetZ) ? `Z${targetZ.toFixed(2)}` : "—"}</b></span></div><p class="press-warning">喷嘴将低于下层表面 ${depth.toFixed(2)} mm。数值越大，下压力越高，请确认平台与喷嘴安全。</p></div>`;
}

function captureConfigView() {
  const viewport = { x: window.scrollX, y: window.scrollY };
  configs.querySelectorAll("[data-config]").forEach((card) => {
    const cfg = state.configs.find((item) => item.id === card.dataset.config), trackList = card.querySelector(".track-list");
    if (cfg && trackList) cfg.trackListScrollTop = trackList.scrollTop;
  });
  return viewport;
}

function restoreConfigView(viewport) {
  const restore = () => {
    state.configs.forEach((cfg) => {
      const trackList = configs.querySelector(`[data-config="${cfg.id}"] .track-list`);
      if (trackList) trackList.scrollTop = cfg.trackListScrollTop ?? 0;
    });
    window.scrollTo(viewport.x, viewport.y);
  };
  restore();
  requestAnimationFrame(restore);
}

function renderConfigs(preserveView = true) {
  const viewport = preserveView ? captureConfigView() : null;
  configs.innerHTML = state.configs.map((cfg, order) => {
    const { sourceLayer, tracks } = candidatesFor(cfg); ensureConfig(cfg, tracks);
    cfg.pressDepth = Number(cfg.pressDepth ?? .1);
    const selected = tracks.filter((track) => cfg.selectedTrackIds.includes(track.trackId)), active = tracks.find((track) => track.trackId === cfg.activeTrackId), activeEnabled = Boolean(active && cfg.selectedTrackIds.includes(active.trackId));
    const passCount = selected.reduce((sum, track) => sum + Number(cfg.trackSettings[track.trackId]?.repeats ?? 1), 0);
    const legend = tracks.map((track, index) => `<button type="button" data-action="selectTrack" data-track-id="${track.trackId}" class="${track.trackId === cfg.activeTrackId ? "is-active" : ""} ${cfg.selectedTrackIds.includes(track.trackId) ? "" : "is-muted"}" title="选择${lineName(track)}"><i class="preview-color" style="background:${colors[index % colors.length]}"></i>${lineName(track)}</button>`).join("");
    const heatSealZ = sourceLayer?.z !== undefined ? Number(sourceLayer.z) - cfg.pressDepth : NaN;
    return `<article class="config-card pause-dashboard" data-config="${cfg.id}"><header><div class="step-number">${String(order + 1).padStart(2, "0")}</div><div><h3>第${cfg.layerNumber}层暂停点热封</h3><p>读取第 ${sourceLayer?.number ?? "—"} 层的全部连续挤出打印线</p></div><button class="icon-button" data-action="remove" aria-label="移除热封操作">×</button></header><div class="dashboard-grid"><section class="dashboard-preview"><div class="preview-head"><span>轨迹预览 · 可直接点线</span><b>${selected.length}条 · ${passCount}次走线</b></div><canvas data-canvas="${cfg.id}" aria-label="第${sourceLayer?.number ?? "—"}层打印线预览，点击轨迹可选择"></canvas><div class="preview-legend">${legend}</div><div class="path-stats"><span>热封 Z <b data-heat-seal-z>${Number.isFinite(heatSealZ) ? heatSealZ.toFixed(2) : "—"}</b></span><span>当前线 <b>${active ? lineName(active) : "—"}</b></span></div></section><section class="dashboard-lines"><div class="column-head"><span>选择热封线</span><b>${selected.length}/${tracks.length}条已选</b></div><p class="column-note">按 G-code 中的出现顺序编号；先勾选要热封的线，再调整当前线参数。</p><div class="track-list">${lineList(cfg, tracks) || "<p class='speed-note is-error'>下方一层没有连续挤出打印线。</p>"}</div></section><section class="dashboard-settings">${pressDepthControl(cfg, sourceLayer)}${settingsPanel(cfg, active, activeEnabled)}</section></div><details><summary>固定工艺参数</summary><div class="fixed-grid"><span>安全位 Z${cfg.safeZ}</span><span>热封前等待 ${cfg.waitBefore}s</span><span>线间抬高 ${cfg.betweenLift}mm</span><span>热封后等待 ${cfg.waitAfter}s</span><span data-press-chip>下压 ${cfg.pressDepth.toFixed(2)}mm</span></div></details></article>`;
  }).join("");
  const hasSelectedLine = state.configs.some((cfg) => cfg.selectedTrackIds?.length);
  $("#export-file").disabled = !hasSelectedLine && !state.finalCut.enabled;
  state.configs.forEach(drawConfig);
  if (viewport) restoreConfigView(viewport);
}

const repeatOptions = (current) => Array.from({ length: 5 }, (_, index) => {
  const value = index + 1;
  return `<label class="offset-option"><input type="radio" name="final-cut-repeats" value="${value}" data-final-field="repeats" ${value === current ? "checked" : ""}><span>${value}<small>遍</small></span></label>`;
}).join("");

const modelMaxZ = () => Math.max(0, ...state.parsed.layers.filter((layer) => layer.tracks.length).map((layer) => Number(layer.z || 0)));

function drawFinalCut() {
  requestAnimationFrame(() => {
    const canvas = $("#final-cut-canvas"); if (!canvas || !state.finalCut.enabled) return;
    try {
      const preview = createFinalCutPreview(state.parsed, state.finalCut);
      drawPaths(canvas, [
        { points: pointsFor(preview.envelope), color: "rgba(24,35,30,.28)", width: 1, dash: [4, 4] },
        { points: pointsFor(preview.cutTrack), color: "#8c4fa8", width: 2.4 }
      ]);
    } catch (error) { drawPaths(canvas, [], error.message); }
  });
}

function renderFinalCut() {
  const highestZ = modelMaxZ(), maxDrop = Math.min(5, Math.floor(highestZ * 10) / 10); state.finalCut.drop = Math.min(state.finalCut.drop, maxDrop);
  const targetZ = Math.max(0, highestZ - state.finalCut.drop);
  $("#final-cut-config").innerHTML = `<div class="final-cut-head"><div><p class="eyebrow">打印结束后 · 单次执行</p><h2>最终切膜走线</h2><p>从每层面积最大的闭合线生成全模型包络，在原始结束代码关闭加热之前执行。</p></div><label class="master-switch"><input type="checkbox" data-final-field="enabled" ${state.finalCut.enabled ? "checked" : ""}><span>${state.finalCut.enabled ? "已开启" : "未开启"}</span></label></div><div class="final-cut-body ${state.finalCut.enabled ? "" : "is-disabled"}"><div class="final-cut-controls"><label class="final-range"><span>闭合线包络外扩 <output>${state.finalCut.offset.toFixed(1)} mm</output></span><input type="range" min="1" max="5" step="0.1" value="${state.finalCut.offset}" data-final-field="offset"><div class="final-range-scale"><span>1.0</span><span>2.0</span><span>3.0</span><span>4.0</span><span>5.0</span></div></label><label class="final-range"><span>从模型最高点向下 <output>${state.finalCut.drop.toFixed(1)} mm</output></span><input type="range" min="0" max="${maxDrop}" step="0.1" value="${state.finalCut.drop}" data-final-field="drop"><div class="final-range-scale"><span>0.0</span><span>${maxDrop.toFixed(1)}</span></div></label><div class="final-repeat-control"><span class="field-label">切膜遍数</span><div class="offset-options final-repeat-options">${repeatOptions(state.finalCut.repeats)}</div></div><label class="final-range final-speed"><span>切膜速度 <output>${state.finalCut.speedFactor.toFixed(1)} ×</output></span><input type="range" min="0.1" max="1" step="0.1" value="${state.finalCut.speedFactor}" data-final-field="speedFactor"><div class="final-range-scale"><span>0.1</span><span>0.5</span><span>1.0</span></div></label><div class="final-cut-summary"><span>模型最高点 <b>Z${highestZ.toFixed(2)}</b></span><span>切膜高度 <b id="final-cut-target-z">Z${targetZ.toFixed(2)}</b></span></div></div><div class="final-cut-preview"><canvas id="final-cut-canvas"></canvas><div class="preview-legend"><span><i class="preview-color original-fill"></i>原始闭合线包络</span><span><i class="preview-color fill-color"></i>最终切膜走线</span></div></div></div>`;
  const hasSelectedLine = state.configs.some((cfg) => cfg.selectedTrackIds?.length);
  $("#export-file").disabled = !hasSelectedLine && !state.finalCut.enabled;
  drawFinalCut();
}

function render() {
  const pauseCount = state.parsed.layers.filter((layer) => layer.hasPause).length;
  $("#file-name").textContent = state.file.name; $("#file-size").textContent = bytes(state.file.size); $("#total-layers").textContent = state.parsed.totalLayers; $("#max-z").textContent = state.parsed.layers.at(-1)?.z ?? "—"; $("#nozzle-temp").textContent = state.parsed.nozzleTemperature ? `${state.parsed.nozzleTemperature}°C` : "—"; $("#pause-count").textContent = `${pauseCount} 个暂停层`;
  if (state.parsed.preprocessed) msg("检测到文件已包含后处理代码。请使用 Bambu Studio 原始切片文件，避免重复插入。", "warning");
  renderTimeline(); renderConfigs(); renderFinalCut();
}

async function load(file) {
  hideMsg(); if (!/\.3mf$/i.test(file.name)) return msg("请选择 Bambu Studio 导出的 .gcode.3mf 文件。", "error");
  try {
    drop.classList.add("is-loading"); msg("正在读取 3MF 压缩包…"); await nextPaint();
    if (!globalThis.JSZip) throw new Error("解压组件加载失败，请强制刷新页面后重试。");
    const zip = await JSZip.loadAsync(await file.arrayBuffer()), path = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name));
    if (!path) throw new Error("压缩包中没有找到 Metadata/plate_*.gcode。");
    msg("正在分析 G-code 分层与连续挤出打印线…"); await nextPaint();
    const gcode = await zip.file(path).async("string");
    const parsed = parseGcode(gcode); if (!parsed.layers.length) throw new Error("没有识别到分层信息，请确认文件包含 CHANGE_LAYER 标记。");
    Object.assign(state, { file, gcode, path, parsed, configs: [], finalCut: { enabled: false, offset: 1, drop: 0, speedFactor: .1, repeats: 1 } });
    $("#upload-view").hidden = true; $("#workspace-view").hidden = false; render();
    const pauseCount = parsed.layers.filter((layer) => layer.hasPause).length;
    msg(pauseCount ? `导入完成：识别到 ${parsed.totalLayers} 层、${pauseCount} 个 Bambu 暂停层。点击橙色暂停层选择热封线。` : `导入完成：识别到 ${parsed.totalLayers} 层，但没有 Bambu 暂停层；仍可单独配置最终切膜。`, pauseCount ? "success" : "warning");
  } catch (error) { msg(`导入失败：${error.message || "文件解析失败。"}`, "error"); } finally { drop.classList.remove("is-loading"); }
}

async function exportFile() {
  hideMsg();
  try {
    const result = generateGcode(state.gcode, state.configs, state.finalCut), zip = await JSZip.loadAsync(await state.file.arrayBuffer()); zip.file(state.path, result.text); zip.file(state.path.replace(/\.gcode$/i, ".gcode.md5"), md5Text(result.text));
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } }), link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.file.name.replace(/\.gcode\.3mf$/i, "").replace(/\.3mf$/i, "")}_热封后处理.gcode.3mf`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    msg(`已生成：${result.operations.length} 个暂停点热封${result.finalCut ? "，并在全部打印结束后加入最终切膜" : ""}。所有新增路径均不含 E 挤出参数。`, "success");
  } catch (error) { msg(error.message || "导出失败。", "error"); }
}

drop.onclick = () => fileInput.click(); drop.onkeydown = (event) => (event.key === "Enter" || event.key === " ") && fileInput.click(); fileInput.onchange = () => { const file = fileInput.files[0]; fileInput.value = ""; if (file) load(file); };
["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.add("is-dragging"); })); ["dragleave", "drop"].forEach((name) => drop.addEventListener(name, (event) => { event.preventDefault(); drop.classList.remove("is-dragging"); })); drop.ondrop = (event) => event.dataTransfer.files[0] && load(event.dataTransfer.files[0]);
$("#change-file").onclick = () => fileInput.click(); $("#export-file").onclick = exportFile;
$("#timeline").onclick = (event) => { const tick = event.target.closest("[data-layer].has-pause"); if (!tick || Number(tick.dataset.layer) < 2) return; const layerNumber = Number(tick.dataset.layer), existing = state.configs.find((cfg) => cfg.layerNumber === layerNumber); if (existing) return document.querySelector(`[data-config="${existing.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); state.configs.push(newConfig(layerNumber)); renderConfigs(false); configs.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" }); };
configs.onclick = (event) => {
  const card = event.target.closest("[data-config]"), actionNode = event.target.closest("[data-action]"), action = actionNode?.dataset.action; if (!card || !action) return;
  const cfg = state.configs.find((item) => item.id === card.dataset.config);
  if (action === "remove") state.configs = state.configs.filter((item) => item.id !== card.dataset.config);
  if (action === "selectTrack") cfg.activeTrackId = actionNode.dataset.trackId;
  if (action === "enableActive") {
    const selected = new Set(cfg.selectedTrackIds); selected.add(actionNode.dataset.trackId); cfg.selectedTrackIds = [...selected]; cfg.activeTrackId = actionNode.dataset.trackId;
  }
  renderConfigs();
};
configs.onchange = (event) => {
  const card = event.target.closest("[data-config]"); if (!card) return;
  const cfg = state.configs.find((item) => item.id === card.dataset.config), field = event.target.dataset.field;
  if (field === "trackEnabled") {
    const id = event.target.dataset.trackId, selected = new Set(cfg.selectedTrackIds);
    event.target.checked ? selected.add(id) : selected.delete(id);
    cfg.selectedTrackIds = [...selected]; cfg.activeTrackId = id;
  }
  if (field === "lineSpeedFactor") cfg.trackSettings[event.target.dataset.trackId].speedFactor = Number(event.target.value);
  if (field === "lineRepeats") cfg.trackSettings[event.target.dataset.trackId].repeats = Number(event.target.value);
  if (field === "pressDepth") cfg.pressDepth = Number(event.target.value);
  renderConfigs();
};
configs.oninput = (event) => {
  if (event.target.dataset.field === "pressDepth") {
    const card = event.target.closest("[data-config]"), cfg = state.configs.find((item) => item.id === card.dataset.config), depth = Number(event.target.value), sourceLayer = candidatesFor(cfg).sourceLayer, targetZ = Number(sourceLayer?.z) - depth;
    cfg.pressDepth = depth;
    const control = event.target.closest(".press-depth-control"); control.querySelector("output").textContent = `${depth.toFixed(2)} mm`; control.querySelector("[data-press-target]").textContent = `Z${targetZ.toFixed(2)}`; control.querySelector(".press-warning").textContent = `喷嘴将低于下层表面 ${depth.toFixed(2)} mm。数值越大，下压力越高，请确认平台与喷嘴安全。`;
    card.querySelector("[data-heat-seal-z]").textContent = targetZ.toFixed(2); card.querySelector("[data-press-chip]").textContent = `下压 ${depth.toFixed(2)}mm`; return;
  }
  if (event.target.dataset.field !== "lineSpeedFactor") return;
  const card = event.target.closest("[data-config]"), cfg = state.configs.find((item) => item.id === card.dataset.config), id = event.target.dataset.trackId, factor = Number(event.target.value), track = candidatesFor(cfg).tracks.find((item) => item.trackId === id), panel = event.target.closest(".line-settings");
  cfg.trackSettings[id].speedFactor = factor;
  panel.querySelector("output").textContent = `${factor.toFixed(1)} × · ${Math.round(factor * 100)}%`;
  panel.querySelector(".speed-scale").innerHTML = speedScale(factor);
  panel.querySelector(".speed-note").textContent = `原路径 ${mmPerSecond(track.originalFeed).toFixed(1)} mm/s，热封 ${mmPerSecond(track.originalFeed * factor).toFixed(1)} mm/s`;
  drawConfig(cfg);
};
$("#final-cut-config").onchange = (event) => { const field = event.target.dataset.finalField; if (!field) return; state.finalCut[field] = field === "enabled" ? event.target.checked : Number(event.target.value); renderFinalCut(); };
$("#final-cut-config").oninput = (event) => {
  const field = event.target.dataset.finalField; if (!["offset", "drop", "speedFactor"].includes(field)) return;
  state.finalCut[field] = Number(event.target.value);
  const unit = field === "speedFactor" ? " ×" : " mm";
  event.target.closest("label")?.querySelector("output")?.replaceChildren(`${state.finalCut[field].toFixed(1)}${unit}`);
  if (field === "drop") $("#final-cut-target-z").textContent = `Z${Math.max(0, modelMaxZ() - state.finalCut.drop).toFixed(2)}`;
  if (field === "offset") drawFinalCut();
};
