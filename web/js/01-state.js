/* =========================================================
 * GLOBAL STATE
 * Biến dùng chung cho toàn bộ app. Load file này ĐẦU TIÊN,
 * trước mọi file khác (timeline, media-list, overlay, crop, render, ui-controls).
 * ========================================================= */

let mediaIndex = 1;
let mode_selected = "render";
let processJobKind = null;
let mediaId = 0; // (chưa thấy dùng ở đâu khác trong code — giữ lại phòng khi cần)

let mediaList = [];
let audioList=[];
let lastSelectedIndex = -1;
let sceneList = [];   // [{ id, name, mediaPaths: [path1, path2, ...] }]
let sceneIndex = 1;   // dùng để đặt tên mặc định "Phân cảnh 1", "Phân cảnh 2"...
// Context menu (click phải vào 1 dòng media)
// Trước đây 2 biến này KHÔNG được khai báo ở đâu cả (bug: biến global ngầm định)
let currentContextRow = null;
let currentContextInfo = null;

let currentMedia = null;

// Overlay (ảnh chèn lên video)
let currentOverlay = null;
let currentOverlayData = null;
let maxZIndex = 1;
let overlays = [];
let overlayId = 0;
let editingOverlay = null;
let IsTimeOverlayImageSameVideo = false;

// Thumbnail queue
const thumbnailQueue = [];
let thumbnailRunning = 0;
const MAX_THUMBNAIL_WORKERS = 10;

// Merge / ratio option
let optionMer = "phancanh";
let currentMerOption;

// Độ phân giải render
const resolutions = {
  0: { width: 1080, height: 1920 },
  1: { width: 720, height: 1280 },
  2: { width: 1920, height: 1080 },
  3: { width: 3840, height: 2160 },
  4: { width: 720, height: 720 },
  5: { width: 1080, height: 1080 },
  6: { width: 1920, height: 1920 },
  7: { width: 1920, height: 1440 }
};

function sourceVideoPixelSize() {
  const video = document.getElementById("previewVideo");
  if (video && video.videoWidth > 0 && video.videoHeight > 0) {
    return { width: video.videoWidth, height: video.videoHeight };
  }
  if (typeof currentMedia !== "undefined" && currentMedia && currentMedia.width && currentMedia.height) {
    return { width: Number(currentMedia.width), height: Number(currentMedia.height) };
  }
  return null;
}

function outputUsesSourceSize() {
  const el = document.getElementById("videoResolution");
  return !!(el && String(el.value) === "src");
}

function currentOutputSize() {
  const el = document.getElementById("videoResolution");
  const key = el ? String(el.value) : "0";
  if (key === "src") {
    return sourceVideoPixelSize() || { width: 1080, height: 1920 };
  }
  return resolutions[key] || { width: 1080, height: 1920 };
}

// DOM refs dùng chung nhiều nơi — khai báo 1 LẦN DUY NHẤT ở đây.
// Các file khác chỉ được ĐỌC biến này, không được khai báo lại (const/let trùng tên sẽ lỗi cú pháp).
const previewVideo = document.getElementById("previewVideo");
// let systemFonts = [];

// async function loadFonts() {
//     systemFonts = await pywebview.api.get_system_fonts();
// }
// document.addEventListener("pywebviewready", async () => {
//     await loadFonts();
// });