import { analyzeLayerGeometry, classifyLayerRegions, generateGcode, getReplayCandidates, md5Text, offsetTrack, parseGcode, parseObjectNames, summarizeLayer } from "./core.mjs";
const $ = (q) => document.querySelector(q);
const state = { file: null, gcode: "", path: "", parsed: null, names: {}, configs: [], geometryLayer: null, geometry: [] };
const notice = $("#notice"), configs = $("#config-list"), fileInput = $("#file-input"), drop = $("#dropzone");
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const esc = (v) => String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const nameOf = (id) => state.names[id] || (id === "未标注主体" ? id : `主体 ${id}`);
const msg = (text, kind = "info") => { notice.textContent = text; notice.className = `notice is-${kind}`; notice.hidden = false; };
const hideMsg = () => notice.hidden = true;
const bytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const newConfig = (layer) => ({ id: crypto.randomUUID(), layerNumber: layer, replay: true, circles: 0, outerRepeat: 1, speedFactors: [], offsetDistances: [], objectIds: [], regionIds: ["skeleton", "outer-ring"], clearance: .01, safeZ: Math.min(256, state.parsed.printableHeight || 256), waitBefore: 30, waitAfter: 10, betweenLift: 10 });

function renderObjects() {
  const summaries = state.parsed.layers.map(classifyLayerRegions), skeletonLayers = summaries.filter((item) => item.skeletonTracks.length).length, ringLayers = summaries.filter((item) => item.outerRingTracks.length).length;
  const skeletonTracks = summaries.reduce((sum, item) => sum + item.skeletonTracks.length, 0), ringTracks = summaries.reduce((sum, item) => sum + item.outerRingTracks.length, 0);
  $("#object-list").innerHTML = `<article class="object-row"><span class="object-swatch swatch-0"></span><div><strong>中间主体骨架</strong><span>按外圈内边界以内的轨迹识别 · ${skeletonLayers} 层</span></div><b>${skeletonTracks}</b><small>骨架轨迹</small></article><article class="object-row"><span class="object-swatch swatch-1"></span><div><strong>热封外圈</strong><span>按最大嵌套轮廓对识别 · ${ringLayers} 层</span></div><b>${ringTracks}</b><small>外圈轨迹</small></article>`;
  $("#transition-count").textContent = summaries.some((item) => item.ringDetected) ? 2 : 1;
  $("#transition-copy").textContent = summaries.some((item) => item.ringDetected) ? "虽然文件已经合并为同一主体，仍已通过几何嵌套关系分离出中间骨架与热封外圈。" : "未找到稳定的双轮廓外圈；当前按最大外轮廓与内部轨迹进行降级分类。";
}

function renderTimeline() {
  const rows = state.parsed.layers.map(summarizeLayer), max = Math.max(1, ...rows.map((r) => r.walls));
  $("#timeline").innerHTML = [...rows].reverse().map((r) => `<button class="layer-tick ${r.paused ? "has-pause" : ""}" data-layer="${r.number}" ${r.paused ? "" : "disabled"} title="${r.paused ? "可选择：Bambu 已在此层暂停" : "不可选择：此层没有 Bambu 暂停"} · 第 ${r.number} 层 · Z${r.z ?? "?"} mm"><span class="layer-position"><b>第 ${r.number} 层</b><small>Z ${r.z ?? "?"} mm</small></span><span class="wall-bar"><i style="width:${Math.max(4, r.walls / max * 100)}%"></i></span><strong>${r.paused ? "暂停" : r.walls}</strong></button>`).join("");
}

function renderGeometry() {
  const selector = $("#geometry-layer"), current = Number(state.geometryLayer ?? state.parsed.layers.at(-1)?.number);
  selector.innerHTML = [...state.parsed.layers].reverse().map((layer) => `<option value="${layer.number}" ${layer.number === current ? "selected" : ""}>第 ${layer.number} 层 · Z ${layer.z ?? "?"} mm</option>`).join("");
  state.geometryLayer = current;
  let analysis = state.geometry.find((item) => item.layerNumber === current);
  if (!analysis) {
    const layer = state.parsed.layers.find((item) => item.number === current);
    if (layer) { analysis = analyzeLayerGeometry(layer); state.geometry.push(analysis); }
  }
  const contours = analysis?.contours ?? [], components = analysis?.components ?? [];
  $("#geometry-components").textContent = components.length; $("#geometry-depth").textContent = analysis?.maxDepth ?? 0; $("#geometry-cross").textContent = analysis?.crossObjectRelations.length ?? 0;
  $("#geometry-list").innerHTML = contours.length ? components.map((component) => {
    const members = component.contourIndices.map((index) => contours[index]);
    return `<article class="geometry-component"><header><b>连通块 ${component.id}</b><span>${component.contourIndices.length} 条轮廓 · ${component.objectIds.length} 个主体</span></header>${members.sort((a, b) => a.depth - b.depth || b.area - a.area).map((contour) => `<div class="contour-row" style="--depth:${contour.depth}"><i class="swatch-${state.parsed.objectIds.indexOf(contour.objectId) % 4}"></i><span><strong>${esc(nameOf(contour.objectId))}</strong><small>${contour.depth === 0 ? "外层轮廓" : `嵌套第 ${contour.depth} 层`} · 面积约 ${contour.area.toFixed(1)} mm²</small></span><em>${contour.parent === null ? "根轮廓" : `包含于 #${contour.parent + 1}`}</em></div>`).join("")}</article>`;
  }).join("") : "<p class='geometry-empty'>这一层没有可分析的闭合墙轮廓。</p>";
  const relations = analysis?.crossObjectRelations ?? [];
  $("#geometry-relations").innerHTML = relations.length ? relations.map((relation) => relation.type === "nested" ? `<li><b>${esc(nameOf(relation.innerObjectId))}</b> 的轮廓嵌套在 <b>${esc(nameOf(relation.outerObjectId))}</b> 内</li>` : `<li><b>${esc(nameOf(relation.aObjectId))}</b> 与 <b>${esc(nameOf(relation.bObjectId))}</b> 的轮廓接触或相交</li>`).join("") : "<li>未发现不同主体之间的轮廓接触或跨主体嵌套。</li>";
}

const pointsFor = (track) => {
  if (track.points?.length) return track.points.concat(track.points[0]);
  const points = [{ ...track.start }], current = { ...track.start };
  track.commands.forEach((command) => {
    const x = command.match(/(?:^|\s)X([-+.\d]+)/i)?.[1], y = command.match(/(?:^|\s)Y([-+.\d]+)/i)?.[1];
    if (x !== undefined) current.x = Number(x);
    if (y !== undefined) current.y = Number(y);
    if (x !== undefined || y !== undefined) points.push({ ...current });
  });
  return points;
};

const loopName = (track, fallbackIndex = 0) => {
  if (track?.isOutermost) return "热封最外圈";
  const count = track?.regionLoopCount ?? track?.loopCount ?? 1, index = track?.regionIndex ?? track?.innerIndex ?? fallbackIndex, prefix = track?.region === "skeleton" ? "骨架" : "外圈";
  return count === 1 ? prefix : `${prefix}第 ${index + 1} 圈`;
};

function draw(cfg) {
  requestAnimationFrame(() => {
    const canvas = document.querySelector(`[data-canvas="${cfg.id}"]`); if (!canvas) return;
    const ctx = canvas.getContext("2d"), dpr = devicePixelRatio || 1, rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; ctx.scale(dpr, dpr);
    const { sourceLayer, tracks } = getReplayCandidates(state.parsed, Number(cfg.layerNumber), cfg.objectIds, cfg.regionIds), selected = tracks.slice(0, cfg.circles);
    if (!sourceLayer || !selected.length) { ctx.fillStyle = "#8c938e"; ctx.font = "13px sans-serif"; ctx.fillText("该层暂无可预览的闭合外墙", 16, 28); return; }
    const paths = selected.map((track, index) => ({ track, index, original: pointsFor(track), shifted: pointsFor(offsetTrack(track, offsetAt(cfg, index))) }));
    const allPoints = paths.flatMap((path) => [...path.original, ...path.shifted]);
    const b = allPoints.reduce((a, point) => ({ minX: Math.min(a.minX, point.x), maxX: Math.max(a.maxX, point.x), minY: Math.min(a.minY, point.y), maxY: Math.max(a.maxY, point.y) }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    const pad = 18, scale = Math.min((rect.width - 2 * pad) / Math.max(1, b.maxX - b.minX), (rect.height - 2 * pad) / Math.max(1, b.maxY - b.minY));
    const p = (point) => ({ x: pad + (point.x - b.minX) * scale, y: rect.height - pad - (point.y - b.minY) * scale });
    paths.forEach(({ original, shifted, index }) => {
      const color = ["#ef6a3a", "#176b51", "#b98b2f", "#445e97"][index % 4];
      if (offsetAt(cfg, index) > 0) {
        ctx.strokeStyle = "rgba(24,35,30,.28)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(p(original[0]).x, p(original[0]).y); original.slice(1).forEach((point) => ctx.lineTo(p(point).x, p(point).y)); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.strokeStyle = color; ctx.lineWidth = index ? 1.8 : 2.5; ctx.beginPath(); ctx.moveTo(p(shifted[0]).x, p(shifted[0]).y); shifted.slice(1).forEach((point) => ctx.lineTo(p(point).x, p(point).y)); ctx.stroke();
    });
  });
}

const factorAt = (cfg, index) => Number(cfg.speedFactors[index] ?? cfg.speedFactors.at(-1) ?? .1);
const offsetAt = (cfg, index) => Number(cfg.offsetDistances[index] ?? cfg.offsetDistances.at(-1) ?? .2);
const mmPerSecond = (feed) => feed / 60;
const speedScale = (factor) => Array.from({ length: 11 }, (_, n) => `<span class="${n === Math.round(factor * 10) ? "is-current" : ""}">${(n / 10).toFixed(1)}</span>`).join("");
const offsetOptions = (offset, index, configId) => Array.from({ length: 6 }, (_, n) => {
  const value = n / 10;
  return `<label class="offset-option"><input type="radio" name="offset-${configId}-${index}" value="${value.toFixed(1)}" data-field="loopOffsetDistance" data-loop-index="${index}" ${Math.abs(offset - value) < 1e-9 ? "checked" : ""}><span>${value.toFixed(1)}<small>mm</small></span></label>`;
}).join("");
const speedControl = (cfg, track, index) => {
  const name = loopName(track, index), factor = factorAt(cfg, index), offset = offsetAt(cfg, index), percent = Math.round(factor * 100), sourceSpeed = mmPerSecond(track.originalFeed), outputSpeed = sourceSpeed * factor;
  const offsetNote = offset === 0 ? "保持原始轨迹，不进行外扩" : `轨迹沿轮廓外侧等距移动 ${offset.toFixed(1)} mm`;
  const regionName = track.region === "skeleton" ? "中间主体骨架" : "热封外圈";
  return `<div class="loop-speed" data-loop="${index}"><div class="loop-identity"><i class="preview-color color-${index % 4}"></i><b>${name}</b><small>${regionName}${track.isOutermost ? " · 可重复热封" : ""}</small></div><div class="field-label speed-label"><span>${name}速度</span><output>${factor.toFixed(1)} × · ${percent}%</output></div><div class="speed-control"><input class="speed-slider" type="range" min="0" max="1" step="0.1" value="${factor}" data-field="loopSpeedFactor" data-loop-index="${index}" aria-label="${name}相对原路径速度"><div class="speed-scale">${speedScale(factor)}</div><p class="speed-note ${factor === 0 ? "is-error" : ""}">${factor === 0 ? "速度为 0 无法复走，请至少选择 0.1。" : `原路径 ${sourceSpeed.toFixed(1)} mm/s，复走 ${outputSpeed.toFixed(1)} mm/s`}</p></div><div class="field-label speed-label offset-label"><span>${name}向外偏移</span><output>${offset.toFixed(1)} mm</output></div><div class="offset-control"><div class="offset-options" role="radiogroup" aria-label="${name}向外偏移距离">${offsetOptions(offset, index, cfg.id)}</div><p class="offset-note">${offsetNote}</p></div></div>`;
};

function renderConfigs() {
  configs.innerHTML = state.configs.map((cfg, i) => {
    cfg.speedFactors ??= [];
    cfg.offsetDistances ??= [];
    cfg.regionIds ??= ["skeleton", "outer-ring"];
    cfg.outerRepeat ??= 1;
    const { sourceLayer, tracks } = getReplayCandidates(state.parsed, Number(cfg.layerNumber), cfg.objectIds, cfg.regionIds), maxCircles = tracks.length;
    cfg.circles = maxCircles;
    while (cfg.speedFactors.length < cfg.circles) cfg.speedFactors.push(cfg.speedFactors.at(-1) ?? .1);
    while (cfg.offsetDistances.length < cfg.circles) cfg.offsetDistances.push(.2);
    const selected = tracks.slice(0, cfg.circles);
    const regionChoices = [["skeleton", "中间主体骨架"], ["outer-ring", "热封外圈"]].map(([value, label]) => `<label class="check-chip"><input type="checkbox" data-field="region" value="${value}" ${cfg.regionIds.includes(value) ? "checked" : ""}><span>${label}</span></label>`).join("");
    const hasOutermost = selected.some((track) => track.isOutermost), passCount = selected.length + (hasOutermost ? cfg.outerRepeat - 1 : 0);
    const speed = selected.length ? selected.map((t, index) => `${loopName(t, index)} ${mmPerSecond(t.originalFeed * factorAt(cfg, index)).toFixed(1)} mm/s`).join(" / ") : "—";
    const speedControls = selected.map((track, index) => speedControl(cfg, track, index)).join("");
    const previewLegend = selected.map((track, index) => `<span><i class="preview-color color-${index % 4}"></i>${loopName(track, index)} · ${track.isOutermost && cfg.outerRepeat === 2 ? "热封 2 遍 · " : ""}外扩 ${offsetAt(cfg, index).toFixed(1)} mm</span>`).join("");
    return `<article class="config-card" data-config="${cfg.id}">
      <header><div class="step-number">${String(i + 1).padStart(2, "0")}</div><div><h3>第 ${cfg.layerNumber} 层已有 Bambu 暂停</h3><p>Z${state.parsed.layers.find((l) => l.number === Number(cfg.layerNumber))?.z ?? "—"} · 热封轨迹来源：第 ${sourceLayer?.number ?? "—"} 层</p></div><button class="icon-button" data-action="remove" aria-label="移除热封操作">×</button></header>
      <div class="config-grid"><section><div class="existing-pause-badge">✓ 使用文件中已有暂停，不新增暂停指令</div><div class="replay-fields"><div class="field-label object-label">热封区域 <small>可分别选择骨架与外圈</small></div><div class="object-chips">${regionChoices}</div><div class="field-row circle-row"><label>识别闭合轨迹 <small>根据所选区域自动更新</small></label><div class="detected-count"><strong>${maxCircles}</strong><span>圈</span></div></div><div class="field-label outer-repeat-label">热封最外圈遍数</div><div class="segmented two outer-repeat ${hasOutermost ? "" : "is-disabled"}"><label><input type="radio" name="outer-repeat-${cfg.id}" data-field="outerRepeat" value="1" ${cfg.outerRepeat === 1 ? "checked" : ""}><span>1 遍</span></label><label><input type="radio" name="outer-repeat-${cfg.id}" data-field="outerRepeat" value="2" ${cfg.outerRepeat === 2 ? "checked" : ""}><span>2 遍</span></label></div>${speedControls || "<p class='speed-note is-error'>所选区域没有可热封的闭合轨迹。</p>"}</div></section>
      <section class="path-preview"><div class="preview-head"><span>轨迹预览</span><b>${selected.length} 条轨迹 · ${passCount} 遍热封</b></div><canvas data-canvas="${cfg.id}"></canvas><div class="preview-legend">${previewLegend}<span class="original-key">虚线＝原始轨迹</span></div><div class="path-stats"><span>复走 Z <b>${sourceLayer?.z !== undefined ? (sourceLayer.z + .01).toFixed(2) : "—"}</b></span><span>输出速度 <b>${speed}</b></span></div></section></div>
      <details><summary>固定工艺参数</summary><div class="fixed-grid"><span>安全位 Z${cfg.safeZ}</span><span>复走前等待 ${cfg.waitBefore}s</span><span>圈间抬高 ${cfg.betweenLift}mm</span><span>复走后等待 ${cfg.waitAfter}s</span><span>表面间隙 0.01mm</span></div></details></article>`;
  }).join("");
  $("#export-file").disabled = !state.configs.length;
  state.configs.forEach(draw);
}

function render() {
  const pauseCount = state.parsed.layers.filter((layer) => layer.hasPause).length, regionCount = state.parsed.layers.some((layer) => classifyLayerRegions(layer).ringDetected) ? 2 : 1;
  $("#file-name").textContent = state.file.name; $("#file-size").textContent = bytes(state.file.size); $("#total-layers").textContent = state.parsed.totalLayers; $("#max-z").textContent = state.parsed.layers.at(-1)?.z ?? "—"; $("#object-count").textContent = regionCount; $("#pause-count").textContent = `${pauseCount} 个已有暂停层`; $("#nozzle-temp").textContent = state.parsed.nozzleTemperature ? `${state.parsed.nozzleTemperature}°C` : "—";
  if (state.parsed.preprocessed) msg("检测到文件已包含暂停或复走后处理代码。建议上传 Bambu Studio 原始切片文件，避免重复插入。", "warning");
  renderObjects(); renderTimeline(); renderGeometry(); renderConfigs();
}

async function load(file) {
  hideMsg();
  if (!/\.3mf$/i.test(file.name)) return msg("请选择 Bambu Studio 导出的 .gcode.3mf 文件。", "error");
  try {
    drop.classList.add("is-loading");
    msg("正在读取 3MF 压缩包…"); await nextPaint();
    if (!globalThis.JSZip) throw new Error("解压组件加载失败，请强制刷新页面后重试。");
    const zip = await JSZip.loadAsync(await file.arrayBuffer()), path = Object.keys(zip.files).find((n) => /Metadata\/plate_\d+\.gcode$/i.test(n));
    if (!path) throw new Error("压缩包中没有找到 Metadata/plate_*.gcode。 ");
    msg("正在解析 G-code 分层与轨迹…"); await nextPaint();
    const gcode = await zip.file(path).async("string"), slice = await zip.file("Metadata/slice_info.config")?.async("string"), platePath = Object.keys(zip.files).find((n) => /Metadata\/plate_\d+\.json$/i.test(n)), plate = platePath ? await zip.file(platePath).async("string") : "";
    const parsed = parseGcode(gcode);
    if (!parsed.layers.length) throw new Error("没有识别到分层信息；请确认文件由 Bambu Studio 导出并包含 CHANGE_LAYER 标记。");
    Object.assign(state, { file, gcode, path, parsed, names: parseObjectNames(slice, plate) }); state.geometry = []; state.geometryLayer = state.parsed.layers.at(-1)?.number; state.configs = [];
    $("#upload-view").hidden = true; $("#workspace-view").hidden = false; render();
    const pauseCount = state.parsed.layers.filter((layer) => layer.hasPause).length;
    msg(pauseCount ? `导入完成：已识别 ${state.parsed.totalLayers} 层、${pauseCount} 个 Bambu 已有暂停层。请点击橙色暂停层配置热封。` : `导入完成：已识别 ${state.parsed.totalLayers} 层，但文件中没有 Bambu 暂停；请先在 Bambu Studio 添加暂停后重新导入。`, pauseCount ? "success" : "warning");
  } catch (e) { msg(`导入失败：${e.message || "文件解析失败。"}`, "error"); } finally { drop.classList.remove("is-loading"); }
}

async function exportFile() {
  hideMsg();
  try {
    const result = generateGcode(state.gcode, state.configs), zip = await JSZip.loadAsync(await state.file.arrayBuffer()); zip.file(state.path, result.text);
    zip.file(state.path.replace(/\.gcode$/i, ".gcode.md5"), md5Text(result.text));
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${state.file.name.replace(/\.gcode\.3mf$/i, "").replace(/\.3mf$/i, "")}_热封后处理.gcode.3mf`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    msg(`已在 ${result.operations.length} 个 Bambu 已有暂停层后加入热封；没有新增暂停，且所有热封轨迹均不含 E 挤出参数。`, "success");
  } catch (e) { msg(e.message || "导出失败。", "error"); }
}

drop.onclick = () => fileInput.click(); drop.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && fileInput.click(); fileInput.onchange = () => { const file = fileInput.files[0]; fileInput.value = ""; if (file) load(file); };
["dragenter","dragover"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add("is-dragging"); })); ["dragleave","drop"].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove("is-dragging"); })); drop.ondrop = (e) => e.dataTransfer.files[0] && load(e.dataTransfer.files[0]);
$("#change-file").onclick = () => fileInput.click(); $("#export-file").onclick = exportFile;
$("#geometry-layer").onchange = (e) => { state.geometryLayer = Number(e.target.value); renderGeometry(); };
$("#timeline").onclick = (e) => { const tick = e.target.closest("[data-layer].has-pause"); if (!tick || Number(tick.dataset.layer) < 2) return; const layerNumber = Number(tick.dataset.layer), existing = state.configs.find((cfg) => cfg.layerNumber === layerNumber); if (existing) { document.querySelector(`[data-config="${existing.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); return; } state.configs.push(newConfig(layerNumber)); renderConfigs(); configs.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" }); };
configs.onclick = (e) => { const card = e.target.closest("[data-config]"); if (!card) return; const cfg = state.configs.find((c) => c.id === card.dataset.config), action = e.target.closest("[data-action]")?.dataset.action; if (action === "remove") state.configs = state.configs.filter((c) => c.id !== cfg.id); if (action) renderConfigs(); };
configs.onchange = (e) => { const card = e.target.closest("[data-config]"); if (!card) return; const cfg = state.configs.find((c) => c.id === card.dataset.config), field = e.target.dataset.field; if (field === "outerRepeat") cfg.outerRepeat = Number(e.target.value); if (field === "loopSpeedFactor") cfg.speedFactors[Number(e.target.dataset.loopIndex)] = Number(e.target.value); if (field === "loopOffsetDistance") cfg.offsetDistances[Number(e.target.dataset.loopIndex)] = Number(e.target.value); if (field === "region") cfg.regionIds = [...card.querySelectorAll('[data-field="region"]:checked')].map((x) => x.value); renderConfigs(); };
configs.oninput = (e) => {
  if (e.target.dataset.field !== 'loopSpeedFactor' || e.target.type !== "range") return;
  const card = e.target.closest("[data-config]");
  const cfg = state.configs.find((c) => c.id === card.dataset.config);
  const loopIndex = Number(e.target.dataset.loopIndex), loop = e.target.closest(".loop-speed"), factor = Number(e.target.value), percent = Math.round(factor * 100), track = getReplayCandidates(state.parsed, cfg.layerNumber, cfg.objectIds, cfg.regionIds).tracks[loopIndex];
  cfg.speedFactors[loopIndex] = factor;
  loop.querySelector(".speed-label output").textContent = `${factor.toFixed(1)} × · ${percent}%`;
  loop.querySelectorAll(".speed-scale span").forEach((span, index) => span.classList.toggle("is-current", index === Math.round(factor * 10)));
  const note = loop.querySelector(".speed-note");
  note.classList.toggle("is-error", factor === 0);
  note.textContent = factor === 0 ? "速度为 0 无法复走，请至少选择 0.1。" : `原路径 ${mmPerSecond(track.originalFeed).toFixed(1)} mm/s，复走 ${mmPerSecond(track.originalFeed * factor).toFixed(1)} mm/s`;
  const selected = getReplayCandidates(state.parsed, cfg.layerNumber, cfg.objectIds, cfg.regionIds).tracks.slice(0, cfg.circles);
  card.querySelector(".path-stats span:last-child b").textContent = selected.length ? selected.map((item, index) => `${loopName(item, index)} ${mmPerSecond(item.originalFeed * factorAt(cfg, index)).toFixed(1)} mm/s`).join(" / ") : "—";
};
