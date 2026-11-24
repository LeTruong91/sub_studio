/* =========================================================
 * OCR phụ đề từ track OCR trên timeline, rồi dịch
 * ========================================================= */

const OCR_SRC_LANGS = [
  ["auto", "Tự nhận"],
  ["zh-CN", "Tiếng Trung"],
  ["en", "Tiếng Anh"],
  ["ja", "Tiếng Nhật"],
  ["ko", "Tiếng Hàn"],
  ["id", "Tiếng Indonesia"],
  ["vi", "Tiếng Việt"],
  ["th", "Tiếng Thái"],
  ["fr", "Tiếng Pháp"],
  ["de", "Tiếng Đức"],
  ["es", "Tiếng Tây Ban Nha"],
  ["ru", "Tiếng Nga"],
];
const OCR_DST_LANGS = [
  ["vi", "Tiếng Việt"],
  ["en", "Tiếng Anh"],
  ["zh-CN", "Tiếng Trung"],
  ["ja", "Tiếng Nhật"],
  ["ko", "Tiếng Hàn"],
  ["id", "Tiếng Indonesia"],
  ["th", "Tiếng Thái"],
  ["fr", "Tiếng Pháp"],
  ["de", "Tiếng Đức"],
  ["es", "Tiếng Tây Ban Nha"],
  ["ru", "Tiếng Nga"],
];

function isOcrUseGpu() {
  const mode = document.getElementById("renderMode");
  const v = mode ? String(mode.value) : "1";
  return v === "0" || v === "1" || v === "2";
}

function ocrLangOptions(list, selected) {
  return list
    .map(([v, n]) => `<option value="${v}"${v === selected ? " selected" : ""}>${n}</option>`)
    .join("");
}

function attachOcrLangBar(div, layer) {
  if (!div || !layer || layer.type !== "ocr") return;
  if (layer.data.autoTranslate === undefined) layer.data.autoTranslate = true;
  if (!layer.data.srcLang || layer.data.srcLang === "auto") layer.data.srcLang = "zh-CN";
  if (!layer.data.dstLang) layer.data.dstLang = "vi";

  const bar = document.createElement("div");
  bar.className = "rs-ocr-lang-bar";
  bar.innerHTML =
    `<label><input type="checkbox" class="rs-ocr-tr-check"${layer.data.autoTranslate !== false && layer.data.translateEngine !== "none" ? " checked" : ""}> Dịch ngay</label>` +
    `<select class="rs-translate-engine" title="Engine dịch"><option value="none">Không dịch</option><option value="default">Default</option><option value="gemini">Gemini API</option><option value="gemini-web">Gemini Web (Pro)</option></select>` +
    `<select class="rs-ocr-src">${ocrLangOptions(OCR_SRC_LANGS, layer.data.srcLang || "zh-CN")}</select>` +
    `<span>→</span>` +
    `<select class="rs-ocr-dst">${ocrLangOptions(OCR_DST_LANGS, layer.data.dstLang || "vi")}</select>`;

  const stop = (e) => {
    e.stopPropagation();
  };
  ["mousedown", "click", "dblclick", "pointerdown"].forEach((ev) => {
    bar.addEventListener(ev, stop);
  });

  const chk = bar.querySelector(".rs-ocr-tr-check");
  const src = bar.querySelector(".rs-ocr-src");
  const dst = bar.querySelector(".rs-ocr-dst");
  const eng = bar.querySelector(".rs-translate-engine");
  if (eng && layer.data.translateEngine) {
    eng.value = layer.data.translateEngine;
  }
  const sync = () => {
    if (eng && eng.value === "none") chk.checked = false;
    layer.data.autoTranslate = !!chk.checked && !(eng && eng.value === "none");
    layer.data.srcLang = src.value || "zh-CN";
    layer.data.dstLang = dst.value || "vi";
    if (eng) layer.data.translateEngine = eng.value || "default";
    src.disabled = !chk.checked;
    dst.disabled = !chk.checked;
    if (eng) eng.disabled = false;
  };
  chk.addEventListener("change", () => {
    if (chk.checked && eng && eng.value === "none") eng.value = "default";
    sync();
  });
  src.addEventListener("change", sync);
  dst.addEventListener("change", sync);
  if (eng) {
    if (typeof bindTranslateEngineSelect === "function") bindTranslateEngineSelect(eng);
    eng.addEventListener("change", sync);
  }
  sync();
  div.appendChild(bar);
}

function collectOcrRegions(layers, duration) {
  const list = layers || (typeof timelineLayers !== "undefined" ? timelineLayers : []);
  const fileDur =
    typeof parseMediaDurationSeconds === "function"
      ? parseMediaDurationSeconds(duration)
      : Number(duration) || 0;
  return list
    .filter((l) => l && l.type === "ocr")
    .map((l) => {
      const d = l.data || {};
      const start =
        typeof effectiveLayerStart === "function" ? effectiveLayerStart(l, fileDur) : Number(l.start) || 0;
      const end =
        typeof effectiveLayerEnd === "function" ? effectiveLayerEnd(l, fileDur) : Number(l.end) || 0;
      return {
        start,
        end,
        x: Number(d.x),
        y: Number(d.y),
        width: Number(d.width),
        height: Number(d.height),
        timelineIsVideo: !!d.timelineIsVideo,
        autoTranslate: d.autoTranslate !== false && d.translateEngine !== "none",
        src_lang: d.srcLang && d.srcLang !== "auto" ? d.srcLang : "zh-CN",
        dst_lang: d.dstLang || "vi",
        translate_engine:
          d.translateEngine ||
          (typeof getTranslateEngine === "function" ? getTranslateEngine() : "default"),
      };
    })
    .filter((r) => r.width > 0 && r.height > 0 && (r.end > r.start || r.timelineIsVideo));
}

const OCR_RUN_IDLE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 5.5v13l11-6.5L8 5.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const OCR_RUN_LIVE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="6.2" fill="currentColor"/></svg>';

function setOcrRunLive(on) {
  const btn = document.getElementById("ocrRunBtn");
  if (!btn) return;
  const live = !!on;
  btn.classList.toggle("rs-ocr-live", live);
  btn.setAttribute("data-tooltip", live ? "Đang OCR…" : "Chạy OCR");
  btn.innerHTML = live ? OCR_RUN_LIVE_ICON : OCR_RUN_IDLE_ICON;
}

async function exportOcrSubtitle() {
  const btn = document.getElementById("ocrRunBtn");
  if (btn && btn.classList.contains("rs-ocr-live")) return false;
  const selected = typeof getSelectedMedia === "function" ? getSelectedMedia() : [];
  if (!selected.length) {
    showCheck("Vui lòng chọn ít nhất một video.", () => {});
    return false;
  }
  if (typeof flushCurrentTracks === "function") flushCurrentTracks();
  const files = [];
  const missing = [];
  selected.forEach((item) => {
    const layers =
      typeof getWorkingLayersForMedia === "function" ? getWorkingLayersForMedia(item) : null;
    const fileDur =
      typeof mediaDurationSeconds === "function"
        ? mediaDurationSeconds(item)
        : typeof parseMediaDurationSeconds === "function"
          ? parseMediaDurationSeconds(item.duration)
          : Number(item.duration) || 0;
    const regions = collectOcrRegions(layers, fileDur);
    if (!regions.length) {
      missing.push(item.name || item.path);
      return;
    }
    files.push({
      path: item.path,
      name: item.name,
      duration: item.duration,
      durationSeconds: fileDur,
      ocr_regions: regions,
      translate_engine:
        (regions[0] && regions[0].translate_engine) ||
        (typeof getTranslateEngine === "function" ? getTranslateEngine() : "default"),
    });
  });
  if (!files.length) {
    showCheck(
      "Chưa có vùng OCR trên track. Thêm khung OCR rồi chạy lại." +
        (missing.length ? "\nThiếu khung: " + missing.join(", ") : ""),
      () => {}
    );
    return false;
  }
  const input = document.getElementById("threadVal");
  const mode = document.getElementById("renderMode");
  const config = {
    files,
    threads: parseInt(input && input.value, 10) || 1,
    render_option: mode ? mode.value : "",
    ocr_region: "box",
    ocr_use_gpu: isOcrUseGpu(),
    translate_engine:
      (files[0] && files[0].translate_engine) ||
      (typeof getTranslateEngine === "function" ? getTranslateEngine() : "default"),
  };
  if (missing.length) {
    missing.forEach((name) => {
      const media = selected.find((x) => (x.name || x.path) === name);
      if (media && typeof updateMediaStatus === "function") {
        updateMediaStatus(media.path, "Chưa có khung OCR", "error");
      }
    });
  }
  files.forEach((item) => updateMediaStatus(item.path, "Đang OCR...", "processing"));
  setOcrRunLive(true);
  try {
    const start = document.getElementById("startBtn");
    const label = document.getElementById("startLabel");
    if (start && label) {
      start.classList.add("rs-running");
      label.innerText = "ĐANG OCR — NHẤN ĐỂ DỪNG";
      start.disabled = false;
    }
    mode_selected = "export-ocr-subtitle";
    processJobKind = "export-ocr-subtitle";
    await window.pywebview.api.generate_ocr_subtitle_batch(config);
    return true;
  } catch (e) {
    console.error(e);
    selected.forEach((item) => updateMediaStatus(item.path, "Lỗi OCR", "error"));
    setOcrRunLive(false);
    return false;
  }
}

function getOcrFrameContext() {
  const srcSel = document.getElementById("ocrFrameLangSrc");
  const dstSel = document.getElementById("ocrFrameLangDst");
  const chk = document.getElementById("ocrFrameTrCheck");
  if (srcSel && dstSel) {
    return {
      src: srcSel.value || "zh-CN",
      dst: dstSel.value || "vi",
      translate: !chk || chk.checked,
    };
  }
  const t = typeof videoState !== "undefined" ? videoState.currentTime || 0 : 0;
  const layers = typeof timelineLayers !== "undefined" ? timelineLayers : [];
  const ocrLayers = layers.filter((l) => l && l.type === "ocr");
  let layer = typeof selectedLayer !== "undefined" && selectedLayer && selectedLayer.type === "ocr" ? selectedLayer : null;
  if (!layer) {
    layer = ocrLayers.find((l) => t >= (l.start || 0) && t <= (l.end || 0)) || ocrLayers[0] || null;
  }
  const d = (layer && layer.data) || {};
  return {
    src: d.srcLang && d.srcLang !== "auto" ? d.srcLang : "zh-CN",
    dst: d.dstLang || "vi",
    translate: !layer || (d.autoTranslate !== false && d.translateEngine !== "none"),
  };
}

function fillOcrFrameLangBar() {
  const src = document.getElementById("ocrFrameLangSrc");
  const dst = document.getElementById("ocrFrameLangDst");
  const chk = document.getElementById("ocrFrameTrCheck");
  if (!src || !dst) return;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem("ocrFrameLang") || "{}") || {};
  } catch (e) {
    saved = {};
  }
  const fromTrack = getOcrFrameContextFromTrack();
  const srcPick = [saved.src, fromTrack.src].find((v) => v && v !== "auto") || "zh-CN";
  src.innerHTML = ocrLangOptions(OCR_SRC_LANGS, srcPick);
  dst.innerHTML = ocrLangOptions(OCR_DST_LANGS, saved.dst || fromTrack.dst || "vi");
  const engSel = document.querySelector("#ocrFrameLangBar .rs-translate-engine");
  if (engSel && saved.engine) engSel.value = saved.engine;
  if (chk) {
    chk.checked = saved.translate !== false && saved.engine !== "none";
    if (engSel && engSel.value === "none") chk.checked = false;
  }
  const persist = () => {
    if (engSel && engSel.value === "none" && chk) chk.checked = false;
    if (chk && chk.checked && engSel && engSel.value === "none") engSel.value = "default";
    try {
      localStorage.setItem(
        "ocrFrameLang",
        JSON.stringify({
          src: src.value,
          dst: dst.value,
          translate: !chk || chk.checked,
          engine: (document.querySelector("#ocrFrameLangBar .rs-translate-engine") || {}).value || "default",
        })
      );
    } catch (e) {}
    const off = chk && !chk.checked;
    src.disabled = !!off;
    dst.disabled = !!off;
  };
  if (!src.dataset.bound) {
    src.dataset.bound = "1";
    if (chk) {
      chk.addEventListener("change", () => {
        if (chk.checked && engSel && engSel.value === "none") engSel.value = "default";
        persist();
      });
    }
    src.addEventListener("change", persist);
    dst.addEventListener("change", persist);
    if (engSel && !engSel.dataset.boundPersist) {
      engSel.dataset.boundPersist = "1";
      engSel.addEventListener("change", persist);
    }
  }
  persist();
}

function getOcrFrameContextFromTrack() {
  const t = typeof videoState !== "undefined" ? videoState.currentTime || 0 : 0;
  const layers = typeof timelineLayers !== "undefined" ? timelineLayers : [];
  const ocrLayers = layers.filter((l) => l && l.type === "ocr");
  let layer = typeof selectedLayer !== "undefined" && selectedLayer && selectedLayer.type === "ocr" ? selectedLayer : null;
  if (!layer) {
    layer = ocrLayers.find((l) => t >= (l.start || 0) && t <= (l.end || 0)) || ocrLayers[0] || null;
  }
  const d = (layer && layer.data) || {};
  return {
    src: d.srcLang && d.srcLang !== "auto" ? d.srcLang : "zh-CN",
    dst: d.dstLang || "vi",
    translate: !layer || (d.autoTranslate !== false && d.translateEngine !== "none"),
  };
}

let ocrQuickPicking = false;
let ocrQuickHasBox = false;

function closeOcrFramePop() {
  const pop = document.getElementById("ocrFramePop");
  if (pop) pop.setAttribute("hidden", "");
  stopOcrQuickPick();
}

function stopOcrQuickPick() {
  ocrQuickPicking = false;
  const overlay = document.getElementById("ocrQuickOverlay");
  const box = document.getElementById("ocrQuickBox");
  const btn = document.querySelector(".rs-ocr-frame-btn");
  if (overlay) overlay.setAttribute("hidden", "");
  if (box) box.setAttribute("hidden", "");
  if (btn) btn.classList.remove("is-picking");
}

function startOcrQuickPick() {
  const overlay = document.getElementById("ocrQuickOverlay");
  const box = document.getElementById("ocrQuickBox");
  const btn = document.querySelector(".rs-ocr-frame-btn");
  const hint = document.getElementById("ocrQuickHint");
  if (!overlay) return;
  ocrQuickPicking = true;
  overlay.removeAttribute("hidden");
  if (box) box.setAttribute("hidden", "");
  ocrQuickHasBox = false;
  if (btn) btn.classList.add("is-picking");
  if (hint) hint.textContent = "Chọn ngôn ngữ, kéo khoanh vùng chữ, rồi bấm lại OCR";
  fillOcrFrameLangBar();
  initOcrQuickPickOnce();
}

function getOcrQuickBoxNorm() {
  const host = document.getElementById("videoContainer");
  const box = document.getElementById("ocrQuickBox");
  if (!host || !box || box.hasAttribute("hidden")) return null;
  const hw = host.clientWidth || 1;
  const hh = host.clientHeight || 1;
  const x = box.offsetLeft / hw;
  const y = box.offsetTop / hh;
  const width = box.offsetWidth / hw;
  const height = box.offsetHeight / hh;
  if (width < 0.02 || height < 0.02) return null;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y)),
    width: Math.max(0.02, Math.min(1 - x, width)),
    height: Math.max(0.02, Math.min(1 - y, height)),
  };
}

function initOcrQuickPickOnce() {
  const overlay = document.getElementById("ocrQuickOverlay");
  const box = document.getElementById("ocrQuickBox");
  if (!overlay || !box || overlay.dataset.bound) return;
  overlay.dataset.bound = "1";
  let mode = null;
  let sx = 0;
  let sy = 0;
  let startLeft = 0;
  let startTop = 0;
  let startW = 0;
  let startH = 0;

  function hostPoint(e) {
    const host = document.getElementById("videoContainer");
    const r = host.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(r.width, e.clientX - r.left)),
      y: Math.max(0, Math.min(r.height, e.clientY - r.top)),
      w: r.width,
      h: r.height,
    };
  }

  overlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest("#ocrQuickToolbar")) return;
    if (e.target.closest && e.target.closest(".crop-handle")) {
      mode = "resize";
      const p = hostPoint(e);
      sx = p.x;
      sy = p.y;
      startLeft = box.offsetLeft;
      startTop = box.offsetTop;
      startW = box.offsetWidth;
      startH = box.offsetHeight;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.target === box) {
      mode = "move";
      const p = hostPoint(e);
      sx = p.x;
      sy = p.y;
      startLeft = box.offsetLeft;
      startTop = box.offsetTop;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    mode = "draw";
    const p = hostPoint(e);
    sx = p.x;
    sy = p.y;
    box.style.left = sx + "px";
    box.style.top = sy + "px";
    box.style.width = "1px";
    box.style.height = "1px";
    box.removeAttribute("hidden");
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!mode || !ocrQuickPicking) return;
    const p = hostPoint(e);
    if (mode === "draw") {
      const x = Math.min(sx, p.x);
      const y = Math.min(sy, p.y);
      box.style.left = x + "px";
      box.style.top = y + "px";
      box.style.width = Math.abs(p.x - sx) + "px";
      box.style.height = Math.abs(p.y - sy) + "px";
    } else if (mode === "move") {
      const nx = Math.max(0, Math.min(p.w - box.offsetWidth, startLeft + (p.x - sx)));
      const ny = Math.max(0, Math.min(p.h - box.offsetHeight, startTop + (p.y - sy)));
      box.style.left = nx + "px";
      box.style.top = ny + "px";
    } else if (mode === "resize") {
      const nw = Math.max(24, Math.min(p.w - startLeft, startW + (p.x - sx)));
      const nh = Math.max(18, Math.min(p.h - startTop, startH + (p.y - sy)));
      box.style.width = nw + "px";
      box.style.height = nh + "px";
    }
  });

  window.addEventListener("mouseup", () => {
    if (!mode) return;
    mode = null;
    ocrQuickHasBox = !!getOcrQuickBoxNorm();
    const hint = document.getElementById("ocrQuickHint");
    if (hint && ocrQuickHasBox) {
      hint.textContent = "Chỉnh khung nếu cần, rồi bấm lại nút OCR (hoặc Dịch vùng này)";
    }
  });
}

function copyOcrFrame(which) {
  const src = (document.getElementById("ocrFrameSrc") || {}).value || "";
  const dst = (document.getElementById("ocrFrameDst") || {}).value || "";
  let text = dst || src;
  if (which === "src") text = src;
  if (which === "dst") text = dst;
  if (which === "both") text = [src, dst].filter(Boolean).join("\n\n");
  if (!text) return;
  const done = () => {
    if (typeof showCheck === "function") showCheck("Đã copy.", () => {});
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    });
  }
}

async function ocrCurrentFrameQuick() {
  if (!ocrQuickPicking) {
    startOcrQuickPick();
    return;
  }
  await runOcrFrameQuickNow();
}

async function runOcrFrameQuickNow() {
  if (!window.pywebview) return;
  const selected = typeof getSelectedMedia === "function" ? getSelectedMedia() : [];
  const media = selected[0];
  if (!media || !media.path) {
    showCheck("Hãy chọn video đang xem trên preview.", () => {});
    return;
  }
  const picked = getOcrQuickBoxNorm();
  if (!picked) {
    showCheck("Hãy kéo chọn vùng chữ trên preview trước khi dịch.", () => {});
    if (!ocrQuickPicking) startOcrQuickPick();
    return;
  }
  const t = previewVideo && previewVideo.currentTime != null
    ? previewVideo.currentTime
    : (typeof videoState !== "undefined" ? videoState.currentTime : 0);
  const ctx = getOcrFrameContext();
  const srcEl = document.getElementById("ocrFrameSrc");
  const dstEl = document.getElementById("ocrFrameDst");
  const pop = document.getElementById("ocrFramePop");
  if (srcEl) srcEl.value = "Đang OCR...";
  if (dstEl) dstEl.value = "";
  if (pop) pop.removeAttribute("hidden");
  try {
    const res = await window.pywebview.api.ocr_frame_quick(
      media.path,
      t,
      picked,
      ctx.src,
      ctx.dst,
      ctx.translate,
      isOcrUseGpu(),
      typeof getTranslateEngine === "function" ? getTranslateEngine() : "default"
    );
    if (!res || !res.ok) {
      if (srcEl) srcEl.value = "";
      showCheck(res && res.error ? res.error : "OCR frame thất bại.", () => {});
      return;
    }
    if (srcEl) srcEl.value = res.text || "";
    const engine = typeof getTranslateEngine === "function" ? getTranslateEngine() : "default";
    if ((res.need_web || engine === "gemini-web") && res.text) {
      await openGeminiWebTranslate(res.text, ctx.dst);
      if (dstEl) {
        dstEl.value = "";
        dstEl.placeholder = "Đã mở Gemini Pro và copy nội dung. Dán bản dịch vào đây.";
      }
    } else if (dstEl) {
      dstEl.value = res.translated || "";
      if (res.error && !res.translated) dstEl.value = res.error;
    }
  } catch (e) {
    console.error(e);
    showCheck("OCR frame lỗi.", () => {});
  }
}

let geminiWebOcrState = { mediaPath: "", srtPath: "", dstLang: "vi", cues: [] };

function normalizeSrtTs(raw, fallbackSec) {
  const s = String(raw || "").trim().replace(".", ",");
  if (/^\d{1,2}:\d{2}:\d{2},\d{1,3}$/.test(s)) {
    const [hms, ms] = s.split(",");
    return hms.replace(/^(\d):/, "0$1") + "," + String(ms + "000").slice(0, 3);
  }
  if (typeof srtSecToTs === "function") return srtSecToTs(fallbackSec);
  return s;
}

function cuesToSrtText(cues) {
  return (cues || [])
    .map((c, i) => {
      const start = normalizeSrtTs(c.start_raw, c.start);
      const end = normalizeSrtTs(c.end_raw, c.end);
      const text = String(c.text || "").trim();
      return String(i + 1) + "\n" + start + " --> " + end + "\n" + text;
    })
    .join("\n\n") + "\n";
}

function extractPlainTranslateLines(body) {
  return String(body || "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^\d+$/.test(s) && !s.includes("-->"))
    .map((s) => s.replace(/^\d+[\.\)\-:]\s*/, "").trim())
    .filter(Boolean);
}

function mergePastedSrtCues(origCues, pasted) {
  let body = String(pasted || "").replace(/\r\n/g, "\n").trim();
  body = body.replace(/^```(?:srt)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!body) return null;
  const orig = origCues || [];
  const parsed = typeof parseSrtClient === "function" ? parseSrtClient(body) : [];
  const fromSrt = parsed.filter((c) => String(c.text || "").trim());
  if (fromSrt.length) {
    return fromSrt.map((p) => ({
      start: p.start,
      end: p.end,
      start_raw: p.start_raw || normalizeSrtTs("", p.start),
      end_raw: p.end_raw || normalizeSrtTs("", p.end),
      text: String(p.text || "").trim(),
    }));
  }
  const lines = extractPlainTranslateLines(body);
  if (!lines.length) return null;
  const lastOrig = orig[orig.length - 1];
  return lines.map((text, i) => {
    const o = orig[i];
    if (o) {
      return {
        start: o.start,
        end: o.end,
        start_raw: o.start_raw || normalizeSrtTs("", o.start),
        end_raw: o.end_raw || normalizeSrtTs("", o.end),
        text,
      };
    }
    const start = (lastOrig ? Number(lastOrig.end) || 0 : 0) + (i - orig.length) * 2;
    return {
      start,
      end: start + 2,
      start_raw: normalizeSrtTs("", start),
      end_raw: normalizeSrtTs("", start + 2),
      text,
    };
  });
}

function closeGeminiWebOcrDialog() {
  const dlg = document.getElementById("geminiWebOcrDialog");
  if (dlg) dlg.classList.remove("show");
}

async function openGeminiWebOcrDialog(mediaPath, srtPath, dstLang) {
  const dlg = document.getElementById("geminiWebOcrDialog");
  if (!dlg || !srtPath) return;
  let cues = [];
  try {
    const raw = typeof loadSrtText === "function" ? await loadSrtText(srtPath) : "";
    cues = typeof parseSrtClient === "function" ? parseSrtClient(raw) : [];
  } catch (e) {
    if (typeof showCheck === "function") showCheck("Không đọc được SRT gốc.", () => {});
    return;
  }
  if (!cues.length) {
    if (typeof showCheck === "function") showCheck("SRT gốc không có câu.", () => {});
    return;
  }
  geminiWebOcrState = {
    mediaPath: mediaPath || "",
    srtPath,
    dstLang: dstLang || "vi",
    cues,
  };
  const srcEl = document.getElementById("geminiWebOcrSrc");
  const dstEl = document.getElementById("geminiWebOcrDst");
  if (srcEl) srcEl.value = cuesToSrtText(cues);
  if (dstEl) dstEl.value = "";
  dlg.classList.add("show");
}

function openGeminiWebFromRegionOcr() {
  const srcEl = document.getElementById("geminiWebOcrSrc");
  const text = srcEl && srcEl.value.trim() ? srcEl.value : cuesToSrtText(geminiWebOcrState.cues);
  if (typeof openGeminiWebTranslate === "function") {
    return openGeminiWebTranslate(text, geminiWebOcrState.dstLang, { srt: true });
  }
}

async function saveGeminiWebOcrTranslation() {
  const dstEl = document.getElementById("geminiWebOcrDst");
  const pasted = dstEl ? dstEl.value : "";
  const cues = mergePastedSrtCues(geminiWebOcrState.cues, pasted);
  if (!cues) {
    showCheck("Ô dán đang trống hoặc chưa có nội dung dịch.", () => {});
    return;
  }
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.write_srt_file) {
    showCheck("Chưa kết nối ứng dụng để lưu file.", () => {});
    return;
  }
  const srcPath = geminiWebOcrState.srtPath;
  const tag = String(geminiWebOcrState.dstLang || "vi").replace(/-/g, "");
  const outPath = String(srcPath).replace(/\.srt$/i, "_" + tag + ".srt");
  const res = await window.pywebview.api.write_srt_file(outPath, cues);
  if (!res || !res.ok) {
    showCheck("Không lưu được file dịch" + (res && res.error ? ": " + res.error : "."), () => {});
    return;
  }
  const saved = res.path || outPath;
  const media = (typeof mediaList !== "undefined" ? mediaList : []).find((x) => x.path === geminiWebOcrState.mediaPath);
  if (media) {
    if (!Array.isArray(media.files)) media.files = [];
    if (!media.files.includes(saved)) media.files.push(saved);
    if (typeof updateMediaFilesList === "function") updateMediaFilesList(media.path);
  }
  if (typeof updateMediaStatusExportSTT === "function") {
    updateMediaStatusExportSTT(geminiWebOcrState.mediaPath, "Đã lưu bản dịch Gemini Web", "success", saved);
  }
  closeGeminiWebOcrDialog();
  if (typeof openSrtEditor === "function") setTimeout(() => openSrtEditor(saved), 200);
}

async function openTranslateSrtWebDialog() {
  const media =
    typeof getTargetMediaForSrt === "function"
      ? getTargetMediaForSrt()
      : (typeof getSelectedMedia === "function" ? getSelectedMedia() : [])[0];
  if (!media) {
    if (typeof showCheck === "function") showCheck("Hãy chọn media trước.", () => {});
    return;
  }
  const asPath = (p) => (typeof p === "string" ? p : (p && p.path) || "");
  let srtPath = typeof pickSrtPathForMedia === "function" ? pickSrtPathForMedia(media) : "";
  if (!srtPath && window.pywebview && window.pywebview.api && window.pywebview.api.pick_files_by_type) {
    const files = await window.pywebview.api.pick_files_by_type("text");
    const first = (files || []).map(asPath).find((p) => /\.srt$/i.test(p));
    if (first) {
      srtPath = first;
      if (!Array.isArray(media.files)) media.files = [];
      if (!media.files.includes(srtPath)) media.files.push(srtPath);
      if (typeof updateMediaFilesList === "function") updateMediaFilesList(media.path);
    }
  }
  if (!srtPath) {
    if (typeof showCheck === "function") showCheck("Chưa có file SRT. Đính kèm hoặc chọn file .srt.", () => {});
    return;
  }
  const dst =
    (typeof collectOcrRegions === "function"
      ? (collectOcrRegions().find((r) => r.dst_lang) || {}).dst_lang
      : "") || "vi";
  const hint = document.getElementById("geminiWebOcrHint");
  if (hint) {
    hint.textContent = "Mở Gemini Pro, copy SRT gốc, dán bản dịch SRT rồi nhấn Lưu.";
  }
  await openGeminiWebOcrDialog(media.path, srtPath, dst);
}

window.closeGeminiWebOcrDialog = closeGeminiWebOcrDialog;
window.openGeminiWebFromRegionOcr = openGeminiWebFromRegionOcr;
window.saveGeminiWebOcrTranslation = saveGeminiWebOcrTranslation;
window.openTranslateSrtWebDialog = openTranslateSrtWebDialog;

async function onOcrSubtitleDone(path, outputPath, translatedPath, message, needWeb) {
  if (typeof updateMediaStatusExportSTT === "function") {
    const msg = needWeb
      ? "OCR xong — dán bản dịch Gemini rồi Lưu"
      : translatedPath
        ? "OCR + dịch hoàn tất"
        : "OCR phụ đề hoàn tất";
    updateMediaStatusExportSTT(path, msg, "success", translatedPath || outputPath);
  }
  const media = (typeof mediaList !== "undefined" ? mediaList : []).find((x) => x.path === path);
  if (!media) return;
  if (!Array.isArray(media.files)) media.files = [];
  [outputPath, translatedPath].forEach((p) => {
    if (p && !media.files.includes(p)) media.files.push(p);
  });
  if (typeof updateMediaFilesList === "function") updateMediaFilesList(path);
  if (needWeb && outputPath) {
    const dst =
      (typeof collectOcrRegions === "function"
        ? (collectOcrRegions().find((r) => r.dst_lang) || {}).dst_lang
        : "") || "vi";
    setTimeout(() => openGeminiWebOcrDialog(path, outputPath, dst), 200);
    return;
  }
  const wantTr = collectOcrRegions().some((r) => r.autoTranslate);
  if (wantTr && !translatedPath && typeof showCheck === "function") {
    const engine = typeof getTranslateEngine === "function" ? getTranslateEngine() : "default";
    const name = engine === "gemini" ? "Gemini" : "Google Translate";
    const detail = (message && String(message).trim()) || ("OCR xong nhưng chưa dịch được (" + name + ").");
    showCheck(detail, () => {});
  }
  const editPath = translatedPath || outputPath;
  if (wantTr && editPath && typeof openSrtEditor === "function") {
    setTimeout(() => openSrtEditor(editPath), 200);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", fillOcrFrameLangBar);
} else {
  fillOcrFrameLangBar();
}
