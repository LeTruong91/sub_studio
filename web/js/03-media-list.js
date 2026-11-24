/* =========================================================
 * MEDIA LIST
 * Chọn file, hiển thị bảng media, thumbnail, context menu, preview video
 * Cần: 01-state.js đã load trước
 * ========================================================= */

async function pickFileMedia() {
  if (!window.pywebview) return;
  try {
    const files = await window.pywebview.api.pick_media();
    if (!files) return;
    files.forEach((info) => {
      mediaList.push(info);
      addMediaRow(info);
    });

    updateMediaCount();
    generateThumbnailsForPaths(files.map((f) => f.path));
  } catch (e) {
    console.error("Error occurred while picking media files:", e);
  }
}
async function pickFileForListMedia(type) {
   if (!window.pywebview) return;

    const files = await window.pywebview.api.pick_files_by_type(type);

    if (!files || files.length === 0) return;

    const selected = getSelectedMedia();

    const medias = selected.length > 0
        ? selected
        : mediaList.filter(x => x.path === pathMedia);

    if (medias.length === 0) return;

    // Mỗi file sẽ tương ứng với 1 Media
    files.forEach((info, index) => {
        // Nếu hết Media thì dừng
        if (index >= medias.length) return;

        const media = medias[index];

        if (!Array.isArray(media.files)) {
            media.files = [];
        }

        media.files.push(info.path);

        updateMediaFilesList(media.path);
    });
}
function showMediaTableLoading(show) {
  const el = document.getElementById("mediaTableLoading");
  if (!el) return;
  el.classList.toggle("show", show);
}

async function pickFileAudios() {
  if (!window.pywebview) return;

  const files = await window.pywebview.api.pick_audios();
  if (!files) return;

  files.forEach((info) => {
    audioList.push(info);
    // addMediaRow(info);
  });
  const listAudioID = document.getElementById("countListbgAuido");
  const deleteAudioBG = document.getElementById("deleteAudioBG");
  if(audioList.length>0){
    listAudioID.innerText=`Đã chọn ${audioList.length} audio `;
    deleteAudioBG.style.display="block";
  }
  

  // updateMediaCount();
}
async function pickFile(pathMedia) {
  if (!window.pywebview) return;

  const files = await window.pywebview.api.pick_files();
  if (!files) return;

  const media = mediaList.find((x) => x.path === pathMedia);
  if (!media) return;

  if (!Array.isArray(media.files)) {
    media.files = [];
  }

  files.forEach((info) => {
    media.files.push(info.path);
  });

  updateMediaFilesList(pathMedia); // <-- vẽ lại cột Files cho dòng tương ứng
}
function updateMediaFilesList(pathMedia) {
    const tbody = document.getElementById("mediaTableBody");
    const tr = tbody?.querySelector(`tr[data-path="${CSS.escape(pathMedia)}"]`);
    if (!tr) return;

    const listEl = tr.querySelector(".rs-files-list");
    const clearBtn = tr.querySelector(".clear");
    const head = tr.querySelector(".rs-attach-head");
    const wrap = tr.querySelector(".rs-attach");
    const countEl = tr.querySelector(".rs-attach-count");

    if (!listEl) return;

    const media = mediaList.find((x) => x.path === pathMedia);
    if (!media) return;

    const n = media.files?.length ?? 0;
    if (wrap) wrap.classList.toggle("is-empty", n === 0);
    if (head) {
      head.hidden = n === 0;
      head.style.display = n === 0 ? "none" : "flex";
    }
    if (countEl) countEl.textContent = n === 0 ? "" : n === 1 ? "1 file đính kèm" : n + " file đính kèm";
    if (clearBtn) {
      clearBtn.hidden = n === 0;
      clearBtn.style.display = n > 0 ? "" : "none";
    }
    listEl.hidden = n === 0;
    listEl.style.display = n > 0 ? "flex" : "none";

    listEl.innerHTML = (media.files || [])
        .map((file, idx) => {
            const name = String(file).replace(/\\/g, "/").split("/").pop() || file;
            return `
            <div class="rs-fname-row">
                <div class="rs-fname" title="${String(file).replace(/"/g, "&quot;")}">${name}</div>
                <div class="rs-fname-remove" data-idx="${idx}" title="Bỏ file này">&times;</div>
            </div>`;
        })
        .join("");

    listEl.querySelectorAll(".rs-fname-remove").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            removeMediaFile(pathMedia, parseInt(btn.dataset.idx, 10));
        });
    });
}
function removeMediaFile(pathMedia, idx) {
  const media = mediaList.find((x) => x.path === pathMedia);
  if (!media || !Array.isArray(media.files)) return;

  media.files.splice(idx, 1);
  updateMediaFilesList(pathMedia);
}
//
function formatFileSize(sizeKb) {
  if (!sizeKb) return "";
 
  if (sizeKb >= 1024) {
    return (sizeKb / 1024).toFixed(1) + " MB";
  }
 
  return sizeKb + " KB";
}
function addMediaRow(info) {
  try {
    const tbody = document.getElementById("mediaTableBody");

    const tr = document.createElement("tr");

    const duration = info.duration || "--:--:--";
    const size = formatFileSize(info.size_kb);

    tr.innerHTML = `
        <td>

        </td>

        <td class="rs-time-cell" style="width: 30px;">
            ${String(mediaIndex).padStart(2, "0")}
        </td>

        <td style="width: 50px;">
            <div class="rs-thumb">
                <svg class="thumb-placeholder"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6">
                    <path d="M8 5v14l11-7z"/>
                </svg>
            </div>
        </td>

        <td>
            <div class="rs-fname">${info.name}${info.tracksSaved ? '<span class="rs-track-saved-tag">Track riêng</span>' : ""}</div>
            <div class="rs-fsub">${size}</div>
        </td>
        <td style="width: 300px; position: relative;">
          <div class="rs-attach${(info.files?.length ?? 0) ? "" : " is-empty"}">
            <div class="rs-attach-head" style="${(info.files?.length ?? 0) ? "" : "display:none"}">
              <span class="rs-attach-meta">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"></path>
                </svg>
                <span class="rs-attach-count">${(info.files?.length ?? 0) ? ((info.files.length === 1) ? "1 file đính kèm" : info.files.length + " file đính kèm") : ""}</span>
              </span>
              <button type="button" class="clear rs-attach-clear" title="Xóa tất cả file">Xóa hết</button>
            </div>
            <div class="rs-files-list" style="${(info.files?.length ?? 0) ? "" : "display:none"}"></div>
          </div>
        </td>
        <td class="rs-time-cell" style="width: 120px;">
            ${duration}
        </td>

        <td style="width: 250px;">
            <span class="rs-badge rs-wait">
                <span class="rs-d"></span>
                Đang chờ xử lý
            </span>
            <div class="render-progress" style="display:none;">
                <div class="render-progress-top">
                    <span class="renderCount"></span>
                    <span class="renderPercent">0%</span>
                </div>
                <div class="render-progress-bar">
                    <div class="render-progress-fill"></div>
                </div>
            </div>
        </td>
        <td style="width: 120px;">
        <div style="display: flex; gap: 10px; justify-content: center;">
          <div class="rs-checkbox" style="margin-top: 1px;">
                <input type="checkbox" class="rs-row-check">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <path d="M5 13l4 4L19 7"></path>
                </svg>
            </div>
           <button class="btn_rs_view rs-tooltip"  data-tooltip="Xem video"
            onmouseenter="this.style.transform='translateY(-1px) scale(1.06)'; this.style.boxShadow='0 4px 10px rgba(0,0,0,0.3)';"
            onmouseleave="this.style.transform='translateY(0) scale(1)'; this.style.boxShadow='0 2px 5px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.3)';"
            onmousedown="this.style.transform='scale(0.92)';"
            onmouseup="this.style.transform='translateY(-1px) scale(1.06)';"
            onclick='event.stopPropagation();OpenViewVideo(${JSON.stringify(info.url)})'>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
        </button>
         <button class="btn_rs_upload rs-tooltip"  data-tooltip="Tải file lên"
            onmouseenter="this.style.transform='translateY(-1px) scale(1.06)'; this.style.boxShadow='0 4px 10px rgba(0,0,0,0.3)';"
            onmouseleave="this.style.transform='translateY(0) scale(1)'; this.style.boxShadow='0 2px 5px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.3)';"
            onmousedown="this.style.transform='scale(0.92)';"
            onmouseup="this.style.transform='translateY(-1px) scale(1.06)';"
            onclick='event.stopPropagation();pickFile(${JSON.stringify(info.path)})'>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 16V4"></path>
          <path d="M6 10l6-6 6 6"></path>
          <path d="M4 20h16"></path>
        </svg>
        </button>
         <button class="btn_rs_delete rs-tooltip"  data-tooltip="Xóa"
            onmouseenter="this.style.transform='translateY(-1px) scale(1.06)'; this.style.boxShadow='0 4px 10px rgba(0,0,0,0.3)';"
            onmouseleave="this.style.transform='translateY(0) scale(1)'; this.style.boxShadow='0 2px 5px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.3)';"
            onmousedown="this.style.transform='scale(0.92)';"
            onmouseup="this.style.transform='translateY(-1px) scale(1.06)';"
            onclick='event.stopPropagation();removeMediaRow(${JSON.stringify(info.path)})'>
                 <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18"/>
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                <path d="M10 11v6"/>
                <path d="M14 11v6"/>
              </svg>
        </button>
        </div>
        </td>
    `;

    tr.dataset.path = info.path;
    tr.dataset.name = info.name;
    tr.dataset.index = mediaIndex;

    
    tr.addEventListener("click", async (e) => {
      if (e.target.closest(".rs-attach-clear, .clear, .rs-fname-remove, .rs-fname-row, .btn_rs_view, .btn_rs_upload, .btn_rs_delete")) {
        return;
      }
      let index = Number(tr.dataset.index);
      let rows = Array.from(tbody.querySelectorAll("tr"));

      // SHIFT: chọn theo khoảng
      if (e.shiftKey && lastSelectedIndex !== -1) {
        let start = Math.min(lastSelectedIndex, index);
        let end = Math.max(lastSelectedIndex, index);

        rows.forEach((r) => {
          let i = Number(r.dataset.index);
          if (i >= start && i <= end) {
            r.classList.add("rs-selected");
            const rc = r.querySelector(".rs-row-check");
            if (rc) setCheckbox(rc, true);
          }
        });
      }
      // CTRL: toggle từng dòng
      else if (e.ctrlKey) {
        const selected = tr.classList.toggle("rs-selected");
        const rc = tr.querySelector(".rs-row-check");
        if (rc) setCheckbox(rc, selected);
      }
      // CLICK thường: chỉ chọn 1 dòng
      else {
        rows.forEach((r) => {
          r.classList.remove("rs-selected");
          const rc = r.querySelector(".rs-row-check");
          if (rc) setCheckbox(rc, false);
        });
        tr.classList.add("rs-selected");
        const rc = tr.querySelector(".rs-row-check");
        if (rc) setCheckbox(rc, true);
      }

      lastSelectedIndex = index;
      updateSelectAllState();

      if (!e.ctrlKey && !e.shiftKey) {
        if (typeof switchMediaTrackContext === "function") await switchMediaTrackContext(info);
        else currentMedia = info;
        await showPreview(info);
      }
    });
    tr.addEventListener("contextmenu", (e) => {
      e.preventDefault();

      currentContextRow = tr;
      currentContextInfo = info;

      if (!tr.classList.contains("rs-selected")) {
        tbody.querySelectorAll("tr").forEach((r) => r.classList.remove("rs-selected"));
        tr.classList.add("rs-selected");
      }

      const menu = document.getElementById("mediaContextMenu");
      menu.style.display = "block";
      menu.style.left = e.clientX + "px";
      menu.style.top = e.clientY + "px";
    });

    const rowCheck = tr.querySelector(".rs-row-check");
    rowCheck.addEventListener("change", () => {
      tr.classList.toggle("rs-selected", rowCheck.checked);
      lastSelectedIndex = Number(tr.dataset.index);
      updateSelectAllState();
    });

    tbody.appendChild(tr);
    refreshMediaNumber();
    const clearAllBtn = tr.querySelector(".rs-attach-clear");
    if (clearAllBtn) {
      clearAllBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearFiles(info.path);
      });
    }
    if (info.files?.length) updateMediaFilesList(info.path);

    if (isImageMedia(info)) {
      setMediaRowImageThumb(tr, info);
    }

    mediaIndex++;
  } catch (error) {
    console.error("addMediaRow error:", error);
  }
}

/* ---------- PREVIEW ---------- */
async function togglePiP() {
  try {
    if (!window.pywebview || !window.pywebview.api) {
      alert("Không tìm thấy pywebview API.");
      return;
    }
 
    if (!previewVideo.src) {
      alert("Chưa có video nào đang xem để mở mini preview.");
      return;
    }
 
    await window.pywebview.api.open_pip_window(previewVideo.src);
  } catch (e) {
    console.error("Không mở được cửa sổ mini preview:", e);
  }
}
async function OpenViewVideo(url) {
  try {
    console.log("OpenViewVideo", url);

    if (!url) {
      alert("Chưa có media nào đang xem để mở preview.");
      return;
    }

    // Nếu là ảnh -> hiện popup xem ảnh, không mở pip video
    if (isImageUrl(url)) {
      showImagePreview(url);
      return;
    }

    if (!window.pywebview || !window.pywebview.api) {
      alert("Không tìm thấy pywebview API.");
      return;
    }

    await window.pywebview.api.open_pip_window(url);
  } catch (e) {
    console.error("Không mở được cửa sổ mini preview:", e);
  }
}
function isImageUrl(url) {
  return /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(String(url || ""));
}
function isImageMedia(info) {
  return isImageUrl((info && (info.path || info.name || info.url)) || "");
}
function mediaFileUrl(info) {
  if (info && info.url) return info.url;
  if (info && info.path) {
    return "http://127.0.0.1:9876/file?path=" + encodeURIComponent(info.path);
  }
  return "";
}
function setMediaRowImageThumb(tr, info) {
  const container = tr.querySelector(".rs-thumb");
  if (!container) return;
  const url = mediaFileUrl(info);
  if (!url) return;
  const img = document.createElement("img");
  img.src = url;
  img.className = "rs-thumb-img";
  img.alt = (info && info.name) || "";
  container.innerHTML = "";
  container.appendChild(img);
}
function showImagePreview(url) {
  let overlay = document.getElementById("rsImagePreviewOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "rsImagePreviewOverlay";
    overlay.innerHTML = `
      <div class="rs-img-preview-backdrop"></div>
      <div class="rs-img-preview-box">
        <button class="rs-img-preview-close" title="Đóng">&times;</button>
        <img class="rs-img-preview-img" src="" alt="preview">
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector(".rs-img-preview-backdrop").onclick = closeImagePreview;
    overlay.querySelector(".rs-img-preview-close").onclick = closeImagePreview;
  }
  overlay.querySelector(".rs-img-preview-img").src = url;
  overlay.style.display = "flex";
}

function closeImagePreview() {
  const overlay = document.getElementById("rsImagePreviewOverlay");
  if (overlay) overlay.style.display = "none";
}

// Đóng bằng phím Esc
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeImagePreview();
});
async function showPreview(info) {
  try {
    const r = await window.pywebview.api.serve_media(info.path);
    const still = getPreviewStill();
    const bar = document.getElementById("previewPlayerBar");
    if (isImageMedia(info) || isImageUrl(r && r.url)) {
      if (previewVideo) {
        previewVideo.pause();
        previewVideo.removeAttribute("src");
        previewVideo.style.display = "none";
      }
      if (still) {
        still.src = r.url;
        still.style.display = "block";
      }
      if (bar) bar.style.visibility = "hidden";
      return;
    }
    if (still) {
      still.removeAttribute("src");
      still.style.display = "none";
    }
    if (bar) bar.style.visibility = "";
    previewVideo.src = r.url;
    previewVideo.style.display = "block";
    previewVideo.load();
  } catch (e) {
    console.error("Failed to load media:", e);
    alert("Không tải được media.");
  }
}

function getPreviewStill() {
  let still = document.getElementById("previewStill");
  if (still) return still;
  const host = document.getElementById("videoContainer");
  if (!host) return null;
  still = document.createElement("img");
  still.id = "previewStill";
  still.alt = "";
  still.style.display = "none";
  const video = document.getElementById("previewVideo");
  if (video && video.parentNode === host) host.insertBefore(still, video);
  else host.appendChild(still);
  return still;
}

/* ---------- THUMBNAIL QUEUE ---------- */

// function queueThumbnail(container, info) {
//   thumbnailQueue.push({ container, info });
//   processThumbnailQueue();
// }

// async function processThumbnailQueue() {
//   while (thumbnailRunning < MAX_THUMBNAIL_WORKERS && thumbnailQueue.length > 0) {
//     const task = thumbnailQueue.shift();
//     thumbnailRunning++;

//     loadVideoThumbnail(task.container, task.info).finally(() => {
//       thumbnailRunning--;
//       processThumbnailQueue();
//     });
//   }
// }

// async function loadVideoThumbnail(container, info) {
//   try {
//     const result = await window.pywebview.api.serve_media(info.path);
//     if (!result || !result.url) return;

//     const ext = info.name.split(".").pop().toLowerCase();

//     // FILE ẢNH
//     if (["jpg", "jpeg", "png", "bmp", "webp", "gif"].includes(ext)) {
//       const img = document.createElement("img");
//       img.src = result.url;
//       img.className = "rs-thumb-img";

//       container.innerHTML = "";
//       container.appendChild(img);
//       return;
//     }

//     // FILE VIDEO
//     const video = document.createElement("video");
//     video.src = result.url;
//     video.muted = true;
//     video.playsInline = true;
//     video.preload = "metadata";
//     video.className = "rs-thumb-video";

//     video.style.visibility = "hidden";
//     container.innerHTML = "";
//     container.appendChild(video);

//     await new Promise((resolve, reject) => {
//       let settled = false;

//       const cleanup = () => {
//         clearTimeout(timeoutId);
//         video.onloadedmetadata = null;
//         video.onseeked = null;
//         video.onerror = null;
//       };

//       const finish = (fn, arg) => {
//         if (settled) return;
//         settled = true;
//         cleanup();
//         fn(arg);
//       };

//       const timeoutId = setTimeout(() => {
//         finish(resolve); // resolve để vẫn hiện video dù không seek được frame preview
//       }, 8000);

//       video.onloadedmetadata = () => {
//         const dur = video.duration;

//         if (!isFinite(dur) || dur <= 0) {
//           finish(resolve);
//           return;
//         }

//         try {
//           video.currentTime = Math.min(1, dur / 2);
//         } catch (e) {
//           finish(resolve);
//         }
//       };

//       video.onseeked = () => finish(resolve);
//       video.onerror = () => finish(reject, new Error("Không load được video"));
//     });

//     video.pause();
//     video.style.visibility = "visible";
//   } catch (e) {
//     console.error("Thumbnail lỗi:", info.name, e);
//   }
// }


async function generateThumbnailsForPaths(paths) {
  if (!window.pywebview || !paths || paths.length === 0) return;
  const videoPaths = paths.filter((p) => !isImageUrl(p));
  if (!videoPaths.length) return;
  const threads = typeof getThreadCount === "function" ? getThreadCount() : 1;
  try {
    await window.pywebview.api.generate_thumbnails_batch(videoPaths, threads);
  } catch (e) {
    console.error("generate_thumbnails_batch lỗi:", e);
  }
}

function applyThumbnailResult(path, result) {
  const tbody = document.getElementById("mediaTableBody");
  const tr = tbody?.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  if (!tr) return;

  const container = tr.querySelector(".rs-thumb");
  if (!container) return;

  if (!result || result.error || !result.url) return;

  const img = document.createElement("img");
  img.src = result.url;
  img.className = "rs-thumb-img";
  container.innerHTML = "";
  container.appendChild(img);
}
/* ---------- SELECTION / STATUS HELPERS ---------- */

function markMediaTracksSaved(path, on) {
  const tr = document.querySelector(`#mediaTableBody tr[data-path="${CSS.escape(path)}"]`);
  if (!tr) return;
  const fname = tr.querySelector(".rs-fname");
  if (!fname) return;
  let tag = fname.querySelector(".rs-track-saved-tag");
  if (on) {
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "rs-track-saved-tag";
      tag.textContent = "Track riêng";
      fname.appendChild(tag);
    }
  } else if (tag) {
    tag.remove();
  }
}

function getSelectedMedia() {
  const list = [];

  document.querySelectorAll("#mediaTableBody tr.rs-selected").forEach((row) => {
    const media = mediaList.find((x) => x.path === row.dataset.path);
    if (media) list.push(media);
  });

  return list;
}

function refreshMediaNumber() {
  document.querySelectorAll("#mediaTableBody tr").forEach((tr, index) => {
    tr.querySelector(".rs-time-cell").innerText = String(index + 1).padStart(2, "0");
  });
}

function updateMediaStatus(path, text, type) {
  const row = document.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  if (!row) return;

  const numeric = parseFloat(String(text).replace("%", ""));
  if (type === "processing" && Number.isFinite(numeric) && String(text).trim() !== "" && /^-?\d+(\.\d+)?%?$/.test(String(text).trim())) {
    updateRenderProgress(path, numeric);
    return;
  }

  const badge = row.querySelector(".rs-badge");
  badge.className = "rs-badge";

  switch (type) {
    case "success":
      badge.classList.add("rs-ok");
      hideRenderProgress(path);
      break;
    case "error":
      badge.classList.add("rs-err");
      hideRenderProgress(path);
      break;
    case "processing":
      badge.classList.add("rs-run");
      break;
    case "wait":
      badge.classList.add("rs-wait");
      hideRenderProgress(path);
      break;  
    default:
      badge.classList.add("rs-wait");
      hideRenderProgress(path);
      break;
  }

  badge.innerHTML = `
        <span class="rs-d"></span>
        ${text}
    `;
}
function updateMediaStatusProcess(path, text, type) {
  const row = document.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  if (!row) return;

  const badge = row.querySelector(".rs-badge");
  badge.className = "rs-badge";

  switch (type) {
    case "success":
      badge.classList.add("rs-ok");
      break;
    case "error":
      badge.classList.add("rs-err");
      break;
    case "processing":
      badge.classList.add("rs-run");
      break;
    default:
      badge.classList.add("rs-wait");
      break;
  }

  badge.innerHTML = `Đang xử lý`;
  const n = parseFloat(String(text).replace("%", ""));
  const label = Number.isFinite(n) ? "Đang render video" : (text || "Đang xử lý");
  updateRenderProgress(path, Number.isFinite(n) ? n : 100, label);
}
function updateMediaStatusRender(path, text, type,outputPath) {
  const row = document.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  if (!row) return;

  const badge = row.querySelector(".rs-badge");
  badge.className = "rs-badge";

  switch (type) {
    case "success":
      badge.classList.add("rs-ok");
      break;
    case "error":
      badge.classList.add("rs-err");
      break;
    case "processing":
      badge.classList.add("rs-run");
      break;
    default:
      badge.classList.add("rs-wait");
      break;
  }

  badge.innerHTML = `
        <span class="rs-d"></span>
        ${text}
    `;
  if (outputPath) {
    hideRenderProgress(path)
    row.dataset.outputPath = outputPath;

    const media = mediaList.find((x) => x.path === path);
    if (media) media.outputPath = outputPath;

    // Thêm nút "Xem kết quả" ngay cạnh badge, chỉ hiện khi render thành công
    const viewResultBtn = document.createElement("button");
    viewResultBtn.className = "rs-view-result-btn rs-tooltip";
    viewResultBtn.dataset.tooltip = "Xem video";
    viewResultBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    `;

    viewResultBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // không để nổi bọt lên click của <tr> (đổi preview video gốc)
      showPreviewByPath(outputPath);
    });

    badge.appendChild(viewResultBtn);
  }
}
function updateMediaStatusMerge(name,text, type,outputPath) {
  const row = document.querySelector(`.plan-row[data-plan-name="${CSS.escape(name)}"]`);
  if (!row) return;

  const badge = row.querySelector(".rs-badge-merge");
  badge.className = "rs-badge-merge";

  switch (type) {
    case "success":
      badge.classList.add("rs-ok");
      break;
    case "error":
      badge.classList.add("rs-err");
      break;
    case "processing":
      badge.classList.add("rs-run");
      break;
    default:
      badge.classList.add("rs-wait");
      break;
  }

  badge.innerHTML = `
        ${text}
    `;
  if (outputPath) {
    // row.dataset.outputPath = outputPath;

    // const media = mediaList.find((x) => x.path === path);
    // if (media) media.outputPath = outputPath;
  const viewVideo = row.querySelector(".plan-output");
    // Thêm nút "Xem kết quả" ngay cạnh badge, chỉ hiện khi render thành công
    const viewResultBtn = document.createElement("button");
    viewResultBtn.innerHTML = `<span>View</span>
    `;
    viewResultBtn.className = "rs_btn_view_video";
    viewResultBtn.addEventListener("click", (e) => {
      e.stopPropagation(); // không để nổi bọt lên click của <tr> (đổi preview video gốc)
      showPreviewByPath(outputPath);
    });
    viewVideo.appendChild(viewResultBtn);
  }
}
async function showPreviewByPath(path) {
  try {
    const r = await window.pywebview.api.serve_media(path);
    OpenViewVideo(r.url);
  } catch (e) {
    console.error("Failed to load rendered video:", e);
    alert("Không tải được video đã render.");
  }
}
function updateMediaStatusExport(path, text, type,outputPath) {
  const row = document.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  if (!row) return;

  const badge = row.querySelector(".rs-badge");
  badge.className = "rs-badge";

  switch (type) {
    case "success":
      badge.classList.add("rs-ok");
      break;
    case "error":
      badge.classList.add("rs-err");
      break;
    case "processing":
      badge.classList.add("rs-run");
      break;
    default:
      badge.classList.add("rs-wait");
      break;
  }

  badge.innerHTML = `
        <span class="rs-d"></span>
        ${text}
    `;
  if (outputPath) {
    // Thêm nút "Xem kết quả" ngay cạnh badge, chỉ hiện khi render thành công
    const viewResultBtn = document.createElement("button");
    viewResultBtn.className = "rs-view-result-btn rs-tooltip";
    viewResultBtn.dataset.tooltip = "Xem thư mục";
    viewResultBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    `;

    viewResultBtn.addEventListener("click", async(e) => {
      e.stopPropagation(); // không để nổi bọt lên click của <tr> (đổi preview video gốc)
      // showPreviewByPath(outputPath);
      await window.pywebview.api.open_folder(outputPath);
    });

    badge.appendChild(viewResultBtn);
  }
}

function updateMediaStatusExportSTT(path, text, type,outputPath) {
  const row = document.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  if (!row) return;
  hideRenderProgress(path);

  const badge = row.querySelector(".rs-badge");
  badge.className = "rs-badge";

  switch (type) {
    case "success":
      badge.classList.add("rs-ok");
      break;
    case "error":
      badge.classList.add("rs-err");
      break;
    case "processing":
      badge.classList.add("rs-run");
      break;
    default:
      badge.classList.add("rs-wait");
      break;
  }

  badge.innerHTML = `
        <span class="rs-d"></span>
        ${text}
    `;
  if (outputPath) {
    // Thêm nút "Xem kết quả" ngay cạnh badge, chỉ hiện khi render thành công
    const viewResultBtn = document.createElement("button");
    viewResultBtn.className = "rs-view-result-btn rs-tooltip";
    viewResultBtn.dataset.tooltip = "Xem file phụ đề";
    viewResultBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    `;

    viewResultBtn.addEventListener("click", async(e) => {
      e.stopPropagation(); // không để nổi bọt lên click của <tr> (đổi preview video gốc)
      // showPreviewByPath(outputPath);
      await window.pywebview.api.open_folder(outputPath);
    });

    badge.appendChild(viewResultBtn);
  }
}

function updateMediaStatusExportAudio(path, text, type,outputPath) {
  const row = document.querySelector(`tr[data-path="${CSS.escape(path)}"]`);
  if (!row) return;

  const badge = row.querySelector(".rs-badge");
  badge.className = "rs-badge";

  switch (type) {
    case "success":
      badge.classList.add("rs-ok");
      break;
    case "error":
      badge.classList.add("rs-err");
      break;
    case "processing":
      badge.classList.add("rs-run");
      break;
    default:
      badge.classList.add("rs-wait");
      break;
  }

  badge.innerHTML = `
        <span class="rs-d"></span>
        ${text}
    `;
  if (outputPath) {
    // Thêm nút "Xem kết quả" ngay cạnh badge, chỉ hiện khi render thành công
    const viewResultBtn = document.createElement("button");
    viewResultBtn.className = "rs-view-result-btn rs-tooltip";
    viewResultBtn.dataset.tooltip = "Xem file âm thanh";
    viewResultBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
    `;

    viewResultBtn.addEventListener("click", async(e) => {
      e.stopPropagation(); // không để nổi bọt lên click của <tr> (đổi preview video gốc)
      // showPreviewByPath(outputPath);
      await window.pywebview.api.open_folder(outputPath);
    });

    badge.appendChild(viewResultBtn);
  }
}
function updateMediaCount() {
  const input = document.getElementById("sourceMediaInput");
  const count = mediaList.length;

  input.value = `Đã chọn ${count} videos`;
  input.placeholder = `Đã chọn ${count} videos`;
  document.getElementById("mediaCount").innerText = `${count} tệp · 0 đã xử lý`;
}

/* ---------- CONTEXT MENU ---------- */

document.addEventListener("click", () => {
  document.getElementById("mediaContextMenu").style.display = "none";
});

document.getElementById("mediaContextMenu").addEventListener("click", async (e) => {
  const item = e.target.closest("[data-action]");
  if (!item) return;

  const action = item.dataset.action;

  switch (action) {
    case "add-scene":
      addSceneFromSelection();
      break;

    case "upfiles-srt":
      await pickFileForListMedia("text")
      break;
    case "translate-attached":
      await translateAttachedFiles();
      break;
    case "translate-srt-web":
      if (typeof openTranslateSrtWebDialog === "function") await openTranslateSrtWebDialog();
      break;
    case "upfiles-audio":
      await pickFileForListMedia("audio");
      break;
    case "delete-upfiles":
        showConfirm("Bạn có chắc muốn xóa file đính kèm?", () => {
            clearSelectedAttachedFiles()
      });
      break;
    case "export-frame":
      await export_frame();
      break;

    case "export-subtitle":
      await export_subtitle();
      break;
    case "export-ocr-subtitle":
      await exportOcrSubtitle();
      break;

    case "export-audio":
      await export_audio();
      break;

    case "remove-list": {
      showConfirm("Bạn có chắc muốn xóa các video đã chọn?", () => {
        const selectedRows = document.querySelectorAll("#mediaTableBody tr.rs-selected");
        if (selectedRows.length === 0) return;

        selectedRows.forEach((row) => {
          const path = row.dataset.path;
          row.remove();
          mediaList = mediaList.filter((x) => x.path !== path);
        });

        refreshMediaNumber();
        updateMediaCount();
        updateSelectAllState();
            if (currentMedia) {
              previewVideo.pause();
              previewVideo.removeAttribute("src");
              previewVideo.style.display = "none";
              currentMedia = null;
            }
      });

      break;
    }

    case "delete-file":
        showConfirm("Bạn có chắc muốn xóa file khỏi máy tính?",async () => {
        const selectedRows = document.querySelectorAll("#mediaTableBody tr.rs-selected");
        if (selectedRows.length === 0) return;

        selectedRows.forEach(async (row) => {
          
          const path = row.dataset.path;
          row.remove();
          mediaList = mediaList.filter((x) => x.path !== path);
          await window.pywebview.api.delete_file(path);
        });

        refreshMediaNumber();
        updateMediaCount();
        updateSelectAllState();
      });
      break;
  }

  document.getElementById("mediaContextMenu").style.display = "none";
});
function clearSelectedAttachedFiles() {
    const selected = getSelectedMedia();

    selected.forEach((media) => {
        media.files = [];
        updateMediaFilesList(media.path);
    });
}
function removeMediaRow(pathMedia) {
    showConfirm("Bạn có chắc muốn xóa video này?", () => {
      const tbody = document.getElementById("mediaTableBody");
      const tr = tbody?.querySelector(`tr[data-path="${CSS.escape(pathMedia)}"]`);

      // Nếu đang xem preview đúng video này thì tắt preview đi cho gọn
      if (currentMedia && currentMedia.path === pathMedia) {
        previewVideo.pause();
        previewVideo.removeAttribute("src");
        previewVideo.style.display = "none";
        currentMedia = null;
      }

      if (tr) tr.remove();

      mediaList = mediaList.filter((x) => x.path !== pathMedia);

      refreshMediaNumber();
      updateMediaCount();
      updateSelectAllState();
  });
 
}
function clearFiles(pathMedia) {
  const media = mediaList.find((x) => x.path === pathMedia);
  console.log("clearFiles", media);
  if (!media) return;

  if (!Array.isArray(media.files) || media.files.length === 0) return;

  showConfirm(`Xóa tất cả ${media.files.length} file đã chọn?`, () => {
    media.files = [];
    updateMediaFilesList(pathMedia);
  });
}
/* ---------- CHỌN TẤT CẢ ---------- */

document.getElementById("selectAllMedia")?.addEventListener("change", (e) => {
  const checked = e.target.checked;
  const tbody = document.getElementById("mediaTableBody");

  tbody.querySelectorAll("tr").forEach((tr) => {
    tr.classList.toggle("rs-selected", checked);

    const rowCheck = tr.querySelector(".rs-row-check");
    if (rowCheck) setCheckbox(rowCheck, checked);;
  });
});
// function updateSelectAllState() {
//   const selectAll = document.getElementById("selectAllMedia");
//   if (!selectAll) return;

//   const checks = document.querySelectorAll("#mediaTableBody .rs-row-check");
//   if (checks.length === 0) {
//     selectAll.checked = false;
//     selectAll.indeterminate = false;
//     return;
//   }

//   const checkedCount = document.querySelectorAll("#mediaTableBody .rs-row-check:checked").length;

//   selectAll.checked = checkedCount === checks.length;
//   selectAll.indeterminate = checkedCount > 0 && checkedCount < checks.length;
// }
function updateSelectAllState() {
  const selectAll = document.getElementById("selectAllMedia");
  if (!selectAll) return;

  const wrapper = selectAll.closest(".rs-checkbox");

  const checks = document.querySelectorAll("#mediaTableBody .rs-row-check");
  if (checks.length === 0) {
    setCheckbox(selectAll, false);
    selectAll.indeterminate = false;
    wrapper?.classList.remove("rs-indeterminate");
    return;
  }
  const checkedCount = document.querySelectorAll("#mediaTableBody .rs-row-check:checked").length;

  setCheckbox(selectAll, checkedCount === checks.length);
  selectAll.indeterminate = checkedCount > 0 && checkedCount < checks.length;
  wrapper?.classList.toggle("rs-indeterminate", selectAll.indeterminate);
}
function clearMediaList() {
  if (mediaList.length ==0)
    return
  showConfirm("Bạn có chắc muốn xóa tất cả video đã chọn?", () => {
  const selectedRows = document.querySelectorAll("#mediaTableBody tr.rs-selected");
        if (selectedRows.length === 0) return;

        selectedRows.forEach(async (row) => {
          
          const path = row.dataset.path;
          row.remove();
          mediaList = mediaList.filter((x) => x.path !== path);
          // await window.pywebview.api.delete_file(path);
        });
        refreshMediaNumber();
        updateMediaCount();
        updateSelectAllState();
    // Nếu đang xem preview thì tắt preview đi cho gọn
    if (currentMedia) {
      previewVideo.pause();
      previewVideo.removeAttribute("src");
      previewVideo.style.display = "none";
      currentMedia = null;
    }
  });
}

/* ---------- PHÂN CẢNH ---------- */

function addSceneFromSelection() {
  const selected = getSelectedMedia();

  if (selected.length === 0) {
    showCheck("Bạn chưa chọn media. Vui lòng chọn để tiếp tục", () => {
  });
    return false;
  }
  document.getElementById("addSceneFromSelection").classList.add("show");
  const defaultName = `Phân cảnh ${sceneIndex}`;
  document.getElementById("NameScene").value =defaultName;
}
function AddSceneDialogName(){
  const selected = getSelectedMedia();

  if (selected.length === 0) {
    showCheck("Bạn chưa chọn media. Vui lòng chọn để tiếp tục", () => {
  });
    return false;
  }
  const name = document.getElementById("NameScene").value;
  const scene = {
    id: crypto.randomUUID ? crypto.randomUUID() : `scene_${Date.now()}`,
    name: name.trim(),
    mediaPaths: selected.map((m) => m.path),
  };

  sceneList.push(scene);
  sceneIndex++;

  renderSceneList();
  document.getElementById("addSceneFromSelection").classList.remove("show");
}
function removeAllScene(){
    showConfirm("Bạn có chắc muốn xoá tất cả phân cảnh?", () => {
      sceneList = [];
      sceneIndex=1;
    renderSceneList();
  });
}
function removeScene(sceneId) {
  showConfirm("Bạn có chắc muốn xoá phân cảnh này?", () => {
    sceneList = sceneList.filter((s) => s.id !== sceneId);
    sceneIndex--;
    renderSceneList();
  });
}

function removeMediaFromScene(sceneId, path) {
  const scene = sceneList.find((s) => s.id === sceneId);
  if (!scene) return;

  scene.mediaPaths = scene.mediaPaths.filter((p) => p !== path);

  // Phân cảnh rỗng thì xoá luôn
  if (scene.mediaPaths.length === 0) {
    sceneList = sceneList.filter((s) => s.id !== sceneId);
  }

  renderSceneList();
}

document.getElementById("sceneListContainer").addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  const sceneId = target.dataset.sceneId;

  if (action === "remove-scene") {
    removeScene(sceneId);
  } else if (action === "remove-media") {
    removeMediaFromScene(sceneId, target.dataset.path);
  }
});

function renderSceneList() {
  const container = document.getElementById("sceneListContainer");
  if (!container) return;

  if (sceneList.length === 0) {
    container.innerHTML = `<div class="rs-scene-empty">Chưa có phân cảnh nào.</div>`;
    return;
  }

  container.innerHTML = sceneList
    .map((scene) => {
      const itemsHtml = scene.mediaPaths
        .map((path) => {
          const media = mediaList.find((m) => m.path === path);
          const name = media ? media.name : path;
          return `
            <div class="rs-scene-item">
              <span class="rs-scene-item-name" title="${escapeHtml(path)}">${escapeHtml(name)}</span>
              <span class="rs-scene-item-remove"
                    data-action="remove-media"
                    data-scene-id="${scene.id}"
                    data-path="${escapeHtml(path)}">&times;</span>
            </div>
          `;
        })
        .join("");

      return `
        <div class="rs-scene-block" data-scene-id="${scene.id}">
          <div class="rs-scene-header">
            <span class="rs-scene-title">${scene.name} (${scene.mediaPaths.length} video)</span>
            <button class="rs-scene-remove-btn" data-action="remove-scene" data-scene-id="${scene.id}">Xoá phân cảnh</button>
          </div>
          <div class="rs-scene-items">
            ${itemsHtml}
          </div>
        </div>
      `;
    })
    .join("");
}

function syncScenesAfterMediaRemoved() {
  const validPaths = new Set(mediaList.map((m) => m.path));

  sceneList.forEach((scene) => {
    scene.mediaPaths = scene.mediaPaths.filter((p) => validPaths.has(p));
  });
  sceneList = sceneList.filter((s) => s.mediaPaths.length > 0);

  renderSceneList();
}

