
// renderRuler();
// updateTimeDisplay();
const videoState = {
  duration: 60,
  currentTime: 0,
};
// updateFontStyles(fontSelect.value);
let timelineLayers = [];
let nextLayerId = 1;
let selectedLayer = null;
const loadedFonts = new Set();

function isUsableDuration(n) {
  const d = Number(n);
  return Number.isFinite(d) && d > 0.2;
}

function parseMediaDurationSeconds(raw) {
  if (raw == null || raw === "") return 0;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : 0;
  const s = String(raw).trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const parts = s.split(":").map((p) => Number(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function mediaDurationSeconds(media) {
  if (!media) return 0;
  const fromSec = parseMediaDurationSeconds(media.durationSeconds);
  if (fromSec > 0) return fromSec;
  return parseMediaDurationSeconds(media.duration);
}

function getTimelineDuration() {
  if (typeof currentMedia !== "undefined" && currentMedia) {
    const d = mediaDurationSeconds(currentMedia);
    if (isUsableDuration(d)) return d;
  }
  if (typeof getSelectedMedia === "function") {
    const selected = getSelectedMedia();
    if (selected && selected[0]) {
      const d = mediaDurationSeconds(selected[0]);
      if (isUsableDuration(d)) return d;
    }
  }
  if (isUsableDuration(videoState.duration)) return Number(videoState.duration);
  return 0;
}

function effectiveLayerEnd(layer, duration) {
  const parsed = parseMediaDurationSeconds(duration);
  const data = (layer && layer.data) || {};
  if (data.timelineIsVideo) {
    if (isUsableDuration(parsed)) return parsed;
    return Number(layer && layer.end) || 0;
  }
  const end = Number(layer && layer.end) || 0;
  if (isUsableDuration(parsed) && end > parsed) return parsed;
  return end;
}

function effectiveLayerStart(layer, duration) {
  const start = Math.max(0, Number(layer && layer.start) || 0);
  const end = effectiveLayerEnd(layer, duration);
  if (end > 0 && start >= end) return Math.max(0, end - 0.2);
  return start;
}
/* ---------- LAYER CRUD ---------- */

/* Các loại layer cần khung vị trí (x, y, width, height) trên preview.
   "trim" chỉ cắt theo thời gian, không cần vị trí không gian.
   "image" (ảnh chèn lên video, trước đây là overlay riêng) cũng cần khung vị trí.
   "crop" cắt khung hình trong khoảng thời gian trên track Crop.
   "ocr" khoanh vùng chữ trên video để OCR rồi dịch. */
const LAYER_TYPES_WITH_POSITION = ["blur", "hook", "sub", "text", "image", "crop", "ocr"];

/** Dropdown FontSize là số tượng trưng (px trên preview). JS nhân scale khi render. */
function getTargetRenderSize() {
  if (typeof currentOutputSize === "function") return currentOutputSize();
  const el = document.getElementById("videoResolution");
  const key = el ? el.value : "0";
  const map = typeof resolutions !== "undefined" ? resolutions : null;
  return (map && map[key]) || { width: 1080, height: 1920 };
}

function getPreviewVideoBox() {
  const frame = document.getElementById("previewFrame");
  if (!frame) return { width: 0, height: 0, el: null };
  const r = frame.getBoundingClientRect();
  return { width: r.width, height: r.height, el: frame };
}

/** previewPx / videoPx — ví dụ 22 / 3.14 khi preview ~611px và video 1920. */
function getPreviewFontScale() {
  const { height: h } = getPreviewVideoBox();
  const targetH = getTargetRenderSize().height || 1920;
  if (!h || !targetH) return 1;
  return h / targetH;
}

function getRenderFontScale(renderHeight) {
  const s = getPreviewFontScale();
  const rh = renderHeight || getTargetRenderSize().height || 1920;
  const previewH = getPreviewVideoBox().height;
  if (previewH > 0 && rh > 0) return rh / previewH;
  return s > 0 ? 1 / s : 1;
}

function previewFontPx(size, fallback) {
  const has = size !== undefined && size !== null && size !== "";
  const n = Number(has ? size : fallback);
  const raw = Number.isFinite(n) ? n : Number(fallback) || 0;
  if (raw <= 0) return 0;
  return raw;
}

function fontSizeUiToRender(uiSize, fallback, renderHeight) {
  const n = Number(uiSize);
  const raw = Number.isFinite(n) && n > 0 ? n : Number(fallback) || 0;
  if (raw <= 0) return 0;
  return Math.round(raw * getRenderFontScale(renderHeight));
}

function refreshOverlayTextFonts() {
  if (typeof timelineLayers === "undefined" || !timelineLayers.length) return;
  timelineLayers.forEach((layer) => {
    if (layer.type === "hook" || layer.type === "sub" || layer.type === "text") {
      if (typeof updateLayerGuideContent === "function") updateLayerGuideContent(layer);
    }
  });
}

async function createLayer(type, start = 0, end = 5) {
  const layer = {
    id: nextLayerId++,
    type: type,
    start: start,
    end: end,
    selected: false,
    data: {},
  };

  if (LAYER_TYPES_WITH_POSITION.includes(type)) {
    // Toạ độ/kích thước lưu dạng tỉ lệ 0–1 so với previewFrame,
    // để không bị lệch khi preview đổi kích thước (responsive)
    layer.data.x = 0.05;
    layer.data.y = 0.2;
    layer.data.width = 0.9;
    layer.data.height = 0.1;
  }
  if(layer.type=="blur"){
    layer.data.opacity =0.5;
    layer.data.timelineIsVideo =false;
    const blurCount = typeof timelineLayers !== "undefined"
      ? timelineLayers.filter((l) => l && l.type === "blur").length
      : 0;
    layer.data.y = Math.min(0.72, 0.2 + blurCount * 0.14);
  }
  if (layer.type === "crop") {
    layer.data.timelineIsVideo = false;
    applyDeclaredCropRatioToLayer(layer);
  }
  if (layer.type === "trim") {
    layer.data.timelineIsVideo = false;
  }
  if (layer.type === "ocr") {
    layer.data.timelineIsVideo = false;
    layer.data.autoTranslate = true;
    layer.data.srcLang = "zh-CN";
    layer.data.dstLang = "vi";
    layer.data.x = 0.06;
    layer.data.y = 0.72;
    layer.data.width = 0.88;
    layer.data.height = 0.22;
  }
  if(layer.type === "sub") {
    layer.data.FontName = "Roboto";
    layer.data.wordCountInLine = 5;
    layer.data.FontSize = 14;
    layer.data.userFileSrt=true;
    layer.data.text = "Nội dung sub sẽ hiển thị như này";
    layer.data.Uppercase= true;
    layer.data.BorderColor ="#000000";
    layer.data.PrimaryColor="#ffffff";
    layer.data.HighlightColor ="#c9c500"
    layer.data.BorderWidth=3;
    layer.data.style_karaoke=true;
    layer.data.styleMode = "karaoke";
    layer.data.applyStyleToAllSubs = true;
    layer.data.BoxOpacity = 0.78;
    layer.data.BoxRadius = 16;
    layer.data.timelineIsVideo = false;
  }
  if (layer.type === "text") {
    layer.data.x = 0.08;
    layer.data.width = 0.84;
    layer.data.height = 0.86;
    layer.data.x = Math.max(0, (1 - layer.data.width) / 2);
    layer.data.y = Math.max(0, (1 - layer.data.height) / 2);
    layer.data.alignY = "center";
    layer.data.useFileText = true;
    layer.data.timelineIsVideo = false;
    layer.data.text =
      "1. Người có đức: Trời cho LỘC\n" +
      "2. Người có tài: Trời cho DANH\n" +
      "3. Người có tâm: Trời cho TẤT CẢ";
    layer.data.FontSize = 22;
    layer.data.FontColor = "#FFD400";
    layer.data.FontColor2 = "#FF1A1A";
    layer.data.BorderColor = "#FFFFFF";
    layer.data.BorderWidth = 3;
    layer.data.BorderColor1 = "#000000";
    layer.data.BorderWidth1 = 2;
    layer.data.BoxColor = "#1c1c1c";
    layer.data.BoxOpacity = 0.78;
    layer.data.BoxRadius = 24;
    layer.data.BoxPadding = 9;
    layer.data.BoxLineGap = 40;
    layer.data.isHookUpper = false;
    layer.data.applyStyleToAllTexts = true;
    const robotoBold = systemFonts.find(
      (f) => f.name === "Roboto" && f.weight === 700
    );
    if (robotoBold && window.pywebview) {
      const fontUrl = await window.pywebview.api.get_font_url(robotoBold.path);
      await loadFont("Roboto", fontUrl);
      layer.data.FontName = robotoBold.name;
      layer.data.FontWeight = robotoBold.weight;
      layer.data.FontFile = robotoBold.path;
      layer.data.FontStyle = robotoBold.style;
    } else {
      layer.data.FontName = "Roboto";
      layer.data.FontStyle = "Bold";
    }
  }
  if (layer.type === "image") {
    // Dữ liệu riêng cho layer ảnh chèn video (trước đây là overlay riêng),
    // path/width/height thật sẽ được addImageLayer() gán đè sau khi biết ảnh
    layer.data.path = null;
    layer.data.rotation = 0;
    layer.data.opacity = 1;
    layer.data.timelineIsVideo = false;
    layer.data.mediaKind = "image";
  }
  if(layer.type==="hook"){

    const robotoBold = systemFonts.find(
        f =>
        f.name === "Roboto" &&
        f.weight === 700
    );


    if(robotoBold){

        let fontUrl =
            await window.pywebview.api.get_font_url(
                robotoBold.path
            );


        await loadFont(
            "Roboto",
            fontUrl
        );


        layer.data.FontName = robotoBold.name;
        layer.data.FontWeight = robotoBold.weight;
        layer.data.FontFile = robotoBold.path;
        // Trước đây hardcode "normal" dù font là Bold -> lệch dữ liệu.
        // Sửa lại lấy đúng style thật của font đã chọn.
        layer.data.FontStyle = robotoBold.style;
    }
    layer.data.lineSpacing = 1;
    layer.data.FontSize = 18;
    layer.data.opacity =1;
    layer.data.useContentList= false;
    layer.data.timelineIsVideo = false;
    layer.data.FontColor= "#b60000";
    layer.data.isTowLine = true;
    layer.data.countword_hook = 5;
    layer.data.isHookUpper = false;
    layer.data.text ="Nội dung hook có hai dòng sẽ hiển thị như này";
    // layer.data.FontFile ="Roboto";
    layer.data.FontSize ="18";
    layer.data.BorderColor= "#000000";
    layer.data.BorderWidth= 0;
    layer.data.hookStyle = "pop";
    // layer.data.FontName = "Roboto"

    // ---- Font riêng cho DÒNG 2 khi bật "Hook có 2 dòng" ----
    // Mặc định giống hệt font dòng 1, người dùng có thể đổi riêng trong dialog sửa
    layer.data.FontName2 = layer.data.FontName;
    layer.data.FontStyle2 = layer.data.FontStyle;
    layer.data.FontWeight2 = layer.data.FontWeight;
    layer.data.FontFile2 = layer.data.FontFile;
    layer.data.FontSize2 = layer.data.FontSize;
    layer.data.FontColor2="#c5a800";
    layer.data.applyStyleToAllHooks = true;

  }

  return layer;
}

/* Tính start/end mặc định cho 1 layer mới cùng loại, dựa theo các layer
   cùng loại đã có + vị trí playhead hiện tại. Tách riêng khỏi addLayer()
   để addImageLayer() (thêm nhiều ảnh 1 lúc, có bước async chọn file) dùng lại được. */
function computeNextLayerRange(type) {
  const DEFAULT_DURATION = 5;

  const sameTypeLayers = timelineLayers.filter((l) => l.type === type);

  let start = 0;
  if (type !== "blur" && sameTypeLayers.length > 0) {
    start = Math.max(...sameTypeLayers.map((l) => l.end));
  }
  if (type !== "blur") {
    const playheadTime = videoState.currentTime;
    if (playheadTime > start) {
      start = playheadTime;
    }
  }
  if (start >= videoState.duration) {
    start = Math.max(0, videoState.duration - 0.2);
  }

  let end = Math.min(start + DEFAULT_DURATION, videoState.duration);

  if (end <= start) {
    end = videoState.duration;
    start = Math.max(0, end - 0.2);
  }

  return { start, end };
}

async function addLayer(type) {
  // Layer "image" cần người dùng CHỌN ẢNH trước, không thể tạo layer rỗng rồi
  // render ngay như blur/hook/sub -> tách riêng luồng, xong việc thì return.
  // Nhờ vậy dù bấm nút nào gọi addLayer("image") cũng luôn đúng thứ tự:
  // chọn ảnh xong mới có layer + mới render.
  if (type === "image") {
    return addImageLayer();
  }

  const { start, end } = computeNextLayerRange(type);

  const layer = await createLayer(type, start, end);
  if (typeof inheritSharedOverlayStyle === "function") inheritSharedOverlayStyle(layer);
  if (type === "hook" || type === "sub" || type === "text" || type === "ocr" || type === "blur") {
    layer.row = assignRowForNewLayer(type, start, end);
  }
  timelineLayers.push(layer);
  publishNewLayerToSharedTracks(layer);
  renderTimeline();

}

/* ---------- THÊM LAYER ẢNH (trước đây là AddOverLayImage() ở file overlay riêng) ----------
 * Giờ ảnh chèn video là 1 layer bình thường: có block trên track "image",
 * có khung vị trí trên preview y hệt blur/hook/sub, dùng chung dialog sửa.
 * Được addLayer("image") gọi vào, không cần gọi trực tiếp hàm này từ HTML nữa.
 */
const OVERLAY_VIDEO_EXT = /\.(mp4|mov|avi|mkv|webm)$/i;

function isOverlayVideoPath(path) {
  return OVERLAY_VIDEO_EXT.test(path || "");
}

function fitOverlaySizeToPreview(w, h) {
  const preview = document.getElementById("previewFrame");
  const maxW = preview ? preview.clientWidth * 0.8 : 400;
  const maxH = preview ? preview.clientHeight * 0.8 : 400;
  if (w > maxW || h > maxH) {
    const scale = Math.min(maxW / w, maxH / h);
    w = w * scale;
    h = h * scale;
  }
  return { width: Math.round(w), height: Math.round(h) };
}

async function addImageLayer() {
  if (!window.pywebview) return;

  const files = await window.pywebview.api.pick_media();
  if (!files) return;

  const previewFrame = document.getElementById("previewFrame");

  for (const info of files) {
    const { start, end } = computeNextLayerRange("image");
    const layer = await createLayer("image", start, end);

    const url = "http://127.0.0.1:9876/file?path=" + encodeURIComponent(info.path);
    const isVideo = isOverlayVideoPath(info.path);
    const size = isVideo
      ? await getVideoDisplaySize(url, info.width, info.height)
      : await getImageDisplaySize(url);

    const frameW = previewFrame ? previewFrame.clientWidth : size.width;
    const frameH = previewFrame ? previewFrame.clientHeight : size.height;

    layer.data.path = info.path;
    layer.data.rotation = 0;
    layer.data.opacity = 1;
    layer.data.mediaKind = isVideo ? "video" : "image";

    layer.data.width = frameW ? size.width / frameW : 0.3;
    layer.data.height = frameH ? size.height / frameH : 0.3;

    layer.data.x = Math.max(0, (1 - layer.data.width) / 2);
    layer.data.y = Math.max(0, (1 - layer.data.height) / 2);
    layer.row = assignRowForNewLayer("image", start, end);

    timelineLayers.push(layer);
    publishNewLayerToSharedTracks(layer);
  }

  renderTimeline();
}

function getImageDisplaySize(url) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      resolve(fitOverlaySizeToPreview(img.naturalWidth, img.naturalHeight));
    };

    img.onerror = () => resolve({ width: 200, height: 200 });

    img.src = url;
  });
}

function getVideoDisplaySize(url, knownW, knownH) {
  if (knownW && knownH) {
    return Promise.resolve(fitOverlaySizeToPreview(knownW, knownH));
  }
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      resolve(fitOverlaySizeToPreview(video.videoWidth || 320, video.videoHeight || 180));
    };
    video.onerror = () => resolve({ width: 320, height: 180 });
    video.src = url;
  });
}

function closePropsIfEditingMissing() {
  if (typeof closeLayerEdit !== "function") return;
  if (!editingLayer || !timelineLayers.some((x) => x.id === editingLayer.id)) {
    closeLayerEdit();
  }
}

function removeLayer(id) {
  timelineLayers = timelineLayers.filter((x) => x.id !== id);
  if (selectedLayer && selectedLayer.id === id) selectedLayer = null;
  closePropsIfEditingMissing();
  renderTimeline();
}

function getLayer(id) {
  return timelineLayers.find((x) => x.id === id);
}

function selectLayer(id) {
  timelineLayers.forEach((x) => (x.selected = false));
  selectedLayer = getLayer(id);
  if (selectedLayer) selectedLayer.selected = true;
  bringLayerToFront(id);
  bringLayerGuideToFront(id);
  renderTimeline();
  if (selectedLayer) {
    if (editingLayer && editingLayer.id === selectedLayer.id) {
      switchSideTab("props");
      syncLayerEditTimes(selectedLayer);
      return;
    }
    openLayerEdit(selectedLayer);
  }
}

let topLayerZIndex = 1;

function bringLayerToFront(id) {
  const layer = getLayer(id);
  if (!layer) return;

  topLayerZIndex += 1;
  layer.zIndex = topLayerZIndex;
}
function bringLayerGuideToFront(id) {
  const guide = layerGuideElements[id];
  if (!guide) return;

  topLayerZIndex += 1;
  guide.style.zIndex = topLayerZIndex;
}

function clearSelection() {
  timelineLayers.forEach((x) => (x.selected = false));
  selectedLayer = null;
  renderTimeline();
}

let suppressNextClearSelection = false;

document.addEventListener("click", function () {
  if (suppressNextClearSelection) {
    suppressNextClearSelection = false;
    return;
  }
  clearSelection();
});

/* ---------- FORMAT TIME (m:ss, không số 0 đầu phút — khớp UI "0:12", "11:59") ---------- */

function formatTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatPlayerTimecode(sec, fps) {
  const rate = Number(fps) > 0 ? Number(fps) : 30;
  const t = Math.max(0, Number(sec) || 0);
  const totalFrames = Math.round(t * rate);
  const frames = totalFrames % Math.round(rate);
  let rem = Math.floor(totalFrames / Math.round(rate));
  const ss = rem % 60;
  rem = Math.floor(rem / 60);
  const mm = rem % 60;
  const hh = Math.floor(rem / 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(frames)}`;
}

function formatRulerLabel(sec, step) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const rem = sec - m * 60;
  if (step < 0.2) {
    return `${m}:${rem.toFixed(2).padStart(5, "0")}`;
  }
  if (step < 1) {
    return `${m}:${rem.toFixed(1).padStart(4, "0")}`;
  }
  const s = Math.round(rem) % 60;
  const mm = m + Math.floor(Math.round(rem) / 60);
  return `${mm}:${String(s).padStart(2, "0")}`;
}

/* ---------- TRACK MAPPING (khớp id thật trong HTML) ---------- */

function getTrack(type) {
  switch (type) {
    case "blur":
      return document.getElementById("blurTrack");
    case "hook":
      return document.getElementById("hookTrack");
    case "sub":
    case "text":
      return document.getElementById("hookTrack");
    case "trim":
      return document.getElementById("trimTrack");
    case "crop":
      return document.getElementById("cropTrack");
    case "ocr":
      return document.getElementById("ocrTrack");
    case "image":
      // Cần thêm 1 track trong HTML, ví dụ: <div class="rs-track" id="imageTrack"></div>
      return document.getElementById("imageTrack");
  }
  return null;
}

/* ---------- CSS CHO SEGMENT ĐANG ĐƯỢC CHỌN ----------
 * Chèn 1 lần bằng JS để chắc chắn có hiệu lực dù CSS ngoài của bạn có định nghĩa
 * ".rs-seg.selected" hay không. Dùng outline (không phải border) để không làm
 * lệch kích thước/vị trí segment vốn đang được set bằng left/width theo %.
 */
(function injectSelectedSegmentStyle() {
  if (document.getElementById("rs-selected-seg-style")) return;

  const style = document.createElement("style");
  style.id = "rs-selected-seg-style";
  style.textContent = `
    .rs-seg.selected {
      outline: none;
      z-index: 4;
    }
  `;
  document.head.appendChild(style);
})();

/* ---------- RENDER SEGMENTS ---------- */

function renderTimeline() {
  document.querySelectorAll(".rs-track").forEach((track) => {
    track.querySelectorAll(".rs-seg").forEach((seg) => seg.remove());
  });

  timelineLayers.forEach((layer) => {
    const track = getTrack(layer.type);
    if (!track) return;
    track.appendChild(createSegment(layer));
  });
  arrangeHookSegments();
  syncLayerGuides();
}

// function createSegment(layer) {
//   const seg = document.createElement("div");
//   seg.className = "rs-seg rs-" + layer.type;

//   if (layer.selected) seg.classList.add("selected");

//   seg.dataset.id = layer.id;

//   const left = (layer.start / videoState.duration) * 100;
//   const width = ((layer.end - layer.start) / videoState.duration) * 100;

//   seg.style.left = left + "%";
//   seg.style.width = width + "%";

//   seg.innerHTML = `
//         <div class="resize-handle left"></div>
//         <span class="time-text">
//             ${formatTime(layer.start)}
//             -
//             ${formatTime(layer.end)}
//         </span>
//         <div class="resize-handle right"></div>
//     `;

//   bindSegment(seg);

//   return seg;
// }
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getSegmentLabel(layer) {
  if (layer.type === "hook" || layer.type === "sub" || layer.type === "text") {
    const raw = ((layer.data && layer.data.text) || "").replace(/\s+/g, " ").trim();
    if (layer.type === "sub" && layer.data?.userFileSrt && !raw) return "File Sub";
    if (layer.type === "hook" && layer.data?.useContentList && !raw) return "Danh sách nội dung";
    if (layer.type === "text" && layer.data?.useFileText) return "File Text";
    return raw || (layer.type === "hook" ? "Hook" : layer.type === "text" ? "Text" : "Sub");
  }
  if (layer.type === "image") {
    const p = ((layer.data && layer.data.path) || "").split(/[/\\]/).pop();
    return p || "Image";
  }
  if (layer.type === "ocr") {
    const src = (layer.data && layer.data.srcLang) || "zh-CN";
    const dst = (layer.data && layer.data.dstLang) || "vi";
    const tr = !layer.data || layer.data.autoTranslate !== false;
    return tr ? `OCR ${src} → ${dst}` : "OCR";
  }
  return `${formatTime(layer.start)} - ${formatTime(layer.end)}`;
}

function createSegment(layer) {
  const seg = document.createElement("div");
  seg.className = "rs-seg rs-" + layer.type;

  if (layer.selected) seg.classList.add("selected");

  seg.dataset.id = layer.id;

  const dur = getTimelineDuration() || videoState.duration || 1;
  const start = effectiveLayerStart(layer, dur);
  const end = effectiveLayerEnd(layer, dur);
  const left = (start / dur) * 100;
  const width = ((end - start) / dur) * 100;

  seg.style.left = left + "%";
  seg.style.width = width + "%";

  // Áp z-index động: layer nào được chọn gần nhất (bringLayerToFront) sẽ nổi
  // lên trên các segment khác cùng track, kể cả khi bị chọn thông qua khung
  // guide trên preview (selectLayer -> bringLayerToFront -> renderTimeline)
  if (layer.zIndex) {
    seg.style.zIndex = layer.zIndex;
  }

  const label = getSegmentLabel(layer);
  seg.title = label;
  seg.innerHTML = `
        <div class="resize-handle left"></div>
        <span class="time-text">${escapeHtml(label)}</span>
        <div class="resize-handle right"></div>
    `;

  bindSegment(seg);
  applyImageSegmentThumb(seg, layer);
  return seg;
}

function applyImageSegmentThumb(seg, layer) {
  if (!seg || layer.type !== "image" || !layer.data || !layer.data.path) return;
  const url = "http://127.0.0.1:9876/file?path=" + encodeURIComponent(layer.data.path);
  const isVideo = layer.data.mediaKind === "video" || isOverlayVideoPath(layer.data.path);
  seg.classList.add("rs-seg-has-thumb");
  if (isVideo) {
    const vid = document.createElement("video");
    vid.className = "rs-seg-thumb-media";
    vid.src = url;
    vid.muted = true;
    vid.playsInline = true;
    vid.preload = "metadata";
    vid.setAttribute("aria-hidden", "true");
    seg.insertBefore(vid, seg.firstChild);
    return;
  }
  seg.style.setProperty("--seg-thumb", 'url("' + url.replace(/"/g, "%22") + '")');
}

function seekPlayheadToLayerCenter(layer) {
  if (!layer) return;
  const dur = getTimelineDuration();
  const mid = (effectiveLayerStart(layer, dur) + effectiveLayerEnd(layer, dur)) / 2;
  seekTo(mid);

  const main = document.querySelector(".rs-timeline-main");
  const content = document.getElementById("timelineZoomContent");
  if (!main || !content) return;

  const duration = videoState.duration || 1;
  const contentWidth = content.offsetWidth;
  const midX = (mid / duration) * contentWidth;
  const maxScroll = Math.max(0, contentWidth - main.clientWidth);
  main.scrollLeft = Math.max(0, Math.min(maxScroll, midX - main.clientWidth / 2));
}

function bindSegment(seg) {
  seg.onclick = function (e) {
    e.stopPropagation();
    const id = parseInt(seg.dataset.id);
    selectLayer(id);
    seekPlayheadToLayerCenter(getLayer(id));
  };

  seg.addEventListener("mousedown", startMove);

  seg.querySelector(".left").addEventListener("mousedown", startResizeLeft);
  seg.querySelector(".right").addEventListener("mousedown", startResizeRight);
}

function getLayerFromSegment(seg) {
  return getLayer(parseInt(seg.dataset.id));
}

/* ---------- DRAG (di chuyển segment) ---------- */

let dragState = {
  active: false,
  layer: null,
  track: null,
  startMouseX: 0,
  startMouseY: 0,   // + thêm
  startStart: 0,
  startEnd: 0,
};
function moveHookLayerRow(layer, direction) {
  const hookLayers = timelineLayers.filter((l) => l.type === "hook");
  const idxInHook = hookLayers.indexOf(layer);
  const targetIdxInHook = idxInHook + direction;

  if (targetIdxInHook < 0 || targetIdxInHook >= hookLayers.length) return false;

  const otherLayer = hookLayers[targetIdxInHook];

  // Chỉ hoán đổi hàng khi khoảng thời gian của 2 layer TRÙNG NHAU
  // (tức đang/sẽ đè lên nhau trên timeline). Không trùng thời gian
  // thì không có lý do gì để đổi hàng -> bỏ qua, giữ nguyên vị trí.
  const isOverlapping = layer.start < otherLayer.end && otherLayer.start < layer.end;
  if (!isOverlapping) return false;

  const idxA = timelineLayers.indexOf(layer);
  const idxB = timelineLayers.indexOf(otherLayer);

  timelineLayers[idxA] = otherLayer;
  timelineLayers[idxB] = layer;

  return true;
}
/* Tìm dòng (row) đầu tiên mà layer mới [start, end) không bị trùng thời gian
   với bất kỳ layer nào cùng type đã có ở dòng đó. */
function getStackGroupTypes(type) {
  if (type === "hook" || type === "sub" || type === "text") return ["hook", "sub", "text"];
  if (type === "image") return ["image"];
  if (type === "ocr") return ["ocr"];
  if (type === "blur") return ["blur"];
  return null;
}

function assignRowForNewLayer(type, start, end) {
  const group = getStackGroupTypes(type) || [type];
  const sameTypeLayers = timelineLayers.filter((l) => group.includes(l.type));
  let row = 0;
  while (
    sameTypeLayers.some(
      (l) => (l.row || 0) === row && start < l.end && l.start < end
    )
  ) {
    row++;
  }
  return row;
}
function startMove(e) {
  if (e.target.classList.contains("resize-handle")) return;

  e.preventDefault();
  e.stopPropagation();

  const layer = getLayerFromSegment(e.currentTarget);
  if (!layer) return;

  bindEditingLayerOnDrag(layer);

  dragState.active = true;
  dragState.layer = layer;
  dragState.track = e.currentTarget.parentElement;
  dragState.startMouseY = e.clientY; // + thêm
  dragState.startMouseX = e.clientX;
  dragState.startStart = layer.start;
  dragState.startEnd = layer.end;
}

document.addEventListener("mousemove", dragMove);

// function dragMove(e) {
//   if (!dragState.active) return;

//   const dx = e.clientX - dragState.startMouseX;
//   const trackWidth = dragState.track.clientWidth;
//   const seconds = (dx / trackWidth) * videoState.duration;
//   const duration = dragState.startEnd - dragState.startStart;

//   let start = dragState.startStart + seconds;
//   let end = start + duration;

//   if (start < 0) {
//     start = 0;
//     end = duration;
//   }

//   if (end > videoState.duration) {
//     end = videoState.duration;
//     start = end - duration;
//   }

//   dragState.layer.start = start;
//   dragState.layer.end = end;

//   renderTimeline();
// }

function bindEditingLayerOnDrag(layer) {
  if (!layer) return;
  timelineLayers.forEach((x) => (x.selected = x.id === layer.id));
  selectedLayer = layer;
  if (typeof editingLayer !== "undefined" && editingLayer && editingLayer.id === layer.id) {
    if (typeof switchSideTab === "function") switchSideTab("props");
    const dialog = document.getElementById("layerEditDialog");
    if (dialog) {
      dialog.hidden = false;
      dialog.style.display = "flex";
    }
    const empty = document.getElementById("layerPropsEmpty");
    if (empty) empty.hidden = true;
    syncLayerEditTimes(layer);
    return;
  }
  if (typeof openLayerEdit === "function") openLayerEdit(layer);
}

function syncLayerEditTimes(layer) {
  if (!layer) return;
  const live = typeof editingLayer !== "undefined" ? editingLayer : null;
  if (live && live.id !== layer.id) return;
  const dur = getTimelineDuration();
  const startEl = document.getElementById("layerEditStart");
  const endEl = document.getElementById("layerEditEnd");
  if (startEl) startEl.value = Number(effectiveLayerStart(layer, dur)).toFixed(1);
  if (endEl) endEl.value = Number(effectiveLayerEnd(layer, dur)).toFixed(1);
}

function dragMove(e) {
  if (!dragState.active) return;

  const dx = e.clientX - dragState.startMouseX;
  const trackWidth = dragState.track.clientWidth;
  const trackDur = getTimelineDuration() || videoState.duration || 1;
  const seconds = (dx / trackWidth) * trackDur;
  const duration = dragState.startEnd - dragState.startStart;

  let start = dragState.startStart + seconds;
  let end = start + duration;

  if (start < 0) {
    start = 0;
    end = duration;
  }

  if (end > trackDur && trackDur > 0.2) {
    end = trackDur;
    start = end - duration;
  }

  if (dragState.layer.data && dragState.layer.data.timelineIsVideo) {
    dragState.layer.start = start;
  } else {
    dragState.layer.start = start;
    dragState.layer.end = end;
  }

  // Kéo dọc: đổi dòng nếu dòng đích không có segment nào trùng thời gian
  const stackTypes = getStackGroupTypes(dragState.layer.type);
  if (stackTypes) {
    const ROW_HEIGHT = dragState.layer.type === "image" ? 32 : (typeof TRACK_ROW_H === "number" ? TRACK_ROW_H : 42);
    const trackRect = dragState.track.getBoundingClientRect();
    const relativeY = e.clientY - trackRect.top;
    const desiredRow = Math.max(0, Math.floor(relativeY / ROW_HEIGHT));

    if (desiredRow !== (dragState.layer.row || 0)) {
      const conflict = timelineLayers.some(
        (l) =>
          stackTypes.includes(l.type) &&
          l.id !== dragState.layer.id &&
          (l.row || 0) === desiredRow &&
          dragState.layer.start < l.end &&
          l.start < dragState.layer.end
      );

      if (!conflict) {
        dragState.layer.row = desiredRow;
      }
    }
  }

  renderTimeline();
  syncLayerEditTimes(dragState.layer);
}
document.addEventListener("mouseup", stopMove);

function stopMove() {
  dragState.active = false;
  dragState.layer = null;
  dragState.track = null;
}

/* ---------- RESIZE (kéo dãn 2 đầu segment) ---------- */

let resizeState = {
  active: false,
  layer: null,
  track: null,
  direction: "",
  startMouseX: 0,
  startStart: 0,
  startEnd: 0,
};

function startResizeLeft(e) {
  e.preventDefault();
  e.stopPropagation();

  const layer = getLayerFromSegment(e.currentTarget.parentElement);
  if (!layer) return;

  bindEditingLayerOnDrag(layer);

  resizeState.active = true;
  resizeState.direction = "left";
  resizeState.layer = layer;
  resizeState.track = e.currentTarget.parentElement.parentElement;
  resizeState.startMouseX = e.clientX;
  resizeState.startStart = layer.start;
  resizeState.startEnd = layer.end;
}

function startResizeRight(e) {
  e.preventDefault();
  e.stopPropagation();

  const layer = getLayerFromSegment(e.currentTarget.parentElement);
  if (!layer) return;

  bindEditingLayerOnDrag(layer);

  resizeState.active = true;
  resizeState.direction = "right";
  resizeState.layer = layer;
  resizeState.track = e.currentTarget.parentElement.parentElement;
  resizeState.startMouseX = e.clientX;
  resizeState.startStart = layer.start;
  resizeState.startEnd = layer.end;
}

function resizeMove(e) {
  if (!resizeState.active) return;

  const dx = e.clientX - resizeState.startMouseX;
  const trackWidth = resizeState.track.clientWidth;
  const trackDur = getTimelineDuration() || videoState.duration || 1;
  const delta = (dx / trackWidth) * trackDur;

  if (resizeState.direction === "left") {
    let start = resizeState.startStart + delta;
    const endBound = resizeState.layer.data && resizeState.layer.data.timelineIsVideo
      ? effectiveLayerEnd(resizeState.layer, trackDur)
      : resizeState.layer.end;

    if (start < 0) start = 0;
    if (start > endBound - 0.2) start = endBound - 0.2;

    resizeState.layer.start = start;
  } else if (!(resizeState.layer.data && resizeState.layer.data.timelineIsVideo)) {
    let end = resizeState.startEnd + delta;

    if (trackDur > 0.2 && end > trackDur) end = trackDur;
    if (end < resizeState.layer.start + 0.2) end = resizeState.layer.start + 0.2;

    resizeState.layer.end = end;
  }

  renderTimeline();
  syncLayerEditTimes(resizeState.layer);
}

function stopResize() {
  resizeState.active = false;
  resizeState.layer = null;
  resizeState.track = null;
  resizeState.direction = "";
}

document.addEventListener("mousemove", resizeMove);
document.addEventListener("mouseup", stopResize);

/* ---------- CHỌN NHIỀU BLOCK BẰNG CÁCH KÉO CHUỘT (rubber-band select) ----------
 * Bấm chuột vào vùng NỀN của track (không phải lên 1 segment/tay cầm nào) rồi kéo
 * ra 1 khung chữ nhật -> mọi segment giao với khung đó sẽ được chọn (selected = true).
 * Xoá các block đang chọn bằng phím Delete/Backspace (xem phần bên dưới).
 */

let boxSelectState = {
  active: false,
  startX: 0,
  startY: 0,
  moved: false,
};

let boxSelectElement = null;

function getTracksContainer() {
  return document.querySelector(".rs-tracks");
}

document.addEventListener("mousedown", (e) => {
  const tracksArea = getTracksContainer();
  if (!tracksArea || !tracksArea.contains(e.target)) return;

  // Bỏ qua nếu bấm vào 1 segment, tay cầm resize, hoặc playhead — các phần tử đó
  // đã tự xử lý mousedown riêng (move/resize/kéo playhead), không box-select ở đây
  if (e.target.closest(".rs-seg")) return;
  if (e.target.id === "playhead") return;

  boxSelectState.active = true;
  boxSelectState.moved = false;
  boxSelectState.startX = e.clientX;
  boxSelectState.startY = e.clientY;
});

document.addEventListener("mousemove", (e) => {
  if (!boxSelectState.active) return;

  boxSelectState.moved = true;

  const tracksArea = getTracksContainer();
  if (!tracksArea) return;

  const rect = tracksArea.getBoundingClientRect();

  const x1 = Math.min(boxSelectState.startX, e.clientX);
  const x2 = Math.max(boxSelectState.startX, e.clientX);
  const y1 = Math.min(boxSelectState.startY, e.clientY);
  const y2 = Math.max(boxSelectState.startY, e.clientY);

  if (!boxSelectElement) {
    boxSelectElement = document.createElement("div");
    boxSelectElement.id = "rsBoxSelect";
    boxSelectElement.style.position = "absolute";
    boxSelectElement.style.border = "1px dashed #3b82f6";
    boxSelectElement.style.background = "rgba(59,130,246,0.15)";
    boxSelectElement.style.pointerEvents = "none";
    boxSelectElement.style.zIndex = "5";
    tracksArea.appendChild(boxSelectElement);
  }

  boxSelectElement.style.left = x1 - rect.left + "px";
  boxSelectElement.style.top = y1 - rect.top + "px";
  boxSelectElement.style.width = x2 - x1 + "px";
  boxSelectElement.style.height = y2 - y1 + "px";
});

document.addEventListener("mouseup", () => {
  if (!boxSelectState.active) return;

  const wasMoved = boxSelectState.moved;
  boxSelectState.active = false;

  if (wasMoved && boxSelectElement) {
    const boxRect = boxSelectElement.getBoundingClientRect();

    timelineLayers.forEach((layer) => (layer.selected = false));

    document.querySelectorAll(".rs-seg").forEach((seg) => {
      const segRect = seg.getBoundingClientRect();

      const intersects = !(
        segRect.right < boxRect.left ||
        segRect.left > boxRect.right ||
        segRect.bottom < boxRect.top ||
        segRect.top > boxRect.bottom
      );

      if (intersects) {
        const layer = getLayer(parseInt(seg.dataset.id));
        if (layer) layer.selected = true;
      }
    });

    selectedLayer = null; // đang chọn nhiều, không có "1 layer" duy nhất
    suppressNextClearSelection = true; // tránh bị listener click ở trên xoá lựa chọn ngay sau đó

    renderTimeline();
  }

  if (boxSelectElement) {
    boxSelectElement.remove();
    boxSelectElement = null;
  }
});

/* ---------- XOÁ CÁC BLOCK ĐANG CHỌN BẰNG PHÍM DELETE / BACKSPACE ---------- */

document.addEventListener("keydown", (e) => {
  if (e.key !== "Delete" && e.key !== "Backspace") return;

  // Không xoá khi đang gõ trong ô nhập liệu (VD dialog sửa layer, đổi tên...)
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
  ) {
    return;
  }

  const hasSelected = timelineLayers.some((l) => l.selected);
  if (!hasSelected) return;
  e.preventDefault();
  showConfirm("Bạn có chắc muốn xóa các layer đã chọn?", () => {
      timelineLayers = timelineLayers.filter((l) => !l.selected);
      selectedLayer = null;
      closePropsIfEditingMissing();
      renderTimeline();
  });

});


/* ---------- ZOOM TIMELINE BẰNG CTRL + CUỘN CHUỘT ----------
 * Phóng to/nhỏ bằng cách đổi width của #timelineZoomContent (bọc chung
 * ruler + tracks + playhead) — vì cả 3 cùng nằm trong 1 lớp bọc nên luôn
 * phóng to đồng bộ, không bị lệch vị trí giữa playhead và các segment.
 * #rs-timeline-body cần có overflow-x:auto để cuộn ngang khi zoom in.
 */
 
let timelineZoom = 1; // 1 = vừa khung (100%)
const TIMELINE_ZOOM_MIN = 1;
const TIMELINE_ZOOM_MAX = 16;
 const TIMELINE_ZOOM_STEP = 1.25;

function zoomTimelineIn() {
  timelineZoom = Math.min(TIMELINE_ZOOM_MAX, timelineZoom * TIMELINE_ZOOM_STEP);
  applyTimelineZoom();
  updateZoomLabel();
}

function zoomTimelineOut() {
  timelineZoom = Math.max(TIMELINE_ZOOM_MIN, timelineZoom / TIMELINE_ZOOM_STEP);
  applyTimelineZoom();
  updateZoomLabel();
}

function updateZoomLabel() {
  const input = document.getElementById("zoomLevelLabel");
  if (input) input.value = Math.round(timelineZoom * 100);
}
function setZoomFromInput(val) {
  let percent = parseFloat(val);
  if (isNaN(percent)) percent = 100;

  percent = Math.max(TIMELINE_ZOOM_MIN * 100, Math.min(TIMELINE_ZOOM_MAX * 100, percent));

  timelineZoom = percent / 100;
  applyTimelineZoom();
  updateZoomLabel();
}
function applyTimelineZoom() {
  const content = document.getElementById("timelineZoomContent");
  // const body = document.querySelector(".rs-timeline-body");
  const body = document.querySelector(".rs-timeline-main");
  if (!content) return;
 
  content.style.width = timelineZoom * 100 + "%";
  if (body) {
    body.style.overflowX = timelineZoom > 1.001 ? "auto" : "hidden";
  }
  updateZoomLabel();
  requestAnimationFrame(() => {
    renderRuler();
    if (typeof syncTrackInfoHeights === "function") syncTrackInfoHeights();
  });
}
//document.querySelector(".rs-timeline-main")?.addEventListener(
document.querySelector(".rs-timeline-main")?.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return; // chỉ zoom khi giữ Ctrl, scroll thường vẫn cuộn bình thường
 
    e.preventDefault(); // chặn trình duyệt tự zoom cả trang
 
    const body = e.currentTarget;
    const bodyRect = body.getBoundingClientRect();
 
    // Vị trí con trỏ chuột trong khung nhìn (viewport), không tính phần đã cuộn
    const mouseX = e.clientX - bodyRect.left;
 
    const bodyWidth = body.clientWidth;
    const oldZoom = timelineZoom;
    const oldContentWidth = oldZoom * bodyWidth;
 
    // Điểm trong nội dung (đã zoom) đang nằm NGAY DƯỚI con trỏ, trước khi đổi zoom
    const contentX = body.scrollLeft + mouseX;
    const ratio = oldContentWidth > 0 ? contentX / oldContentWidth : 0;
 
    const factor = e.deltaY < 0 ? 1.1 : 0.9; // lăn lên -> to ra, lăn xuống -> nhỏ lại
 
    timelineZoom = Math.min(
      TIMELINE_ZOOM_MAX,
      Math.max(TIMELINE_ZOOM_MIN, oldZoom * factor)
    );
 
    applyTimelineZoom();
 
    // Đặt lại scrollLeft để đúng điểm vừa tính vẫn nằm dưới con trỏ chuột sau khi zoom
    const newContentWidth = timelineZoom * bodyWidth;
    let newScrollLeft = ratio * newContentWidth - mouseX;
 
    const maxScrollLeft = Math.max(0, newContentWidth - bodyWidth);
    newScrollLeft = Math.max(0, Math.min(newScrollLeft, maxScrollLeft));
 
    body.scrollLeft = newScrollLeft;
  },
  { passive: false }
);
/* ---------- KHUNG VỊ TRÍ TRÊN PREVIEW (blur/hook/sub/image) ----------
 * Giống cropGuide: mỗi layer có 1 khung riêng, kéo/resize được,
 * lưu toạ độ dạng tỉ lệ 0–1 vào layer.data.{x,y,width,height}.
 * Riêng "image" còn xoay được (layer.data.rotation).
 * Luôn hiển thị hết tất cả (không ẩn/hiện theo lựa chọn).
 */

const layerGuideElements = {}; // layer.id -> phần tử DOM tương ứng

const LAYER_GUIDE_COLORS = {
  blur: "var(--track-blur, #3AADA4)",
  hook: "var(--track-hook, #C96B73)",
  sub: "var(--track-sub, #4EAE7E)",
  text: "var(--track-text, #5B8DEF)",
  image: "var(--track-image, #3D9AAD)",
  crop: "var(--track-crop, #6B9BD1)",
  ocr: "var(--track-ocr, #5A9FD4)",
};

/* ---------- HOOK 2 DÒNG: tách text theo số từ + áp font riêng từng dòng ---------- */

/**
 * Tách nội dung hook thành 2 dòng:
 * - Dòng 1: đúng `wordCount` từ đầu tiên
 * - Dòng 2: phần còn lại
 */
function splitHookText(text, wordCount) {
  if (!text) return { line1: "", line2: "" };

  const words = text.trim().split(/\s+/).filter(Boolean);
  const n = Math.max(1, parseInt(wordCount) || 1);

  if (words.length <= n) {
    return { line1: text.trim(), line2: "" };
  }

  return {
    line1: words.slice(0, n).join(" "),
    line2: words.slice(n).join(" "),
  };
}

/**
 * Áp font/size/style cho 1 phần tử dòng chữ của hook.
 * lineNumber = 1 -> dùng FontName/FontStyle/FontWeight/FontSize
 * lineNumber = 2 -> dùng FontName2/FontStyle2/FontWeight2/FontSize2 (fallback về dòng 1 nếu chưa có)
 */
function applyHookFontStyle(el, layer, lineNumber) {
  const suffix = lineNumber === 2 ? "2" : "";

  const fontSize = previewFontPx(layer.data["FontSize" + suffix] || layer.data.FontSize, 18);
  const fontWeight = layer.data["FontWeight" + suffix] || layer.data.FontWeight;
  const fontStyle = layer.data["FontStyle" + suffix] || layer.data.FontStyle;
  const fontName = layer.data["FontName" + suffix] || layer.data.FontName;
  const fontColer = layer.data["FontColor"+suffix] || layer.data.FontColor;

  el.style.fontSize = fontSize + "px";
  el.style.lineHeight = "1.15";
  el.style.fontWeight = fontWeight;
  el.style.color =fontColer;
  el.style.fontStyle = fontStyle === "italic" ? "italic" : "normal";
  el.style.lineHeight = "1.15";
  if (fontName) {
    el.style.fontFamily = `"${fontName}"`;
  }
  const borderWidth = previewFontPx(
    layer.data["BorderWidth" + suffix] ?? layer.data.BorderWidth ?? 0,
    0
  );
  const borderColor = layer.data["BorderColor" + suffix] || layer.data.BorderColor || "#000000";

  if (borderWidth > 0.4) {
    el.style.webkitTextStroke = `${borderWidth}px ${borderColor}`;
    el.style.paintOrder = "stroke fill";
  } else {
    el.style.webkitTextStroke = "0";
  }
}

/**
 * Render lại phần nội dung chữ bên trong khung guide của layer "hook".
 * - Nếu isTowLine = true -> tách 2 dòng, mỗi dòng 1 <div> với font riêng
 * - Nếu false -> 1 dòng duy nhất, dùng font dòng 1
 */
const hookContentRenderSeq = new WeakMap();

async function renderHookContent(content, layer) {
  const seq = (hookContentRenderSeq.get(content) || 0) + 1;
  hookContentRenderSeq.set(content, seq);
  const stillCurrent = () => hookContentRenderSeq.get(content) === seq;
  content.innerHTML = "";

  const hookStyle = layer.data.hookStyle || "default";
  content.className = "rs-layer-guide-content rs-hook-style-" + hookStyle;
  content.style.display = "flex";
  content.style.flexDirection = "column";
  content.style.alignItems = "center";
  content.style.textTransform = layer.data.isHookUpper ? "uppercase" : "none";

  let displayText = layer.data.text || "";
  if (hasTextLayerUsingFile()) {
    const attached = await loadAttachedTxtLines();
    if (!stillCurrent()) return;
    const parsed = splitHookHeaderFromLines(attached || []);
    if (parsed.hook) displayText = parsed.hook;
  }

  if (layer.data.isTowLine) {
    const { line1, line2 } = splitHookText(displayText, layer.data.countword_hook);

    const frameHeightPx = getPreviewVideoBox().height;
    const guideHeightPx = layer.data.height * frameHeightPx;
    const spacingPercent = layer.data.lineSpacing ?? 10;
    const gapPx = (spacingPercent / 100) * guideHeightPx;

    content.style.gap = gapPx + "px";

    const line1El = document.createElement("div");
    line1El.className = "rs-hook-line rs-hook-line-1";
    line1El.textContent = line1;
    applyHookFontStyle(line1El, layer, 1);
    content.appendChild(line1El);

    const line2El = document.createElement("div");
    line2El.className = "rs-hook-line rs-hook-line-2";
    line2El.textContent = line2;
    applyHookFontStyle(line2El, layer, 2);
    content.appendChild(line2El);
  } else {
    content.style.gap = "0px";

    const line1El = document.createElement("div");
    line1El.className = "rs-hook-line rs-hook-line-1";
    line1El.textContent = displayText;
    applyHookFontStyle(line1El, layer, 1);
    content.appendChild(line1El);
  }
}
function splitTextColon(line) {
  const s = String(line || "");
  const idx = s.search(/[:：]/);
  if (idx < 0) return { left: s, right: "" };
  return {
    left: s.slice(0, idx + 1).trim(),
    right: s.slice(idx + 1).trim(),
  };
}

function parseTextLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitHookHeaderFromLines(lines) {
  const list = Array.isArray(lines) ? lines.slice() : [];
  if (!list.length) return { lines: list, hook: null };
  const m = String(list[0]).trim().match(/^hook\s*[:：]\s*(.*)$/i);
  if (!m) return { lines: list, hook: null };
  return { lines: list.slice(1), hook: (m[1] || "").trim() || null };
}

function hasTextLayerUsingFile() {
  return (typeof timelineLayers !== "undefined" ? timelineLayers : []).some(
    (l) => l && l.type === "text" && l.data && l.data.useFileText
  );
}

function measureTextPx(text, fontSize, fontName, fontWeight, fontStyle) {
  if (!measureTextPx._ctx) {
    const c = document.createElement("canvas");
    measureTextPx._ctx = c.getContext("2d");
  }
  const ctx = measureTextPx._ctx;
  const style = fontStyle === "italic" ? "italic" : "normal";
  const weight = fontWeight || 400;
  const fs = Math.max(1, Number(fontSize) || 22);
  ctx.font = `${style} ${weight} ${fs}px "${fontName || "Roboto"}", sans-serif`;
  return ctx.measureText(String(text || "")).width;
}

function coloredPartsWidth(parts, fontSize, fontName, fontWeight, fontStyle, gapPx) {
  const left = parts.filter((p) => p.side === "1").map((p) => p.text).join(" ");
  const right = parts.filter((p) => p.side === "2").map((p) => p.text).join(" ");
  let w = measureTextPx(left, fontSize, fontName, fontWeight, fontStyle)
    + measureTextPx(right, fontSize, fontName, fontWeight, fontStyle);
  if (left && right) w += gapPx;
  return w;
}

function splitTokenToWidth(token, maxW, fontSize, fontName, fontWeight, fontStyle) {
  const t = String(token || "");
  if (!t) return [];
  if (measureTextPx(t, fontSize, fontName, fontWeight, fontStyle) <= maxW) return [t];
  const out = [];
  let cur = "";
  for (const ch of t) {
    const trial = cur + ch;
    if (cur && measureTextPx(trial, fontSize, fontName, fontWeight, fontStyle) > maxW) {
      out.push(cur);
      cur = ch;
    } else {
      cur = trial;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function wrapColoredTextLine(line, fontSize, boxW, fontName, fontWeight, fontStyle) {
  const { left, right } = splitTextColon(line);
  const items = [];
  String(left || "").split(/\s+/).filter(Boolean).forEach((w) => items.push({ text: w, side: "1" }));
  String(right || "").split(/\s+/).filter(Boolean).forEach((w) => items.push({ text: w, side: "2" }));
  if (!items.length) return [{ left: String(line || ""), right: "" }];
  const maxW = Math.max(8, Number(boxW) || 0);
  const gapPx = Math.max(4, fontSize * 0.28);
  const rows = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    rows.push({
      left: cur.filter((p) => p.side === "1").map((p) => p.text).join(" "),
      right: cur.filter((p) => p.side === "2").map((p) => p.text).join(" "),
    });
    cur = [];
  };
  items.forEach((item) => {
    splitTokenToWidth(item.text, maxW, fontSize, fontName, fontWeight, fontStyle).forEach((chunk) => {
      const next = cur.concat([{ text: chunk, side: item.side }]);
      if (cur.length && coloredPartsWidth(next, fontSize, fontName, fontWeight, fontStyle, gapPx) > maxW) {
        flush();
      }
      cur.push({ text: chunk, side: item.side });
    });
  });
  flush();
  return rows.length ? rows : [{ left: left || String(line || ""), right: right || "" }];
}

async function loadAttachedTxtLines() {
  try {
    const selected = typeof getSelectedMedia === "function" ? getSelectedMedia() : [];
    const files = (selected[0] && selected[0].files) || [];
    const txt = files.find((p) => String(p).toLowerCase().endsWith(".txt"));
    if (!txt) return null;
    const url = "http://127.0.0.1:9876/file?path=" + encodeURIComponent(txt);
    const res = await fetch(url);
    if (!res.ok) return null;
    return parseTextLines(await res.text());
  } catch (e) {
    return null;
  }
}

const textContentRenderSeq = new WeakMap();

async function renderTextContent(content, layer) {
  const seq = (textContentRenderSeq.get(content) || 0) + 1;
  textContentRenderSeq.set(content, seq);
  const stillCurrent = () => textContentRenderSeq.get(content) === seq;
  content.innerHTML = "";
  content.className = "rs-layer-guide-content rs-text-card";
  content.style.display = "flex";
  content.style.flexDirection = "column";
  content.style.justifyContent = "flex-start";
  content.style.alignItems = "stretch";
  content.style.width = "100%";
  content.style.height = "100%";
  content.style.boxSizing = "border-box";
  const pad = getTextBoxPaddingPct(layer);
  content.style.padding = pad + "%";
  const fontSize = previewFontPx(layer.data.FontSize, 22);
  const gapPct = getTextBoxLineGapPct(layer) / 100;
  content.style.gap = fontSize * gapPct + "px";
  content.style.position = "relative";
  content.style.zIndex = "1";
  content.style.textTransform = layer.data.isHookUpper ? "uppercase" : "none";

  let lines = parseTextLines(layer.data.text);
  if (layer.data.useFileText) {
    const attached = await loadAttachedTxtLines();
    if (!stillCurrent()) return;
    if (attached && attached.length) lines = attached;
    else if (!lines.length) lines = ["Nội dung từ file .txt đính kèm"];
  }
  const splitHook = splitHookHeaderFromLines(lines);
  if (splitHook.hook) lines = splitHook.lines;
  if (!lines.length) lines = ["Text"];

  const fontName = layer.data.FontName || "Roboto";
  const fontWeight = Number(layer.data.FontWeight) || 400;
  await ensureFontLoaded(fontName, layer.data.FontStyle);
  if (!stillCurrent()) return;
  const c1 = layer.data.FontColor || "#FFD400";
  const c2 = layer.data.FontColor2 || "#FF1A1A";
  const bw = Number(layer.data.BorderWidth || 0);
  const bc = layer.data.BorderColor || "#FFFFFF";
  const bw1 = Number(layer.data.BorderWidth1 || 0);
  const bc1 = layer.data.BorderColor1 || "#000000";

  const frame = getPreviewVideoBox();
  const boxW = Math.max(1, (Number(layer.data.width) || 0.84) * (frame.width || 1));
  const innerW = Math.max(8, boxW - boxW * (pad / 100) * 2);
  const visualRows = [];
  lines.forEach((line) => {
    wrapColoredTextLine(
      line,
      fontSize,
      innerW,
      fontName,
      fontWeight,
      layer.data.FontStyle
    ).forEach((row) => visualRows.push(row));
  });
  if (!visualRows.length) visualRows.push({ left: "Text", right: "" });

  visualRows.forEach((part) => {
    const left = part.left || "";
    const right = part.right || "";
    const row = document.createElement("div");
    row.className = "rs-text-line";
    row.style.fontFamily = `"${fontName}", sans-serif`;
    row.style.fontWeight = String(fontWeight);
    row.style.fontStyle = layer.data.FontStyle === "italic" ? "italic" : "normal";
    row.style.fontSize = fontSize + "px";
    row.style.lineHeight = "1.15";
    row.style.whiteSpace = "nowrap";
    row.style.overflow = "visible";

    const leftEl = document.createElement("span");
    leftEl.style.color = c1;
    leftEl.style.marginRight = right ? "6px" : "0";
    if (bw1 > 0) {
      leftEl.style.webkitTextStroke = `${previewFontPx(bw1, 0)}px ${bc1}`;
      leftEl.style.paintOrder = "stroke fill";
    }
    leftEl.textContent = left;
    row.appendChild(leftEl);

    if (right) {
      const rightEl = document.createElement("span");
      rightEl.style.color = c2;
      if (bw > 0) {
        rightEl.style.webkitTextStroke = `${previewFontPx(bw, 0)}px ${bc}`;
        rightEl.style.paintOrder = "stroke fill";
      }
      rightEl.textContent = right;
      row.appendChild(rightEl);
    }
    content.appendChild(row);
  });
  autosizeTextBoxHeight(layer, visualRows.length);
  const guide = content.parentElement || layerGuideElements[layer.id];
  if (guide) {
    updateGuidePosition(guide, layer);
    applyTextBoxChrome(guide, layer);
  }
}

function subHexToRgba(hex, alpha) {
  let h = String(hex || "#000000").replace("#", "").trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) h = "000000";
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r},${g},${b},${a})`;
}

function renderSubContent(content, layer) {
  content.innerHTML = "";

  content.style.display = "flex";
  content.style.flexDirection = "column";
  content.style.alignItems = "center";
  content.style.justifyContent = "center";
  content.style.gap = "0px";
  content.style.width = "100%";
  content.style.height = "100%";
  content.style.boxSizing = "border-box";

  const isBox = (layer.data.styleMode || "") === "box";
  const parent = content.parentElement;
  if (isBox) {
    const hex = layer.data.BorderColor || "#000000";
    let op = Number(layer.data.BoxOpacity);
    if (!Number.isFinite(op)) op = 0.78;
    op = Math.max(0, Math.min(1, op));
    let radius = Number(layer.data.BoxRadius);
    if (!Number.isFinite(radius)) radius = 16;
    content.style.background = subHexToRgba(hex, op);
    content.style.opacity = "1";
    content.style.borderRadius = Math.max(0, radius) + "px";
    content.style.overflow = "hidden";
    if (parent) parent.style.background = "transparent";
  } else {
    content.style.background = "";
    content.style.borderRadius = "";
    content.style.overflow = "";
  }

  const line1El = document.createElement("div");
  line1El.className = "rs-hook-line rs-hook-line-1";
  const text = layer.data.text || "";
  line1El.textContent = layer.data.Uppercase ? text.toUpperCase() : text;
  let fontSize = previewFontPx(layer.data.FontSize, 18);
  if (isBox) {
    const parent = content.parentElement;
    const boxH = parent ? parent.clientHeight : 0;
    if (boxH > 8) fontSize = Math.min(fontSize, Math.max(8, Math.floor(boxH * 0.42)));
  }
  line1El.style.fontSize = fontSize + "px";
  const fontName = layer.data.FontName || "Roboto";
  line1El.style.fontFamily = `"${fontName}"`;
  line1El.style.fontWeight = layer.data.FontWeight || 400;
  line1El.style.fontStyle = layer.data.FontStyle === "italic" ? "italic" : "normal";
  if (layer.data.PrimaryColor) line1El.style.color = layer.data.PrimaryColor;
  content.appendChild(line1El);
}

function syncLayerGuides() {
  const previewFrame = document.getElementById("previewFrame");
  if (!previewFrame) return;

  const activeIds = new Set();

  timelineLayers.forEach((layer) => {
    if (!LAYER_TYPES_WITH_POSITION.includes(layer.type)) return;

    activeIds.add(layer.id);

    let guide = layerGuideElements[layer.id];

    if (!guide) {
      guide = createLayerGuideElement(layer);
      layerGuideElements[layer.id] = guide;
      previewFrame.appendChild(guide);
      // Gán z-index ngay khi tạo (thay vì để mặc định "auto") để nhất quán
      // với cơ chế bring-to-front trong selectLayer() ở trên
      bringLayerGuideToFront(layer.id);
    }

    updateGuidePosition(guide, layer);
    if (layer.type === "sub") updateLayerGuideContent(layer);
    if (layer.type === "text") applyTextBoxChrome(guide, layer);

    // Viền sáng hơn khi segment tương ứng đang được chọn trên timeline
    guide.style.boxShadow = layer.selected ? "0 0 0 2px #fff" : "none";

    // Chỉ hiện khung khi thời gian hiện tại nằm trong khoảng start–end của layer
    const dur = getTimelineDuration();
    const inRange =
      videoState.currentTime >= effectiveLayerStart(layer, dur) &&
      videoState.currentTime <= effectiveLayerEnd(layer, dur);
    guide.style.display = inRange ? "block" : "none";
    if (guide._extBtns) {
      guide._extBtns.deleteBtn.style.display = "none";
      guide._extBtns.editBtn.style.display = "none";
    }
    if (layer.type === "image") {
      syncOverlayMedia(guide, layer, inRange);
    }
  });

  // // Xoá khung của layer đã bị xoá khỏi timelineLayers
  // Object.keys(layerGuideElements).forEach((idStr) => {
  //   if (!activeIds.has(Number(idStr))) {
  //     layerGuideElements[idStr].remove();
  //     delete layerGuideElements[idStr];
  //   }
  // });
    Object.keys(layerGuideElements).forEach((idStr) => {
    if (!activeIds.has(Number(idStr))) {
      const g = layerGuideElements[idStr];
      if (g._extBtns) {
        g._extBtns.deleteBtn.remove();
        g._extBtns.editBtn.remove();
      }
      g.remove();
      delete layerGuideElements[idStr];
    }
  });
}

function createLayerGuideElement(layer) {
  const color = LAYER_GUIDE_COLORS[layer.type] || "#ffffff";

  const div = document.createElement("div");
  // div.className = "rs-layer-guide rs-layer-guide-" + layer.type;
  div.className = "rs-layer-guide-" + layer.type;
  div.dataset.layerId = layer.id;

  div.style.position = "absolute";
  div.style.border = "1px dotted  " + color;
  div.style.boxSizing = "border-box";
  div.style.cursor = "move";

  // Nền tối mờ để dễ nhìn khung + chữ (blur/hook/sub); ảnh thì để trong suốt
  // để không che mất chính ảnh đang chèn
  if (layer.type !== "image") {
    div.style.background = "rgb(0 0 0 / 10%)";
  }
  if (layer.type === "crop") {
    div.style.borderStyle = "dashed";
    div.style.background = "rgb(231 235 16 / 12%)";
  }
  if (layer.type === "ocr") {
    div.style.borderStyle = "dashed";
    div.style.background = "rgb(74 168 255 / 14%)";
    if (typeof attachOcrLangBar === "function") attachOcrLangBar(div, layer);
  }
if(layer.type === "text"){
    applyTextBoxChrome(div, layer);
    const content = document.createElement("div");
    content.className = "rs-layer-guide-content";
    div.appendChild(content);
    renderTextContent(content, layer);
}
if(layer.type === "sub"){
    div.style.display = "flex";
    div.style.alignItems = "stretch";
    const content = document.createElement("div");
    content.className = "rs-layer-guide-content";
    content.style.color = "#fff";
    content.style.textAlign = "center";
    content.style.padding = "4px 8px";
    content.style.wordBreak = "break-word";
    div.appendChild(content);
    renderSubContent(content, layer);
}
  if (layer.type === "hook") {
      const content = document.createElement("div");
      content.className = "rs-layer-guide-content";
      content.style.color = "#fff";
      content.style.textAlign = "center";
      content.style.padding = "4px 8px";
      content.style.wordBreak = "break-word";
      div.appendChild(content);
      // Dựng nội dung (1 hoặc 2 dòng, mỗi dòng font riêng nếu bật isTowLine)
      renderHookContent(content, layer);
  }

  if (layer.type === "image") {
      const mediaUrl = layer.data.path
          ? "http://127.0.0.1:9876/file?path=" + encodeURIComponent(layer.data.path)
          : "";
      const isVideo = layer.data.mediaKind === "video" || isOverlayVideoPath(layer.data.path);
      const media = isVideo ? document.createElement("video") : document.createElement("img");
      media.className = "rs-layer-guide-image";
      media.src = mediaUrl;
      media.style.width = "100%";
      media.style.height = "100%";
      media.style.objectFit = "fill";
      media.style.pointerEvents = "none";
      if (isVideo) {
        media.muted = true;
        media.loop = true;
        media.playsInline = true;
        media.preload = "metadata";
      } else {
        media.draggable = false;
      }
      div.appendChild(media);
  }

  const label = document.createElement("span");
  const isVideoOverlay =
    layer.type === "image" &&
    (layer.data.mediaKind === "video" || isOverlayVideoPath(layer.data.path));
  label.textContent = isVideoOverlay ? "VIDEO" : layer.type.toUpperCase();
  label.style.position = "absolute";
  label.style.top = "-18px";
  label.style.left = "11px";
  label.style.fontSize = "11px";
  label.style.color = color;
  label.style.background="#00000069";
  label.style.borderRadius="5px";
  label.style.padding="0px 5px";
  label.style.fontWeight="600";

  label.style.whiteSpace = "nowrap";
  div.appendChild(label);

  const handle = document.createElement("div");
  handle.className = "rs-layer-guide-handle";
  handle.style.position = "absolute";
  handle.style.right = "-6px";
  handle.style.bottom = "-6px";
  handle.style.width = "12px";
  handle.style.height = "12px";
  handle.style.background = color;
  handle.style.cursor = "nwse-resize";
  handle.style.zIndex = "3";
  div.appendChild(handle);

  // Tay cầm XOAY — chỉ layer "image" mới cần (blur/hook/sub không xoay).
  // Trước đây đây là rotateHandle riêng trong file overlay, giờ gắn thẳng
  // vào khung guide chung.
  let rotateHandle = null;
  if (layer.type === "image") {
    const rotateLine = document.createElement("div");
    rotateLine.style.position = "absolute";
    rotateLine.style.left = "50%";
    rotateLine.style.top = "-22px";
    rotateLine.style.width = "1px";
    rotateLine.style.height = "22px";
    rotateLine.style.background = "rgba(255,255,255,0.6)";
    rotateLine.style.pointerEvents = "none";
    div.appendChild(rotateLine);

    rotateHandle = document.createElement("div");
    rotateHandle.className = "rs-layer-guide-rotate";
    rotateHandle.style.position = "absolute";
    rotateHandle.style.left = "50%";
    rotateHandle.style.top = "-38px";
    rotateHandle.style.width = "20px";
    rotateHandle.style.height = "20px";
    rotateHandle.style.marginLeft = "-10px";
    rotateHandle.style.borderRadius = "50%";
    rotateHandle.style.background = "#ffffff";
    rotateHandle.style.border = "2px solid #f59e0b";
    rotateHandle.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
    rotateHandle.style.cursor = "grab";
    rotateHandle.style.display = "flex";
    rotateHandle.style.alignItems = "center";
    rotateHandle.style.justifyContent = "center";
    rotateHandle.style.transition = "transform 0.15s ease";
    rotateHandle.innerHTML = `
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#f59e0b" stroke-width="2.6">
              <path d="M3 12a9 9 0 1 0 3-6.7"/>
              <path d="M3 4v5h5"/>
          </svg>
      `;
    rotateHandle.addEventListener("mouseenter", () => (rotateHandle.style.transform = "scale(1.2)"));
    rotateHandle.addEventListener("mouseleave", () => (rotateHandle.style.transform = "scale(1)"));
    rotateHandle.addEventListener("mousedown", (e) => e.stopPropagation());
    div.appendChild(rotateHandle);
  }

  // Sửa/Xóa trên preview ẩn — chỉnh clip ở tab Thuộc tính

  bindLayerGuide(div, handle, layer, rotateHandle);

  return div;
}

function syncOverlayMedia(guide, layer, inRange) {
  const vid = guide.querySelector("video.rs-layer-guide-image");
  if (!vid) return;
  if (!inRange) {
    vid.pause();
    return;
  }
  const localT = Math.max(0, videoState.currentTime - layer.start);
  if (Math.abs((vid.currentTime || 0) - localT) > 0.4) {
    try {
      vid.currentTime = localT;
    } catch (e) {}
  }
  const mainPaused = !previewVideo || previewVideo.paused;
  if (mainPaused) {
    vid.pause();
  } else if (vid.paused) {
    vid.play().catch(() => {});
  }
}

function updateGuidePosition(guide, layer) {
  guide.style.left = layer.data.x * 100 + "%";
  guide.style.top = layer.data.y * 100 + "%";
  guide.style.width = layer.data.width * 100 + "%";
  guide.style.height = layer.data.height * 100 + "%";

  // Xoay + độ mờ chỉ layer "image" dùng tới, layer khác rotation luôn = 0/undefined
  guide.style.transform = layer.data.rotation ? `rotate(${layer.data.rotation}deg)` : "";
  if (layer.type === "image") {
    guide.style.opacity = layer.data.opacity != null ? layer.data.opacity : 1;
    updateImageActionButtonsPosition(guide, layer);
  }
}

function updateImageActionButtonsPosition(guide, layer) {
  if (!guide._extBtns) return;

  const previewFrame = document.getElementById("previewFrame");
  if (!previewFrame) return;

  const frameW = previewFrame.clientWidth;
  const frameH = previewFrame.clientHeight;
  if (!frameW || !frameH) return;

  const guideLeftPx = layer.data.x * frameW;
  const guideTopPx = layer.data.y * frameH;
  const guideWidthPx = layer.data.width * frameW;

  const BTN = 24; // kích thước ước lượng của 1 nút (px)
  const GAP = 4;

  // Nút SỬA: giữ nguyên vị trí cũ — góc phải-trên khung guide
  let editLeft = guideLeftPx + guideWidthPx - BTN;
  let editTop = guideTopPx - BTN - GAP;

  // Nút XOÁ: chuyển sang góc trái-trên khung guide (đối xứng với Sửa)
  let deleteLeft = guideLeftPx;
  let deleteTop = guideTopPx - BTN - GAP;

  const clamp = (v, max) => Math.max(0, Math.min(v, Math.max(0, max - BTN)));

  deleteLeft = clamp(deleteLeft, frameW);
  deleteTop = clamp(deleteTop, frameH);
  editLeft = clamp(editLeft, frameW);
  editTop = clamp(editTop, frameH);

  guide._extBtns.deleteBtn.style.left = deleteLeft + "px";
  guide._extBtns.deleteBtn.style.top = deleteTop + "px";
  guide._extBtns.editBtn.style.left = editLeft + "px";
  guide._extBtns.editBtn.style.top = editTop + "px";
}

/* Cập nhật lại phần chữ (text/font) bên trong khung guide đã tồn tại trên preview,
   không tạo lại DOM — dùng khi đổi FontName/FontStyle/FontSize/text/isTowLine/countword_hook
   lúc đang sửa layer "hook" */
function updateLayerGuideContent(layer) {
  if (!layer || layer.id == null) return;
  const guide = layerGuideElements[layer.id];
  if (!guide) return;

  const content = guide.querySelector(".rs-layer-guide-content");
  if (!content) return;

  if (layer.type === "sub") {
    renderSubContent(content, layer);
    return;
  }
  if (layer.type === "text") {
    applyTextBoxChrome(guide, layer);
    renderTextContent(content, layer);
    return;
  }
  renderHookContent(content, layer);
}

function getTextBoxPaddingPct(layer) {
  const n = Number(layer?.data?.BoxPadding);
  if (!Number.isFinite(n)) return 9;
  return Math.max(0, Math.min(25, n));
}

function getTextBoxLineGapPct(layer) {
  const n = Number(layer?.data?.BoxLineGap);
  if (!Number.isFinite(n)) return 40;
  return Math.max(0, Math.min(150, n));
}

function autosizeTextBoxHeight(layer, lineCount) {
  const box = getPreviewVideoBox();
  const frameH = box.height || 1;
  const frameW = box.width || 1;
  const boxW = Math.max(1, (Number(layer.data.width) || 0.84) * frameW);
  const padPx = boxW * (getTextBoxPaddingPct(layer) / 100);
  const fontSize = previewFontPx(layer.data.FontSize, 22);
  const gapPx = fontSize * (getTextBoxLineGapPct(layer) / 100);
  const n = Math.max(1, lineCount | 0);
  const lineStep = fontSize * 1.2 + gapPx;
  const boxH = padPx * 2 + n * lineStep;
  layer.data.height = Math.min(0.98, Math.max(0.05, boxH / frameH));
  if (layer.data.alignY === "center") {
    layer.data.y = Math.max(0, (1 - layer.data.height) / 2);
  } else if ((layer.data.y || 0) + layer.data.height > 1) {
    layer.data.y = Math.max(0, 1 - layer.data.height);
  }
}

function hexToRgba(hex, alpha) {
  const h = String(hex || "#1c1c1c").replace("#", "");
  if (h.length !== 6) return `rgba(28,28,28,${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function applyTextBoxChrome(guide, layer) {
  if (!guide || !layer) return;
  const boxColor = layer.data.BoxColor || "#1c1c1c";
  const boxOp = layer.data.BoxOpacity != null ? layer.data.BoxOpacity : 0.78;
  const radius = Math.max(0, layer.data.BoxRadius != null ? Number(layer.data.BoxRadius) : 24);
  guide.style.overflow = "visible";
  guide.style.background = "transparent";
  guide.style.borderRadius = radius + "px";

  let fill = guide.querySelector(".rs-text-box-fill");
  if (!fill) {
    fill = document.createElement("div");
    fill.className = "rs-text-box-fill";
    fill.style.position = "absolute";
    fill.style.inset = "0";
    fill.style.pointerEvents = "none";
    fill.style.zIndex = "0";
    guide.insertBefore(fill, guide.firstChild);
  }
  fill.style.background = hexToRgba(boxColor, boxOp);
  fill.style.borderRadius = radius + "px";
}

/* Tỉ lệ crop theo option đã khai báo:
 * - Pill Crop (9:16 / 1:1 / 16:9) nếu đang bật
 * - Không thì lấy từ dropdown Kích thước (videoResolution)
 * - 0:0 / Tự do -> null (resize tự do)
 */
function getDeclaredCropRatio() {
  // Pill đang chọn: 9:16 / 1:1 / 16:9 -> cropRatio > 0
  // Pill "Tự do" -> cropEnabled = true nhưng cropRatio = null, KHÔNG lấy 9:16 từ dropdown
  if (typeof cropEnabled !== "undefined" && cropEnabled) {
    return typeof cropRatio === "number" && cropRatio > 0 ? cropRatio : null;
  }
  if (typeof cropRatio === "number" && cropRatio > 0) {
    return cropRatio;
  }
  const resEl = document.getElementById("videoResolution");
  if (resEl && String(resEl.value) === "src") return null;
  const size = resEl ? resolutions[resEl.value] : null;
  if (size && size.width && size.height) {
    return size.width / size.height;
  }
  return null;
}

function applyDeclaredCropRatioToLayer(layer) {
  const preview = document.getElementById("previewFrame");
  const frameW = preview && preview.clientWidth ? preview.clientWidth : 1;
  const frameH = preview && preview.clientHeight ? preview.clientHeight : 1;
  const ratio = getDeclaredCropRatio();

  let wPx;
  let hPx;

  if (ratio) {
    if (frameW / frameH > ratio) {
      hPx = frameH * 0.8;
      wPx = hPx * ratio;
    } else {
      wPx = frameW * 0.8;
      hPx = wPx / ratio;
    }
  } else {
    wPx = frameW * 0.8;
    hPx = frameH * 0.8;
  }

  layer.data.width = wPx / frameW;
  layer.data.height = hPx / frameH;
  layer.data.x = Math.max(0, (1 - layer.data.width) / 2);
  layer.data.y = Math.max(0, (1 - layer.data.height) / 2);
  layer.data.ratio = ratio;
}

function bindLayerGuide(div, handle, layer, rotateHandle) {
  let dragging = false;
  let resizing = false;
  let rotating = false;
  let startMouseX = 0;
  let startMouseY = 0;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let startAngle = 0;
  let startRotation = 0;

  div.addEventListener("mousedown", (e) => {
    if (e.target === handle) return; // để riêng cho resize
    if (rotateHandle && e.target === rotateHandle) return; // để riêng cho xoay
    e.preventDefault();
    e.stopPropagation();

    dragging = true;
    selectLayer(layer.id); // click khung trên preview cũng chọn luôn segment trên timeline

    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startX = layer.data.x;
    startY = layer.data.y;
  });

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    resizing = true;
    selectLayer(layer.id);

    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startW = layer.data.width;
    startH = layer.data.height;
  });

  // Xoay — chỉ tồn tại với layer "image" (rotateHandle được truyền vào)
  if (rotateHandle) {
    rotateHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      rotating = true;
      selectLayer(layer.id);
      rotateHandle.style.cursor = "grabbing";

      const rect = div.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
      startRotation = layer.data.rotation || 0;
    });
  }

  document.addEventListener("mousemove", (e) => {
    if (!dragging && !resizing && !rotating) return;

    const previewFrame = document.getElementById("previewFrame");
    if (!previewFrame) return;

    const rect = previewFrame.getBoundingClientRect();
    const isFreeMove = layer.type === "image";
    if (dragging) {
      const dx = (e.clientX - startMouseX) / rect.width;
      const dy = (e.clientY - startMouseY) / rect.height;

      let x = startX + dx;
      let y = startY + dy;
      if (!isFreeMove) {
        x = Math.max(0, Math.min(x, 1 - layer.data.width));
        y = Math.max(0, Math.min(y, 1 - layer.data.height));
      }

      layer.data.x = x;
      layer.data.y = y;
      if (layer.type === "text") layer.data.alignY = "manual";

      updateGuidePosition(div, layer);
    }

    if (resizing) {
      const dx = (e.clientX - startMouseX) / rect.width;
      const dy = (e.clientY - startMouseY) / rect.height;

      let w = Math.max(0.05, startW + dx);
      let h = Math.max(0.05, startH + dy);

      if (layer.type === "crop") {
        const ratio = getDeclaredCropRatio();
        layer.data.ratio = ratio;
        w = Math.min(w, 1 - layer.data.x);

        if (ratio) {
          // Khóa tỉ lệ theo pixel thật trên preview (giống cropGuide)
          let wPx = w * rect.width;
          let hPx = wPx / ratio;
          h = hPx / rect.height;

          if (h > 1 - layer.data.y) {
            h = 1 - layer.data.y;
            hPx = h * rect.height;
            wPx = hPx * ratio;
            w = wPx / rect.width;
          }

          w = Math.max(0.05, Math.min(w, 1 - layer.data.x));
          h = (w * rect.width / ratio) / rect.height;
          h = Math.max(0.05, Math.min(h, 1 - layer.data.y));
        } else {
          h = Math.min(h, 1 - layer.data.y);
        }
      } else if (!isFreeMove) {
        w = Math.min(w, 1 - layer.data.x);
        h = Math.min(h, 1 - layer.data.y);
      }

      layer.data.width = w;
      layer.data.height = h;

      updateGuidePosition(div, layer);
    }

    if (rotating) {
      const divRect = div.getBoundingClientRect();
      const centerX = divRect.left + divRect.width / 2;
      const centerY = divRect.top + divRect.height / 2;

      const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
      const delta = angle - startAngle;

      layer.data.rotation = startRotation + delta;
      updateGuidePosition(div, layer);
    }
  });

  document.addEventListener("mouseup", () => {
    const moved = dragging || resizing;
    dragging = false;
    resizing = false;
    rotating = false;
    if (rotateHandle) rotateHandle.style.cursor = "grab";
    if (moved && layer) {
      if (
        layer.type === "sub" &&
        layer.data.applyStyleToAllSubs !== false &&
        timelineLayers.some((l) => l.type === "sub" && l.id !== layer.id)
      ) {
        applySubPositionToAll(layer);
      }
      if (
        layer.type === "hook" &&
        layer.data.applyStyleToAllHooks !== false &&
        typeof applyHookPositionToAll === "function"
      ) {
        applyHookPositionToAll(layer);
      }
      if (
        layer.type === "text" &&
        layer.data.applyStyleToAllTexts !== false &&
        typeof applyTextPositionToAll === "function"
      ) {
        applyTextPositionToAll(layer);
      }
    }
  });
}

async function ensureFontLoaded(fontName, fontStyle) {
    const font = pickSystemFont(fontName, fontStyle);
    if (!font) return;
    if (loadedFonts.has(font.path)) return;
    const fontUrl = await window.pywebview.api.get_font_url(font.path);
    await loadFont(fontName, fontUrl);
    loadedFonts.add(font.path);
}

function pickSystemFont(fontName, fontStyle) {
  const list = typeof systemFonts !== "undefined" ? systemFonts : [];
  return (
    list.find((f) => f.name === fontName && f.style === fontStyle) ||
    list.find((f) => f.name === fontName) ||
    null
  );
}

/**
 * Cập nhật danh sách "kiểu chữ" (regular/bold/italic...) khả dụng cho 1 font,
 * đổ vào <select> đích. Mặc định đích là "FontStyle" (dòng 1), truyền thêm
 * `styleSelectId` = "FontStyle2" để cập nhật cho dòng 2.
 */
function updateFontStyles(fontName, styleSelectId = "FontStyle") {
  const styleSelect = document.getElementById(styleSelectId);
  if (!styleSelect) return;

  const stylesForFont = systemFonts.filter(f => f.name === fontName);

  styleSelect.innerHTML = stylesForFont
    .map(f => `<option value="${f.style}">${f.style}</option>`)
    .join("");
}

/* ---------- DIALOG SỬA LAYER (blur/hook/sub/image) ---------- */

let editingLayer = null;

function switchSideTab(name) {
  const tabs = document.querySelectorAll("#sideInspectorTabs .rs-side-tab");
  const scenes = document.getElementById("sidePaneScenes");
  const props = document.getElementById("sidePaneProps");
  const wrap = document.getElementById("previewPhanCanh");
  tabs.forEach((btn) => {
    btn.classList.toggle("rs-on", btn.dataset.sideTab === name);
  });
  if (scenes) {
    scenes.hidden = name !== "scenes";
    scenes.style.display = name === "scenes" ? "" : "none";
  }
  if (props) {
    props.hidden = name !== "props";
    props.style.display = name === "props" ? "" : "none";
  }
  if (wrap) wrap.classList.toggle("rs-side-mode-props", name === "props");
  if (typeof updatePreviewFrameHeight === "function") updatePreviewFrameHeight();
}

function initSideInspectorTabs() {
  const host = document.getElementById("sideInspectorTabs");
  if (!host || host.dataset.bound) return;
  host.dataset.bound = "1";
  host.querySelectorAll(".rs-side-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchSideTab(btn.dataset.sideTab));
  });
  bindLayerEditActionsOnce();
  switchSideTab("props");
}

function bindLayerEditActionsOnce() {
  const overlay = document.getElementById("layerEditDialog");
  if (!overlay || overlay.dataset.bound) return;
  overlay.dataset.bound = "1";
  const save = overlay.querySelector("#layerEditSaveBtn");
  const del = overlay.querySelector("#layerEditDeleteBtn");
  if (save) save.addEventListener("click", saveLayerEdit);
  if (del) del.addEventListener("click", () => {
    if (!editingLayer) return;
    const id = editingLayer.id;
    showConfirm("Bạn có chắc muốn xóa?", () => {
      removeLayer(id);
    });
  });
}

function ensureLayerEditDialog(layer) {

    let overlay = document.getElementById("layerEditDialog");
    const host = document.getElementById("sidePaneProps");

    if (!overlay && host) {
        overlay = document.createElement("div");
        overlay.id = "layerEditDialog";
        overlay.className = "rs-layer-props-dock";
        overlay.innerHTML = `
            <div id="layerEditBox">
                <div class="rs-layer-props-head">
                    <h4 id="layerEditTitle"></h4>
                    <div class="rs-dialog-actions rs-layer-props-actions">
                        <button type="button" id="layerEditDeleteBtn" class="rs-props-icon-btn rs-props-icon-del rs-tooltip" data-tooltip="Xóa" title="Xóa">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                        </button>
                        <button type="button" id="layerEditSaveBtn" class="rs-props-icon-btn rs-props-icon-save rs-tooltip" data-tooltip="Lưu thuộc tính và gán track cho video đang chọn" title="Lưu">
                          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                        </button>
                    </div>
                </div>
                <div class="rs-dialog-body">
                    <div id="layerExtra"></div>
                </div>
            </div>
        `;
        host.appendChild(overlay);
    }

    bindLayerEditActionsOnce();

    if (!overlay) return;

    const extra = overlay.querySelector("#layerExtra");
    if (!extra) return;

    extra.innerHTML = "";

    if (layer && layer.type === "blur") {

        extra.innerHTML = `
          <div class="rs-opt-row-dialog">
                        <span style="font-size:13px;">
                            Bắt đầu (giây)
                        </span>

                        <div class="rs-stepper">
                            <button onclick="steplayerEditStart(-0.1)">–</button>
                            <input id="layerEditStart" value="10">
                            <button onclick="steplayerEditStart(0.1)">+</button>
                        </div>
                    </div>

                    <div class="rs-opt-row-dialog">
                        <span style="font-size:13px;">
                            Kết thúc (giây)
                        </span>

                        <div class="rs-stepper">
                            <button onclick="steplayerEditEnd(-0.1)">–</button>
                            <input id="layerEditEnd" value="10">
                            <button onclick="steplayerEditEnd(0.1)">+</button>
                        </div>
                    </div>
                      
           <div class="rs-opt-row-dialog">
            <span style="font-size:13px;">
                Thời gian theo thời gian video
            </span>

            <div class="rs-stepper">
              <div class="rs-checkbox"  data-target="layerEditEnd"><input type="checkbox" id="BlurisTimeIsVideo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
              </div>
            </div>
          </div>
            <div class="rs-slider-field" style="margin-top:10px;">

                <div class="rs-top">
                    <span class="rs-name">Độ mờ</span>
                    <span class="rs-val" id="layerOpVal">1.0</span>
                </div>

                <input
                    type="range"
                    id="numLayeropVal"
                    min="0"
                    step="0.1"
                    max="1"
                    value="0.1"
                    oninput="
                        document.getElementById('layerOpVal').innerText =
                        parseFloat(this.value).toFixed(1);
                    ">

            </div>
        `;
    }
    if(layer && layer.type==="sub"){
      const uniqueFonts = [
        ...new Map((typeof systemFonts !== "undefined" ? systemFonts : []).map((font) => [font.name, font])).values()
      ];
      const fontOptionsHtml = uniqueFonts.map((font) => `
                  <option value="${font.name}">${font.name}</option>
              `).join("");
      extra.innerHTML = `
          <div class="rs-sub-editor">
            <section class="rs-sub-card">
              <div class="rs-sub-card-head">Thời gian</div>
              <div class="rs-sub-fields-2">
                <label class="rs-sub-field">
                  <span>Bắt đầu</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="steplayerEditStart(-0.1)">–</button>
                    <input id="layerEditStart" value="10">
                    <button type="button" onclick="steplayerEditStart(0.1)">+</button>
                  </div>
                </label>
                <label class="rs-sub-field">
                  <span>Kết thúc</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="steplayerEditEnd(-0.1)">–</button>
                    <input id="layerEditEnd" value="10">
                    <button type="button" onclick="steplayerEditEnd(0.1)">+</button>
                  </div>
                </label>
              </div>
              <div class="rs-sub-toggle-row" style="margin-top:10px;">
                <div class="rs-checkbox" data-target="layerEditEnd">
                  <input type="checkbox" id="SubIsTimeIsVideo">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                </div>
                <b>Theo thời gian video</b>
              </div>
            </section>



            <section class="rs-sub-card">
              <div class="rs-sub-card-head">Phong cách</div>
              <div class="rs-sub-toggle-row rs-sub-toggle-compact" style="margin-bottom:10px;">
                <div class="rs-checkbox rs-on">
                  <input type="checkbox" id="ApplySubStyleAll" checked>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                </div>
                <div class="rs-sub-toggle-copy">
                  <b>Áp dụng cho mọi sub trên track</b>
                  <small>(Đồng bộ phong cách và vị trí khung)</small>
                </div>
              </div>
              <select id="subStyleMode" class="rs-sub-style-select" hidden>
                <option value="default">Mặc định</option>
                <option value="karaoke">Karaoke (TikTok)</option>
                <option value="pop">Nảy từng từ</option>
                <option value="one_word">Một từ (Auto)</option>
                <option value="box">Nền hộp</option>
                <option value="bounce">Nảy cả câu</option>
                <option value="fade">Hiện dần</option>
              </select>
              <div class="rs-sub-style-grid" id="subStylePills">
                <button type="button" class="rs-sub-style-pill" data-style="default">Mặc định</button>
                <button type="button" class="rs-sub-style-pill" data-style="karaoke">Karaoke</button>
                <button type="button" class="rs-sub-style-pill" data-style="pop">Nảy từ</button>
                <button type="button" class="rs-sub-style-pill" data-style="one_word">Một từ</button>
                <button type="button" class="rs-sub-style-pill" data-style="box">Nền hộp</button>
                <button type="button" class="rs-sub-style-pill" data-style="bounce">Nảy câu</button>
                <button type="button" class="rs-sub-style-pill" data-style="fade">Hiện dần</button>
              </div>
            </section>

            <section class="rs-sub-card">
              <div class="rs-sub-card-head">Chữ &amp; viền</div>
              <div class="rs-grid-3-22-1" style="margin-bottom:10px;">
                <select class="rs-select-field" id="FontFilterSub">${fontOptionsHtml}</select>
                <select class="rs-select-field" id="FontStyleSub"></select>
                <div class="rs-stepper">
                    <button type="button" onclick="stepFontSizeSub(-1)">–</button>
                    <input id="valFontSizeSub" value="18">
                    <button type="button" onclick="stepFontSizeSub(1)">+</button>
                  </div>
              </div>
              <div class="rs-sub-fields-3">
                <label class="rs-sub-field">
                  <span>Từ / dòng</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="stepsCountWordSub(-1)">–</button>
                    <input id="CountWordSub" value="1">
                    <button type="button" onclick="stepsCountWordSub(1)">+</button>
                  </div>
                </label>
                <label class="rs-sub-field">
                  <span>Độ dày viền</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="stepstepBorderSub(-1)">–</button>
                    <input id="valBorderSub" value="1">
                    <button type="button" onclick="stepstepBorderSub(1)">+</button>
                  </div>
                </label>
              </div>
              <div class="rs-sub-toggle-row rs-sub-toggle-compact">
                <div class="rs-checkbox">
                  <input type="checkbox" id="UppercaseSub">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                </div>
                <div class="rs-sub-toggle-copy">
                  <b>Tự động in hoa</b>
                  <small>Viết hoa toàn bộ chữ khi render</small>
                </div>
              </div>
              <div class="rs-sub-colors">
                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="SubPrimaryColor" value="#ffffff">
                    <div class="rs-color-preview" id="color_SubPrimaryColor"></div>
                  </div>
                  <span>Chữ</span>
                </label>
                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="SubHighlightColor" value="#c9c500">
                    <div class="rs-color-preview" id="color_SubHighlightColor"></div>
                  </div>
                  <span>Highlight</span>
                </label>
                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="ColorBorderSub" value="#000000">
                    <div class="rs-color-preview" id="color_border_sub"></div>
                  </div>
                  <span>Viền / hộp</span>
                </label>
              </div>
              <div id="subBoxChromeFields" style="margin-top: 10px;opacity: 0.55;display: grid;grid-template-columns: 1fr 1fr;grid-template-rows: 1fr 1fd;grid: 10px/;alignment-baseline: 10px;gap: 26px;">
                <div class="rs-slider-field">
                  <div class="rs-top">
                    <span class="rs-name">Độ mờ nền hộp</span>
                    <span class="rs-val" id="layerSubBoxOpVal">0.78</span>
                  </div>
                  <input type="range" id="numLayerSubBoxOpVal" min="0" step="0.01" max="1" value="0.78">
                </div>
                <div class="rs-slider-field">
                  <div class="rs-top">
                    <span class="rs-name">Bo góc hộp</span>
                    <span class="rs-val" id="layerSubBoxRadiusVal">16px</span>
                  </div>
                  <input type="range" id="numLayerSubBoxRadius" min="0" step="1" max="80" value="16">
                </div>
               
              </div>
               <small style="display:block;margin-top:8px;color:#8b93a1;font-size:11px;line-height:1.4;">Áp dụng khi chọn phong cách Nền hộp. Màu hộp lấy từ mục Viền / hộp.</small>
            </section>
                        <section class="rs-sub-card">
              <div class="rs-sub-card-head">Nguồn phụ đề</div>
              <div class="rs-sub-toggle-row">
                <div class="rs-checkbox" data-target="txtContentSub">
                  <input type="checkbox" id="useFileSub">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                </div>
                <div class="rs-sub-toggle-copy">
                  <b>Dùng file Sub</b>
                  <small>(Lấy nội dung từ file .srt đính kèm media)</small>
                </div>
              </div>
              <div class="rs-sub-textarea-wrap">
                <textarea id="txtContentSub" class="rs-ta" rows="4" placeholder="Nhập nội dung sub khi không dùng file…"></textarea>
              </div>
            </section>
          </div>
        `;
    }
    if(layer && layer.type==="text"){
      const uniqueFonts = [
        ...new Map(systemFonts.map(font => [font.name, font])).values()
      ];
      const fontOptionsHtml = uniqueFonts.map(font => `
                  <option value="${font.name}">${font.name}</option>
              `).join("");
      extra.innerHTML = `
          <div class="rs-sub-editor rs-hook-editor">
            <section class="rs-sub-card">
              <div class="rs-sub-fields-2">
                <label class="rs-sub-field">
                  <span>Bắt đầu</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="steplayerEditStart(-0.1)">–</button>
                    <input id="layerEditStart" value="10">
                    <button type="button" onclick="steplayerEditStart(0.1)">+</button>
                  </div>
                </label>
                <label class="rs-sub-field">
                  <span>Kết thúc</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="steplayerEditEnd(-0.1)">–</button>
                    <input id="layerEditEnd" value="10">
                    <button type="button" onclick="steplayerEditEnd(0.1)">+</button>
                  </div>
                </label>
              </div>
              <div class="rs-hook-checks">
                <div class="rs-sub-toggle-row">
                  <div class="rs-checkbox" data-target="txtContentText">
                    <input type="checkbox" id="useFileText">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                  </div>
                  <div class="rs-sub-toggle-copy">
                    <b>Theo file text đính kèm</b>
                   
                  </div>
                </div>
                <div class="rs-sub-toggle-row">
                  <div class="rs-checkbox" data-target="layerEditEnd">
                    <input type="checkbox" id="TextIsTimeIsVideo">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                  </div>
                  <b>Theo thời gian video</b>
                </div>
              </div>
              <div class="rs-sub-textarea-wrap">
                <textarea id="txtContentText" class="rs-ta" rows="5" placeholder="Mỗi dòng một câu. Dòng đầu hook:Nội dung hook sẽ đưa lên layer Hook. Phần trước dấu : màu 1, phần sau màu 2."></textarea>
              </div>
            </section>
            <section class="rs-sub-card">
              <div class="rs-sub-card-head">Phông &amp; màu</div>
              <div class="rs-sub-toggle-row rs-sub-toggle-compact" style="margin-bottom:10px;">
                <div class="rs-checkbox rs-on">
                  <input type="checkbox" id="ApplyTextStyleAll" checked>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                </div>
                <div class="rs-sub-toggle-copy">
                  <b>Áp dụng cho mọi text</b>
                  <small>(Đồng bộ phong cách trên mọi video)</small>
                </div>
              </div>
              <div class="rs-grid-3-22-1">
                <select class="rs-select-field" id="FontFilterText">${fontOptionsHtml}</select>
                <select class="rs-select-field" id="FontStyleText"></select>
                <select class="rs-select-field" id="FontSizeText">${Array.from({length:193},(_,i)=>i+8).map(n=>`<option value="${n}">${n}</option>`).join("")}</select>
              </div>
              <div class="rs-sub-fields-2" style="margin-top:8px;">

              
                <label class="rs-sub-field">
                  <span>Viền chữ trước</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="document.getElementById('valBorderText1').value=Math.max(0,(parseInt(document.getElementById('valBorderText1').value)||0)-1)">–</button>
                    <input id="valBorderText1" value="2">
                    <button type="button" onclick="document.getElementById('valBorderText1').value=(parseInt(document.getElementById('valBorderText1').value)||0)+1">+</button>
                  </div>
                </label>
                <label class="rs-sub-field">
                  <span>Viền chữ sau</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="document.getElementById('valBorderText').value=Math.max(0,(parseInt(document.getElementById('valBorderText').value)||0)-1)">–</button>
                    <input id="valBorderText" value="3">
                    <button type="button" onclick="document.getElementById('valBorderText').value=(parseInt(document.getElementById('valBorderText').value)||0)+1">+</button>
                  </div>
                </label>
              </div>
              <div class="rs-sub-colors">
                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="TextColor1" value="#FFD400">
                    <div class="rs-color-preview" id="color_text1"></div>
                  </div>
                  <span>Chữ trước</span>
                </label>
                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="TextColor2" value="#FF1A1A">
                    <div class="rs-color-preview" id="color_text2"></div>
                  </div>
                  <span>Chữ sau</span>
                </label>
                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="TextBoxColor" value="#1c1c1c">
                    <div class="rs-color-preview" id="color_text_box"></div>
                  </div>
                  <span>Nền hộp</span>
                </label>
                
                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="TextBorderColor1" value="#000000">
                    <div class="rs-color-preview" id="color_text_border1"></div>
                  </div>
                  <span>Viền trước</span>
                </label>

                <label class="rs-sub-color">
                  <div class="rs-color-box">
                    <input type="color" id="TextBorderColor" value="#FFFFFF">
                    <div class="rs-color-preview" id="color_text_border"></div>
                  </div>
                  <span>Viền sau</span>
                </label>


              </div>
              <div class="rs-slider-field" style="margin-top:12px;">
                <div class="rs-top">
                  <span class="rs-name">Độ mờ nền hộp</span>
                  <span class="rs-val" id="layerTextBoxOpVal">0.78</span>
                </div>
                <input type="range" id="numLayerTextBoxOpVal" min="0" step="0.01" max="1" value="0.78"
                  oninput="document.getElementById('layerTextBoxOpVal').innerText=parseFloat(this.value).toFixed(2);">
              </div>
              <div class="rs-slider-field" style="margin-top:10px;">
                <div class="rs-top">
                  <span class="rs-name">Bo góc hộp</span>
                  <span class="rs-val" id="layerTextBoxRadiusVal">24</span>
                </div>
                <input type="range" id="numLayerTextBoxRadius" min="0" step="1" max="80" value="24"
                  oninput="document.getElementById('layerTextBoxRadiusVal').innerText=parseInt(this.value,10)+'px';">
              </div>
              <div class="rs-slider-field" style="margin-top:10px;">
                <div class="rs-top">
                  <span class="rs-name">Padding hộp</span>
                  <span class="rs-val" id="layerTextBoxPadVal">9%</span>
                </div>
                <input type="range" id="numLayerTextBoxPad" min="0" step="1" max="25" value="9"
                  oninput="document.getElementById('layerTextBoxPadVal').innerText=parseInt(this.value,10)+'%';">
              </div>
              <div class="rs-slider-field" style="margin-top:10px;">
                <div class="rs-top">
                  <span class="rs-name">Khoảng cách dòng</span>
                  <span class="rs-val" id="layerTextBoxGapVal">40%</span>
                </div>
                <input type="range" id="numLayerTextBoxGap" min="0" step="5" max="150" value="40"
                  oninput="document.getElementById('layerTextBoxGapVal').innerText=parseInt(this.value,10)+'%';">
              </div>
            </section>
          </div>
        `;
    }
    if (layer && layer.type === "image") {
      // Dialog sửa ảnh chèn video — trước đây là dialog riêng (#overlayEditDialog)
      // trong file overlay, giờ dùng chung khung dialog sửa layer
      extra.innerHTML = `
          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">
                  Bắt đầu (giây)
              </span>

              <div class="rs-stepper">
                  <button onclick="steplayerEditStart(-0.1)">–</button>
                  <input id="layerEditStart" value="10">
                  <button onclick="steplayerEditStart(0.1)">+</button>
              </div>
          </div>

          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">
                  Kết thúc (giây)
              </span>

              <div class="rs-stepper">
                  <button onclick="steplayerEditEnd(-0.1)">–</button>
                  <input id="layerEditEnd" value="10">
                  <button onclick="steplayerEditEnd(0.1)">+</button>
              </div>
          </div>

          <div class="rs-opt-row-dialog">
            <span style="font-size:13px;">
                Thời gian theo thời gian video
            </span>

            <div class="rs-stepper">
              <div class="rs-checkbox" data-target="layerEditEnd"><input type="checkbox" id="ImageIsTimeIsVideo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
              </div>
            </div>
          </div>

          <div class="rs-slider-field" style="margin-top:10px;">
              <div class="rs-top">
                  <span class="rs-name">Độ mờ</span>
                  <span class="rs-val" id="layerImageOpVal">1.0</span>
              </div>

              <input
                  type="range"
                  id="numLayerImageOpVal"
                  min="0"
                  step="0.1"
                  max="1"
                  value="1"
                  oninput="
                      document.getElementById('layerImageOpVal').innerText =
                      parseFloat(this.value).toFixed(1);
                  ">
          </div>
      `;
    }
    if (layer && layer.type === "crop") {
      extra.innerHTML = `
          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">
                  Bắt đầu (giây)
              </span>

              <div class="rs-stepper">
                  <button onclick="steplayerEditStart(-0.1)">–</button>
                  <input id="layerEditStart" value="10">
                  <button onclick="steplayerEditStart(0.1)">+</button>
              </div>
          </div>

          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">
                  Kết thúc (giây)
              </span>

              <div class="rs-stepper">
                  <button onclick="steplayerEditEnd(-0.1)">–</button>
                  <input id="layerEditEnd" value="10">
                  <button onclick="steplayerEditEnd(0.1)">+</button>
              </div>
          </div>

          <div class="rs-opt-row-dialog">
            <span style="font-size:13px;">
                Thời gian theo thời gian video
            </span>

            <div class="rs-stepper">
              <div class="rs-checkbox" data-target="layerEditEnd"><input type="checkbox" id="CropIsTimeIsVideo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
              </div>
            </div>
          </div>
      `;
    }
    if (layer && layer.type === "trim") {
      extra.innerHTML = `
          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">Bắt đầu (giây)</span>
              <div class="rs-stepper">
                  <button type="button" onclick="steplayerEditStart(-0.1)">–</button>
                  <input id="layerEditStart" value="10">
                  <button type="button" onclick="steplayerEditStart(0.1)">+</button>
              </div>
          </div>
          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">Kết thúc (giây)</span>
              <div class="rs-stepper">
                  <button type="button" onclick="steplayerEditEnd(-0.1)">–</button>
                  <input id="layerEditEnd" value="10">
                  <button type="button" onclick="steplayerEditEnd(0.1)">+</button>
              </div>
          </div>
          <div class="rs-opt-row-dialog">
            <span style="font-size:13px;">Thời gian theo thời gian video</span>
            <div class="rs-stepper">
              <div class="rs-checkbox" data-target="layerEditEnd"><input type="checkbox" id="TrimIsTimeIsVideo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
              </div>
            </div>
          </div>
      `;
    }
    if (layer && layer.type === "ocr") {
      extra.innerHTML = `
          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">Bắt đầu (giây)</span>
              <div class="rs-stepper">
                  <button onclick="steplayerEditStart(-0.1)">–</button>
                  <input id="layerEditStart" value="10">
                  <button onclick="steplayerEditStart(0.1)">+</button>
              </div>
          </div>
          <div class="rs-opt-row-dialog">
              <span style="font-size:13px;">Kết thúc (giây)</span>
              <div class="rs-stepper">
                  <button onclick="steplayerEditEnd(-0.1)">–</button>
                  <input id="layerEditEnd" value="10">
                  <button onclick="steplayerEditEnd(0.1)">+</button>
              </div>
          </div>
          <div class="rs-opt-row-dialog">
            <span style="font-size:13px;">Thời gian theo thời gian video</span>
            <div class="rs-stepper">
              <div class="rs-checkbox" data-target="layerEditEnd"><input type="checkbox" id="OcrIsTimeIsVideo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
              </div>
            </div>
          </div>
      `;
    }
    if(layer && layer.type ==="hook"){
        const uniqueFonts = [
      ...new Map(systemFonts.map(font => [font.name, font])).values()
      ];
      const fontOptionsHtml = uniqueFonts.map(font => `
                  <option value="${font.name}">
                      ${font.name}
                  </option>
              `).join("");
      const fontSizeOptionsHtml = Array.from(
                  { length: 193 },
                  (_, i) => `<option value="${i + 8}">${i + 8}</option>`
              ).join("");

      extra.innerHTML = `
          <div class="rs-sub-editor rs-hook-editor">
            <section class="rs-sub-card">
              <div class="rs-sub-fields-2">
                <label class="rs-sub-field">
                  <span>Bắt đầu</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="steplayerEditStart(-0.1)">–</button>
                    <input id="layerEditStart" value="10">
                    <button type="button" onclick="steplayerEditStart(0.1)">+</button>
                  </div>
                </label>
                <label class="rs-sub-field">
                  <span>Kết thúc</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="steplayerEditEnd(-0.1)">–</button>
                    <input id="layerEditEnd" value="10">
                    <button type="button" onclick="steplayerEditEnd(0.1)">+</button>
                  </div>
                </label>
              </div>
              <div class="rs-hook-checks">
                <div class="rs-sub-toggle-row">
                  <div class="rs-checkbox" data-target="txtContentHook">
                    <input type="checkbox" id="useContentList">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                  </div>
                  <b>Theo danh sách nội dung</b>
                </div>
                <div class="rs-sub-toggle-row">
                  <div class="rs-checkbox" data-target="layerEditEnd">
                    <input type="checkbox" id="HookisTimeIsVideo">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                  </div>
                  <b>Thời gian như video</b>
                  
                </div>
                <div class="rs-sub-toggle-row">
                  <div class="rs-checkbox">
                    <input type="checkbox" id="isHookUpper">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                  </div>
                  <b>Tự động in hoa cho hook</b>
                </div>
                <div class="rs-sub-toggle-row">
                  <div class="rs-checkbox" data-target="countword_hook">
                    <input type="checkbox" id="isHookTowLine">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                  </div>
                  <b>Hook có hai dòng</b>
                </div>
              </div>
              <div class="rs-sub-textarea-wrap" style="margin-top: 20px;">
                <textarea id="txtContentHook" class="rs-ta" rows="2" placeholder="Nhập nội dung hook…"></textarea>
              </div>
            </section>

            <section class="rs-sub-card">
              <div class="rs-sub-card-head">Phong cách</div>
              <div class="rs-sub-toggle-row rs-sub-toggle-compact" style="margin-bottom:10px;">
                <div class="rs-checkbox rs-on">
                  <input type="checkbox" id="ApplyHookStyleAll" checked>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 13l4 4L19 7"></path></svg>
                </div>
                <div class="rs-sub-toggle-copy">
                  <b>Áp dụng cho mọi hook</b>
                  <small>(Đồng bộ kiểu trên mọi video)</small>
                </div>
              </div>
              <select id="hookStyleMode" hidden>
                <option value="default">Mặc định</option>
                <option value="pop">Nảy vào</option>
                <option value="slide">Trượt xuống</option>
                <option value="fade">Hiện dần</option>
                <option value="box">Nền hộp</option>
                <option value="shadow">Bóng đổ</option>
              </select>
              <div class="rs-sub-style-grid" id="hookStylePills">
                <button type="button" class="rs-sub-style-pill" data-style="default">Mặc định</button>
                <button type="button" class="rs-sub-style-pill" data-style="pop">Nảy vào</button>
                <button type="button" class="rs-sub-style-pill" data-style="slide">Trượt</button>
                <button type="button" class="rs-sub-style-pill" data-style="fade">Hiện dần</button>
                <button type="button" class="rs-sub-style-pill" data-style="box">Nền hộp</button>
                <button type="button" class="rs-sub-style-pill" data-style="shadow">Bóng đổ</button>
              </div>
              <div class="rs-sub-fields-121" style="margin-top:18px;">
                <label class="rs-sub-field">
                  <span>Số từ dòng 1</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="stepCountword_hook(-1)">–</button>
                    <input id="countword_hook" value="2">
                    <button type="button" onclick="stepCountword_hook(1)">+</button>
                  </div>
                </label>
                <label class="rs-sub-field">
                  <span>Độ dày viền</span>
                  <div class="rs-stepper">
                    <button type="button" onclick="stepstepBorderHook(-1)">–</button>
                    <input id="valBorderHook" value="1">
                    <button type="button" onclick="stepstepBorderHook(1)">+</button>
                  </div>
                </label>
                <label class="rs-sub-color rs-hook-border-color" style=" border: none; background: transparent;">
                  <div class="rs-color-box">
                    <input type="color" id="fontColorBorderHook" value="#000000">
                    <div class="rs-color-preview" id="color_border_hook"></div>
                  </div>
                  <span>Màu viền</span>
                </label>
              </div>
              <div class="rs-slider-field" id="hookLineGapRow" style="margin-top:15px;margin-bottom:0;">
                <div class="rs-top" style="margin-bottom:0;">
                  <span class="rs-name">Khoảng 2 dòng</span>
                  <span class="rs-val" id="layerDistanceTowLine">10%</span>
                </div>
                <input type="range" id="numlayerDistanceTowLine" min="1" step="1" max="100" value="10"
                  oninput="document.getElementById('layerDistanceTowLine').innerText=parseFloat(this.value).toFixed(0)+'%';">
              </div>
            </section>

            <section class="rs-sub-card">
              <div class="rs-sub-card-head">Phông dòng 1</div>
              <div class="rs-grid-4-1">
                <select class="rs-select-field" id="FontFilter">${fontOptionsHtml}</select>
                <select class="rs-select-field" id="FontStyle"></select>
                <select class="rs-select-field" id="FontSize">${fontSizeOptionsHtml}</select>
                <div class="rs-color-box">
                  <input type="color" id="fontColor" value="#b60000">
                  <div class="rs-color-preview" id="color_preview"></div>
                </div>
              </div>
              <div id="hookFont2Label" class="rs-sub-card-head">Phông dòng 2</div>
              <div class="rs-grid-4-1" id="hookFont2Row">
                <select class="rs-select-field" id="FontFilter2">${fontOptionsHtml}</select>
                <select class="rs-select-field" id="FontStyle2"></select>
                <select class="rs-select-field" id="FontSize2">${fontSizeOptionsHtml}</select>
                <div class="rs-color-box">
                  <input type="color" id="fontColor2" value="#c5a800">
                  <div class="rs-color-preview" id="color_preview2"></div>
                </div>
              </div>
            </section>
          </div>
        `;
        updateFontStyles("Roboto");
       
    }
    

}

const FOLLOW_VIDEO_INPUT_IDS = [
  "BlurisTimeIsVideo",
  "CropIsTimeIsVideo",
  "TrimIsTimeIsVideo",
  "OcrIsTimeIsVideo",
  "ImageIsTimeIsVideo",
  "TextIsTimeIsVideo",
  "HookisTimeIsVideo",
  "SubIsTimeIsVideo",
];

function isFollowVideoChecked(id) {
  const input = document.getElementById(id);
  if (!input) return false;
  const box = input.closest(".rs-checkbox");
  return !!(input.checked || (box && box.classList.contains("rs-on")));
}

function followVideoInputIdForType(type) {
  const map = {
    blur: "BlurisTimeIsVideo",
    crop: "CropIsTimeIsVideo",
    trim: "TrimIsTimeIsVideo",
    ocr: "OcrIsTimeIsVideo",
    image: "ImageIsTimeIsVideo",
    text: "TextIsTimeIsVideo",
    hook: "HookisTimeIsVideo",
    sub: "SubIsTimeIsVideo",
  };
  return map[type] || "";
}

function syncFollowVideoTimeFromUi() {
  if (!editingLayer) return;
  const id = followVideoInputIdForType(editingLayer.type);
  if (!id) return;
  const follow = isFollowVideoChecked(id);
  if (!editingLayer.data) editingLayer.data = {};
  if (follow) {
    if (editingLayer.data.baseEnd == null) editingLayer.data.baseEnd = editingLayer.end;
    editingLayer.data.timelineIsVideo = true;
  } else {
    editingLayer.data.timelineIsVideo = false;
    const base = Number(editingLayer.data.baseEnd);
    if (Number.isFinite(base) && base > editingLayer.start) editingLayer.end = base;
    delete editingLayer.data.baseEnd;
  }
  const endEl = document.getElementById("layerEditEnd");
  if (endEl) endEl.value = Number(effectiveLayerEnd(editingLayer, getTimelineDuration())).toFixed(1);
  if (typeof setDisabled === "function") setDisabled("layerEditEnd", follow);
  if (typeof renderTimeline === "function") renderTimeline();
  if (typeof syncLayerGuides === "function") syncLayerGuides();
}

function bindFollowVideoTimeToggles() {
  FOLLOW_VIDEO_INPUT_IDS.forEach((id) => {
    const input = document.getElementById(id);
    if (!input || input.dataset.followBound === "1") return;
    input.dataset.followBound = "1";
    input.addEventListener("change", syncFollowVideoTimeFromUi);
  });
}

function openLayerEdit(layer) {
  ensureLayerEditDialog(layer);
  editingLayer = layer;

  const dialog = document.getElementById("layerEditDialog");
  const box = document.getElementById("layerEditBox");
  if (!dialog || !box) return;


  dialog.querySelector("#layerEditTitle").textContent = "Chỉnh sửa [ " + layer.type.toUpperCase()+" ]";
  box.classList.toggle("rs-layer-edit-box-wide", layer.type === "sub" || layer.type === "hook" || layer.type === "text");
  box.classList.toggle("rs-layer-edit-box-hook", layer.type === "hook" || layer.type === "text");
  const startInp = dialog.querySelector("#layerEditStart");
  const endInp = dialog.querySelector("#layerEditEnd");
  const openDur = getTimelineDuration();
  if (startInp) startInp.value = Number(effectiveLayerStart(layer, openDur)).toFixed(1);
  if (endInp) endInp.value = Number(effectiveLayerEnd(layer, openDur)).toFixed(1);
  if(layer.type==="blur"){
    dialog.querySelector("#layerOpVal").textContent= layer.data.opacity;
    dialog.querySelector("#numLayeropVal").value = layer.data.opacity;
    // dialog.querySelector("#BlurisTimeIsVideo").checked = layer.data.timelineIsVideo;
    setCheckbox(dialog.querySelector("#BlurisTimeIsVideo"),layer.data.timelineIsVideo);
    if(layer.data.timelineIsVideo){
       setDisabled("layerEditEnd", true);
    }
  }
  if (layer.type === "crop") {
    setCheckbox(dialog.querySelector("#CropIsTimeIsVideo"), layer.data.timelineIsVideo);
    if (layer.data.timelineIsVideo) {
      setDisabled("layerEditEnd", true);
    }
  }
  if (layer.type === "trim") {
    setCheckbox(dialog.querySelector("#TrimIsTimeIsVideo"), layer.data.timelineIsVideo);
    if (layer.data.timelineIsVideo) {
      setDisabled("layerEditEnd", true);
    }
  }
  if (layer.type === "ocr") {
    setCheckbox(dialog.querySelector("#OcrIsTimeIsVideo"), layer.data.timelineIsVideo);
    if (layer.data.timelineIsVideo) {
      setDisabled("layerEditEnd", true);
    }
  }
  if (layer.type === "image") {
    const opInput = dialog.querySelector("#numLayerImageOpVal");
    const opLabel = dialog.querySelector("#layerImageOpVal");
    const opacity = layer.data.opacity != null ? layer.data.opacity : 1;

    opInput.value = opacity;
    opLabel.textContent = opacity.toFixed(1);

    setCheckbox(dialog.querySelector("#ImageIsTimeIsVideo"), layer.data.timelineIsVideo);
    if (layer.data.timelineIsVideo) {
      setDisabled("layerEditEnd", true);
    }
  }
  if(layer.type==="sub"){
    setCheckbox(dialog.querySelector("#SubIsTimeIsVideo"), layer.data.timelineIsVideo);
    if (layer.data.timelineIsVideo) setDisabled("layerEditEnd", true);
    if (sharedSubStyle && layer.data.applyStyleToAllSubs !== false) {
      stampSubStyle(layer.data, sharedSubStyle);
    }
    const wordCountInLine = dialog.querySelector("#CountWordSub");
    const contentTextarea = dialog.querySelector("#txtContentSub");
    const useFileCheckbox = dialog.querySelector("#useFileSub");
    const UppercaseSub = dialog.querySelector("#UppercaseSub");
    const subStyleMode = dialog.querySelector("#subStyleMode");
    const ColorBorderSub = dialog.querySelector("#ColorBorderSub");
    const SubPrimaryColor = dialog.querySelector("#SubPrimaryColor");
    const SubHighlightColor = dialog.querySelector("#SubHighlightColor");
    const color_border_sub = dialog.querySelector("#color_border_sub");
    const color_SubPrimaryColor = dialog.querySelector("#color_SubPrimaryColor");
    const color_SubHighlightColor = dialog.querySelector("#color_SubHighlightColor")
    const valBorderSub = dialog.querySelector("#valBorderSub");
    const valFontSizeSub = dialog.querySelector("#valFontSizeSub");
    valBorderSub.value  = layer.data.BorderWidth;
    valFontSizeSub.value = layer.data.FontSize != null ? layer.data.FontSize : 18;
    contentTextarea.value = layer.data.text;
    wordCountInLine.value = layer.data.wordCountInLine;
    useFileCheckbox.checked = layer.data.userFileSrt;
    UppercaseSub.checked = layer.data.Uppercase;
    
    ColorBorderSub.value = layer.data.BorderColor || "#000000";
    SubPrimaryColor.value = layer.data.PrimaryColor || "#ffffff";
    SubHighlightColor.value = layer.data.HighlightColor || "#c9c500";
    color_border_sub.style.background = ColorBorderSub.value;
    color_SubPrimaryColor.style.background = SubPrimaryColor.value;
    color_SubHighlightColor.style.background = SubHighlightColor.value;
    ColorBorderSub.addEventListener("input", () => {
        color_border_sub.style.background = ColorBorderSub.value;
        layer.data.BorderColor = ColorBorderSub.value;
        updateLayerGuideContent(layer);
        maybeApplySubStyleToAll(layer);
    });
    SubPrimaryColor.addEventListener("input", () => {
        color_SubPrimaryColor.style.background = SubPrimaryColor.value;
        layer.data.PrimaryColor = SubPrimaryColor.value;
        updateLayerGuideContent(layer);
        maybeApplySubStyleToAll(layer);
    });
    SubHighlightColor.addEventListener("input", () => {
        color_SubHighlightColor.style.background = SubHighlightColor.value;
        layer.data.HighlightColor = SubHighlightColor.value;
        maybeApplySubStyleToAll(layer);
    });
    setCheckbox(useFileCheckbox, !!layer.data.userFileSrt);
    setCheckbox(UppercaseSub, layer.data.Uppercase);
    const applyAll = dialog.querySelector("#ApplySubStyleAll");
    const subCount = timelineLayers.filter((l) => l.type === "sub").length;
    setCheckbox(applyAll, layer.data.applyStyleToAllSubs !== false && subCount > 1);
    applyAll.addEventListener("change", function () {
      const box = this.closest(".rs-checkbox");
      const on = !!(this.checked || (box && box.classList.contains("rs-on")));
      layer.data.applyStyleToAllSubs = on;
      if (on) {
        readSubStyleFromDialogInto(layer);
        applySubStyleToAll(layer);
        applySubPositionToAll(layer);
      }
    });
    const resolvedStyle = layer.data.styleMode
      || (layer.data.style_karaoke === false ? "default" : "karaoke");
    subStyleMode.value = resolvedStyle;
    dialog.querySelectorAll(".rs-sub-style-pill").forEach((pill) => {
      pill.classList.toggle("is-on", pill.dataset.style === resolvedStyle);
      pill.addEventListener("click", () => {
        dialog.querySelectorAll(".rs-sub-style-pill").forEach((p) => p.classList.remove("is-on"));
        pill.classList.add("is-on");
        subStyleMode.value = pill.dataset.style;
        subStyleMode.dispatchEvent(new Event("change"));
      });
    });
    subStyleMode.addEventListener("change", function () {
      layer.data.styleMode = this.value;
      layer.data.style_karaoke = this.value === "karaoke";
      const chrome = dialog.querySelector("#subBoxChromeFields");
      if (chrome) chrome.style.opacity = this.value === "box" ? "1" : "0.55";
      updateLayerGuideContent(layer);
      maybeApplySubStyleToAll(layer);
    });

    const boxOpInput = dialog.querySelector("#numLayerSubBoxOpVal");
    const boxOpLabel = dialog.querySelector("#layerSubBoxOpVal");
    const boxRInput = dialog.querySelector("#numLayerSubBoxRadius");
    const boxRLabel = dialog.querySelector("#layerSubBoxRadiusVal");
    let boxOp = Number(layer.data.BoxOpacity);
    if (!Number.isFinite(boxOp)) boxOp = 0.78;
    let boxR = parseInt(layer.data.BoxRadius, 10);
    if (isNaN(boxR)) boxR = 16;
    if (boxOpInput) {
      boxOpInput.value = boxOp;
      if (boxOpLabel) boxOpLabel.textContent = boxOp.toFixed(2);
      boxOpInput.addEventListener("input", function () {
        layer.data.BoxOpacity = parseFloat(this.value);
        if (isNaN(layer.data.BoxOpacity)) layer.data.BoxOpacity = 0.78;
        if (boxOpLabel) boxOpLabel.textContent = layer.data.BoxOpacity.toFixed(2);
        updateLayerGuideContent(layer);
        maybeApplySubStyleToAll(layer);
      });
    }
    if (boxRInput) {
      boxRInput.value = boxR;
      if (boxRLabel) boxRLabel.textContent = boxR + "px";
      boxRInput.addEventListener("input", function () {
        layer.data.BoxRadius = parseInt(this.value, 10) || 0;
        if (boxRLabel) boxRLabel.textContent = layer.data.BoxRadius + "px";
        updateLayerGuideContent(layer);
        maybeApplySubStyleToAll(layer);
      });
    }
    const chrome = dialog.querySelector("#subBoxChromeFields");
    if (chrome) chrome.style.opacity = resolvedStyle === "box" ? "1" : "0.55";

    function refreshTcontentTextarea(useFile) {
      const wrap = contentTextarea.closest(".rs-sub-textarea-wrap") || contentTextarea.closest(".rs-stepper");
      contentTextarea.classList.toggle("rs-disabled", !!useFile);
      contentTextarea.disabled = !!useFile;
      wrap?.classList.toggle("rs-disabled", !!useFile);
    }

    refreshTcontentTextarea(useFileCheckbox.checked);
    useFileCheckbox.addEventListener("change", function () {
      layer.data.userFileSrt = this.checked;
      refreshTcontentTextarea(this.checked);
    });
    const fontSelect = dialog.querySelector("#FontFilterSub");
    const fontStyle = dialog.querySelector("#FontStyleSub");
    if (fontSelect && fontStyle) {
      updateFontStyles(layer.data.FontName || "Roboto", "FontStyleSub");
      fontSelect.value = layer.data.FontName || "Roboto";
      if (layer.data.FontStyle) fontStyle.value = layer.data.FontStyle;
      const applySubFontChoice = async () => {
        const font = systemFonts.find(
          (f) => f.name === fontSelect.value && f.style === fontStyle.value
        ) || systemFonts.find((f) => f.name === fontSelect.value);
        if (!font) return;
        layer.data.FontName = font.name;
        layer.data.FontStyle = font.style;
        layer.data.FontWeight = font.weight;
        layer.data.FontFile = font.path;
        await ensureFontLoaded(font.name, font.style);
        updateLayerGuideContent(layer);
        maybeApplySubStyleToAll(layer);
      };
      fontSelect.addEventListener("change", async () => {
        updateFontStyles(fontSelect.value, "FontStyleSub");
        await applySubFontChoice();
      });
      fontStyle.addEventListener("change", applySubFontChoice);
      ensureFontLoaded(layer.data.FontName || "Roboto", layer.data.FontStyle || fontStyle.value);
    }
    valFontSizeSub.addEventListener("input", function () {
      layer.data.FontSize = parseInt(this.value, 10) || 18;
      updateLayerGuideContent(layer);
      maybeApplySubStyleToAll(layer);
    });
    valBorderSub.addEventListener("input", function () {
      layer.data.BorderWidth = parseInt(this.value, 10);
      if (isNaN(layer.data.BorderWidth)) layer.data.BorderWidth = 3;
      maybeApplySubStyleToAll(layer);
    });
    wordCountInLine.addEventListener("input", function () {
      layer.data.wordCountInLine = parseInt(this.value, 10) || 1;
      maybeApplySubStyleToAll(layer);
    });
    UppercaseSub.addEventListener("change", function () {
      const box = this.closest(".rs-checkbox");
      layer.data.Uppercase = !!(this.checked || (box && box.classList.contains("rs-on")));
      updateLayerGuideContent(layer);
      maybeApplySubStyleToAll(layer);
    });
  }
  if (layer.type === "text") {
    if (sharedTextStyle && layer.data.applyStyleToAllTexts !== false) {
      stampTextStyle(layer.data, sharedTextStyle);
    }
    if (sharedTextPos && layer.data.applyStyleToAllTexts !== false) {
      stampTextPosition(layer.data, sharedTextPos);
    }
    const fontSelect = document.getElementById("FontFilterText");
    const fontStyle = document.getElementById("FontStyleText");
    const fontSizeSelect = document.getElementById("FontSizeText");
    const contentTextarea = document.getElementById("txtContentText");
    const useFile = document.getElementById("useFileText");
    const c1 = document.getElementById("TextColor1");
    const c2 = document.getElementById("TextColor2");
    const cb = document.getElementById("TextBorderColor");
    const cb1 = document.getElementById("TextBorderColor1");
    const boxc = document.getElementById("TextBoxColor");
    const p1 = document.getElementById("color_text1");
    const p2 = document.getElementById("color_text2");
    const pb = document.getElementById("color_text_border");
    const pb1 = document.getElementById("color_text_border1");
    const pbox = document.getElementById("color_text_box");
    const borderInput = document.getElementById("valBorderText");
    const borderInput1 = document.getElementById("valBorderText1");

    updateFontStyles(layer.data.FontName || "Roboto", "FontStyleText");
    fontSelect.value = layer.data.FontName || "Roboto";
    fontStyle.value = layer.data.FontStyle || fontStyle.value;
    fontSizeSelect.value = layer.data.FontSize || 22;
    contentTextarea.value = layer.data.text || "";
    borderInput.value = layer.data.BorderWidth != null ? layer.data.BorderWidth : 3;
    if (borderInput1) borderInput1.value = layer.data.BorderWidth1 != null ? layer.data.BorderWidth1 : 2;
    c1.value = layer.data.FontColor || "#FFD400";
    c2.value = layer.data.FontColor2 || "#FF1A1A";
    cb.value = layer.data.BorderColor || "#FFFFFF";
    if (cb1) cb1.value = layer.data.BorderColor1 || "#000000";
    boxc.value = layer.data.BoxColor || "#1c1c1c";
    p1.style.background = c1.value;
    p2.style.background = c2.value;
    pb.style.background = cb.value;
    if (pb1) pb1.style.background = cb1.value;
    pbox.style.background = boxc.value;
    const boxOp = layer.data.BoxOpacity != null ? Number(layer.data.BoxOpacity) : 0.78;
    const boxOpInput = document.getElementById("numLayerTextBoxOpVal");
    const boxOpLabel = document.getElementById("layerTextBoxOpVal");
    if (boxOpInput) boxOpInput.value = boxOp;
    if (boxOpLabel) boxOpLabel.textContent = boxOp.toFixed(2);
    boxOpInput?.addEventListener("input", function () {
      layer.data.BoxOpacity = parseFloat(this.value);
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    const radius = layer.data.BoxRadius != null ? Number(layer.data.BoxRadius) : 24;
    const radiusInput = document.getElementById("numLayerTextBoxRadius");
    const radiusLabel = document.getElementById("layerTextBoxRadiusVal");
    if (radiusInput) radiusInput.value = radius;
    if (radiusLabel) radiusLabel.textContent = Math.round(radius) + "px";
    radiusInput?.addEventListener("input", function () {
      layer.data.BoxRadius = parseInt(this.value, 10) || 0;
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    const padPct = getTextBoxPaddingPct(layer);
    const padInput = document.getElementById("numLayerTextBoxPad");
    const padLabel = document.getElementById("layerTextBoxPadVal");
    if (padInput) padInput.value = padPct;
    if (padLabel) padLabel.textContent = Math.round(padPct) + "%";
    padInput?.addEventListener("input", function () {
      layer.data.BoxPadding = parseInt(this.value, 10) || 0;
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    const gapPct = getTextBoxLineGapPct(layer);
    const gapInput = document.getElementById("numLayerTextBoxGap");
    const gapLabel = document.getElementById("layerTextBoxGapVal");
    if (gapInput) gapInput.value = gapPct;
    if (gapLabel) gapLabel.textContent = Math.round(gapPct) + "%";
    gapInput?.addEventListener("input", function () {
      layer.data.BoxLineGap = parseInt(this.value, 10) || 0;
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    setCheckbox(useFile, !!layer.data.useFileText);
    setCheckbox(dialog.querySelector("#TextIsTimeIsVideo"), layer.data.timelineIsVideo);
    const applyTextAll = dialog.querySelector("#ApplyTextStyleAll");
    setCheckbox(applyTextAll, layer.data.applyStyleToAllTexts !== false);
    applyTextAll?.addEventListener("change", function () {
      const box = this.closest(".rs-checkbox");
      const on = !!(this.checked || (box && box.classList.contains("rs-on")));
      layer.data.applyStyleToAllTexts = on;
      if (on) applyTextStyleAndPositionToAll(layer);
    });
    if (layer.data.timelineIsVideo) setDisabled("layerEditEnd", true);

    function refreshTextArea(on) {
      const wrap = contentTextarea.closest(".rs-sub-textarea-wrap");
      contentTextarea.disabled = !!on;
      wrap?.classList.toggle("rs-disabled", !!on);
    }
    refreshTextArea(useFile.checked);
    useFile.addEventListener("change", function () {
      layer.data.useFileText = this.checked;
      refreshTextArea(this.checked);
      updateLayerGuideContent(layer);
    });
    contentTextarea.addEventListener("input", function () {
      layer.data.text = this.value;
      updateLayerGuideContent(layer);
    });
    fontSizeSelect.addEventListener("change", function () {
      layer.data.FontSize = parseInt(this.value, 10) || 22;
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    borderInput.addEventListener("input", function () {
      layer.data.BorderWidth = parseInt(this.value, 10) || 0;
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    borderInput1?.addEventListener("input", function () {
      layer.data.BorderWidth1 = parseInt(this.value, 10) || 0;
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    const bindColor = (picker, preview, key) => {
      picker.addEventListener("input", () => {
        preview.style.background = picker.value;
        layer.data[key] = picker.value;
        updateLayerGuideContent(layer);
        maybeApplyTextStyleToAll(layer);
      });
    };
    bindColor(c1, p1, "FontColor");
    bindColor(c2, p2, "FontColor2");
    bindColor(cb, pb, "BorderColor");
    if (cb1 && pb1) bindColor(cb1, pb1, "BorderColor1");
    bindColor(boxc, pbox, "BoxColor");

    fontSelect.addEventListener("change", async () => {
      updateFontStyles(fontSelect.value, "FontStyleText");
      const nextStyle = fontStyle.value;
      const font = pickSystemFont(fontSelect.value, nextStyle);
      if (!font) {
        layer.data.FontName = fontSelect.value;
        updateLayerGuideContent(layer);
        return;
      }
      fontStyle.value = font.style;
      const url = await window.pywebview.api.get_font_url(font.path);
      await loadFont(font.name, url);
      if (typeof loadedFonts !== "undefined") loadedFonts.add(font.path);
      layer.data.FontName = font.name;
      layer.data.FontStyle = font.style;
      layer.data.FontWeight = font.weight;
      layer.data.FontFile = font.path;
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
    fontStyle.addEventListener("change", async function () {
      layer.data.FontStyle = this.value;
      const font = pickSystemFont(layer.data.FontName, layer.data.FontStyle);
      if (font) {
        layer.data.FontStyle = font.style;
        layer.data.FontWeight = font.weight;
        layer.data.FontFile = font.path;
      }
      await ensureFontLoaded(layer.data.FontName, layer.data.FontStyle);
      updateLayerGuideContent(layer);
      maybeApplyTextStyleToAll(layer);
    });
  }
  if(layer.type==="hook"){
      if (sharedHookStyle && layer.data.applyStyleToAllHooks !== false) {
        stampHookStyle(layer.data, sharedHookStyle);
      }
      if (sharedHookPos && layer.data.applyStyleToAllHooks !== false) {
        stampHookPosition(layer.data, sharedHookPos);
      }
      const fontSelect = document.getElementById("FontFilter");
      const fontStyle = document.getElementById("FontStyle");
      const fontSizeSelect = document.getElementById("FontSize");
      const contentTextarea = document.getElementById("txtContentHook");

      const fontSelect2 = document.getElementById("FontFilter2");
      const fontStyle2 = document.getElementById("FontStyle2");
      const fontSizeSelect2 = document.getElementById("FontSize2");
      const towLineCheckbox = document.getElementById("isHookTowLine");
      const countInput = document.getElementById("countword_hook");
      const lineSpacingSlider = document.getElementById("numlayerDistanceTowLine");
      const lineSpacingLabel = document.getElementById("layerDistanceTowLine");
      const picker = document.getElementById("fontColor");
      const preview = document.getElementById("color_preview");
      const picker2 = document.getElementById("fontColor2");
      const preview2 = document.getElementById("color_preview2");
      const isHookUpper = document.getElementById("isHookUpper")
      const pickerBorderHook = document.getElementById("fontColorBorderHook");
      const borderHookInput = document.getElementById("valBorderHook");
      const previewBorderHook = document.getElementById("color_border_hook");

      preview.style.background = layer.data.FontColor;
      preview2.style.background = layer.data.FontColor2;
      picker.addEventListener("input", () => {
          preview.style.background = picker.value;
          layer.data.FontColor =  picker.value;
          updateLayerGuideContent(layer);
          maybeApplyHookStyleToAll(layer);
      });
      picker2.addEventListener("input", () => {
          preview2.style.background = picker2.value;
          layer.data.FontColor2 =  picker2.value;
          updateLayerGuideContent(layer);
          maybeApplyHookStyleToAll(layer);
      });

      pickerBorderHook.addEventListener("input", () => {
          previewBorderHook.style.background = pickerBorderHook.value;
          layer.data.BorderColor = pickerBorderHook.value;
          updateLayerGuideContent(layer);
          maybeApplyHookStyleToAll(layer);
      });
      borderHookInput.addEventListener("input", () => {
          layer.data.BorderWidth = parseInt(borderHookInput.value) || 0;
          updateLayerGuideContent(layer);
          maybeApplyHookStyleToAll(layer);
      });
      // Ẩn/hiện khối font dòng 2 + bật/tắt ô "số từ dòng 1" theo trạng thái 2 dòng
      function refreshTwoLineUI(isTwo) {
        // document.getElementById("hookFont2Row").style.display = isTwo ? "grid" : "none";
        const hookFont2Row = document.getElementById("hookFont2Row");
        const hookFont2Label = document.getElementById("hookFont2Label");

        if (isTwo) {
            hookFont2Row.classList.remove("rs-disabled");
            hookFont2Label.classList.remove("rs-disabled")
        } else {
            hookFont2Row.classList.add("rs-disabled");
            hookFont2Label.classList.add("rs-disabled")
        }
        // document.getElementById("hookFont2Row").style.pointerEvents=isTwo ? "none":"visible";
        // document.getElementById("hookFont2Label").style.display = isTwo ? "block" : "none";
        setDisabled("countword_hook", !isTwo);
        document.getElementById("hookLineGapRow")?.classList.toggle("rs-disabled", !isTwo);
      }

      fontSelect.addEventListener("change", async () => {
          updateFontStyles(fontSelect.value);

          const font = systemFonts.find(f =>
              f.name === fontSelect.value &&
              f.style === fontStyle.value
          );

          if (!font) return;

          const url = await window.pywebview.api.get_font_url(font.path);

          await loadFont(font.name, url);

          layer.data.FontName = font.name;
          layer.data.FontStyle = font.style;
          layer.data.FontWeight = font.weight; // <-- thiếu dòng này trước đây, khiến weight bị "kẹt" ở giá trị cũ
          layer.data.FontFile = font.path;

          updateLayerGuideContent(layer); // cập nhật khung preview ngay khi đổi font
          maybeApplyHookStyleToAll(layer);
      });
    fontStyle.addEventListener("change", async function () {

        layer.data.FontStyle = this.value;

        const font = systemFonts.find(f =>
            f.name === layer.data.FontName &&
            f.style === layer.data.FontStyle
        );

        if (font) {
            layer.data.FontWeight = font.weight; // <-- fix chính: cập nhật weight khi đổi đậm/nghiêng
            layer.data.FontFile = font.path;
        }

        await ensureFontLoaded(
            layer.data.FontName,
            layer.data.FontStyle
        );

        updateLayerGuideContent(layer); // cập nhật khung preview ngay khi đổi kiểu chữ
        maybeApplyHookStyleToAll(layer);
    });

    fontSizeSelect.addEventListener("change", function () {
        layer.data.FontSize = parseInt(this.value);
        updateLayerGuideContent(layer); // cập nhật khung preview ngay khi đổi cỡ chữ
        maybeApplyHookStyleToAll(layer);
    });

    contentTextarea.addEventListener("input", function () {
        layer.data.text = this.value;
        updateLayerGuideContent(layer); // cập nhật khung preview ngay khi gõ nội dung (tách 2 dòng nếu cần)
    });

    // ---- Font DÒNG 2 ----
    fontSelect2.addEventListener("change", async () => {
        updateFontStyles(fontSelect2.value, "FontStyle2");

        const font = systemFonts.find(f =>
            f.name === fontSelect2.value &&
            f.style === fontStyle2.value
        );

        if (!font) return;

        const url = await window.pywebview.api.get_font_url(font.path);
        await loadFont(font.name, url);

        layer.data.FontName2 = font.name;
        layer.data.FontStyle2 = font.style;
        layer.data.FontWeight2 = font.weight;
        layer.data.FontFile2 = font.path;

        updateLayerGuideContent(layer);
        maybeApplyHookStyleToAll(layer);
    });

    fontStyle2.addEventListener("change", async function () {
        layer.data.FontStyle2 = this.value;

        const font = systemFonts.find(f =>
            f.name === layer.data.FontName2 &&
            f.style === layer.data.FontStyle2
        );

        if (font) {
            layer.data.FontWeight2 = font.weight;
            layer.data.FontFile2 = font.path;
        }

        await ensureFontLoaded(layer.data.FontName2, layer.data.FontStyle2);

        updateLayerGuideContent(layer);
        maybeApplyHookStyleToAll(layer);
    });

    fontSizeSelect2.addEventListener("change", function () {
        layer.data.FontSize2 = parseInt(this.value);
        updateLayerGuideContent(layer);
        maybeApplyHookStyleToAll(layer);
    });

    // ---- Bật/tắt "Hook có 2 dòng" ----
    towLineCheckbox.addEventListener("change", function () {
        layer.data.isTowLine = this.checked;
        refreshTwoLineUI(this.checked);
        updateLayerGuideContent(layer);
        maybeApplyHookStyleToAll(layer);
    });
    isHookUpper.addEventListener("change", function () {
        layer.data.isHookUpper = this.checked;
        updateLayerGuideContent(layer);
        maybeApplyHookStyleToAll(layer);
    });
  const towLineWrapper = towLineCheckbox.closest(".rs-checkbox");
    towLineWrapper?.addEventListener("click", function () {
        setTimeout(() => {
            layer.data.isTowLine = towLineCheckbox.checked;
            refreshTwoLineUI(towLineCheckbox.checked);
            updateLayerGuideContent(layer);
            maybeApplyHookStyleToAll(layer);
        }, 0);
    });
    const isHookUpperWrapper = isHookUpper.closest(".rs-checkbox");
      isHookUpperWrapper?.addEventListener("click", function () {
          setTimeout(() => {
              layer.data.isHookUpper = isHookUpper.checked;
              updateLayerGuideContent(layer);
              maybeApplyHookStyleToAll(layer);
          }, 0);
      });
    // ---- Số từ dòng 1 ----
    countInput.addEventListener("input", function () {
        layer.data.countword_hook = parseInt(this.value) || 1;
        updateLayerGuideContent(layer);
        maybeApplyHookStyleToAll(layer);
    });
    lineSpacingSlider.addEventListener("input", function () {
      const val = parseFloat(this.value) || 0;
      layer.data.lineSpacing = val;
      lineSpacingLabel.textContent = val.toFixed(0) + "%";
      updateLayerGuideContent(layer);
      maybeApplyHookStyleToAll(layer);
    });
    dialog.querySelector("#txtContentHook").value= layer.data.text;
    dialog.querySelector("#countword_hook").value= layer.data.countword_hook;
    dialog.querySelector("#valBorderHook").value= layer.data.BorderWidth;
    dialog.querySelector("#fontColorBorderHook").value= layer.data.BorderColor;
    previewBorderHook.style.background = layer.data.BorderColor;
    lineSpacingSlider.value = layer.data.lineSpacing ?? 10;
    lineSpacingLabel.textContent = (layer.data.lineSpacing ?? 10).toFixed(0) + "%";
    setCheckbox( dialog.querySelector("#isHookTowLine"),layer.data.isTowLine);
    setCheckbox( dialog.querySelector("#HookisTimeIsVideo"),layer.data.timelineIsVideo);
    setCheckbox( dialog.querySelector("#useContentList"),layer.data.useContentList);
    setCheckbox(dialog.querySelector("#isHookUpper"),layer.data.isHookUpper)
    const applyHookAll = dialog.querySelector("#ApplyHookStyleAll");
    setCheckbox(applyHookAll, layer.data.applyStyleToAllHooks !== false);
    applyHookAll?.addEventListener("change", function () {
      const box = this.closest(".rs-checkbox");
      const on = !!(this.checked || (box && box.classList.contains("rs-on")));
      layer.data.applyStyleToAllHooks = on;
      if (on) applyHookStyleAndPositionToAll(layer);
    });
    const hookStyleMode = dialog.querySelector("#hookStyleMode");
    const resolvedHookStyle = layer.data.hookStyle === "neon"
      ? "default"
      : (layer.data.hookStyle || "default");
    if (hookStyleMode) hookStyleMode.value = resolvedHookStyle;
    dialog.querySelectorAll("#hookStylePills .rs-sub-style-pill").forEach((pill) => {
      pill.classList.toggle("is-on", pill.dataset.style === resolvedHookStyle);
      pill.addEventListener("click", () => {
        dialog.querySelectorAll("#hookStylePills .rs-sub-style-pill").forEach((p) => p.classList.remove("is-on"));
        pill.classList.add("is-on");
        if (hookStyleMode) hookStyleMode.value = pill.dataset.style;
        layer.data.hookStyle = pill.dataset.style;
        updateLayerGuideContent(layer);
        maybeApplyHookStyleToAll(layer);
      });
    });
    dialog.querySelector("#FontFilter").value = layer.data.FontName;
    dialog.querySelector("#FontStyle").value = layer.data.FontStyle;
    dialog.querySelector("#FontSize").value = layer.data.FontSize;

    // Khởi tạo UI + giá trị cho font dòng 2
    updateFontStyles(layer.data.FontName2 || layer.data.FontName, "FontStyle2");
    document.getElementById("FontFilter2").value = layer.data.FontName2 || layer.data.FontName;
    document.getElementById("FontStyle2").value = layer.data.FontStyle2 || layer.data.FontStyle;
    document.getElementById("FontSize2").value = layer.data.FontSize2 || layer.data.FontSize;
    refreshTwoLineUI(layer.data.isTowLine);

    if(layer.data.timelineIsVideo){
       setDisabled("layerEditEnd", true);
    }
    if(layer.data.useContentList){
       setDisabled("txtContentHook", true);
    }
  }
  switchSideTab("props");
  const empty = document.getElementById("layerPropsEmpty");
  if (empty) empty.hidden = true;
  dialog.hidden = false;
  dialog.style.display = "flex";
  dialog.style.opacity = "1";
  if (box) {
    box.style.opacity = "1";
    box.style.transform = "none";
  }
  bindFollowVideoTimeToggles();
  syncLayerEditTimes(layer);
}

function closeLayerEdit() {
  const dialog = document.getElementById("layerEditDialog");
  const empty = document.getElementById("layerPropsEmpty");
  if (dialog) {
    dialog.hidden = true;
    dialog.style.display = "none";
  }
  if (empty) empty.hidden = false;
  editingLayer = null;
}

const SUB_POS_KEYS = ["x", "y", "width", "height"];
const SUB_STYLE_KEYS = [
  "FontName",
  "FontStyle",
  "FontSize",
  "FontFile",
  "FontWeight",
  "wordCountInLine",
  "Uppercase",
  "BorderWidth",
  "BorderColor",
  "PrimaryColor",
  "HighlightColor",
  "styleMode",
  "style_karaoke",
  "BoxOpacity",
  "BoxRadius",
];

let sharedSubStyle = null;

function isApplySubStyleAllChecked() {
  const input = document.querySelector("#ApplySubStyleAll");
  if (!input) return true;
  const box = input.closest(".rs-checkbox");
  return !!(input.checked || (box && box.classList.contains("rs-on")));
}

function wantsSubApplyAll(layer) {
  if (layer && layer.data && layer.data.applyStyleToAllSubs === false) return false;
  if (editingLayer && editingLayer.type === "sub") return isApplySubStyleAllChecked();
  return true;
}

function collectSubStyle(data) {
  const d = data || {};
  const styleMode = d.styleMode || (d.style_karaoke === false ? "default" : "karaoke");
  return {
    FontName: d.FontName || "Roboto",
    FontStyle: d.FontStyle,
    FontFile: d.FontFile,
    FontWeight: d.FontWeight,
    FontSize: parseInt(d.FontSize, 10) || 14,
    wordCountInLine: parseInt(d.wordCountInLine, 10) || 2,
    Uppercase: !!d.Uppercase,
    BorderWidth: parseInt(d.BorderWidth, 10),
    BorderColor: d.BorderColor || "#000000",
    PrimaryColor: d.PrimaryColor || "#ffffff",
    HighlightColor: d.HighlightColor || "#c9c500",
    styleMode: styleMode,
    style_karaoke: styleMode === "karaoke",
    BoxOpacity: (() => {
      const n = parseFloat(d.BoxOpacity);
      return Number.isFinite(n) ? n : 0.78;
    })(),
    BoxRadius: parseInt(d.BoxRadius, 10),
  };
}

function stampSubStyle(target, style) {
  if (!target || !style) return;
  if (style.BorderWidth == null || isNaN(style.BorderWidth)) style.BorderWidth = 3;
  if (style.BoxRadius == null || isNaN(style.BoxRadius)) style.BoxRadius = 16;
  if (style.BoxOpacity == null || isNaN(style.BoxOpacity)) style.BoxOpacity = 0.78;
  SUB_STYLE_KEYS.forEach((key) => {
    if (style[key] !== undefined) target[key] = style[key];
  });
}

function stampSubPosition(target, data) {
  if (!target || !data) return;
  SUB_POS_KEYS.forEach((key) => {
    if (data[key] !== undefined) target[key] = data[key];
  });
}

function refreshAllSubGuides(includePos) {
  timelineLayers.forEach((layer) => {
    if (layer.type !== "sub") return;
    updateLayerGuideContent(layer);
    if (includePos) {
      const guide = layerGuideElements[layer.id];
      if (guide) updateGuidePosition(guide, layer);
    }
  });
}

function applySubStyleToAll(sourceLayer) {
  if (!sourceLayer || sourceLayer.type !== "sub") return;
  sharedSubStyle = collectSubStyle(sourceLayer.data);
  stampSubStyle(sourceLayer.data, sharedSubStyle);
  sourceLayer.data.applyStyleToAllSubs = true;
  timelineLayers.forEach((layer) => {
    if (layer.type !== "sub") return;
    stampSubStyle(layer.data, sharedSubStyle);
    layer.data.applyStyleToAllSubs = true;
  });
  refreshAllSubGuides(false);
}

function applySubPositionToAll(sourceLayer) {
  if (!sourceLayer || sourceLayer.type !== "sub") return;
  const pos = sourceLayer.data || {};
  timelineLayers.forEach((layer) => {
    if (layer.type !== "sub") return;
    stampSubPosition(layer.data, pos);
    layer.data.applyStyleToAllSubs = true;
  });
  refreshAllSubGuides(true);
}

function applySubStyleAndPositionToAll(sourceLayer) {
  applySubStyleToAll(sourceLayer);
  applySubPositionToAll(sourceLayer);
}

function maybeApplySubStyleToAll(layer) {
  if (!layer || layer.type !== "sub") return;
  sharedSubStyle = collectSubStyle(layer.data);
  if (!wantsSubApplyAll(layer)) return;
  applySubStyleToAll(layer);
}

const OVERLAY_POS_KEYS = ["x", "y", "width", "height"];
const HOOK_STYLE_KEYS = [
  "FontName", "FontStyle", "FontSize", "FontFile", "FontWeight", "FontColor",
  "FontName2", "FontStyle2", "FontSize2", "FontFile2", "FontWeight2", "FontColor2",
  "BorderWidth", "BorderColor", "isTowLine", "isHookUpper", "countword_hook",
  "hookStyle", "lineSpacing",
];
const TEXT_STYLE_KEYS = [
  "FontName", "FontStyle", "FontSize", "FontFile", "FontWeight",
  "FontColor", "FontColor2", "BorderColor", "BorderColor1", "BorderWidth", "BorderWidth1",
  "BoxColor", "BoxOpacity", "BoxRadius", "BoxPadding", "BoxLineGap",
];

let sharedHookStyle = null;
let sharedHookPos = null;
let sharedTextStyle = null;
let sharedTextPos = null;

function forEachLayerOfTypeEverywhere(type, fn) {
  const seen = new Set();
  const visitList = (layers) => {
    if (!Array.isArray(layers)) return;
    layers.forEach((layer) => {
      if (!layer || layer.type !== type) return;
      if (seen.has(layer)) return;
      seen.add(layer);
      if (!layer.data) layer.data = {};
      fn(layer);
    });
  };
  visitList(typeof timelineLayers !== "undefined" ? timelineLayers : []);
  const current = typeof currentMedia !== "undefined" ? currentMedia : null;
  const currentIsSaved = !!(current && current.tracksSaved);
  if (currentIsSaved && typeof defaultTrackSnapshot !== "undefined" && defaultTrackSnapshot) {
    visitList(defaultTrackSnapshot.layers);
  }
  if (typeof mediaList !== "undefined" && Array.isArray(mediaList)) {
    mediaList.forEach((m) => {
      if (!m || m === current) return;
      visitList(m.trackSnapshot && m.trackSnapshot.layers);
    });
  }
  if (typeof flushCurrentTracks === "function") flushCurrentTracks();
}

function isApplyHookStyleAllChecked() {
  const input = document.querySelector("#ApplyHookStyleAll");
  if (!input) return true;
  const box = input.closest(".rs-checkbox");
  return !!(input.checked || (box && box.classList.contains("rs-on")));
}

function isApplyTextStyleAllChecked() {
  const input = document.querySelector("#ApplyTextStyleAll");
  if (!input) return true;
  const box = input.closest(".rs-checkbox");
  return !!(input.checked || (box && box.classList.contains("rs-on")));
}

function wantsHookApplyAll(layer) {
  if (layer && layer.data && layer.data.applyStyleToAllHooks === false) return false;
  if (editingLayer && editingLayer.type === "hook") return isApplyHookStyleAllChecked();
  return true;
}

function wantsTextApplyAll(layer) {
  if (layer && layer.data && layer.data.applyStyleToAllTexts === false) return false;
  if (editingLayer && editingLayer.type === "text") return isApplyTextStyleAllChecked();
  return true;
}

function collectHookStyle(data) {
  const d = data || {};
  const style = {};
  HOOK_STYLE_KEYS.forEach((key) => {
    if (d[key] !== undefined) style[key] = d[key];
  });
  if (style.hookStyle === "neon") style.hookStyle = "default";
  return style;
}

function stampHookStyle(target, style) {
  if (!target || !style) return;
  HOOK_STYLE_KEYS.forEach((key) => {
    if (style[key] !== undefined) target[key] = style[key];
  });
}

function stampHookPosition(target, data) {
  if (!target || !data) return;
  OVERLAY_POS_KEYS.forEach((key) => {
    if (data[key] !== undefined) target[key] = data[key];
  });
}

function collectTextStyle(data) {
  const d = data || {};
  const style = {};
  TEXT_STYLE_KEYS.forEach((key) => {
    if (d[key] !== undefined) style[key] = d[key];
  });
  return style;
}

function stampTextStyle(target, style) {
  if (!target || !style) return;
  TEXT_STYLE_KEYS.forEach((key) => {
    if (style[key] !== undefined) target[key] = style[key];
  });
}

function stampTextPosition(target, data) {
  if (!target || !data) return;
  OVERLAY_POS_KEYS.forEach((key) => {
    if (data[key] !== undefined) target[key] = data[key];
  });
}

function refreshAllGuidesOfType(type, includePos) {
  (timelineLayers || []).forEach((layer) => {
    if (layer.type !== type) return;
    updateLayerGuideContent(layer);
    if (includePos) {
      const guide = layerGuideElements[layer.id];
      if (guide) updateGuidePosition(guide, layer);
    }
  });
}

function applyHookStyleToAll(sourceLayer) {
  applyHookStyleAndPositionToAll(sourceLayer, { includePos: false });
}

function applyHookPositionToAll(sourceLayer) {
  applyHookStyleAndPositionToAll(sourceLayer, { includePos: true, style: false });
}

function applyHookStyleAndPositionToAll(sourceLayer, opts) {
  if (!sourceLayer || sourceLayer.type !== "hook") return;
  const includePos = !opts || opts.includePos !== false;
  const includeStyle = !opts || opts.style !== false;
  if (includeStyle) {
    sharedHookStyle = collectHookStyle(sourceLayer.data);
    stampHookStyle(sourceLayer.data, sharedHookStyle);
  }
  if (includePos) {
    sharedHookPos = {};
    OVERLAY_POS_KEYS.forEach((key) => {
      if (sourceLayer.data[key] !== undefined) sharedHookPos[key] = sourceLayer.data[key];
    });
  }
  sourceLayer.data.applyStyleToAllHooks = true;
  forEachLayerOfTypeEverywhere("hook", (layer) => {
    if (includeStyle && sharedHookStyle) stampHookStyle(layer.data, sharedHookStyle);
    if (includePos && sharedHookPos) stampHookPosition(layer.data, sharedHookPos);
    layer.data.applyStyleToAllHooks = true;
  });
  refreshAllGuidesOfType("hook", includePos);
}

function applyTextStyleToAll(sourceLayer) {
  applyTextStyleAndPositionToAll(sourceLayer, { includePos: false });
}

function applyTextPositionToAll(sourceLayer) {
  applyTextStyleAndPositionToAll(sourceLayer, { includePos: true, style: false });
}

function applyTextStyleAndPositionToAll(sourceLayer, opts) {
  if (!sourceLayer || sourceLayer.type !== "text") return;
  const includePos = !opts || opts.includePos !== false;
  const includeStyle = !opts || opts.style !== false;
  if (includeStyle) {
    sharedTextStyle = collectTextStyle(sourceLayer.data);
    stampTextStyle(sourceLayer.data, sharedTextStyle);
  }
  if (includePos) {
    sharedTextPos = {};
    OVERLAY_POS_KEYS.forEach((key) => {
      if (sourceLayer.data[key] !== undefined) sharedTextPos[key] = sourceLayer.data[key];
    });
  }
  sourceLayer.data.applyStyleToAllTexts = true;
  forEachLayerOfTypeEverywhere("text", (layer) => {
    if (includeStyle && sharedTextStyle) stampTextStyle(layer.data, sharedTextStyle);
    if (includePos && sharedTextPos) stampTextPosition(layer.data, sharedTextPos);
    layer.data.applyStyleToAllTexts = true;
  });
  refreshAllGuidesOfType("text", includePos);
}

function maybeApplyHookStyleToAll(layer) {
  if (!layer || layer.type !== "hook") return;
  sharedHookStyle = collectHookStyle(layer.data);
  if (!wantsHookApplyAll(layer)) return;
  applyHookStyleAndPositionToAll(layer, { includePos: false });
}

function maybeApplyTextStyleToAll(layer) {
  if (!layer || layer.type !== "text") return;
  sharedTextStyle = collectTextStyle(layer.data);
  if (!wantsTextApplyAll(layer)) return;
  applyTextStyleAndPositionToAll(layer, { includePos: false });
}

function inheritSharedOverlayStyle(layer) {
  if (!layer || !layer.data) return;
  if (layer.type === "hook") {
    if (sharedHookStyle) stampHookStyle(layer.data, sharedHookStyle);
    if (sharedHookPos) stampHookPosition(layer.data, sharedHookPos);
  }
  if (layer.type === "text") {
    if (sharedTextStyle) stampTextStyle(layer.data, sharedTextStyle);
    if (sharedTextPos) stampTextPosition(layer.data, sharedTextPos);
  }
  if (layer.type === "sub" && sharedSubStyle && layer.data.applyStyleToAllSubs !== false) {
    stampSubStyle(layer.data, sharedSubStyle);
  }
}

function readSubStyleFromDialogInto(layer) {
  if (!layer) return;
  const dialog = document.getElementById("layerEditDialog");
  if (!dialog) return;
  const pill = dialog.querySelector(".rs-sub-style-pill.is-on");
  const select = dialog.querySelector("#subStyleMode");
  const styleMode = (pill && pill.dataset.style) || (select && select.value) || layer.data.styleMode || "karaoke";
  layer.data.styleMode = styleMode;
  layer.data.style_karaoke = styleMode === "karaoke";
  const fs = dialog.querySelector("#valFontSizeSub");
  layer.data.FontSize = parseInt(fs && fs.value, 10) || layer.data.FontSize || 14;
  const bw = dialog.querySelector("#valBorderSub");
  layer.data.BorderWidth = parseInt(bw && bw.value, 10);
  if (isNaN(layer.data.BorderWidth)) layer.data.BorderWidth = 3;
  const wc = dialog.querySelector("#CountWordSub");
  layer.data.wordCountInLine = parseInt(wc && wc.value, 10) || 1;
  const primary = dialog.querySelector("#SubPrimaryColor");
  const highlight = dialog.querySelector("#SubHighlightColor");
  const border = dialog.querySelector("#ColorBorderSub");
  if (primary && primary.value) layer.data.PrimaryColor = primary.value;
  if (highlight && highlight.value) layer.data.HighlightColor = highlight.value;
  if (border && border.value) layer.data.BorderColor = border.value;
  const boxOp = dialog.querySelector("#numLayerSubBoxOpVal");
  const boxR = dialog.querySelector("#numLayerSubBoxRadius");
  layer.data.BoxOpacity = parseFloat(boxOp && boxOp.value);
  if (isNaN(layer.data.BoxOpacity)) layer.data.BoxOpacity = 0.78;
  layer.data.BoxRadius = parseInt(boxR && boxR.value, 10);
  if (isNaN(layer.data.BoxRadius)) layer.data.BoxRadius = 16;
  const upperInput = dialog.querySelector("#UppercaseSub");
  const upperBox = upperInput && upperInput.closest(".rs-checkbox");
  layer.data.Uppercase = !!(upperInput && (upperInput.checked || (upperBox && upperBox.classList.contains("rs-on"))));
  const fontSelect = dialog.querySelector("#FontFilterSub");
  const fontStyle = dialog.querySelector("#FontStyleSub");
  if (fontSelect && fontSelect.value) {
    layer.data.FontName = fontSelect.value;
    layer.data.FontStyle = (fontStyle && fontStyle.value) || layer.data.FontStyle || "normal";
    const font = (typeof systemFonts !== "undefined" ? systemFonts : []).find(
      (f) => f.name === layer.data.FontName && f.style === layer.data.FontStyle
    ) || (typeof systemFonts !== "undefined" ? systemFonts : []).find(
      (f) => f.name === layer.data.FontName
    );
    if (font) {
      layer.data.FontWeight = font.weight;
      layer.data.FontFile = font.path;
    }
  }
}

function saveLayerEdit() {
  if (!editingLayer) return;

  const dialog = document.getElementById("layerEditDialog");

  let start = parseFloat(dialog.querySelector("#layerEditStart").value);
  let end = parseFloat(dialog.querySelector("#layerEditEnd").value);

  if (isNaN(start)) start = editingLayer.start;
  if (isNaN(end)) end = editingLayer.end;

  start = Math.max(0, start);
  end = Math.max(start + 0.2, end);

  editingLayer.start = start;
  const applyFollow = (follow) => {
    if (!editingLayer.data) editingLayer.data = {};
    editingLayer.data.timelineIsVideo = !!follow;
    if (follow) {
      if (editingLayer.data.baseEnd == null) {
        const stored = Number(editingLayer.end);
        editingLayer.data.baseEnd = Number.isFinite(stored) && stored > editingLayer.start
          ? stored
          : editingLayer.start + 5;
      }
      editingLayer.end = Number(editingLayer.data.baseEnd);
    } else {
      delete editingLayer.data.baseEnd;
      editingLayer.end = end;
    }
  };
  const followId = followVideoInputIdForType(editingLayer.type);
  if (!followId) editingLayer.end = end;
  if(editingLayer.type==="blur"){
    editingLayer.data.opacity =parseFloat(dialog.querySelector("#numLayeropVal").value);
    applyFollow(isFollowVideoChecked("BlurisTimeIsVideo"));
  }
  if (editingLayer.type === "crop") {
    applyFollow(isFollowVideoChecked("CropIsTimeIsVideo"));
  }
  if (editingLayer.type === "trim") {
    applyFollow(isFollowVideoChecked("TrimIsTimeIsVideo"));
  }
  if (editingLayer.type === "ocr") {
    applyFollow(isFollowVideoChecked("OcrIsTimeIsVideo"));
  }
  if (editingLayer.type === "image") {
    editingLayer.data.opacity = parseFloat(dialog.querySelector("#numLayerImageOpVal").value);
    applyFollow(isFollowVideoChecked("ImageIsTimeIsVideo"));
    const guide = layerGuideElements[editingLayer.id];
    if (guide) guide.style.opacity = editingLayer.data.opacity;
  }
  if (editingLayer.type === "sub") {
    applyFollow(isFollowVideoChecked("SubIsTimeIsVideo"));
    const useFileInput = dialog.querySelector("#useFileSub");
    const useFileBox = useFileInput && useFileInput.closest(".rs-checkbox");
    editingLayer.data.text = dialog.querySelector("#txtContentSub").value;
    editingLayer.data.userFileSrt = !!(useFileInput && (useFileInput.checked || (useFileBox && useFileBox.classList.contains("rs-on"))));
    readSubStyleFromDialogInto(editingLayer);
    const applyAll = isApplySubStyleAllChecked();
    editingLayer.data.applyStyleToAllSubs = applyAll;
    updateLayerGuideContent(editingLayer);
    if (applyAll) {
      applySubStyleToAll(editingLayer);
      applySubPositionToAll(editingLayer);
    }
  }
  if (editingLayer.type === "text") {
    editingLayer.data.text = dialog.querySelector("#txtContentText").value;
    editingLayer.data.useFileText = document.querySelector("#useFileText").checked;
    editingLayer.data.FontName = document.getElementById("FontFilterText").value;
    editingLayer.data.FontStyle = document.getElementById("FontStyleText").value;
    editingLayer.data.FontSize = parseInt(document.getElementById("FontSizeText").value, 10) || 22;
    editingLayer.data.BorderWidth = parseInt(document.getElementById("valBorderText").value, 10) || 0;
    editingLayer.data.BorderWidth1 = parseInt(document.getElementById("valBorderText1").value, 10) || 0;
    editingLayer.data.BoxOpacity = parseFloat(document.getElementById("numLayerTextBoxOpVal").value);
    if (isNaN(editingLayer.data.BoxOpacity)) editingLayer.data.BoxOpacity = 0.78;
    editingLayer.data.BoxRadius = parseInt(document.getElementById("numLayerTextBoxRadius").value, 10);
    if (isNaN(editingLayer.data.BoxRadius)) editingLayer.data.BoxRadius = 24;
    editingLayer.data.BoxPadding = parseInt(document.getElementById("numLayerTextBoxPad").value, 10);
    if (isNaN(editingLayer.data.BoxPadding)) editingLayer.data.BoxPadding = 9;
    editingLayer.data.BoxLineGap = parseInt(document.getElementById("numLayerTextBoxGap").value, 10);
    if (isNaN(editingLayer.data.BoxLineGap)) editingLayer.data.BoxLineGap = 40;
    const font = pickSystemFont(editingLayer.data.FontName, editingLayer.data.FontStyle);
    editingLayer.data.FontFile = font?.path;
    editingLayer.data.FontWeight = font?.weight || 400;
    if (font) editingLayer.data.FontStyle = font.style;
    applyFollow(isFollowVideoChecked("TextIsTimeIsVideo"));
    const applyTextAll = isApplyTextStyleAllChecked();
    editingLayer.data.applyStyleToAllTexts = applyTextAll;
    if (applyTextAll) applyTextStyleAndPositionToAll(editingLayer);
    const textLayer = editingLayer;
    ensureFontLoaded(textLayer.data.FontName, textLayer.data.FontStyle).then(() => {
      if (editingLayer === textLayer) updateLayerGuideContent(textLayer);
    });
  }
  if(editingLayer.type==="hook"){
       
        editingLayer.data.countword_hook = parseInt(dialog.querySelector("#countword_hook").value);
        editingLayer.data.BorderWidth = parseInt(dialog.querySelector("#valBorderHook").value);
        applyFollow(isFollowVideoChecked("HookisTimeIsVideo"));
        editingLayer.data.isTowLine = document.querySelector("#isHookTowLine").checked;
        editingLayer.data.useContentList = document.querySelector("#useContentList").checked;
        editingLayer.data.isHookUpper = document.querySelector("#isHookUpper").checked;
        editingLayer.data.FontName =document.getElementById("FontFilter").value;
        editingLayer.data.FontStyle =document.getElementById("FontStyle").value;
        editingLayer.data.FontSize =parseInt(document.getElementById("FontSize").value);
        // editingLayer.data.FontColor = document.getElementById("FontColor").value;
        // editingLayer.data.FontColor2 = document.getElementById("FontColor2").value;

        editingLayer.data.lineSpacing =  parseFloat(dialog.querySelector("#numlayerDistanceTowLine").value) || 0;
        const font = systemFonts.find(f =>
        f.name === editingLayer.data.FontName &&
        f.style === editingLayer.data.FontStyle
        );
        editingLayer.data.FontFile = font?.path;
        editingLayer.data.FontWeight = font?.weight; // <-- thiếu dòng này trước đây, weight không được lưu khi bấm Lưu

        // ---- Lưu font DÒNG 2 ----
        editingLayer.data.FontName2 = document.getElementById("FontFilter2").value;
        editingLayer.data.FontStyle2 = document.getElementById("FontStyle2").value;
        editingLayer.data.FontSize2 = parseInt(document.getElementById("FontSize2").value);
        const font2 = systemFonts.find(f =>
          f.name === editingLayer.data.FontName2 &&
          f.style === editingLayer.data.FontStyle2
        );
        editingLayer.data.FontFile2 = font2?.path;
        editingLayer.data.FontWeight2 = font2?.weight;

        editingLayer.data.text = dialog.querySelector("#txtContentHook").value
        editingLayer.data.hookStyle = (dialog.querySelector("#hookStyleMode") || {}).value || "default";
        const applyHookAll = isApplyHookStyleAllChecked();
        editingLayer.data.applyStyleToAllHooks = applyHookAll;
        updateLayerGuideContent(editingLayer);
        if (applyHookAll) applyHookStyleAndPositionToAll(editingLayer);
  }

  renderTimeline();
  const bound = saveTracksForCurrentMedia({ quiet: true });
  showToast(bound ? "Đã lưu và gán track cho video này" : "Lưu thành công", "ok");
}

/* ---------- RULER (mật độ mốc theo zoom, kiểu CapCut) ---------- */

const RULER_NICE_STEPS = [
  0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800,
];

function pickNiceRulerStep(minSeconds) {
  for (let i = 0; i < RULER_NICE_STEPS.length; i++) {
    if (RULER_NICE_STEPS[i] >= minSeconds) return RULER_NICE_STEPS[i];
  }
  return RULER_NICE_STEPS[RULER_NICE_STEPS.length - 1];
}

function pickMinorRulerStep(major) {
  if (major >= 60) return major / 6;
  if (major === 30 || major === 15) return 5;
  if (major === 10) return 2;
  if (major === 5) return 1;
  if (major === 2) return 0.5;
  if (major === 1) return 0.2;
  if (major <= 0.5) return major / 5;
  return major / 5;
}

function renderRuler() {
  const ruler = document.getElementById("ruler");
  if (!ruler) return;

  const duration = Math.max(0.001, Number(videoState.duration) || 0);
  const width = ruler.clientWidth || ruler.offsetWidth || 800;
  const pxPerSec = width / duration;

  // Nhãn cách nhau ~50px; vạch nhỏ dày hơn (kiểu CapCut)
  const major = pickNiceRulerStep(50 / pxPerSec);
  let minor = pickMinorRulerStep(major);
  if (duration / minor > 500) {
    minor = pickNiceRulerStep(duration / 400);
  }

  ruler.innerHTML = "";
  const frag = document.createDocumentFragment();
  const n = Math.max(1, Math.ceil(duration / minor));

  for (let i = 0; i <= n; i++) {
    const time = i === n ? duration : Math.min(i * minor, duration);
    const left = (time / duration) * 100;
    const majorIdx = Math.round(time / major);
    const isMajor =
      i === 0 ||
      i === n ||
      Math.abs(time - majorIdx * major) <= minor * 0.51;

    const tick = document.createElement("i");
    tick.className = "rs-tick " + (isMajor ? "rs-tick-major" : "rs-tick-minor");
    tick.style.left = left + "%";
    frag.appendChild(tick);

    if (isMajor) {
      const span = document.createElement("span");
      span.style.left = left + "%";
      span.textContent = formatRulerLabel(i === n ? time : majorIdx * major, major);
      frag.appendChild(span);
    }
  }

  ruler.appendChild(frag);
}

if (!window._rulerResizeBound) {
  window._rulerResizeBound = true;
  window.addEventListener("resize", () => renderRuler());
}

/* ---------- TIME DISPLAY (rs-cur / rs-tot) ---------- */

function updateTimeDisplay() {
  const curEl = document.querySelector(".rs-tl-time .rs-cur");
  const totEl = document.querySelector(".rs-tl-time .rs-tot");

  if (curEl) curEl.textContent = formatTime(videoState.currentTime);
  if (totEl) totEl.textContent = formatTime(videoState.duration);
  const pCur = document.getElementById("previewPlayerCur");
  const pTot = document.getElementById("previewPlayerTot");
  if (pCur) pCur.textContent = formatPlayerTimecode(videoState.currentTime);
  if (pTot) pTot.textContent = formatPlayerTimecode(videoState.duration);
  if (!playerSeekDragging) updatePreviewSeekBar(videoState.currentTime);
}

/* ---------- PLAYHEAD ---------- */

function updatePlayheadPosition(seconds) {
  const playhead = document.getElementById("playhead");
  if (!playhead) return;

  const percent = (seconds / videoState.duration) * 100;
  playhead.style.left = percent + "%";
}

function seekTo(seconds) {
  seconds = Math.max(0, Math.min(seconds, videoState.duration));

  previewVideo.currentTime = seconds;
  videoState.currentTime = seconds;

  updatePlayheadPosition(seconds);
  updateTimeDisplay();
  syncLayerGuides();
  if (playheadDragging) scrollTimelineToFollowPlayhead();
}

function getTimelineScrollMain() {
  return document.querySelector(".rs-timeline-main");
}

function getTimelineZoomContent() {
  return document.getElementById("timelineZoomContent");
}

function timeFromTimelineClientX(clientX) {
  const main = getTimelineScrollMain();
  const content = getTimelineZoomContent();
  if (!main || !content) return videoState.currentTime;
  const rect = main.getBoundingClientRect();
  const width = content.offsetWidth || 1;
  const x = main.scrollLeft + (clientX - rect.left);
  const percent = Math.max(0, Math.min(1, x / width));
  return percent * videoState.duration;
}

function autoScrollTimelineWhileDragging(clientX) {
  const main = getTimelineScrollMain();
  const content = getTimelineZoomContent();
  if (!main || !content || timelineZoom <= 1.001) return;
  const rect = main.getBoundingClientRect();
  const rel = clientX - rect.left;
  const edge = 40;
  const maxScroll = Math.max(0, content.offsetWidth - main.clientWidth);
  let delta = 0;
  if (rel > rect.width - edge) {
    delta = 10 + (rel - (rect.width - edge)) * 0.55;
  } else if (rel < edge) {
    delta = -(10 + (edge - rel) * 0.55);
  }
  if (!delta) return;
  main.scrollLeft = Math.max(0, Math.min(maxScroll, main.scrollLeft + delta));
}

function scrollTimelineToFollowPlayhead() {
  const main = getTimelineScrollMain();
  const content = getTimelineZoomContent();
  if (!main || !content) return;
  if (timelineZoom <= 1.001) return;
  const duration = videoState.duration || 1;
  const x = (videoState.currentTime / duration) * content.offsetWidth;
  const pad = 56;
  const viewL = main.scrollLeft;
  const viewR = viewL + main.clientWidth;
  const maxScroll = Math.max(0, content.offsetWidth - main.clientWidth);
  if (x < viewL + pad) {
    main.scrollLeft = Math.max(0, x - pad);
  } else if (x > viewR - pad) {
    main.scrollLeft = Math.min(maxScroll, x - main.clientWidth + pad);
  }
}

let playheadDragging = false;

function startPlayheadDrag(e) {
  e.preventDefault();
  e.stopPropagation();
  playheadDragging = true;
  document.body.style.cursor = "grabbing";
}

document.getElementById("playhead")?.addEventListener("mousedown", startPlayheadDrag);
document.getElementById("ruler")?.addEventListener("mousedown", (e) => {
  startPlayheadDrag(e);
  seekTo(timeFromTimelineClientX(e.clientX));
});

document.addEventListener("mousemove", (e) => {
  if (!playheadDragging) return;
  autoScrollTimelineWhileDragging(e.clientX);
  seekTo(timeFromTimelineClientX(e.clientX));
});

document.addEventListener("mouseup", () => {
  if (!playheadDragging) return;
  playheadDragging = false;
  document.body.style.cursor = "";
});

/* ---------- ĐỒNG BỘ VỚI <video> THẬT ---------- */

previewVideo.addEventListener("loadedmetadata", () => {
  const d = Number(previewVideo.duration);
  if (Number.isFinite(d) && d > 0.2) {
    videoState.duration = d;
    if (typeof currentMedia !== "undefined" && currentMedia) {
      currentMedia.durationSeconds = d;
      if (typeof mediaList !== "undefined") {
        const row = mediaList.find((m) => m.path === currentMedia.path);
        if (row) row.durationSeconds = d;
      }
    }
  }
  videoState.currentTime = previewVideo.currentTime;

  renderRuler();
  renderTimeline();
  updateTimeDisplay();
  updatePlayheadPosition(videoState.currentTime);
});

previewVideo.addEventListener("timeupdate", () => {
  // Không ghi đè currentTime khi đang tự kéo playhead bằng tay
  if (playheadDragging) return;

  videoState.currentTime = previewVideo.currentTime;
  updatePlayheadPosition(videoState.currentTime);
  updateTimeDisplay();
  syncLayerGuides();
});

previewVideo.addEventListener("play", syncPreviewPlayButton);
previewVideo.addEventListener("pause", syncPreviewPlayButton);
previewVideo.addEventListener("ended", () => {
  previewVideo.pause();
  syncPreviewPlayButton();
});

function syncPreviewPlayButton() {
  const btn = document.getElementById("previewPlayBtn");
  if (!btn || !previewVideo) return;
  btn.classList.toggle("is-playing", !previewVideo.paused);
}

function togglePreviewPlayback() {
  if (!previewVideo || !previewVideo.src) return;
  if (previewVideo.paused) previewVideo.play().catch(() => {});
  else previewVideo.pause();
}

function isPreviewExpanded() {
  return document.body.classList.contains("rs-preview-expanded");
}

function setPreviewExpanded(on) {
  document.body.classList.toggle("rs-preview-expanded", !!on);
  const fsBtn = document.getElementById("previewFsBtn");
  if (fsBtn) fsBtn.title = on ? "Thu nhỏ preview" : "Phóng to preview";
  requestAnimationFrame(() => {
    if (typeof updateVideoContainer === "function") updateVideoContainer();
    if (typeof syncLayerGuides === "function") syncLayerGuides();
  });
}

function togglePreviewFullscreen() {
  setPreviewExpanded(!isPreviewExpanded());
}

function updatePreviewSeekBar(seconds) {
  const fill = document.getElementById("previewPlayerSeekFill");
  const thumb = document.getElementById("previewPlayerSeekThumb");
  const dur = videoState.duration || 0;
  const pct = dur > 0 ? Math.max(0, Math.min(100, (seconds / dur) * 100)) : 0;
  if (fill) fill.style.width = pct + "%";
  if (thumb) thumb.style.left = pct + "%";
}

let playerSeekDragging = false;
let playerSeekRaf = 0;
let playerSeekPending = null;

function timeFromPlayerSeekX(clientX) {
  const seek = document.getElementById("previewPlayerSeek");
  if (!seek || !videoState.duration) return 0;
  const rect = seek.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  return ratio * videoState.duration;
}

function previewPlayerScrubUi(seconds) {
  seconds = Math.max(0, Math.min(seconds, videoState.duration || 0));
  videoState.currentTime = seconds;
  updatePreviewSeekBar(seconds);
  updatePlayheadPosition(seconds);
  const pCur = document.getElementById("previewPlayerCur");
  if (pCur) pCur.textContent = formatPlayerTimecode(seconds);
  const curEl = document.querySelector(".rs-tl-time .rs-cur");
  if (curEl) curEl.textContent = formatTime(seconds);
  return seconds;
}

function queuePreviewVideoSeek(seconds) {
  playerSeekPending = seconds;
  if (playerSeekRaf) return;
  playerSeekRaf = requestAnimationFrame(() => {
    playerSeekRaf = 0;
    if (playerSeekPending == null || !previewVideo) return;
    previewVideo.currentTime = playerSeekPending;
  });
}

function initPreviewPlayerBar() {
  const playBtn = document.getElementById("previewPlayBtn");
  const fsBtn = document.getElementById("previewFsBtn");
  const seek = document.getElementById("previewPlayerSeek");
  const bar = document.getElementById("previewPlayerBar");
  if (playBtn) playBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePreviewPlayback();
  });
  if (fsBtn) fsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePreviewFullscreen();
  });
  if (seek) {
    const onPointerMove = (e) => {
      if (!playerSeekDragging) return;
      const t = previewPlayerScrubUi(timeFromPlayerSeekX(e.clientX));
      queuePreviewVideoSeek(t);
    };
    const endScrub = (e) => {
      if (!playerSeekDragging) return;
      playerSeekDragging = false;
      if (bar) bar.classList.remove("is-seeking");
      try { seek.releasePointerCapture(e.pointerId); } catch (err) {}
      seek.removeEventListener("pointermove", onPointerMove);
      seek.removeEventListener("pointerup", endScrub);
      seek.removeEventListener("pointercancel", endScrub);
      if (playerSeekRaf) {
        cancelAnimationFrame(playerSeekRaf);
        playerSeekRaf = 0;
      }
      const t = previewPlayerScrubUi(timeFromPlayerSeekX(e.clientX));
      playerSeekPending = null;
      seekTo(t);
    };
    seek.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      playerSeekDragging = true;
      if (bar) bar.classList.add("is-seeking");
      seek.setPointerCapture(e.pointerId);
      const t = previewPlayerScrubUi(timeFromPlayerSeekX(e.clientX));
      queuePreviewVideoSeek(t);
      seek.addEventListener("pointermove", onPointerMove);
      seek.addEventListener("pointerup", endScrub);
      seek.addEventListener("pointercancel", endScrub);
    });
  }
  if (previewVideo) {
    previewVideo.addEventListener("click", () => togglePreviewPlayback());
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isPreviewExpanded()) {
      e.preventDefault();
      setPreviewExpanded(false);
      return;
    }
    if (e.code !== "Space" && e.key !== " ") return;
    const tag = (e.target && e.target.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || e.target.isContentEditable) return;
    e.preventDefault();
    togglePreviewPlayback();
  });
  syncPreviewPlayButton();
  updateTimeDisplay();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initPreviewPlayerBar();
    initSideInspectorTabs();
  });
} else {
  initPreviewPlayerBar();
  initSideInspectorTabs();
}

/* ---------- TRACK THEO TỪNG VIDEO (Lưu) / BỘ CHUNG (chưa lưu) ---------- */

let defaultTrackSnapshot = null;
let _trackRestoreLock = false;

function serializeLayerForSnapshot(layer) {
  const data = JSON.parse(JSON.stringify((layer && layer.data) || {}));
  const start = Number(layer.start) || 0;
  let end = Number(layer.end) || 0;
  if (data.timelineIsVideo) {
    const base = Number(data.baseEnd);
    end = Number.isFinite(base) && base > start ? base : start + 5;
  }
  return {
    type: layer.type,
    start,
    end,
    row: layer.row || 0,
    zIndex: layer.zIndex || 0,
    data,
  };
}

function captureTrackSnapshot() {
  const layers = (typeof timelineLayers !== "undefined" ? timelineLayers : []).map(serializeLayerForSnapshot);
  return {
    layers,
    cropEnabled: typeof cropEnabled !== "undefined" ? !!cropEnabled : false,
    cropRatio: typeof cropRatio !== "undefined" ? cropRatio : null,
    durationRef: typeof videoState !== "undefined" ? videoState.duration : 0,
  };
}

function flushCurrentTracks() {
  if (_trackRestoreLock) return;
  const snap = captureTrackSnapshot();
  if (typeof currentMedia !== "undefined" && currentMedia && currentMedia.tracksSaved) {
    currentMedia.trackSnapshot = snap;
  } else {
    defaultTrackSnapshot = snap;
  }
}

/** Layer mới luôn vào bộ track chung. Video đã Lưu chỉ khác ở layer đã chỉnh riêng. */
function publishNewLayerToSharedTracks(layer) {
  if (!layer || _trackRestoreLock) return;
  const media = typeof currentMedia !== "undefined" ? currentMedia : null;
  if (!media || !media.tracksSaved) {
    defaultTrackSnapshot = captureTrackSnapshot();
    return;
  }
  if (!defaultTrackSnapshot || !Array.isArray(defaultTrackSnapshot.layers)) {
    defaultTrackSnapshot = captureTrackSnapshot();
  } else {
    defaultTrackSnapshot.layers.push(serializeLayerForSnapshot(layer));
  }
  media.trackSnapshot = captureTrackSnapshot();
}

function getWorkingLayersForMedia(media) {
  flushCurrentTracks();
  let raw;
  if (media && media.tracksSaved && media.trackSnapshot) {
    raw = media.trackSnapshot.layers || [];
  } else if (defaultTrackSnapshot && Array.isArray(defaultTrackSnapshot.layers)) {
    raw = defaultTrackSnapshot.layers;
  } else {
    raw = (typeof timelineLayers !== "undefined" ? timelineLayers : []).map(serializeLayerForSnapshot);
  }
  const dur = mediaDurationSeconds(media) || (!media ? getTimelineDuration() : 0);
  return raw.map((layer) => {
    const copy = serializeLayerForSnapshot(layer);
    copy.start = effectiveLayerStart(layer, dur);
    copy.end = effectiveLayerEnd(layer, dur);
    return copy;
  });
}

async function applyTrackSnapshot(snap) {
  _trackRestoreLock = true;
  try {
    const srcLayers = (snap && snap.layers) || [];
    if (typeof cropEnabled !== "undefined") {
      cropEnabled = !!(snap && snap.cropEnabled);
    }
    if (typeof cropRatio !== "undefined") {
      cropRatio = snap && snap.cropRatio == null ? null : snap.cropRatio;
    }
    timelineLayers = [];
    selectedLayer = null;
    if (typeof closePropsIfEditingMissing === "function") closePropsIfEditingMissing();
    for (const src of srcLayers) {
      const start = Math.max(0, Number(src.start) || 0);
      const end = Math.max(start + 0.2, Number(src.end) || 0);
      const layer = {
        id: nextLayerId++,
        type: src.type,
        start,
        end,
        selected: false,
        row: src.row || 0,
        zIndex: src.zIndex || 0,
        data: JSON.parse(JSON.stringify(src.data || {})),
      };
      timelineLayers.push(layer);
      if (layer.type === "hook" || layer.type === "sub" || layer.type === "text") {
        if (layer.data.FontName && typeof ensureFontLoaded === "function") {
          await ensureFontLoaded(layer.data.FontName, layer.data.FontStyle);
        }
        if (layer.data.FontName2 && typeof ensureFontLoaded === "function") {
          await ensureFontLoaded(layer.data.FontName2, layer.data.FontStyle2);
        }
      }
    }
    if (typeof renderTimeline === "function") renderTimeline();
    if (typeof syncLayerGuides === "function") syncLayerGuides();
  } finally {
    _trackRestoreLock = false;
  }
}

function saveTracksForCurrentMedia(opts) {
  const quiet = !!(opts && opts.quiet);
  const media = typeof currentMedia !== "undefined" ? currentMedia : null;
  if (!media || !media.path) {
    if (!quiet && typeof showCheck === "function") {
      showCheck("Hãy chọn một video rồi bấm Lưu trong thuộc tính.", () => {});
    }
    return false;
  }
  if (!defaultTrackSnapshot) defaultTrackSnapshot = captureTrackSnapshot();
  media.tracksSaved = true;
  media.trackSnapshot = captureTrackSnapshot();
  if (typeof markMediaTracksSaved === "function") markMediaTracksSaved(media.path, true);
  if (!quiet) {
    const msg = "Đã lưu track cho video này. Video chưa lưu vẫn dùng bộ track chung.";
    if (typeof showToast === "function") showToast(msg, "ok");
    else if (typeof showCheck === "function") showCheck(msg, () => {});
  }
  return true;
}

async function switchMediaTrackContext(nextMedia) {
  if (!nextMedia) return;
  const prev = typeof currentMedia !== "undefined" ? currentMedia : null;
  if (prev && prev.path === nextMedia.path) {
    currentMedia = nextMedia;
    return;
  }
  if (prev) {
    if (prev.tracksSaved) prev.trackSnapshot = captureTrackSnapshot();
    else defaultTrackSnapshot = captureTrackSnapshot();
  } else {
    defaultTrackSnapshot = captureTrackSnapshot();
  }
  currentMedia = nextMedia;
  if (nextMedia.tracksSaved && nextMedia.trackSnapshot) {
    await applyTrackSnapshot(nextMedia.trackSnapshot);
  } else {
    await applyTrackSnapshot(defaultTrackSnapshot);
  }
}

window.getTimelineDuration = getTimelineDuration;
window.parseMediaDurationSeconds = parseMediaDurationSeconds;
window.mediaDurationSeconds = mediaDurationSeconds;
window.captureTrackSnapshot = captureTrackSnapshot;
window.flushCurrentTracks = flushCurrentTracks;
window.getWorkingLayersForMedia = getWorkingLayersForMedia;
window.saveTracksForCurrentMedia = saveTracksForCurrentMedia;
window.switchMediaTrackContext = switchMediaTrackContext;

/* ---------- LẤY DỮ LIỆU LAYER THEO LOẠI (để gửi vào config render) ---------- */

function getTimelineLayersByType(type, layerList) {
  const srcLayers = layerList || timelineLayers;
  return srcLayers
    .filter((l) => l && l.type === type)
    .sort((a, b) => a.start - b.start)
    .map((l) => {
      const data = { ...(l.data || {}) };
      if (data.FontSize != null && data.FontSize !== "") {
        data.FontSize = Number(data.FontSize);
      }
      if (data.FontSize2 != null && data.FontSize2 !== "") {
        data.FontSize2 = Number(data.FontSize2);
      }

      // Với hook 2 dòng: đính kèm sẵn 2 dòng đã tách + font riêng từng dòng,
      // để backend render video không phải tự tách từ lại.
      if (l.type === "hook" && data.isTowLine) {
        const { line1, line2 } = splitHookText(data.text, data.countword_hook);
        data.line1 = line1;
        data.line2 = line2;
      } else if (l.type === "hook") {
        delete data.lineSpacing;
        delete data.lineSpacingRatio;
        if (data.isHookUpper) {
          data.text = (data.text || "").toUpperCase();
        }
      }

      return {
        start: Math.round(l.start * 100) / 100,
        end: Math.round(l.end * 100) / 100,
        // l.data chứa dữ liệu riêng của từng loại segment, ví dụ text phụ đề cho "sub"
        data: data,
      };
    });
}

function getAllTimelineLayersData(layerList) {
  return {
    blur: getTimelineLayersByType("blur", layerList),
    hook: getTimelineLayersByType("hook", layerList),
    sub: getTimelineLayersByType("sub", layerList),
    text: getTimelineLayersByType("text", layerList),
    trim: getTimelineLayersByType("trim", layerList),
    crop: getTimelineLayersByType("crop", layerList),
    ocr: getTimelineLayersByType("ocr", layerList),
    image: getTimelineLayersByType("image", layerList),
  };
}
function initLayerEditDrag() {
    const box = document.getElementById("layerEditBox");
    const title = document.getElementById("layerEditTitle");
    if (!box || !title || box.closest(".rs-layer-props-dock")) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    title.addEventListener("mousedown", e => {

        dragging = true;

        const rect = box.getBoundingClientRect();

        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;

        box.style.transition = "none";

        if (box.style.position !== "fixed") {
            box.style.position = "fixed";
            box.style.left = rect.left + "px";
            box.style.top = rect.top + "px";
            box.style.margin = "0";
            box.style.transform = "none";
        }

        e.preventDefault();
    });

    document.addEventListener("mousemove", e => {

        if (!dragging) return;

        box.style.left = (e.clientX - offsetX) + "px";
        box.style.top = (e.clientY - offsetY) + "px";

    });

    document.addEventListener("mouseup", () => {
        dragging = false;
    });
}

/* ---------- INIT ---------- */

renderRuler();
updateTimeDisplay();

function collectTimelineTemplate() {
  const layers = timelineLayers.map((layer) => ({
    type: layer.type,
    start: layer.start,
    end: layer.end,
    row: layer.row || 0,
    zIndex: layer.zIndex || 0,
    data: JSON.parse(JSON.stringify(layer.data || {})),
  }));
  return {
    durationRef: videoState.duration,
    cropEnabled: typeof cropEnabled !== "undefined" ? !!cropEnabled : false,
    cropRatio: typeof cropRatio !== "undefined" ? cropRatio : null,
    layers,
  };
}

function saveTimelineTemplate() {
  const dlg = document.getElementById("saveTemplateDialog");
  const input = document.getElementById("templateNameInput");
  if (!dlg || !input) return;
  input.value = "";
  dlg.classList.add("show");
  setTimeout(() => input.focus(), 50);
}

function closeSaveTemplateDialog() {
  const dlg = document.getElementById("saveTemplateDialog");
  if (dlg) dlg.classList.remove("show");
}

async function confirmSaveTimelineTemplate() {
  if (!window.pywebview) return;
  const input = document.getElementById("templateNameInput");
  const name = (input && input.value || "").trim();
  if (!name) {
    document.getElementById("errortemplateNameInput").style.display="block";
    // showCheck("Vui lòng nhập tên template.", () => {});
    return;
  }
  document.getElementById("errortemplateNameInput").style.display="none";
  const payload = collectTimelineTemplate();
  const res = await window.pywebview.api.save_timeline_template(name, payload);
  closeSaveTemplateDialog();
  if (res && res.ok) {
    const msg = "Đã lưu template \"" + (res.name || name) + "\".";
    if (typeof showToast === "function") showToast(msg, "ok");
    // else if (typeof showCheck === "function") showCheck(msg, () => {});
    // showCheck("Đã lưu template \"" + (res.name || name) + "\".", () => {});
  } else {
    showCheck("Không lưu được template" + (res && res.error ? ": " + res.error : "."), () => {});
  }
}

function closeLoadTemplateDialog() {
  const dlg = document.getElementById("loadTemplateDialog");
  if (dlg) dlg.classList.remove("show");
}

async function openLoadTemplateDialog() {
  if (!window.pywebview) return;
  const dlg = document.getElementById("loadTemplateDialog");
  const list = document.getElementById("templateList");
  if (!dlg || !list) return;
  const items = await window.pywebview.api.list_timeline_templates();
  list.innerHTML = "";
  if (!items || !items.length) {
    list.innerHTML = '<div class="rs-tpl-empty">Chưa có template nào. Hãy lưu cấu hình timeline trước.</div>';
  } else {
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "rs-tpl-item";
      const meta = document.createElement("div");
      meta.className = "rs-tpl-meta";
      meta.innerHTML =
        '<div class="rs-tpl-name"></div>' +
        '<div class="rs-tpl-sub"></div>';
      meta.querySelector(".rs-tpl-name").textContent = item.name || "Template";
      const bits = [];
      if (item.created_at) bits.push(item.created_at);
      bits.push((item.layer_count || 0) + " layer");
      meta.querySelector(".rs-tpl-sub").textContent = bits.join(" · ");
      const actions = document.createElement("div");
      actions.className = "rs-tpl-actions";
      const useBtn = document.createElement("button");
      useBtn.className = "rs-btn-confim rs-btn-ok";
      useBtn.textContent = "DÙNG";
      useBtn.onclick = () => applyTimelineTemplateById(item.id, item.name);
      const delBtn = document.createElement("button");
      delBtn.className = "rs-btn-confim rs-btn-danger";
      delBtn.textContent = "XÓA";
      delBtn.onclick = () => deleteTimelineTemplate(item.id, item.name);
      actions.appendChild(useBtn);
      actions.appendChild(delBtn);
      row.appendChild(meta);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }
  dlg.classList.add("show");
}

async function deleteTimelineTemplate(id, name) {
  showConfirm("Xóa template \"" + (name || "") + "\"?", async () => {
    if (!window.pywebview) return;
    await window.pywebview.api.delete_timeline_template(id);
    openLoadTemplateDialog();
  });
}

async function applyTimelineTemplateById(id, name) {
  if (!window.pywebview) return;
  const go = async () => {
    const res = await window.pywebview.api.load_timeline_template(id);
    if (!res || !res.ok) {
      showCheck("Không tải được template" + (res && res.error ? ": " + res.error : "."), () => {});
      return;
    }
    await applyTimelineTemplate(res.template);
    closeLoadTemplateDialog();
    //showCheck("Đã áp dụng template \"" + (name || res.template.name || "") + "\".", () => {});
  };
  if (timelineLayers.length) {
    showCheck("Áp dụng template sẽ thay thế các layer hiện tại. Tiếp tục?", go);
  } else {
    await go();
  }
}

async function applyTimelineTemplate(rec) {
  const payload = (rec && rec.payload) || {};
  const srcLayers = payload.layers || [];
  const ref = Number(payload.durationRef) || 0;
  const dur = (typeof getTimelineDuration === "function" && isUsableDuration(getTimelineDuration()))
    ? getTimelineDuration()
    : (videoState.duration || 60);
  const scale = ref > 0 ? dur / ref : 1;
  const prevDefault = defaultTrackSnapshot;

  if (typeof cropEnabled !== "undefined") {
    cropEnabled = !!payload.cropEnabled;
  }
  if (typeof cropRatio !== "undefined") {
    cropRatio = payload.cropRatio == null ? null : payload.cropRatio;
  }

  timelineLayers = [];
  selectedLayer = null;
  closePropsIfEditingMissing();

  for (const src of srcLayers) {
    const keepAbsolute = src.type === "ocr" || src.type === "crop";
    const scaleThis = keepAbsolute ? 1 : scale;
    let start = Math.max(0, Number(src.start) * scaleThis);
    let end = Math.max(0, Number(src.end) * scaleThis);
    if (src.type === "crop" && isUsableDuration(dur)) {
      if (start >= dur) continue;
      if (end > dur) end = dur;
      if (end - start < 0.05) continue;
    } else {
      if (end > dur) end = dur;
      if (start >= end) {
        start = Math.max(0, end - 0.2);
      }
    }
    const layer = {
      id: nextLayerId++,
      type: src.type,
      start,
      end,
      selected: false,
      row: src.row || 0,
      zIndex: src.zIndex || 0,
      data: JSON.parse(JSON.stringify(src.data || {})),
    };
    timelineLayers.push(layer);
    if (layer.type === "hook" || layer.type === "sub" || layer.type === "text") {
      if (layer.data.FontName) {
        await ensureFontLoaded(layer.data.FontName, layer.data.FontStyle);
      }
      if (layer.data.FontName2) {
        await ensureFontLoaded(layer.data.FontName2, layer.data.FontStyle2);
      }
    }
  }

  renderTimeline();
  syncLayerGuides();
  if (typeof currentMedia !== "undefined" && currentMedia && currentMedia.path && typeof saveTracksForCurrentMedia === "function") {
    saveTracksForCurrentMedia({ quiet: true });
    defaultTrackSnapshot = prevDefault;
    if (typeof showToast === "function") {
      showToast("Đã tải template thành track riêng. Đoạn Crop ngoài thời lượng video đã bỏ.", "ok");
    }
  } else if (typeof flushCurrentTracks === "function") {
    flushCurrentTracks();
  }
}

document.getElementById("templateNameInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    confirmSaveTimelineTemplate();
  }
});
