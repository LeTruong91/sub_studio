// /* =========================================================
//  * CROP
//  * Kéo/resize khung crop trên preview video
//  * Cần: 01-state.js đã load trước (dùng biến previewVideo)
//  * ========================================================= */

// const cropGuide = document.querySelector(".rs-crop-guide");
// const previewFrame = document.querySelector("#previewFrame");
// const videoContainer = document.getElementById("videoContainer");

// let isDraggingCrop = false;
// let offsetX = 0;
// let offsetY = 0;

// let currentCropButton = null;
// let cropEnabled = false;
// let cropRatio = null;

// let resizing = false;
// let startX, startY;
// let startWidth, startHeight;

// /* ---------- KÉO DI CHUYỂN KHUNG CROP ---------- */

// cropGuide.addEventListener("mousedown", (e) => {
//   e.preventDefault();

//   isDraggingCrop = true;
//   cropGuide.classList.add("dragging");
//   const rect = cropGuide.getBoundingClientRect();
//   const parent = previewFrame.getBoundingClientRect();

//   cropGuide.style.inset = "auto";
//   cropGuide.style.left = rect.left - parent.left + "px";
//   cropGuide.style.top = rect.top - parent.top + "px";

//   offsetX = e.clientX - rect.left;
//   offsetY = e.clientY - rect.top;
// });

// document.addEventListener("mousemove", (e) => {
//   if (resizing) {
//     // Nhánh này giữ nguyên như bản gốc (dùng startWidth/startHeight cố định,
//     // phần thay đổi kích thước thật sự nằm ở resizeHandle mousemove bên dưới)
//     let width = Math.max(50, startWidth);
//     let height = Math.max(50, startHeight);

//     cropGuide.style.width = width + "px";
//     cropGuide.style.height = height + "px";
//     return;
//   }

//   if (!isDraggingCrop) return;

//   const frame = previewFrame.getBoundingClientRect();

//   let x = e.clientX - frame.left - offsetX;
//   let y = e.clientY - frame.top - offsetY;

//   x = Math.max(0, Math.min(x, frame.width - cropGuide.offsetWidth));
//   y = Math.max(0, Math.min(y, frame.height - cropGuide.offsetHeight));

//   cropGuide.style.left = x + "px";
//   cropGuide.style.top = y + "px";
//   cropGuide.style.right = "auto";
//   cropGuide.style.bottom = "auto";
// });

// document.addEventListener("mouseup", () => {
//   isDraggingCrop = false;
//   resizing = false;
//   cropGuide.classList.remove("dragging");
// });

// /* ---------- RESIZE KHUNG CROP (góc dưới-phải) ---------- */

// const resizeHandle = document.querySelector(".crop-handle.br");

// resizeHandle.addEventListener("mousedown", (e) => {
//   e.preventDefault();
//   e.stopPropagation();

//   resizing = true;
//   startX = e.clientX;
//   startY = e.clientY;
//   startWidth = cropGuide.offsetWidth;
//   startHeight = cropGuide.offsetHeight;
// });

// document.addEventListener("mousemove", (e) => {
//   if (!resizing) return;

//   let newHeight = 0;
//   let newWidth = startWidth + (e.clientX - startX);

//   if (cropRatio > 0) {
//     newHeight = newWidth / cropRatio;
//   } else {
//     newHeight = startHeight + (e.clientY - startY);
//   }

//   newWidth = Math.max(80, newWidth);
//   newHeight = Math.max(80, newHeight);

//   const frameWidth = previewFrame.clientWidth - cropGuide.offsetLeft;
//   const frameHeight = previewFrame.clientHeight - cropGuide.offsetTop;

//   newWidth = Math.min(newWidth, frameWidth);
//   newHeight = Math.min(newHeight, frameHeight);

//   cropGuide.style.width = newWidth + "px";
//   cropGuide.style.height = newHeight + "px";
// });

// document.addEventListener("mouseup", () => {
//   resizing = false;
// });

// /* ---------- CHỌN TỶ LỆ CROP (nút bấm 9:16, 1:1, v.v.) ---------- */

// function setCropRatio(el, w, h) {
//   const guide = document.getElementById("cropGuide");

//   if (currentCropButton === el) {
//     el.classList.remove("rs_active_crop");
//     currentCropButton = null;
//     cropEnabled = false;
//     cropRatio = null;
//     guide.style.display = "none";
//     return;
//   }

//   document.querySelectorAll(".rs-ratio-pill").forEach((x) => {
//     x.classList.remove("rs_active_crop");
//   });

//   el.classList.add("rs_active_crop");
//   currentCropButton = el;
//   cropEnabled = true;
//   guide.style.display = "block";

//   cropRatio = w === 0 && h === 0 ? null : w / h;
// }

// /* ---------- KHUNG HIỂN THỊ VIDEO THEO TỶ LỆ THẬT (letterbox) ---------- */

// previewVideo.addEventListener("loadedmetadata", updateVideoContainer);
// window.addEventListener("resize", updateVideoContainer);

// function updateVideoContainer() {
//   const frameW = previewFrame.clientWidth;
//   const frameH = previewFrame.clientHeight;

//   const videoRatio = previewVideo.videoWidth / previewVideo.videoHeight;
//   const frameRatio = frameW / frameH;

//   let displayW, displayH;

//   if (videoRatio > frameRatio) {
//     displayW = frameW;
//     displayH = frameW / videoRatio;
//   } else {
//     displayH = frameH;
//     displayW = frameH * videoRatio;
//   }

//   videoContainer.style.width = displayW + "px";
//   videoContainer.style.height = displayH + "px";
// }

// /* ---------- THỰC HIỆN CROP BATCH ---------- */

// async function cropVideos() {
//   const selected = getSelectedMedia();

//   if (!cropEnabled) {
//     selected.forEach((item) => {
//       updateMediaStatus(item.path, "Chưa thiết lập vùng chọn", "error");
//     });
//     return false;
//   }

//   if (selected.length === 0) {
//     alert("Vui lòng chọn ít nhất một video.");
//     return false;
//   }

//   const input = document.getElementById("threadVal").value;
//   const mode = document.getElementById("renderMode").value;

//   const config = {
//     files: selected.map((item) => ({
//       path: item.path,
//       name: item.name,
//       width: item.width,
//       height: item.height,
//       duration: item.duration,
//     })),
//     threads: parseInt(input) || 4,
//     render_option: mode,
//     crop: {
//       enabled: cropEnabled,
//       x: cropGuide.offsetLeft / videoContainer.clientWidth,
//       y: cropGuide.offsetTop / videoContainer.clientHeight,
//       width: cropGuide.offsetWidth / videoContainer.clientWidth,
//       height: cropGuide.offsetHeight / videoContainer.clientHeight,
//     },
//   };

//   selected.forEach((item) => {
//     updateMediaStatus(item.path, "Đang xử lý...", "processing");
//   });

//   try {
//     await window.pywebview.api.generate_crop_batch(config);
//     return true;
//   } catch (e) {
//     console.error(e);
//     selected.forEach((item) => {
//       updateMediaStatus(item.path, "Lỗi xử lý", "error");
//     });
//     return false;
//   }
// }
/* =========================================================
 * CROP
 * Kéo/resize khung crop trên preview video
 * Cần: 01-state.js đã load trước (dùng biến previewVideo)
 * ========================================================= */

const cropGuide = document.querySelector(".rs-crop-guide");
const previewFrame = document.querySelector("#previewFrame");
const videoContainer = document.getElementById("videoContainer");

let isDraggingCrop = false;
let offsetX = 0;
let offsetY = 0;

let currentCropButton = null;
let cropEnabled = false;
let cropRatio = null;

let resizing = false;
let startX, startY;
let startWidth, startHeight;

/* ---------- KÉO DI CHUYỂN KHUNG CROP ----------
 * Dùng videoContainer (vùng hiển thị THẬT của video sau letterbox) làm mốc,
 * không dùng previewFrame (có thể to hơn do có viền đen 2 bên/trên dưới).
 */

cropGuide.addEventListener("mousedown", (e) => {
  e.preventDefault();

  isDraggingCrop = true;
  cropGuide.classList.add("dragging");

  const rect = cropGuide.getBoundingClientRect();
  const container = videoContainer.getBoundingClientRect();

  cropGuide.style.inset = "auto";
  cropGuide.style.left = rect.left - container.left + "px";
  cropGuide.style.top = rect.top - container.top + "px";

  offsetX = e.clientX - rect.left;
  offsetY = e.clientY - rect.top;
});

document.addEventListener("mousemove", (e) => {
  if (resizing) {
    // Kích thước thật sự được xử lý ở khối resizeHandle mousemove bên dưới;
    // nhánh này chỉ giữ nguyên kích thước hiện có khi đang trong thao tác resize.
    let width = Math.max(50, startWidth);
    let height = Math.max(50, startHeight);

    cropGuide.style.width = width + "px";
    cropGuide.style.height = height + "px";
    return;
  }

  if (!isDraggingCrop) return;

  const container = videoContainer.getBoundingClientRect();

  let x = e.clientX - container.left - offsetX;
  let y = e.clientY - container.top - offsetY;

  x = Math.max(0, Math.min(x, container.width - cropGuide.offsetWidth));
  y = Math.max(0, Math.min(y, container.height - cropGuide.offsetHeight));

  cropGuide.style.left = x + "px";
  cropGuide.style.top = y + "px";
  cropGuide.style.right = "auto";
  cropGuide.style.bottom = "auto";
});

document.addEventListener("mouseup", () => {
  isDraggingCrop = false;
  resizing = false;
  cropGuide.classList.remove("dragging");
});

/* ---------- RESIZE KHUNG CROP (góc dưới-phải) ---------- */

const resizeHandle = document.querySelector(".crop-handle.br");

resizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();

  resizing = true;
  startX = e.clientX;
  startY = e.clientY;
  startWidth = cropGuide.offsetWidth;
  startHeight = cropGuide.offsetHeight;
});

document.addEventListener("mousemove", (e) => {
  if (!resizing) return;

  let newHeight = 0;
  let newWidth = startWidth + (e.clientX - startX);

  if (cropRatio > 0) {
    newHeight = newWidth / cropRatio;
  } else {
    newHeight = startHeight + (e.clientY - startY);
  }

  newWidth = Math.max(80, newWidth);
  newHeight = Math.max(80, newHeight);

  // Giới hạn theo videoContainer (vùng video thật), không phải previewFrame
  const maxWidth = videoContainer.clientWidth - cropGuide.offsetLeft;
  const maxHeight = videoContainer.clientHeight - cropGuide.offsetTop;

  newWidth = Math.min(newWidth, maxWidth);
  newHeight = Math.min(newHeight, maxHeight);

  cropGuide.style.width = newWidth + "px";
  cropGuide.style.height = newHeight + "px";
});

document.addEventListener("mouseup", () => {
  resizing = false;
});

/* ---------- CHỌN TỶ LỆ CROP (nút bấm 9:16, 1:1, v.v.) ----------
 * Mỗi lần bật crop (chọn tỉ lệ), tự đặt khung crop CANH GIỮA videoContainer
 * với kích thước hợp lý — không để lại vị trí/khung cũ từ video trước đó
 * (vốn có thể đã lệch nếu video mới có tỉ lệ khung hình khác).
 */

function setCropRatio(el, w, h) {
  const guide = document.getElementById("cropGuide");
  if (guide) guide.style.display = "none";

  if (currentCropButton === el) {
    el.classList.remove("rs_active_crop");
    currentCropButton = null;
    cropEnabled = false;
    cropRatio = null;
    return;
  }

  document.querySelectorAll(".rs-ratio-pill").forEach((x) => {
    x.classList.remove("rs_active_crop");
  });

  el.classList.add("rs_active_crop");
  currentCropButton = el;
  cropEnabled = true;
  cropRatio = w === 0 && h === 0 ? null : w / h;
}

/* Đặt khung crop vào giữa videoContainer, kích thước ~80% chiều nhỏ hơn,
   theo đúng cropRatio nếu có, hoặc hình vuông mặc định nếu tự do (cropRatio = null). */
function resetCropGuideToCenter() {
  const containerW = videoContainer.clientWidth;
  const containerH = videoContainer.clientHeight;

  if (containerW === 0 || containerH === 0) return; // video chưa load xong, bỏ qua

  let w, h;

  if (cropRatio) {
    // Vừa khít theo chiều nhỏ hơn, giữ đúng tỉ lệ
    if (containerW / containerH > cropRatio) {
      h = containerH * 0.8;
      w = h * cropRatio;
    } else {
      w = containerW * 0.8;
      h = w / cropRatio;
    }
  } else {
    w = containerW * 0.8;
    h = containerH * 0.8;
  }

  cropGuide.style.width = w + "px";
  cropGuide.style.height = h + "px";
  cropGuide.style.left = (containerW - w) / 2 + "px";
  cropGuide.style.top = (containerH - h) / 2 + "px";
  cropGuide.style.right = "auto";
  cropGuide.style.bottom = "auto";
}

/* ---------- KHUNG HIỂN THỊ VIDEO THEO TỶ LỆ THẬT (letterbox) ---------- */

previewVideo.addEventListener("loadedmetadata", () => {
  updateVideoContainer();
  // Video mới có thể có tỉ lệ khung hình khác -> canh lại khung crop cho đúng
  if (cropEnabled) resetCropGuideToCenter();
});

window.addEventListener("resize", () => {
  updateVideoContainer();
  if (cropEnabled) resetCropGuideToCenter();
});

function updateVideoContainer() {
  if (!previewFrame || !videoContainer) return;

  const frameW = previewFrame.clientWidth;
  const frameH = previewFrame.clientHeight;
  if (!frameW || !frameH) return;

  const vw = previewVideo && previewVideo.videoWidth;
  const vh = previewVideo && previewVideo.videoHeight;
  if (!vw || !vh) {
    videoContainer.style.width = "100%";
    videoContainer.style.height = "100%";
    return;
  }

  const videoRatio = vw / vh;
  const frameRatio = frameW / frameH;

  let displayW, displayH;

  if (videoRatio > frameRatio) {
    displayW = frameW;
    displayH = frameW / videoRatio;
  } else {
    displayH = frameH;
    displayW = frameH * videoRatio;
  }

  videoContainer.style.width = displayW + "px";
  videoContainer.style.height = displayH + "px";
}

function cropLayerToVideoNorm(data) {
  const frame = document.getElementById("previewFrame");
  const vid = document.getElementById("videoContainer");
  const frameW = frame && frame.clientWidth ? frame.clientWidth : 1;
  const frameH = frame && frame.clientHeight ? frame.clientHeight : 1;
  const vidW = vid && vid.clientWidth ? vid.clientWidth : frameW;
  const vidH = vid && vid.clientHeight ? vid.clientHeight : frameH;
  const offX = vid ? vid.offsetLeft : 0;
  const offY = vid ? vid.offsetTop : 0;

  let x = (data.x * frameW - offX) / vidW;
  let y = (data.y * frameH - offY) / vidH;
  let w = (data.width * frameW) / vidW;
  let h = (data.height * frameH) / vidH;

  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  w = Math.max(0.01, Math.min(1 - x, w));
  h = Math.max(0.01, Math.min(1 - y, h));
  return { x, y, width: w, height: h };
}

/* ---------- THỰC HIỆN CROP BATCH (theo layer trên track Crop, rồi nối 1 video) ---------- */

async function cropVideos() {
  const selected = getSelectedMedia();
  if (selected.length === 0) {
    showCheck("Vui lòng chọn ít nhất một video.", () => {
    });
    return false;
  }

  if (typeof flushCurrentTracks === "function") flushCurrentTracks();
  const cropFromLayers = (layers) => {
    const cropLayers = getAllTimelineLayersData(layers).crop || [];
    return cropLayers.map((l) => {
      const box = cropLayerToVideoNorm(l.data || {});
      return {
        start: l.start,
        end: l.end,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        timelineIsVideo: !!(l.data && l.data.timelineIsVideo),
        data: { timelineIsVideo: !!(l.data && l.data.timelineIsVideo) },
      };
    });
  };
  const cropLayers = cropFromLayers(
    typeof getWorkingLayersForMedia === "function" ? getWorkingLayersForMedia(null) : null
  );
  const files = selected.map((item) => ({
    path: item.path,
    name: item.name,
    width: item.width,
    height: item.height,
    duration: item.duration,
    crops: cropFromLayers(
      typeof getWorkingLayersForMedia === "function" ? getWorkingLayersForMedia(item) : null
    ),
  }));
  if (!files.some((f) => (f.crops || []).length) && cropLayers.length === 0) {
    showCheck("Bạn chưa thêm layer Crop trên timeline. Vui lòng thiết lập.", () => {});
    return false;
  }

  const input = document.getElementById("threadVal").value;
  const mode = document.getElementById("renderMode").value;
  const useSource = typeof outputUsesSourceSize === "function" && outputUsesSourceSize();
  const renderSize = useSource
    ? { width: 0, height: 0 }
    : ((typeof currentOutputSize === "function" ? currentOutputSize() : null) || { width: 1080, height: 1920 });

  const config = {
    files,
    threads: typeof getThreadCount === "function" ? getThreadCount() : (parseInt(input, 10) || 1),
    render_option: mode,
    width: renderSize.width,
    height: renderSize.height,
    use_source_size: useSource,
    crops: cropLayers,
  };

  selected.forEach((item) => {
    updateMediaStatus(item.path, "Đang xử lý crop...", "processing");
  });

  try {
    await window.pywebview.api.generate_crop_batch(config);
    return true;
  } catch (e) {
    console.error(e);
    selected.forEach((item) => {
      updateMediaStatus(item.path, "Lỗi xử lý", "error");
    });
    return false;
  }
}

function formatCropSegTime(t) {
  const n = Math.round(t * 1000) / 1000;
  return Number.isInteger(n) ? String(n) : String(n);
}

function stepCropSeg(id, delta) {
  const el = document.getElementById(id);
  if (!el) return;
  const mins = { cropSegDuration: 0.1, cropSegCount: 1, cropSegGap: 0, cropSegOrigin: 0 };
  const maxs = { cropSegCount: 200 };
  let v = parseFloat(el.value);
  if (isNaN(v)) v = mins[id] || 0;
  v = Math.round((v + delta) * 1000) / 1000;
  const min = mins[id] != null ? mins[id] : 0;
  if (v < min) v = min;
  if (maxs[id] != null && v > maxs[id]) v = maxs[id];
  el.value = formatCropSegTime(v);
  updateCropSegmentsPreview();
}

function getCropSegmentRanges() {
  const duration = Math.max(0.1, parseFloat(document.getElementById("cropSegDuration").value) || 0);
  const count = Math.max(1, Math.min(200, parseInt(document.getElementById("cropSegCount").value, 10) || 1));
  const gap = Math.max(0, parseFloat(document.getElementById("cropSegGap").value) || 0);
  const origin = Math.max(0, parseFloat(document.getElementById("cropSegOrigin").value) || 0);
  const videoDur = (typeof videoState !== "undefined" && videoState && videoState.duration > 0)
    ? videoState.duration
    : Infinity;
  const ranges = [];
  for (let i = 0; i < count; i++) {
    const start = origin + i * (duration + gap);
    if (start >= videoDur) break;
    const end = Math.min(start + duration, videoDur);
    if (end <= start) break;
    ranges.push({ start, end, index: i + 1 });
  }
  return { duration, count, gap, origin, ranges };
}

function updateCropSegmentsPreview() {
  const el = document.getElementById("cropSegPreview");
  if (!el) return;
  const { ranges } = getCropSegmentRanges();
  if (!ranges.length) {
    el.className = "rs-crop-seg-preview is-empty";
    el.textContent = "Không tạo được đoạn (kiểm tra thời lượng video).";
    return;
  }
  el.className = "rs-crop-seg-preview";
  el.innerHTML = ranges.map((r) =>
    '<span class="rs-crop-chip"><b>' + r.index + '</b>' +
    formatCropSegTime(r.start) + " – " + formatCropSegTime(r.end) + "</span>"
  ).join("");
}

function openCropSegmentsDialog() {
  const dlg = document.getElementById("cropSegmentsDialog");
  if (!dlg) return;
  const originInp = document.getElementById("cropSegOrigin");
  if (originInp && typeof videoState !== "undefined" && videoState) {
    originInp.value = formatCropSegTime(Math.max(0, videoState.currentTime || 0));
  }
  updateCropSegmentsPreview();
  dlg.classList.add("show");
}

function closeCropSegmentsDialog() {
  const dlg = document.getElementById("cropSegmentsDialog");
  if (dlg) dlg.classList.remove("show");
}

function addQuickCropLayer() {
  closeCropSegmentsDialog();
  if (typeof addLayer === "function") addLayer("crop");
}

async function confirmCropSegments() {
  const { ranges } = getCropSegmentRanges();
  if (!ranges.length) {
    if (typeof showCheck === "function") showCheck("Không tạo được đoạn crop.", () => {});
    return;
  }
  closeCropSegmentsDialog();
  for (const r of ranges) {
    const layer = await createLayer("crop", r.start, r.end);
    if (typeof inheritSharedOverlayStyle === "function") inheritSharedOverlayStyle(layer);
    timelineLayers.push(layer);
    if (typeof publishNewLayerToSharedTracks === "function") publishNewLayerToSharedTracks(layer);
  }
  renderTimeline();
}