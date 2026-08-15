import { classifyLayerRegions, createFinalCutPreview, generateGcode, getReplayCandidates, md5Text, offsetTrack, parseGcode, parseObjectNames, summarizeLayer } from "./core.mjs";

const $ = (query) => document.querySelector(query);
const notice = $("#notice"), configs = $("#config-list"), fileInput = $("#file-input"), drop = $("#dropzone");
const state = {
  file: null, gcode: "", path: "", parsed: null, names: {}, configs: [], regions: [],
  finalCut: { enabled: false, offset: 1, drop: 0, speedFactor: .1, repeats: 1 }
};
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(resolve));
const msg = (text, kind = "info") => { notice.textContent = text; notice.className = `notice is-${kind}`; notice.hidden = false; };
const hideMsg = () => notice.hidden = true;
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const mmPerSecond = (feed) => Number(feed || 0) / 60;
const factorAt = (cfg, index) => Number(cfg.speedFactors[index] ?? cfg.speedFactors.at(-1) ?? .1);
const offsetAt = (cfg, index) => Number(cfg.offsetDistances[index] ?? cfg.offsetDistances.at(-1) ?? 0);

function regionsFor(layer) {
  let result = state.regions.find((item) => item.layerNumber === layer.number);
  if (!result) { result = { layerNumber: layer.number, ...classifyLayerRegions(layer) }; state.regions.push(result); }
  return result;
}

const newConfig = (layerNumber) => ({
  id: crypto.randomUUID(), layerNumber, circles: 0, outerRepeat: 1, autoFill: false,
  speedFactors: [], offsetDistances: [], objectIds: [], clearance: .01,
  safeZ: Math.min(256, state.parsed.printableHeight || 256), waitBefore: 30, waitAfter: 10, betweenLift: 10
});

function renderObjects() {
  const summaries = state.parsed.layers.map(regionsFor);
  const skeletonLayers = summaries.filter((item) => item.skeletonTracks.length).length;
  const wallLayers = summaries.filter((item) => item.peripheralWallTracks.length).length;
  const skeletonTracks = summaries.reduce((sum, item) => sum + item.skeletonTracks.length, 0);
  const wallTracks = summaries.reduce((sum, item) => sum + item.peripheralWallTracks.length, 0);
  $("#object-list").innerHTML = `<article class="object-row"><span class="object-swatch swatch-0"></span><div><strong>中间主体骨架</strong><span>外围墙体以内、与外围墙体不相连的主体轨迹 · ${skeletonLayers} 层</span></div><b>${skeletonTracks}</b><small>骨架轨迹</small></article><article class="object-row"><span class="object-swatch swatch-1"></span><div><strong>外围墙体</strong><span>模型外侧成对闭合的墙体轨迹 · ${wallLayers} 层</span></div><b>${wallTracks}</b><small>墙体轨迹</small></article>`;
  $("#transition-count").textContent = summaries.some((item) => item.wallDetected) ? 2 : 1;
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

const pointsFor = (track) => {
  if (track.points?.length) return track.points.concat(track.points[0]);
  const points = [{ ...track.start }], current = { ...track.start };
  track.commands.forEach((command) => {
    const x = command.match(/(?:^|\s)X([-+.\d]+)/i)?.[1], y = command.match(/(?:^|\s)Y([-+.\d]+)/i)?.[1];
    if (x !== undefined) current.x = Number(x); if (y !== undefined) current.y = Number(y);
    if (x !== undefined || y !== undefined) points.push({ ...current });
  });
  return points;
};

function drawPaths(canvas, paths, emptyText = "没有可显示的轨迹") {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1, ctx = canvas.getContext("2d");
  canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr)); ctx.scale(dpr, dpr);
  const valid = paths.filter((path) => path.points?.length > 1);
  if (!valid.length) { ctx.fillStyle = "#8c938e"; ctx.font = "13px sans-serif"; ctx.fillText(emptyText, 18, 30); return; }
  const all = valid.flatMap((path) => path.points), bounds = all.reduce((b, point) => ({ minX: Math.min(b.minX, point.x), maxX: Math.max(b.maxX, point.x), minY: Math.min(b.minY, point.y), maxY: Math.max(b.maxY, point.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const pad = 24, width = Math.max(1, bounds.maxX - bounds.minX), height = Math.max(1, bounds.maxY - bounds.minY), scale = Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height), offsetX = (rect.width - width * scale) / 2, offsetY = (rect.height - height * scale) / 2;
  const project = (point) => ({ x: offsetX + (point.x - bounds.minX) * scale, y: rect.height - offsetY - (point.y - bounds.minY) * scale });
  valid.forEach((path) => {
    const first = project(path.points[0]); ctx.beginPath(); ctx.moveTo(first.x, first.y);
    path.points.slice(1).forEach((point) => { const next = project(point); ctx.lineTo(next.x, next.y); });
    ctx.strokeStyle = path.color; ctx.lineWidth = path.width ?? 1.5; ctx.setLineDash(path.dash ?? []); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.stroke();
  });
  ctx.setLineDash([]);
}

function drawFullTopView() {
  requestAnimationFrame(() => {
    const paths = state.parsed.layers.flatMap((layer) => {
      const regions = regionsFor(layer), wallSet = new Set(regions.peripheralWallTracks);
      return layer.tracks.map((track) => ({ points: pointsFor(track), region: wallSet.has(track) ? "wall" : "skeleton", color: wallSet.has(track) ? "rgba(239,106,58,.09)" : "rgba(23,107,81,.11)", width: wallSet.has(track) ? 1.25 : .8 }));
    });
    drawPaths($("#full-top-view"), [...paths.filter((p) => p.region === "skeleton"), ...paths.filter((p) => p.region === "wall")]);
  });
}

function renderGeometry() {
  const summaries = state.parsed.layers.map(regionsFor);
  $("#geometry-skeleton").textContent = summaries.reduce((sum, item) => sum + item.skeletonTracks.length, 0);
  $("#geometry-wall").textContent = summaries.reduce((sum, item) => sum + item.peripheralWallTracks.length, 0);
  $("#geometry-layers").textContent = summaries.filter((item) => item.skeletonTracks.length || item.peripheralWallTracks.length).length;
  drawFullTopView();
}

function loopName(track, fallbackIndex = 0) {
  const count = track?.loopCount ?? 1, index = track?.innerIndex ?? fallbackIndex;
  if (count === 1) return "第1圈（唯一）";
  if (index === 0) return "第1圈（最里）";
  if (index === count - 1) return `第${index + 1}圈（最外）`;
  return `第${index + 1}圈`;
}

const speedScale = (factor) => Array.from({ length: 10 }, (_, index) => {
  const value = (index + 1) / 10;
  return `<span class="${Math.abs(value - factor) < .001 ? "is-current" : ""}">${value.toFixed(1)}</span>`;
}).join("");
const offsetOptions = (offset, index, configId) => Array.from({ length: 6 }, (_, n) => {
  const value = n / 10;
  return `<label class="offset-option"><input type="radio" name="offset-${configId}-${index}" value="${value.toFixed(1)}" data-field="loopOffsetDistance" data-loop-index="${index}" ${Math.abs(offset - value) < 1e-9 ? "checked" : ""}><span>${value.toFixed(1)}<small>mm</small></span></label>`;
}).join("");

function speedControl(cfg, track, index) {
  const name = loopName(track, index), factor = factorAt(cfg, index), offset = offsetAt(cfg, index), sourceSpeed = mmPerSecond(track.originalFeed), outputSpeed = sourceSpeed * factor;
  return `<div class="loop-speed" data-loop="${index}"><div class="loop-identity"><i class="preview-color color-${index % 4}"></i><b>${name}</b><small>外围墙体${track.isOutermost ? " · 可重复热封" : ""}</small></div><div class="field-label speed-label"><span>${name}速度</span><output>${factor.toFixed(1)} × · ${Math.round(factor * 100)}%</output></div><div class="speed-control"><input class="speed-slider" type="range" min="0.1" max="1" step="0.1" value="${factor}" data-field="loopSpeedFactor" data-loop-index="${index}"><div class="speed-scale">${speedScale(factor)}</div><p class="speed-note">原路径 ${sourceSpeed.toFixed(1)} mm/s，热封 ${outputSpeed.toFixed(1)} mm/s</p></div><div class="field-label speed-label offset-label"><span>${name}向外偏移</span><output>${offset.toFixed(1)} mm</output></div><div class="offset-control"><div class="offset-options">${offsetOptions(offset, index, cfg.id)}</div><p class="offset-note">${offset === 0 ? "沿外围墙体原始轨迹热封" : `向外围墙体外侧偏移 ${offset.toFixed(1)} mm`}</p></div></div>`;
}

function drawConfig(cfg) {
  requestAnimationFrame(() => {
    const canvas = document.querySelector(`[data-canvas="${cfg.id}"]`), result = getReplayCandidates(state.parsed, Number(cfg.layerNumber), cfg.objectIds), selected = result.tracks.slice(0, cfg.circles), paths = [];
    selected.forEach((track, index) => {
      const original = pointsFor(track), shifted = pointsFor(offsetTrack(track, offsetAt(cfg, index)));
      if (offsetAt(cfg, index) > 0) paths.push({ points: original, color: "rgba(24,35,30,.28)", width: 1, dash: [4, 4] });
      paths.push({ points: shifted, color: ["#ef6a3a", "#176b51", "#b98b2f", "#445e97"][index % 4], width: index ? 1.8 : 2.5 });
    });
    if (cfg.autoFill && result.autoFillTrack) paths.push({ points: pointsFor(result.autoFillTrack), color: "#8c4fa8", width: 2.3 });
    drawPaths(canvas, paths, "该暂停点前未识别到可热封的外围墙体");
  });
}

function renderConfigs() {
  configs.innerHTML = state.configs.map((cfg, order) => {
    cfg.speedFactors ??= []; cfg.offsetDistances ??= []; cfg.outerRepeat ??= 1; cfg.autoFill ??= false;
    const { sourceLayer, tracks, autoFillTrack } = getReplayCandidates(state.parsed, Number(cfg.layerNumber), cfg.objectIds);
    cfg.circles = tracks.length;
    while (cfg.speedFactors.length < cfg.circles) cfg.speedFactors.push(cfg.speedFactors.at(-1) ?? .1);
    while (cfg.offsetDistances.length < cfg.circles) cfg.offsetDistances.push(0);
    const selected = tracks.slice(0, cfg.circles), hasOutermost = selected.some((track) => track.isOutermost);
    const passCount = selected.length + (hasOutermost ? cfg.outerRepeat - 1 : 0) + (cfg.autoFill && autoFillTrack ? 1 : 0);
    const speeds = selected.length ? selected.map((track, index) => `${loopName(track, index)} ${mmPerSecond(track.originalFeed * factorAt(cfg, index)).toFixed(1)} mm/s`).join(" / ") : "—";
    const controls = selected.map((track, index) => speedControl(cfg, track, index)).join("");
    const legend = selected.map((track, index) => `<span><i class="preview-color color-${index % 4}"></i>${loopName(track, index)}${track.isOutermost && cfg.outerRepeat > 1 ? ` · ${cfg.outerRepeat}遍` : ""}</span>`).join("") + (cfg.autoFill ? `<span><i class="preview-color fill-color"></i>自动填缝</span>` : "");
    return `<article class="config-card" data-config="${cfg.id}"><header><div class="step-number">${String(order + 1).padStart(2, "0")}</div><div><h3>第${cfg.layerNumber}层暂停点热封</h3><p>热封路径来自第 ${sourceLayer?.number ?? "—"} 层外围墙体</p></div><button class="icon-button" data-action="remove" aria-label="移除热封操作">×</button></header><div class="config-grid"><section><div class="replay-fields"><div class="field-row circle-row"><label>外围墙体轨迹 <small>从里向外自动编号</small></label><div class="detected-count"><strong>${selected.length}</strong><span>圈</span></div></div><div class="field-label outer-repeat-label">最外圈热封遍数</div><div class="segmented three outer-repeat ${hasOutermost ? "" : "is-disabled"}">${[1, 2, 3].map((value) => `<label><input type="radio" name="outer-repeat-${cfg.id}" data-field="outerRepeat" value="${value}" ${cfg.outerRepeat === value ? "checked" : ""}><span>${value}遍</span></label>`).join("")}</div><div class="field-label outer-repeat-label">自动填缝</div><div class="segmented two ${autoFillTrack ? "" : "is-disabled"}">${[[false, "关闭"], [true, "开启"]].map(([value, label]) => `<label><input type="radio" name="auto-fill-${cfg.id}" data-field="autoFill" value="${value}" ${cfg.autoFill === value ? "checked" : ""}><span>${label}</span></label>`).join("")}</div><p class="offset-note">自动填缝作为一个整体，不参与外围墙体圈数编号。</p>${controls || "<p class='speed-note is-error'>该暂停点前没有识别到可热封的外围墙体。</p>"}</div></section><section class="path-preview"><div class="preview-head"><span>热封轨迹预览</span><b>${selected.length}圈 · ${passCount}次走线</b></div><canvas data-canvas="${cfg.id}"></canvas><div class="preview-legend">${legend}<span class="original-key">虚线：偏移前轨迹</span></div><div class="path-stats"><span>热封 Z <b>${sourceLayer?.z !== undefined ? (sourceLayer.z + .01).toFixed(2) : "—"}</b></span><span>输出速度 <b>${speeds}</b></span></div></section></div><details><summary>固定工艺参数</summary><div class="fixed-grid"><span>安全位 Z${cfg.safeZ}</span><span>热封前等待 ${cfg.waitBefore}s</span><span>圈间抬高 ${cfg.betweenLift}mm</span><span>热封后等待 ${cfg.waitAfter}s</span><span>表面间隙 0.01mm</span></div></details></article>`;
  }).join("");
  $("#export-file").disabled = !state.configs.length && !state.finalCut.enabled;
  state.configs.forEach(drawConfig);
}

const repeatOptions = (current) => Array.from({ length: 5 }, (_, index) => {
  const value = index + 1;
  return `<label class="offset-option"><input type="radio" name="final-cut-repeats" value="${value}" data-final-field="repeats" ${value === current ? "checked" : ""}><span>${value}<small>遍</small></span></label>`;
}).join("");

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
  const skeletonMaxZ = Math.max(0, ...state.parsed.layers.filter((layer) => regionsFor(layer).skeletonWallTracks.length).map((layer) => Number(layer.z || 0)));
  const maxDrop = Math.min(5, Math.floor(skeletonMaxZ * 10) / 10); state.finalCut.drop = Math.min(state.finalCut.drop, maxDrop);
  const targetZ = Math.max(0, skeletonMaxZ - state.finalCut.drop);
  $("#final-cut-config").innerHTML = `<div class="final-cut-head"><div><p class="eyebrow">打印结束后 · 单次执行</p><h2>最终切膜走线</h2><p>在最后一条模型挤出之后、原始结束代码关闭加热之前执行。</p></div><label class="master-switch"><input type="checkbox" data-final-field="enabled" ${state.finalCut.enabled ? "checked" : ""}><span>${state.finalCut.enabled ? "已开启" : "未开启"}</span></label></div><div class="final-cut-body ${state.finalCut.enabled ? "" : "is-disabled"}"><div class="final-cut-controls"><label class="final-range"><span>外围墙体外扩 <output>${state.finalCut.offset.toFixed(1)} mm</output></span><input type="range" min="1" max="5" step="0.1" value="${state.finalCut.offset}" data-final-field="offset"><div class="final-range-scale"><span>1.0</span><span>2.0</span><span>3.0</span><span>4.0</span><span>5.0</span></div></label><label class="final-range"><span>从骨架最高点向下 <output>${state.finalCut.drop.toFixed(1)} mm</output></span><input type="range" min="0" max="${maxDrop}" step="0.1" value="${state.finalCut.drop}" data-final-field="drop"><div class="final-range-scale"><span>0.0</span><span>${maxDrop.toFixed(1)}</span></div></label><div class="final-repeat-control"><span class="field-label">切膜遍数</span><div class="offset-options final-repeat-options">${repeatOptions(state.finalCut.repeats)}</div></div><label class="final-range final-speed"><span>切膜速度 <output>${state.finalCut.speedFactor.toFixed(1)} ×</output></span><input type="range" min="0.1" max="1" step="0.1" value="${state.finalCut.speedFactor}" data-final-field="speedFactor"><div class="final-range-scale"><span>0.1</span><span>0.5</span><span>1.0</span></div></label><div class="final-cut-summary"><span>骨架最高点 <b>Z${skeletonMaxZ.toFixed(2)}</b></span><span>切膜高度 <b id="final-cut-target-z">Z${targetZ.toFixed(2)}</b></span></div></div><div class="final-cut-preview"><canvas id="final-cut-canvas"></canvas><div class="preview-legend"><span><i class="preview-color original-fill"></i>外围墙体包络</span><span><i class="preview-color fill-color"></i>最终切膜走线</span></div></div></div>`;
  $("#export-file").disabled = !state.configs.length && !state.finalCut.enabled;
  drawFinalCut();
}

function render() {
  const pauseCount = state.parsed.layers.filter((layer) => layer.hasPause).length, regionCount = state.parsed.layers.some((layer) => regionsFor(layer).wallDetected) ? 2 : 1;
  $("#file-name").textContent = state.file.name; $("#file-size").textContent = bytes(state.file.size); $("#total-layers").textContent = state.parsed.totalLayers; $("#max-z").textContent = state.parsed.layers.at(-1)?.z ?? "—"; $("#object-count").textContent = regionCount; $("#pause-count").textContent = `${pauseCount} 个暂停层`; $("#nozzle-temp").textContent = state.parsed.nozzleTemperature ? `${state.parsed.nozzleTemperature}°C` : "—";
  if (state.parsed.preprocessed) msg("检测到文件已包含后处理代码。请使用 Bambu Studio 原始切片文件，避免重复插入。", "warning");
  renderObjects(); renderTimeline(); renderGeometry(); renderConfigs(); renderFinalCut();
}

async function load(file) {
  hideMsg(); if (!/\.3mf$/i.test(file.name)) return msg("请选择 Bambu Studio 导出的 .gcode.3mf 文件。", "error");
  try {
    drop.classList.add("is-loading"); msg("正在读取 3MF 压缩包…"); await nextPaint();
    if (!globalThis.JSZip) throw new Error("解压组件加载失败，请强制刷新页面后重试。");
    const zip = await JSZip.loadAsync(await file.arrayBuffer()), path = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.gcode$/i.test(name));
    if (!path) throw new Error("压缩包中没有找到 Metadata/plate_*.gcode。");
    msg("正在分析 G-code 分层与轨迹…"); await nextPaint();
    const gcode = await zip.file(path).async("string"), slice = await zip.file("Metadata/slice_info.config")?.async("string"), platePath = Object.keys(zip.files).find((name) => /Metadata\/plate_\d+\.json$/i.test(name)), plate = platePath ? await zip.file(platePath).async("string") : "";
    const parsed = parseGcode(gcode); if (!parsed.layers.length) throw new Error("没有识别到分层信息，请确认文件包含 CHANGE_LAYER 标记。");
    Object.assign(state, { file, gcode, path, parsed, names: parseObjectNames(slice, plate), regions: [], configs: [], finalCut: { enabled: false, offset: 1, drop: 0, speedFactor: .1, repeats: 1 } });
    $("#upload-view").hidden = true; $("#workspace-view").hidden = false; render();
    const pauseCount = parsed.layers.filter((layer) => layer.hasPause).length;
    msg(pauseCount ? `导入完成：识别到 ${parsed.totalLayers} 层、${pauseCount} 个 Bambu 暂停层。点击橙色暂停层配置热封。` : `导入完成：识别到 ${parsed.totalLayers} 层，但没有 Bambu 暂停层；仍可单独配置最终切膜。`, pauseCount ? "success" : "warning");
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
$("#timeline").onclick = (event) => { const tick = event.target.closest("[data-layer].has-pause"); if (!tick || Number(tick.dataset.layer) < 2) return; const layerNumber = Number(tick.dataset.layer), existing = state.configs.find((cfg) => cfg.layerNumber === layerNumber); if (existing) return document.querySelector(`[data-config="${existing.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); state.configs.push(newConfig(layerNumber)); renderConfigs(); configs.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" }); };
configs.onclick = (event) => { const card = event.target.closest("[data-config]"), action = event.target.closest("[data-action]")?.dataset.action; if (!card || !action) return; if (action === "remove") state.configs = state.configs.filter((cfg) => cfg.id !== card.dataset.config); renderConfigs(); };
configs.onchange = (event) => { const card = event.target.closest("[data-config]"); if (!card) return; const cfg = state.configs.find((item) => item.id === card.dataset.config), field = event.target.dataset.field; if (field === "outerRepeat") cfg.outerRepeat = Number(event.target.value); if (field === "autoFill") cfg.autoFill = event.target.value === "true"; if (field === "loopSpeedFactor") cfg.speedFactors[Number(event.target.dataset.loopIndex)] = Number(event.target.value); if (field === "loopOffsetDistance") cfg.offsetDistances[Number(event.target.dataset.loopIndex)] = Number(event.target.value); renderConfigs(); };
configs.oninput = (event) => { if (event.target.dataset.field !== "loopSpeedFactor") return; const card = event.target.closest("[data-config]"), cfg = state.configs.find((item) => item.id === card.dataset.config), index = Number(event.target.dataset.loopIndex); cfg.speedFactors[index] = Number(event.target.value); const loop = event.target.closest(".loop-speed"), track = getReplayCandidates(state.parsed, cfg.layerNumber, cfg.objectIds).tracks[index]; loop.querySelector("output").textContent = `${cfg.speedFactors[index].toFixed(1)} × · ${Math.round(cfg.speedFactors[index] * 100)}%`; loop.querySelector(".speed-note").textContent = `原路径 ${mmPerSecond(track.originalFeed).toFixed(1)} mm/s，热封 ${mmPerSecond(track.originalFeed * cfg.speedFactors[index]).toFixed(1)} mm/s`; };
$("#final-cut-config").onchange = (event) => { const field = event.target.dataset.finalField; if (!field) return; state.finalCut[field] = field === "enabled" ? event.target.checked : Number(event.target.value); renderFinalCut(); };
$("#final-cut-config").oninput = (event) => {
  const field = event.target.dataset.finalField; if (!["offset", "drop", "speedFactor"].includes(field)) return;
  state.finalCut[field] = Number(event.target.value);
  const unit = field === "speedFactor" ? " ×" : " mm";
  event.target.closest("label")?.querySelector("output")?.replaceChildren(`${state.finalCut[field].toFixed(1)}${unit}`);
  if (field === "drop") {
    const skeletonMaxZ = Math.max(0, ...state.parsed.layers.filter((layer) => regionsFor(layer).skeletonWallTracks.length).map((layer) => Number(layer.z || 0)));
    $("#final-cut-target-z").textContent = `Z${Math.max(0, skeletonMaxZ - state.finalCut.drop).toFixed(2)}`;
  }
  if (field === "offset") drawFinalCut();
};
