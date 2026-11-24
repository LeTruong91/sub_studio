/* =========================================================
 * Sửa SRT + đưa cue lên track Text + Fast Preview
 * ========================================================= */

let srtEditorState = { path: "", cues: [], mediaPath: "" };

function asAttachedPath(p) {
  return typeof p === "string" ? p : (p && p.path) || "";
}

function mediaFileStem(filePath) {
  const name = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
  return name.replace(/\.[^.]+$/, "");
}

function srtMatchesMedia(srtPath, media) {
  const stem = mediaFileStem(media && media.path).toLowerCase();
  const srtStem = mediaFileStem(srtPath).toLowerCase();
  if (!stem || !srtStem) return false;
  return srtStem === stem || srtStem.startsWith(stem + "_");
}

function rankSrtForMedia(srtPath, media) {
  const stem = mediaFileStem(media && media.path).toLowerCase();
  const srtStem = mediaFileStem(srtPath).toLowerCase();
  if (srtStem === stem + "_edit") return 100;
  if (stem && srtStem.startsWith(stem + "_") && /_[a-z]{2}(-[a-z]+)?$/i.test(srtStem.slice(stem.length))) {
    return 90;
  }
  if (srtStem === stem + "_ocr") return 70;
  if (srtStem === stem) return 60;
  if (stem && srtStem.startsWith(stem + "_")) return 40;
  return 0;
}

function pickSrtPathForMedia(media) {
  if (!media) return "";
  const srts = (media.files || []).map(asAttachedPath).filter((p) => /\.srt$/i.test(p));
  const own = srts.filter((p) => srtMatchesMedia(p, media));
  if (!own.length) return "";
  own.sort((a, b) => {
    const d = rankSrtForMedia(b, media) - rankSrtForMedia(a, media);
    if (d) return d;
    return own.indexOf(b) - own.indexOf(a);
  });
  return own[0];
}

function getTargetMediaForSrt() {
  const selected = typeof getSelectedMedia === "function" ? getSelectedMedia() : [];
  const cur = typeof currentMedia !== "undefined" ? currentMedia : null;
  if (cur && cur.path) {
    const inSel = selected.find((m) => m.path === cur.path);
    if (inSel) return inSel;
    if (!selected.length) return cur;
  }
  if (selected.length === 1) return selected[0];
  return selected[0] || cur || null;
}

function attachSrtToMedia(media, srtPath) {
  if (!media || !srtPath) return;
  if (!Array.isArray(media.files)) media.files = [];
  if (!media.files.includes(srtPath)) media.files.push(srtPath);
  if (typeof updateMediaFilesList === "function") updateMediaFilesList(media.path);
}

function parseSrtClient(raw) {
  const blocks = String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split(/\n\s*\n/);
  const cues = [];
  blocks.forEach((block) => {
    const lines = block.split("\n").map((l) => l.trimEnd());
    if (lines.length < 2) return;
    let timeIdx = 0;
    if (/^\d+$/.test((lines[0] || "").trim()) && lines.length >= 3) timeIdx = 1;
    const timeLine = lines[timeIdx] || "";
    if (!timeLine.includes("-->")) return;
    const [a, b] = timeLine.split("-->");
    const startRaw = String(a || "").trim().split(/\s+/)[0];
    const endRaw = String(b || "").trim().split(/\s+/)[0];
    const text = lines.slice(timeIdx + 1).join("\n").trim();
    cues.push({
      start: srtTsToSec(startRaw),
      end: srtTsToSec(endRaw),
      start_raw: startRaw,
      end_raw: endRaw,
      text,
    });
  });
  return cues;
}

function srtTsToSec(raw) {
  const s = String(raw || "").trim().replace(",", ".");
  const p = s.split(":");
  if (p.length !== 3) return 0;
  const secParts = String(p[2] || "0").split(".");
  const whole = parseInt(secParts[0] || "0", 10) || 0;
  const frac = ((secParts[1] || "0") + "000").slice(0, 3);
  const ms = (parseInt(p[0], 10) || 0) * 3600000 + (parseInt(p[1], 10) || 0) * 60000 + whole * 1000 + (parseInt(frac, 10) || 0);
  return ms / 1000;
}

function srtSecToTs(sec) {
  let ms = Math.round((Number(sec) || 0) * 1000 + 1e-6);
  if (ms < 0) ms = 0;
  const milli = ms % 1000;
  let rest = Math.floor(ms / 1000);
  const s = rest % 60;
  rest = Math.floor(rest / 60);
  const m = rest % 60;
  const h = Math.floor(rest / 60);
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

function srtSecToInput(sec) {
  return (Math.round((Number(sec) || 0) * 1000 + 1e-6) / 1000).toFixed(3);
}

async function loadSrtText(path) {
  const url = "http://127.0.0.1:9876/file?path=" + encodeURIComponent(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Không đọc được file SRT.");
  return res.text();
}

function collectSrtCuesFromEditor(keepOrder) {
  const rows = document.querySelectorAll("#srtEditorList .rs-srt-row");
  const cues = [];
  rows.forEach((row) => {
    const start = parseFloat(row.querySelector(".srt-start").value);
    const end = parseFloat(row.querySelector(".srt-end").value);
    const text = (row.querySelector(".srt-text").value || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    cues.push({ start, end, text, start_raw: srtSecToTs(start), end_raw: srtSecToTs(end) });
  });
  if (!keepOrder) cues.sort((a, b) => a.start - b.start);
  return cues;
}

let srtEditorSelected = new Set();
let srtEditorLastPick = null;

function renderSrtEditorList() {
  const list = document.getElementById("srtEditorList");
  if (!list) return;
  if (!srtEditorState.cues.length) {
    list.innerHTML = '<div class="rs-fsub">Chưa có câu phụ đề.</div>';
    srtEditorSelected.clear();
    return;
  }
  const maxIdx = srtEditorState.cues.length - 1;
  srtEditorSelected = new Set([...srtEditorSelected].filter((i) => i >= 0 && i <= maxIdx));
  list.innerHTML = srtEditorState.cues
    .map(
      (c, i) => `
      <div class="rs-srt-row${srtEditorSelected.has(i) ? " is-selected" : ""}" data-idx="${i}">
        <input class="srt-pick" type="checkbox" ${srtEditorSelected.has(i) ? "checked" : ""} title="Chọn câu để gộp" onclick="event.preventDefault(); srtEditorToggleSelect(${i}, event)">
        <input class="srt-start" type="number" step="0.001" min="0" value="${srtSecToInput(c.start)}" title="Bắt đầu (giây)">
        <input class="srt-end" type="number" step="0.001" min="0" value="${srtSecToInput(c.end)}" title="Kết thúc (giây)">
        <textarea class="srt-text">${escapeHtml(c.text || "")}</textarea>
        <button type="button" class="rs-tl-btn" title="Xóa câu" onclick="srtEditorRemoveCue(${i})">×</button>
      </div>`
    )
    .join("");
}

function srtEditorToggleSelect(idx, event) {
  const e = event || window.event;
  if (e) e.stopPropagation();
  if (e && e.shiftKey && srtEditorLastPick != null) {
    const a = Math.min(srtEditorLastPick, idx);
    const b = Math.max(srtEditorLastPick, idx);
    for (let i = a; i <= b; i++) srtEditorSelected.add(i);
  } else if (e && (e.ctrlKey || e.metaKey)) {
    if (srtEditorSelected.has(idx)) srtEditorSelected.delete(idx);
    else srtEditorSelected.add(idx);
  } else {
    const on = !srtEditorSelected.has(idx);
    srtEditorSelected.clear();
    if (on) srtEditorSelected.add(idx);
  }
  srtEditorLastPick = idx;
  document.querySelectorAll("#srtEditorList .rs-srt-row").forEach((row) => {
    const i = Number(row.dataset.idx);
    const picked = srtEditorSelected.has(i);
    row.classList.toggle("is-selected", picked);
    const cb = row.querySelector(".srt-pick");
    if (cb) cb.checked = picked;
  });
}

function srtEditorMergeSelected() {
  hideSrtSplitMenu();
  const rows = Array.from(document.querySelectorAll("#srtEditorList .rs-srt-row"));
  const cues = rows.map((r) => ({
    start: parseFloat(r.querySelector(".srt-start").value),
    end: parseFloat(r.querySelector(".srt-end").value),
    text: (r.querySelector(".srt-text").value || "").trim(),
  }));
  const idxs = [...srtEditorSelected].filter((i) => i >= 0 && i < cues.length).sort((a, b) => a - b);
  if (idxs.length < 2) {
    showCheck("Hãy chọn ít nhất 2 câu (tick ô bên trái, Shift để chọn dải) rồi gộp.", () => {});
    return;
  }
  const picked = idxs.map((i) => cues[i]);
  const start = Math.min(...picked.map((c) => (Number.isFinite(c.start) ? c.start : Infinity)));
  const end = Math.max(...picked.map((c) => (Number.isFinite(c.end) ? c.end : 0)));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    showCheck("Thời gian các câu đã chọn không hợp lệ.", () => {});
    return;
  }
  const text = picked.map((c) => c.text).filter(Boolean).join(" ");
  const keep = cues.filter((_, i) => !srtEditorSelected.has(i));
  keep.splice(idxs[0], 0, { start, end, text });
  keep.sort((a, b) => a.start - b.start);
  srtEditorState.cues = keep;
  const mergedIdx = srtEditorState.cues.findIndex((c) => c.start === start && c.end === end && c.text === text);
  srtEditorSelected = new Set([mergedIdx >= 0 ? mergedIdx : idxs[0]]);
  srtEditorLastPick = [...srtEditorSelected][0];
  renderSrtEditorList();
}

function srtEditorAddCue() {
  srtEditorState.cues = collectSrtCuesFromEditor();
  const last = srtEditorState.cues[srtEditorState.cues.length - 1];
  const start = last ? last.end : (typeof videoState !== "undefined" ? videoState.currentTime : 0);
  srtEditorState.cues.push({ start, end: start + 2, text: "" });
  renderSrtEditorList();
}

function srtEditorRemoveCue(idx) {
  srtEditorState.cues = collectSrtCuesFromEditor();
  srtEditorState.cues.splice(idx, 1);
  renderSrtEditorList();
}

let srtSplitMenuTarget = null;

function hideSrtSplitMenu() {
  const menu = document.getElementById("srtSplitContextMenu");
  if (menu) menu.style.display = "none";
  srtSplitMenuTarget = null;
}

function srtEditorSplitCueAt(idx, caret) {
  const rows = document.querySelectorAll("#srtEditorList .rs-srt-row");
  const row = rows[idx];
  if (!row) return;
  const start = parseFloat(row.querySelector(".srt-start").value);
  const end = parseFloat(row.querySelector(".srt-end").value);
  const raw = String(row.querySelector(".srt-text").value || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const pos = Math.max(0, Math.min(raw.length, Number(caret) || 0));
  const left = raw.slice(0, pos).trim();
  const right = raw.slice(pos).trim();
  if (!left || !right) {
    showCheck("Đặt con trỏ giữa nội dung câu rồi chọn Tách câu.", () => {});
    return;
  }
  const cues = [];
  rows.forEach((r) => {
    cues.push({
      start: parseFloat(r.querySelector(".srt-start").value),
      end: parseFloat(r.querySelector(".srt-end").value),
      text: r.querySelector(".srt-text").value || "",
    });
  });
  const dur = Math.max(0.2, end - start);
  const ratio = pos / Math.max(1, raw.length);
  let mid = start + dur * ratio;
  const minD = Math.min(0.2, dur / 2);
  if (mid - start < minD) mid = start + minD;
  if (end - mid < minD) mid = end - minD;
  cues.splice(idx, 1, { start, end: mid, text: left }, { start: mid, end, text: right });
  srtEditorState.cues = cues;
  renderSrtEditorList();
  const next = document.querySelector(`#srtEditorList .rs-srt-row[data-idx="${idx + 1}"] .srt-text`);
  if (next) {
    next.focus();
    next.setSelectionRange(0, 0);
  }
}

function initSrtEditorSplitMenu() {
  const list = document.getElementById("srtEditorList");
  const menu = document.getElementById("srtSplitContextMenu");
  const splitItem = document.getElementById("srtSplitCueItem");
  const mergeItem = document.getElementById("srtMergeCueItem");
  if (!list || !menu || !splitItem || !mergeItem || splitItem.dataset.bound) return;
  splitItem.dataset.bound = "1";

  list.addEventListener("contextmenu", (e) => {
    const row = e.target && e.target.closest ? e.target.closest(".rs-srt-row") : null;
    if (!row) return;
    e.preventDefault();
    const ta = e.target.closest(".srt-text");
    srtSplitMenuTarget = {
      idx: Number(row.dataset.idx),
      caret: ta ? ta.selectionStart : null,
    };
    splitItem.style.display = ta ? "flex" : "none";
    mergeItem.style.display = srtEditorSelected.size >= 2 ? "flex" : "none";
    if (splitItem.style.display === "none" && mergeItem.style.display === "none") return;
    menu.style.display = "block";
    const x = Math.min(e.clientX, window.innerWidth - 220);
    const y = Math.min(e.clientY, window.innerHeight - 90);
    menu.style.left = x + "px";
    menu.style.top = y + "px";
  });

  splitItem.addEventListener("click", () => {
    const t = srtSplitMenuTarget;
    hideSrtSplitMenu();
    if (!t || !Number.isFinite(t.idx) || t.caret == null) return;
    srtEditorSplitCueAt(t.idx, t.caret);
  });
  mergeItem.addEventListener("click", () => {
    srtEditorMergeSelected();
  });

  document.addEventListener("click", (e) => {
    if (menu.contains(e.target)) return;
    hideSrtSplitMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideSrtSplitMenu();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSrtEditorSplitMenu);
} else {
  initSrtEditorSplitMenu();
}

function closeSrtEditor() {
  const dlg = document.getElementById("srtEditorDialog");
  if (dlg) dlg.classList.remove("show");
}

async function openSrtEditor(path) {
  const dlg = document.getElementById("srtEditorDialog");
  if (!dlg) return;
  let filePath = asAttachedPath(path);
  let media = getTargetMediaForSrt();
  if (filePath) {
    const list = typeof mediaList !== "undefined" ? mediaList : [];
    const owner = list.find(
      (m) =>
        (m.files || []).map(asAttachedPath).includes(filePath) || srtMatchesMedia(filePath, m)
    );
    if (owner) media = owner;
  } else {
    filePath = pickSrtPathForMedia(media);
  }
  if (filePath) {
    try {
      const raw = await loadSrtText(filePath);
      srtEditorState = {
        path: filePath,
        cues: parseSrtClient(raw),
        mediaPath: (media && media.path) || "",
      };
    } catch (e) {
      showCheck("Không mở được SRT: " + (e.message || e), () => {});
      return;
    }
  } else {
    srtEditorState = { path: "", cues: [], mediaPath: (media && media.path) || "" };
  }
  const pathEl = document.getElementById("srtEditorPath");
  if (pathEl) {
    const videoName = media ? mediaFileStem(media.path) || media.name : "";
    pathEl.textContent = srtEditorState.path
      ? (videoName ? videoName + " — " : "") + srtEditorState.path
      : videoName
        ? "Chưa có SRT cho «" + videoName + "» — lưu sẽ tạo file mới"
        : "(chưa gắn file — lưu sẽ tạo file mới nếu có video đang chọn)";
  }
  renderSrtEditorList();
  dlg.classList.add("show");
}

async function importSrtCuesToTextTrack(cues, srtPath) {
  if (typeof timelineLayers === "undefined" || typeof createLayer !== "function") return;
  const list = cues || [];
  timelineLayers = timelineLayers.filter((l) => !(l.data && l.data.fromSrtImport));
  if (typeof closePropsIfEditingMissing === "function") closePropsIfEditingMissing();
  for (const cue of list) {
    const start = Math.max(0, Number(cue.start) || 0);
    let end = Math.max(start + 0.2, Number(cue.end) || start + 0.2);
    if (typeof videoState !== "undefined" && videoState.duration) {
      end = Math.min(end, videoState.duration);
    }
    const layer = await createLayer("sub", start, end);
    layer.data.fromSrtImport = true;
    layer.data.userFileSrt = false;
    layer.data.applyStyleToAllSubs = true;
    layer.data.text = cue.text || "";
    layer.data.srtPath = srtPath || "";
    const styleSrc =
      (typeof sharedSubStyle !== "undefined" && sharedSubStyle) ||
      (timelineLayers.find((l) => l.type === "sub" && l.data) || {}).data;
    if (typeof stampSubStyle === "function" && styleSrc) {
      stampSubStyle(layer.data, typeof collectSubStyle === "function" ? collectSubStyle(styleSrc) : styleSrc);
    }
    const posSrc = timelineLayers.find((l) => l.type === "sub" && l.data && l.data.x != null);
    if (posSrc && posSrc.data) {
      layer.data.x = posSrc.data.x;
      layer.data.y = posSrc.data.y;
      layer.data.width = posSrc.data.width;
      layer.data.height = posSrc.data.height;
    } else {
      layer.data.y = 0.78;
      layer.data.height = 0.18;
      layer.data.width = 0.9;
      layer.data.x = 0.05;
    }
    layer.row = assignRowForNewLayer("sub", start, end);
    timelineLayers.push(layer);
  }
  renderTimeline();
  if (typeof syncLayerGuides === "function") syncLayerGuides();
}

async function saveSrtEditor() {
  srtEditorState.cues = collectSrtCuesFromEditor();
  if (!srtEditorState.cues.length) {
    showCheck("Chưa có câu phụ đề để lưu.", () => {});
    return;
  }
  let media = getTargetMediaForSrt();
  if (srtEditorState.mediaPath && typeof mediaList !== "undefined") {
    const owner = mediaList.find((m) => m.path === srtEditorState.mediaPath);
    if (owner) media = owner;
  }
  let path = srtEditorState.path;
  if (path && media && !srtMatchesMedia(path, media)) path = "";
  if (!path && media && media.path) {
    const stem = String(media.path).replace(/\.[^.\\/]+$/, "");
    path = stem + "_edit.srt";
  }
  if (!path) {
    showCheck("Hãy chọn video hoặc mở một file SRT trước.", () => {});
    return;
  }
  const res = await window.pywebview.api.write_srt_file(path, srtEditorState.cues);
  if (!res || !res.ok) {
    showCheck("Không lưu được SRT" + (res && res.error ? ": " + res.error : "."), () => {});
    return;
  }
  srtEditorState.path = res.path || path;
  srtEditorState.mediaPath = (media && media.path) || srtEditorState.mediaPath || "";
  attachSrtToMedia(media, srtEditorState.path);
  await importSrtCuesToTextTrack(srtEditorState.cues, srtEditorState.path);
  closeSrtEditor();
  showCheck("Đã lưu SRT và đưa câu phụ đề lên track Text.", () => {});
}

async function pickSubtitleToTextTrack() {
  if (!window.pywebview) return;
  const files = await window.pywebview.api.pick_files_by_type("text");
  if (!files || !files.length) return;
  const srt = files.find((f) => /\.srt$/i.test(f.path || f.name)) || files[0];
  if (!srt || !srt.path) return;
  let cues = [];
  try {
    cues = parseSrtClient(await loadSrtText(srt.path));
  } catch (e) {
    showCheck("Không đọc được file sub.", () => {});
    return;
  }
  if (!cues.length) {
    showCheck("File không có câu SRT hợp lệ.", () => {});
    return;
  }
  const media = getTargetMediaForSrt();
  srtEditorState = { path: srt.path, cues, mediaPath: (media && media.path) || "" };
  attachSrtToMedia(media, srt.path);
  await importSrtCuesToTextTrack(cues, srt.path);
  openSrtEditor(srt.path);
}

async function runFastPreview() {
  const selected = typeof getSelectedMedia === "function" ? getSelectedMedia() : [];
  if (!selected.length) {
    showCheck("Hãy chọn một video để Fast Preview.", () => {});
    return;
  }
  const contents = typeof getContentList === "function" ? getContentList() : [];
  const input = document.getElementById("threadVal") ? document.getElementById("threadVal").value : 1;
  const mode = document.getElementById("renderMode") ? document.getElementById("renderMode").value : "0";
  const renderSize = currentOutputSize();
  const t0 = typeof videoState !== "undefined" ? videoState.currentTime || 0 : 0;
  const dur = Math.min(5, Math.max(0.8, (videoState.duration || t0 + 5) - t0));
  const buidConfig = buildRenderConfig(renderSize.width, renderSize.height, input, mode, contents);
  const config = {
    files: [{ path: selected[0].path, name: selected[0].name, duration: selected[0].duration, files: selected[0].files || [] }],
    RenameVideo: false,
    AddOverlay: document.getElementById("RenderOverlay") ? document.getElementById("RenderOverlay").checked : true,
    AddAudio: document.getElementById("RenderAudio") ? document.getElementById("RenderAudio").checked : true,
    RenderRenderAutoTrim: false,
    AddFillter: document.getElementById("RenderFillter") ? document.getElementById("RenderFillter").checked : false,
    use_two_screen: typeof renderTwoScreenSelected === "function" && renderTwoScreenSelected(),
    muteOriginalAudio: false,
    audioConfig: {},
    preview_start: t0,
    preview_duration: dur,
    ...buidConfig,
  };
  try {
    updateMediaStatus(selected[0].path, "Fast Preview...", "processing");
    const res = await window.pywebview.api.generate_fast_preview(config);
    if (!res || !res.success) {
      showCheck("Fast Preview lỗi" + (res && res.message ? ": " + res.message : "."), () => {});
      return;
    }
    const url = "http://127.0.0.1:9876/file?path=" + encodeURIComponent(res.output);
    if (typeof OpenViewVideo === "function") OpenViewVideo(url);
    else if (typeof previewVideo !== "undefined") {
      previewVideo.src = url;
      previewVideo.style.display = "block";
      previewVideo.play().catch(() => {});
    }
  } catch (e) {
    console.error(e);
    showCheck("Fast Preview thất bại.", () => {});
  }
}
