/* =========================================================
 * Dịch nội dung (Google Translate / Gemini, module translation/)
 * ========================================================= */

let currentTranslateEngine = "default";

function normalizeTranslateEngine(engine) {
  const v = String(engine || "").toLowerCase();
  if (v === "gemini") return "gemini";
  if (v === "gemini-web" || v === "web" || v === "gemini_web") return "gemini-web";
  if (v === "none" || v === "off" || v === "no") return "none";
  return "default";
}

function getTranslateEngine() {
  const live = document.querySelector("#ocrFrameLangBar .rs-translate-engine")
    || document.querySelector(".rs-ocr-frame-langs .rs-translate-engine")
    || document.querySelector(".rs-ocr-lang-bar .rs-translate-engine");
  if (live && live.value) return normalizeTranslateEngine(live.value);
  return normalizeTranslateEngine(currentTranslateEngine);
}

function syncTranslateEngineSelects(engine) {
  const value = normalizeTranslateEngine(engine);
  if (value === "none") return;
  currentTranslateEngine = value;
  document.querySelectorAll(".rs-translate-engine").forEach((sel) => {
    if (sel.closest("#ocrFrameLangBar") || sel.closest(".rs-ocr-lang-bar")) return;
    if (sel.value !== value) sel.value = value;
  });
}

function bindTranslateEngineSelect(sel) {
  if (!sel) return;
  if (sel.dataset.boundEngine === "1") return;
  sel.dataset.boundEngine = "1";
  const isOcr = !!(sel.closest("#ocrFrameLangBar") || sel.closest(".rs-ocr-lang-bar"));
  if (!isOcr) sel.value = getTranslateEngine();
  sel.addEventListener("change", async () => {
    if (normalizeTranslateEngine(sel.value) === "none") return;
    await applyTranslateEngine(sel.value);
  });
}

async function applyTranslateEngine(engine) {
  const value = normalizeTranslateEngine(engine);
  if (value === "none") return;
  syncTranslateEngineSelects(value);
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.set_translate_engine) return;
  try {
    await window.pywebview.api.set_translate_engine(value);
  } catch (e) {}
}

async function saveGeminiApiKey() {
  const input = document.getElementById("geminiApiKey");
  const modelEl = document.getElementById("geminiModel");
  const key = input ? String(input.value || "").trim() : "";
  const model = modelEl ? String(modelEl.value || "").trim() : "gemini-3.7-flash";
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.set_gemini_api_key) return;
  const res = await window.pywebview.api.set_gemini_api_key(key, model);
  if (input && key) input.value = "";
  const hint = res && (res.key_hint || res.key_hint);
  if (input && hint) input.placeholder = "Đã lưu " + hint;
  const msg = key ? "Đã lưu Gemini API key + model" : "Đã lưu model Gemini";
  if (typeof showToast === "function") showToast(msg, "ok");
  else if (typeof showCheck === "function") showCheck(msg + ".", () => {});
}

async function loadTranslateSettings() {
  document.querySelectorAll(".rs-translate-engine").forEach(bindTranslateEngineSelect);
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_translate_settings) return;
  try {
    const res = await window.pywebview.api.get_translate_settings();
    if (!res) return;
    syncTranslateEngineSelects(res.engine);
    const input = document.getElementById("geminiApiKey");
    const modelEl = document.getElementById("geminiModel");
    const hasKey = !!(res.has_key || res.has_key);
    const hint = res.key_hint || res.key_hint;
    if (input && hasKey && hint) input.placeholder = "Đã lưu " + hint;
    if (modelEl && res.model) {
      const opt = Array.from(modelEl.options).some((o) => o.value === res.model);
      if (!opt) {
        const extra = document.createElement("option");
        extra.value = res.model;
        extra.textContent = res.model;
        modelEl.appendChild(extra);
      }
      modelEl.value = res.model;
    }
  } catch (e) {}
}

window.addEventListener("pywebviewready", loadTranslateSettings);
document.addEventListener("DOMContentLoaded", loadTranslateSettings);
window.saveGeminiApiKey = saveGeminiApiKey;
window.bindTranslateEngineSelect = bindTranslateEngineSelect;
window.getTranslateEngine = getTranslateEngine;
window.normalizeTranslateEngine = normalizeTranslateEngine;
window.openGeminiWebTranslate = openGeminiWebTranslate;
window.openGeminiWebFromOcr = openGeminiWebFromOcr;

function geminiTargetLangName(targetLang) {
  const dstName = {
    vi: "tiếng Việt",
    en: "English",
    zh: "中文",
    "zh-CN": "中文",
    ja: "日本語",
    ko: "한국어",
    th: "ไทย",
    id: "Bahasa Indonesia",
  };
  return dstName[targetLang] || targetLang || "tiếng Việt";
}

async function openGeminiWebTranslate(text, targetLang, options) {
  const src = String(text || "").trim();
  if (!src) return false;
  const dst = geminiTargetLangName(targetLang);
  const asSrt = !!(options && options.srt);
  const prompt = asSrt
    ? (
      "Dịch file phụ đề SRT sau sang " + dst + ".\n" +
      "BẮT BUỘC giữ nguyên định dạng SRT chuẩn:\n" +
      "- số thứ tự cue\n" +
      "- dòng thời gian HH:MM:SS,mmm --> HH:MM:SS,mmm (không được sửa mốc thời gian)\n" +
      "- chỉ dịch phần nội dung chữ dưới dòng thời gian\n" +
      "Trả về đúng file SRT hoàn chỉnh. Không markdown, không giải thích, không thêm text ngoài SRT.\n\n" +
      src
    )
    : ("Dịch đoạn sau sang " + dst + ". Chỉ trả về bản dịch, không giải thích.\n\n" + src);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(prompt);
    }
  } catch (e) {}
  if (window.pywebview && window.pywebview.api && window.pywebview.api.open_url) {
    await window.pywebview.api.open_url("https://gemini.google.com/app");
  } else {
    window.open("https://gemini.google.com/app", "_blank");
  }
  return true;
}

function openGeminiWebFromOcr() {
  const srcEl = document.getElementById("ocrFrameSrc");
  const dstSel = document.getElementById("ocrFrameLangDst");
  const text = srcEl ? srcEl.value : "";
  const dst = dstSel ? dstSel.value : "vi";
  return openGeminiWebTranslate(text, dst);
}

function getTranslateLangs() {
  const src = document.getElementById("translateSrcLang");
  const dst = document.getElementById("translateTargetLang");
  return {
    src: src ? src.value : "auto",
    dst: dst ? dst.value : "vi",
  };
}

async function translateContentInput() {
  const ta = document.getElementById("txtContent");
  if (!ta || !window.pywebview) return;
  const lines = ta.value.split("\n");
  const keep = lines.map((l) => l);
  const idx = [];
  const payload = [];
  keep.forEach((line, i) => {
    if (line.trim()) {
      idx.push(i);
      payload.push(line);
    }
  });
  if (!payload.length) {
    showCheck("Ô nhập đang trống.", () => {});
    return;
  }
  const { src, dst } = getTranslateLangs();
  const engine = getTranslateEngine();
  const res = await window.pywebview.api.translate_texts(payload, src, dst, engine);
  if (!res || !res.ok) {
    showCheck("Dịch thất bại" + (res && res.error ? ": " + res.error : "."), () => {});
    return;
  }
  (res.texts || []).forEach((t, i) => {
    keep[idx[i]] = t;
  });
  ta.value = keep.join("\n");
}

async function translateContentList() {
  if (!window.pywebview) return;
  const items = document.querySelectorAll(".rs-content-list .rs-item span");
  if (!items.length) {
    showCheck("Danh sách nội dung đang trống.", () => {});
    return;
  }
  const payload = Array.from(items).map((el) => el.textContent);
  const { src, dst } = getTranslateLangs();
  const engine = getTranslateEngine();
  const res = await window.pywebview.api.translate_texts(payload, src, dst, engine);
  if (!res || !res.ok) {
    showCheck("Dịch thất bại" + (res && res.error ? ": " + res.error : "."), () => {});
    return;
  }
  (res.texts || []).forEach((t, i) => {
    if (items[i]) items[i].textContent = t;
  });
}

async function translateAttachedFiles() {
  if (!window.pywebview) return;
  const selected = typeof getSelectedMedia === "function" ? getSelectedMedia() : [];
  if (!selected.length) {
    showCheck("Hãy chọn media trước.", () => {});
    return;
  }
  const paths = [];
  selected.forEach((media) => {
    (media.files || []).forEach((p) => {
      const s = String(p).toLowerCase();
      if (s.endsWith(".txt") || s.endsWith(".srt")) paths.push(p);
    });
  });
  if (!paths.length) {
    showCheck("Media đã chọn chưa đính kèm file .txt hoặc .srt.", () => {});
    return;
  }
  const { src, dst } = getTranslateLangs();
  let engine = getTranslateEngine();
  if (engine === "none") engine = "default";
  const results = await window.pywebview.api.translate_files(paths, src, dst, engine);
  let ok = 0;
  let fail = 0;
  (results || []).forEach((r) => {
    if (r && r.ok && r.out_path) {
      ok += 1;
      selected.forEach((media) => {
        if (!Array.isArray(media.files)) media.files = [];
        if (media.files.includes(r.path) && !media.files.includes(r.out_path)) {
          media.files.push(r.out_path);
          if (typeof updateMediaFilesList === "function") updateMediaFilesList(media.path);
        }
      });
    } else {
      fail += 1;
    }
  });
  showCheck(
    "Đã dịch " + ok + " file" + (fail ? ", lỗi " + fail + " file" : "") + ". File mới gắn kèm (*_vi.txt / *_vi.srt).",
    () => {}
  );
  if (typeof restoreProcessModeFromUi === "function") restoreProcessModeFromUi();
}
