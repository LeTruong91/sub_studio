/* =========================================================
 * RENDER / EXPORT
 * Nút Bắt đầu xử lý, build config render, các hàm export
 * Cần: 01-state.js, 03-media-list.js (getSelectedMedia, updateMediaStatus),
 *       04-overlay.js (overlays, getOverlays), 05-crop.js (cropVideos)
 * ========================================================= */

async function toggleStart() {
  const btn = document.getElementById("startBtn");
  const label = document.getElementById("startLabel");

  if (btn.classList.contains("rs-running")) {
    btn.disabled = false;
    try {
      const job = processJobKind || mode_selected;
      if (job === "export-ocr-subtitle") {
        await pywebview.api.stop_ocr_subtitle_batch();
      } else if (job === "export-subtitle") {
        await pywebview.api.stop_subtitle_batch();
      } else {
        await pywebview.api.stop_render_studio_batch();
      }
    } catch (e) {
      console.error("Lỗi khi dừng:", e);
    }

    btn.classList.remove("rs-running");
    label.innerText = "BẮT ĐẦU XỬ LÝ";
    restoreProcessModeFromUi();
    return;
  }

  const mode = restoreProcessModeFromUi();
  if (!mode) {
    if (typeof showCheck === "function") {
      showCheck("Hãy chọn chế độ xử lý (Render / Ghép Video / Trim / Crop).", () => {});
    }
    return;
  }

  btn.classList.add("rs-running");
  label.innerText = "ĐANG XỬ LÝ — NHẤN ĐỂ DỪNG";
  btn.disabled = false;
  processJobKind = mode;

  let result = true;

  if (mode === "crop") {
    result = await cropVideos();
  } else if (mode === "i2v") {
    result = await ImageToVideos();
  } else if (mode === "render") {
    await RenderVideos();
  } else if (mode === "trim") {
    result = await TrimVideos();
  } else if (mode === "merge") {
    result = await MergeVideos();
  } else {
    result = false;
    if (typeof showCheck === "function") {
      showCheck("Hãy chọn chế độ xử lý (Render / Ghép Video / Trim / Crop).", () => {});
    }
  }
  if (!result) {
    btn.classList.remove("rs-running");
    label.innerText = "BẮT ĐẦU XỬ LÝ";
    restoreProcessModeFromUi();
    return;
  }

  btn.classList.remove("rs-running");
  label.innerText = "BẮT ĐẦU XỬ LÝ";
  restoreProcessModeFromUi();
}

/* ---------- BUILD CONFIG CHO CHẾ ĐỘ "RENDER" ---------- */

function renderTwoScreenSelected() {
  const el = document.getElementById("videoFilter");
  return !!(el && String(el.value) === "two");
}

function previewFrameSize() {
  const preview = document.getElementById("previewFrame");
  const rect = preview ? preview.getBoundingClientRect() : { width: 0, height: 0 };
  if (rect.width > 1 && rect.height > 1) return { width: rect.width, height: rect.height };
  return { width: 315, height: 560 };
}

function scaleTimelineDataForRender(timelineData, renderWidth, renderHeight) {
  const rect = previewFrameSize();
  const scaleY = renderHeight / rect.height;
  const toRenderFs = (value, fallback) => {
    if (typeof fontSizeUiToRender === "function") {
      return fontSizeUiToRender(value, fallback, renderHeight);
    }
    const n = Number(value);
    const raw = Number.isFinite(n) && n > 0 ? n : fallback;
    return Math.round(raw * scaleY);
  };
  const applyRenderFonts = (layers, fallback) => {
    (layers || []).forEach((l) => {
      if (!l.data) return;
      if (l.data.FontSize != null && l.data.FontSize !== "") {
        l.data.FontSize = toRenderFs(l.data.FontSize, fallback);
      }
      if (l.data.FontSize2 != null && l.data.FontSize2 !== "") {
        l.data.FontSize2 = toRenderFs(l.data.FontSize2, fallback);
      }
      if (l.data.BorderWidth != null && l.data.BorderWidth !== "") {
        l.data.BorderWidth = toRenderFs(l.data.BorderWidth, 0);
      }
      if (l.data.BorderWidth1 != null && l.data.BorderWidth1 !== "") {
        l.data.BorderWidth1 = toRenderFs(l.data.BorderWidth1, 0);
      }
    });
    return layers;
  };
  const scalePositional = (layers) =>
    (layers || []).map((l) => {
      const data = { ...(l.data || {}) };
      if (data.FontSize != null && data.FontSize !== "") {
        data.FontSize = Number(data.FontSize);
      }
      if (data.FontSize2 != null && data.FontSize2 !== "") {
        data.FontSize2 = Number(data.FontSize2);
      }
      const out = { start: l.start, end: l.end, data };
      if (data.x !== undefined) out.x = Math.round(data.x * renderWidth);
      if (data.y !== undefined) out.y = Math.round(data.y * renderHeight);
      if (data.width !== undefined) out.width = Math.round(data.width * renderWidth);
      if (data.height !== undefined) out.height = Math.round(data.height * renderHeight);
      return out;
    });
  const subLayers = scalePositional(timelineData.sub);
  if (typeof collectSubStyle === "function" && subLayers.length) {
    const masterSrc = timelineData.sub[0] && timelineData.sub[0].data;
    const master =
      (typeof sharedSubStyle !== "undefined" && sharedSubStyle) ||
      collectSubStyle(masterSrc || {});
    subLayers.forEach((l) => {
      if (!l.data) l.data = {};
      if (master && typeof stampSubStyle === "function") stampSubStyle(l.data, master);
    });
  }
  applyRenderFonts(subLayers, 14);
  const hookLayers = scalePositional(timelineData.hook);
  if (typeof collectHookStyle === "function" && hookLayers.length) {
    const masterSrc = timelineData.hook[0] && timelineData.hook[0].data;
    const master =
      (typeof sharedHookStyle !== "undefined" && sharedHookStyle) ||
      collectHookStyle(masterSrc || {});
    hookLayers.forEach((l) => {
      if (!l.data) l.data = {};
      if (master && typeof stampHookStyle === "function") stampHookStyle(l.data, master);
    });
  }
  applyRenderFonts(hookLayers, 18);
  const textLayers = scalePositional(timelineData.text);
  if (typeof collectTextStyle === "function" && textLayers.length) {
    const masterSrc = timelineData.text[0] && timelineData.text[0].data;
    const master =
      (typeof sharedTextStyle !== "undefined" && sharedTextStyle) ||
      collectTextStyle(masterSrc || {});
    textLayers.forEach((l) => {
      if (!l.data) l.data = {};
      if (master && typeof stampTextStyle === "function") stampTextStyle(l.data, master);
    });
  }
  applyRenderFonts(textLayers, 22);
  return {
    blur: scalePositional(timelineData.blur),
    hook: hookLayers,
    sub: subLayers,
    text: textLayers,
    crop: scalePositional(timelineData.crop),
    image: scalePositional(timelineData.image),
  };
}

function buildRenderConfig(renderWidth, renderHeight, threadVal, render_option,contents) {
  const rect = previewFrameSize();
  const scaleX = renderWidth / rect.width;
  const scaleY = renderHeight / rect.height;
  const timelineData = getAllTimelineLayersData();
  const pieces = scaleTimelineDataForRender(timelineData, renderWidth, renderHeight);

  const renderOverlays = overlays.map((item) => ({
    id: item.id,
    type: item.type,
    path: item.path,
    x: Math.round(item.x * scaleX),
    y: Math.round(item.y * scaleY),
    width: Math.round(item.width * scaleX),
    height: Math.round(item.height * scaleY),
    rotation: item.rotation,
    sameTime: item.sameTime,
    opacity: item.opacity,
    zIndex: item.zIndex,
    start: item.start,
    end: item.end
  }));

  return {
    thread: parseInt(threadVal, 10) || 1,
    threads: parseInt(threadVal, 10) || 1,
    render_option: render_option,
    width: renderWidth,
    height: renderHeight,
    contents: contents || [],
    overlays: renderOverlays,
    ...pieces,
    scale: {
      scaleX,            
      scaleY, 
      previewWidth: rect.width,
      previewHeight: rect.height,
      renderWidth,
      renderHeight
    }
  };
}

async function RenderVideos() {
  const selected = getSelectedMedia();
  if (selected.length === 0) {
    showCheck("Bạn chưa chọn media. Vui lòng chọn để tiếp tục", () => {
      // pickFileMedia()
  });
    return false;
  }
  const contents = getContentList();
  const input = document.getElementById("threadVal").value;
  const mode = document.getElementById("renderMode").value;
  const renderSize = currentOutputSize();
  const RenderOverlay = document.getElementById("RenderOverlay").checked;
  const RenderAudio = document.getElementById("RenderAudio").checked;
  const RenderRenderAutoTrim = document.getElementById("RenderRenderAutoTrim").checked;
  const RenderFillter = document.getElementById("RenderFillter").checked;
  const postToTikTok = !!(document.getElementById("RenderToTikTok") && document.getElementById("RenderToTikTok").checked);
  const postToFacebook = !!(document.getElementById("RenderToFacebook") && document.getElementById("RenderToFacebook").checked);
  const RenameVideo = document.getElementById("reNameVideoByContent").checked;
  const buidConfig = buildRenderConfig(renderSize.width, renderSize.height, input, mode,contents);
  const muteOriginalAudio = document.getElementById("muteOriginalAudio").checked;
  const addAudioFile = document.getElementById("addAudioFile").checked;
  const valVolum = document.getElementById("valVolum").value;
  const valPitch= document.getElementById("valPitch").value;
  const valTempo= document.getElementById("valTempo").value;
  const valVolumeBg= document.getElementById("valVolumeBg").value;
  const valFadeIn = document.getElementById("valFadeIn").value;
  const valFadeOut= document.getElementById("valFadeOut").value;
  addBgAudio = false;
  if(audioList.length > 0){
    addBgAudio =true
  }
  if(RenameVideo && contents.length==0 ){
    showCheck("Danh sách nội dung đang trống. Vui lòng thêm", () => {
    });
    return false;
  }
  if (addAudioFile) {
    if(!muteOriginalAudio){
      showCheck(
              `Vui lòng tắt âm thanh gốc. Trước khi thêm âm thanh.`,
              () => {}
          );

          return false;
    }
      const audioExtensions = [
          ".mp3",
          ".wav",
          ".m4a",
          ".aac",
          ".flac",
          ".ogg"
      ];

      const invalidItems = selected.filter(item => {
          const files = item.files || [];

          // Kiểm tra xem dòng này có ít nhất 1 file âm thanh không
            updateMediaStatus(
                  item.path,
                  "Đang chờ xử lý",
                  "wait"
              );
          const hasAudio = files.some(file => {
              const filePath = typeof file === "string"
                  ? file
                  : file.path || file.name || "";

              const ext = filePath
                  .toLowerCase()
                  .split("?")[0]
                  .split(".")
                  .pop();

              return audioExtensions.includes("." + ext);
          });

          return !hasAudio;
      });

      if (invalidItems.length > 0) {
          invalidItems.forEach(item => {
              updateMediaStatus(
                  item.path,
                  "Chưa có file âm thanh",
                  "error"
              );
          });
          showCheck(
              `Có ${invalidItems.length} dòng chưa có file âm thanh. Vui lòng thêm file âm thanh để tiếp tục.`,
              () => {}
          );

          return false;
      }
  }
  const audioConfig ={
    muteOriginalAudio:muteOriginalAudio,
    volumeOriginalAudio:parseFloat(valVolum/10),
    pitchOriginalAudio :parseFloat(valPitch/10),
    tempoOriginalAudio :parseFloat(valTempo/10),
    volumeBgAudio: parseFloat(valVolumeBg/10),
    fadeInBgAudio:parseFloat(valFadeIn/10),
    fadeOutBgAudio:parseFloat(valFadeOut/10),
    addBgAudio:addBgAudio,
    addAudioFile:addAudioFile,
    listBgAudo:audioList

  }
  if (typeof flushCurrentTracks === "function") flushCurrentTracks();
  const config = {
    files: selected.map((item) => {
      const layers = typeof getWorkingLayersForMedia === "function" ? getWorkingLayersForMedia(item) : null;
      const pieces = scaleTimelineDataForRender(getAllTimelineLayersData(layers), renderSize.width, renderSize.height);
      return {
        path: item.path,
        name: item.name,
        duration: item.duration,
        files: item.files,
        ...pieces,
      };
    }),
    RenameVideo:RenameVideo,
    AddOverlay: RenderOverlay,
    AddAudio:RenderAudio,
    RenderRenderAutoTrim:RenderRenderAutoTrim,
    AddFillter:RenderFillter,
    use_two_screen: renderTwoScreenSelected(),
    postToTikTok: postToTikTok,
    postToFacebook: postToFacebook,
    muteOriginalAudio:muteOriginalAudio,
    audioConfig:audioConfig,
    ...buidConfig
  };
  console.log(config)
  try {
       const result = await window.pywebview.api.generate_render_batch(config);
       if (result && result.success === false && result.message && !result.stopped && typeof showCheck === "function") {
         showCheck(result.message, () => {});
       }
  } catch (error) {

  }

  // TODO: gọi API thật sự để render, ví dụ:
  // await window.pywebview.api.generate_render_batch(config);
}

/* ---------- ẢNH -> VIDEO ---------- */

async function ImageToVideos() {
  const selected = getSelectedMedia();

  if (selected.length === 0) {
    showCheck("Bạn chưa chọn media. Vui lòng chọn để tiếp tục", () => {
      // pickFileMedia()
  });
    return false;
  }

  const input = document.getElementById("threadVal").value;
  const mode = document.getElementById("renderMode").value;
  const renderSize = currentOutputSize();
  const time = document.getElementById("countI2V").value;
  const panhand = document.getElementById("penHand").checked;
  const hold_seconds = document.getElementById("HoldI2V").value;

  const config = {
    files: selected.map((item) => ({ path: item.path, name: item.name })),
    threads: typeof getThreadCount === "function" ? getThreadCount() : (parseInt(input, 10) || 1),
    time_: parseFloat(time) || 3,
    panhand:panhand || false,
    hold_seconds:parseFloat(hold_seconds) || 1,
    render_option: mode,
    width: renderSize.width,
    height: renderSize.height,
  };

  selected.forEach((item) => {
    updateMediaStatus(item.path, "Đang xử lý tạo video từ hình ảnh...", "processing");
  });

  try {
    await window.pywebview.api.generate_image_to_video_batch(config);
    return true;
  } catch (e) {
    console.error(e);
    selected.forEach((item) => {
      updateMediaStatus(item.path, "Lỗi xử lý", "error");
    });
    return false;
  }
}


/* ---------- TRIM -> VIDEO ---------- */

async function TrimVideos() {
  const selected = getSelectedMedia();

  if (selected.length === 0) {
    showCheck("Bạn chưa chọn media. Vui lòng chọn để tiếp tục", () => {
      // pickFileMedia()
  });
    return false;
  }

  const input = document.getElementById("threadVal").value;
  const mode = document.getElementById("renderMode").value;
  if (typeof flushCurrentTracks === "function") flushCurrentTracks();
  const defaultTrim = getAllTimelineLayersData(
    typeof getWorkingLayersForMedia === "function" ? getWorkingLayersForMedia(null) : null
  ).trim;
  const files = selected.map((item) => ({
    path: item.path,
    name: item.name,
    duration: item.duration,
    trim: getAllTimelineLayersData(
      typeof getWorkingLayersForMedia === "function" ? getWorkingLayersForMedia(item) : null
    ).trim,
  }));
  const hasTrim = files.some((f) => (f.trim || []).length);
  if (!hasTrim && defaultTrim.length == 0) {
      showCheck("Bạn chưa thiết lập Trim. Vui lòng thiết lập. ", () => {

  });
   return false;
  }
  const config = {
    files,
    threads: typeof getThreadCount === "function" ? getThreadCount() : (parseInt(input, 10) || 1),
    render_option: mode,
    trim: defaultTrim,
    
  };
  selected.forEach((item) => {
    updateMediaStatus(item.path, "Đang bắt đầu xử lý Trim ...", "processing");
  });

  try {
    await window.pywebview.api.generate_trim_video_batch(config);
    return true;
  } catch (e) {
    console.error(e);
    selected.forEach((item) => {
      updateMediaStatus(item.path, "Lỗi xử lý", "error");
    });
    return false;
  }
}
/* ---------- TRIM -> VIDEO ---------- */

async function MergeVideos() {
  const selected = getSelectedMedia();

  if (sceneList.length === 0 && optionMer=="phancanh") {
    showCheck("Bạn chưa tạo phân cảnh. Vui lòng tạo phân cảnh để tiếp tục", () => {
  });
    return false;
  }

  if(optionMer=="phancanh"){
   await mergeScenesAndSend()
   return true;
  }else if(optionMer=="intro"){
    await  mergeWithTransitions()
  }else{

    await mergeAllSelectedVideosMultipleTimes()
    return true;
  }

}

/*------------UP SUBS----------------------*/
// async function up_files_srt() {
//   const selected = getSelectedMedia();

//   if (selected.length === 0) {
//     showCheck("Vui lòng chọn ít nhất một video.", () => {
//     });
//     return false;
//   }

  
// }

// /*------------UP AUDIOS--------------------*/
// async function up_files_audio() {
//   const selected = getSelectedMedia();

//   if (selected.length === 0) {
//     showCheck("Vui lòng chọn ít nhất một video.", () => {
//     });
//     return false;
//   }

  
// }
/* ---------- EXPORT FRAME / AUDIO / SUBTITLE ---------- */

async function export_frame() {
  const selected = getSelectedMedia();

  if (selected.length === 0) {
    showCheck("Vui lòng chọn ít nhất một video.", () => {
    });
    return false;
  }

  const input = document.getElementById("threadVal").value;
  const mode = document.getElementById("renderMode").value;

  const config = {
    files: selected.map((item) => ({
      path: item.path,
      name: item.name,
      width: item.width,
      height: item.height,
      duration: item.duration,
    })),
    threads: typeof getThreadCount === "function" ? getThreadCount() : (parseInt(input, 10) || 1),
    render_option: mode,
  };

  selected.forEach((item) => updateMediaStatus(item.path, "Đang xử lý...", "processing"));

  try {
    const btn = document.getElementById("startBtn");
    const label = document.getElementById("startLabel");
    btn.classList.add("rs-running");
    label.innerText = "ĐANG XỬ LÝ — NHẤN ĐỂ DỪNG";
    mode_selected = "export-frame";
    processJobKind = "export-frame";

    await window.pywebview.api.generate_export_image_batch(config);

    btn.classList.remove("rs-running");
    label.innerText = "BẮT ĐẦU XỬ LÝ";
    if (typeof restoreProcessModeFromUi === "function") restoreProcessModeFromUi();
    return true;
  } catch (e) {
    console.error(e);
    selected.forEach((item) => updateMediaStatus(item.path, "Lỗi xử lý", "error"));
    return false;
  }
}

async function export_audio() {
  const selected = getSelectedMedia();

  if (selected.length === 0) {
    showCheck("Vui lòng chọn ít nhất một video.", () => {
    });
    return false;
  }

  const input = document.getElementById("threadVal").value;
  const mode = document.getElementById("renderMode").value;

  const config = {
    files: selected.map((item) => ({
      path: item.path,
      name: item.name,
      width: item.width,
      height: item.height,
      duration: item.duration,
    })),
    threads: typeof getThreadCount === "function" ? getThreadCount() : (parseInt(input, 10) || 1),
    render_option: mode,
  };

  selected.forEach((item) => updateMediaStatus(item.path, "Đang xử lý...", "processing"));

  try {
    const btn = document.getElementById("startBtn");
    const label = document.getElementById("startLabel");
    btn.classList.add("rs-running");
    label.innerText = "ĐANG XỬ LÝ — NHẤN ĐỂ DỪNG";
    mode_selected = "export-audio";
    processJobKind = "export-audio";

    await window.pywebview.api.generate_export_auido_batch(config);

    btn.classList.remove("rs-running");
    label.innerText = "BẮT ĐẦU XỬ LÝ";
    if (typeof restoreProcessModeFromUi === "function") restoreProcessModeFromUi();
    return true;
  } catch (e) {
    console.error(e);
    selected.forEach((item) => updateMediaStatus(item.path, "Lỗi xử lý", "error"));
    return false;
  }
}

async function export_subtitle() {
  const selected = getSelectedMedia();

  if (selected.length === 0) {
    showCheck("Vui lòng chọn ít nhất một video.", () => {
    });
    return false;
  }

  const input = document.getElementById("threadVal").value;
  const mode = document.getElementById("renderMode").value;

  const config = {
    files: selected.map((item) => ({
      path: item.path,
      name: item.name,
      width: item.width,
      height: item.height,
      duration: item.duration,
    })),
    threads: typeof getThreadCount === "function" ? getThreadCount() : (parseInt(input, 10) || 1),
    render_option: mode,
    language: "auto",
  };

  selected.forEach((item) => updateMediaStatus(item.path, "Đang xử lý...", "processing"));

  try {
    const btn = document.getElementById("startBtn");
    const label = document.getElementById("startLabel");
    btn.classList.add("rs-running");
    label.innerText = "ĐANG XỬ LÝ — NHẤN ĐỂ DỪNG";
    btn.disabled = false;
    mode_selected = "export-subtitle";
    processJobKind = "export-subtitle";

    await window.pywebview.api.generate_subtitle_batch(config);
    return true;
  } catch (e) {
    console.error(e);
    selected.forEach((item) => updateMediaStatus(item.path, "Lỗi xử lý", "error"));
    return false;
  }
}
async function mergeScenesAndSend() {
  const outputCount = parseInt(document.getElementById("countMerVal").value) || 1;
  const mode = document.getElementById("renderMode").value;
  const thread = typeof getThreadCount === "function" ? getThreadCount() : (parseInt(document.getElementById("threadVal").value, 10) || 1);
  const renderSize = currentOutputSize();
   const plans = buildMergePlans(sceneList, outputCount, "merge");
  if(plans.length==0){
    showCheck("Không thể tạo ra tổ hợp video nào từ các phân cảnh hiện tại. Vui lòng kiểm tra lại.", () => {
    });
    return false;
  }
  renderPlanList(plans); 
   const config = {
    plans,
    threads: thread,
    render_option: mode,
    width: renderSize.width,
    height: renderSize.height,
  };
  try {
    await window.pywebview.api.generate_merge_video_batch(config);
  } catch (e) {
    return false;
  }

}
function renderPlanList(plans) {
  const container = document.getElementById("mergePlanList");
  if (!container) return;
  container.innerHTML = plans
    .map(
      (plan) => `
      <div class="plan-row rs-grid-3-2-1" style="margin-bottom: 5px;" data-plan-name="${plan.name}">
        <span class="plan-title">${plan.name}</span>
        <span class="rs-badge-merge rs-wait">Chờ xử lý…</span>
        <span class="plan-output"></span>
      </div>
    `
    )
    .join("");
}
function getMaxCombinations(sceneList) {
  return sceneList.reduce((acc, s) => {
    const len = s.mediaPaths?.length || 0;
    return len > 0 ? acc * len : acc;
  }, 1);
}

function pairKey(a, b) {
  return a + "=>" + b;
}

/**
 * Chọn 1 video trong phân cảnh:
 * - Random
 * - Ưu tiên clip dùng ít nhất
 * - Ưu tiên ít đi cặp với các clip đã chọn ở phân cảnh trước (giảm tỉ lệ trùng)
 */
function pickDiverseClip(paths, usageMap, pairMap, chosenSoFar) {
  let bestScore = Infinity;
  const scored = [];

  for (const p of paths) {
    let score = (usageMap.get(p) || 0) * 1000;
    for (const prev of chosenSoFar) {
      score += (pairMap.get(pairKey(prev, p)) || 0) * 25;
    }
    scored.push({ p, score });
    if (score < bestScore) bestScore = score;
  }

  const candidates = scored.filter((x) => x.score === bestScore).map((x) => x.p);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function buildDiverseCombination(sceneList, usageMap, pairMap) {
  const combo = [];
  for (const scene of sceneList) {
    const pick = pickDiverseClip(scene.mediaPaths, usageMap, pairMap, combo);
    combo.push(pick);
  }
  return combo;
}

function rememberCombination(combo, usageMap, pairMap) {
  combo.forEach((path) => {
    usageMap.set(path, (usageMap.get(path) || 0) + 1);
  });
  for (let i = 0; i < combo.length - 1; i++) {
    const key = pairKey(combo[i], combo[i + 1]);
    pairMap.set(key, (pairMap.get(key) || 0) + 1);
  }
}

/** Nếu số tổ hợp không quá lớn: xáo toàn bộ tổ hợp duy nhất rồi lấy N cái đầu. */
function sampleUniqueCombinations(sceneList, count) {
  const lists = sceneList.map((s) => shuffleArray(s.mediaPaths));
  const all = lists.reduce(
    (acc, curr) => {
      const next = [];
      for (const prefix of acc) {
        for (const clip of curr) next.push([...prefix, clip]);
      }
      return next;
    },
    [[]]
  );
  return shuffleArray(all).slice(0, count);
}
function generateUniqueName(prefix, index) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${stamp}_${String(index + 1).padStart(3, "0")}`;
}
/**
 * Tạo nhiều tổ hợp:
 * - Không trùng thứ tự tổ hợp
 * - Cân bằng số lần sử dụng của từng video trong mỗi phân cảnh
 *
 * @param {Array} sceneList
 * @param {Number} outputCount
 */
function buildMergePlans(sceneList, outputCount = 1, namePrefix = "merge") {
  const validScenes = sceneList.filter(
    (s) => s.mediaPaths && s.mediaPaths.length > 0
  );
  if (validScenes.length === 0) {
    console.warn("Không có phân cảnh nào có video.");
    return [];
  }

  const maxPossible = getMaxCombinations(validScenes);
  const targetCount = Math.min(outputCount, maxPossible);
  if (targetCount < outputCount) {
    console.warn(
      `Chỉ có tối đa ${maxPossible} tổ hợp khả dĩ, giảm outputCount từ ${outputCount} xuống ${targetCount}.`
    );
  }

  // Ít tổ hợp: lấy mẫu từ toàn bộ tổ hợp unique rồi xáo — trùng = 0
  if (maxPossible <= 20000) {
    const combos = sampleUniqueCombinations(validScenes, targetCount);
    return combos.map((files, i) => ({
      name: generateUniqueName(namePrefix, i),
      files,
    }));
  }

  const plans = [];
  const seen = new Set();
  const usageMap = new Map();
  const pairMap = new Map();
  let attempts = 0;
  const maxAttempts = targetCount * 80;

  while (plans.length < targetCount && attempts < maxAttempts) {
    attempts++;
    const combo = buildDiverseCombination(validScenes, usageMap, pairMap);
    const key = combo.join("||");
    if (seen.has(key)) continue;

    seen.add(key);
    rememberCombination(combo, usageMap, pairMap);
    plans.push({
      name: generateUniqueName(namePrefix, plans.length),
      files: combo,
    });
  }

  if (plans.length < targetCount) {
    console.warn(
      `Chỉ tạo được ${plans.length}/${targetCount} tổ hợp không trùng sau ${attempts} lần thử.`
    );
  }

  return plans;
}
// ADD INTRO
/**
 * Xáo trộn ngẫu nhiên 1 mảng (Fisher-Yates), không đổi mảng gốc.
 */
function getSelectedVideoPaths() {
  return getSelectedMedia().map((m) => m.path);
}
function maxPermutationCount(n) {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) {
    result *= i;
    if (result >= 1e12) return 1e12;
  }
  return result;
}

function permutationPairScore(order, pairMap) {
  let score = 0;
  for (let i = 0; i < order.length - 1; i++) {
    score += pairMap.get(pairKey(order[i], order[i + 1])) || 0;
  }
  return score;
}

/**
 * Tạo nhiều thứ tự xáo trộn, không trùng cả chuỗi,
 * ưu tiên thứ tự ít lặp cặp clip liền kề (A rồi B).
 */
function buildDiverseOrderList(items, count) {
  const n = items.length;
  if (n === 0) return [];
  if (n === 1) return [[items[0]]];

  const targetCount = Math.min(count, maxPermutationCount(n));
  const seen = new Set();
  const pairMap = new Map();
  const orders = [];
  let attempts = 0;
  const maxAttempts = targetCount * 80;

  while (orders.length < targetCount && attempts < maxAttempts) {
    attempts++;
    let best = null;
    let bestScore = Infinity;
    let bestKey = null;

    for (let t = 0; t < 16; t++) {
      const cand = shuffleArray(items);
      const key = cand.join("||");
      if (seen.has(key)) continue;
      const score = permutationPairScore(cand, pairMap);
      if (score < bestScore) {
        bestScore = score;
        best = cand;
        bestKey = key;
      }
    }

    if (!best) continue;
    seen.add(bestKey);
    rememberCombination(best, new Map(), pairMap);
    orders.push(best);
  }

  return orders;
}

function buildShuffledMergePlans(videoList, outputCount, namePrefix = "merge") {
  const orders = buildDiverseOrderList(videoList, outputCount);
  return orders.map((files, i) => ({
    name: generateUniqueName(namePrefix, i),
    files,
  }));
}

async function mergeAllSelectedVideosMultipleTimes() {
  const selectedPaths = getSelectedVideoPaths();
  if (selectedPaths.length === 0) {
    showCheck("Bạn chưa chọn media. Vui lòng chọn để tiếp tục", () => {
      // pickFileMedia()
  });
    return false;
  }
  const outputCount = parseInt(document.getElementById("countMerVal").value) || 1;
  const mode = document.getElementById("renderMode").value;
  const thread = typeof getThreadCount === "function" ? getThreadCount() : (parseInt(document.getElementById("threadVal").value, 10) || 1);
  const renderSize = currentOutputSize();

  const plans = buildShuffledMergePlans(selectedPaths, outputCount, "merge_intro");

  if (plans.length === 0) {
    showCheck("Không tạo được video nào", () => {
      // pickFileMedia()
  });
    return false;
  }

  renderPlanList(plans);

  const config = {
    plans,
    threads: thread,
    render_option: mode,
    width: renderSize.width,
    height: renderSize.height,
  };

  try {
    const result = await window.pywebview.api.generate_merge_video_batch(config);
    // console.log("Kết quả ghép video:", result);
    return result;
  } catch (err) {
    // console.error("Lỗi khi gọi generate_merge_video_batch:", err);
  }
}

//ADD INTRO2
/**
 * Lấy tên file không kèm đuôi
 */
function getVideoStem(path) {
  const fileName = path.split(/[\\/]/).pop();
  return fileName.replace(/\.[^/.]+$/, "");
}

function findVideoByStemName(pool, stemName) {
  return pool.find((m) => getVideoStem(m.path) === stemName);
}

/**
 * Chèn video nối giữa các clip chính, theo tên số đếm NGƯỢC từ (n-1) xuống 1.
 */
async function buildInterleavedFiles(mainClipPaths) {
  const n = mainClipPaths.length;
  const files = [];
  const missing = [];

  if (n === 0) return { files, missing };
  if (n === 1) {
    files.push(mainClipPaths[0]);
    return { files, missing };
  }

  const gapCount = n - 1;

  // Danh sách tên transition cần tìm, VD: n=5 -> gapCount=4 -> cần tên "4","3","2","1"
  const neededNames = [];
  for (let i = 0; i < gapCount; i++) {
    neededNames.push(String(gapCount - i));
  }

  // Gọi Python 1 lần để tìm hết, tránh gọi lặp nhiều lần
  const response = await window.pywebview.api.find_transition_videos({
    names: neededNames,
  });

  const transitionMap = response?.result || {};

  for (let i = 0; i < n; i++) {
    files.push(mainClipPaths[i]);

    if (i < n - 1) {
      const transitionName = String(gapCount - i);
      const transitionPath = transitionMap[transitionName];

      if (!transitionPath) {
        missing.push(transitionName);
        continue;
      }
      files.push(transitionPath);
    }
  }

  return { files, missing };
}

function shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function factorial(n) {
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function generateUniqueName(prefix, index) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${stamp}_${String(index + 1).padStart(3, "0")}`;
}

/**
 * Tạo `outputCount` plan, mỗi plan:
 * - Chứa TOÀN BỘ clip chính đã chọn, nhưng theo 1 thứ tự xáo trộn khác nhau (không trùng thứ tự giữa các plan)
 * - Tự động chèn video transition (đếm ngược n-1 -> 1) giữa các clip chính
 *
 * @param {Array<string>} mainClipPaths - toàn bộ clip chính đã chọn
 * @param {Array} transitionPool - nguồn tìm video transition (thường là mediaList)
 * @param {Number} outputCount - số video output muốn tạo
 * @param {String} namePrefix
 * @returns {{ plans: Array<{name,files}>, missing: string[] }}
 */
async function buildTransitionMergePlans(mainClipPaths, outputCount, namePrefix = "merge") {
  if (!mainClipPaths.length) {
    console.warn("Danh sách clip chính rỗng.");
    return { plans: [], missing: [] };
  }

  const orders = buildDiverseOrderList(mainClipPaths, outputCount);
  const plans = [];
  const allMissing = new Set();

  for (const shuffledMain of orders) {
    const { files, missing } = await buildInterleavedFiles(shuffledMain);
    missing.forEach((m) => allMissing.add(m));
    plans.push({
      name: generateUniqueName(namePrefix, plans.length),
      files,
    });
  }

  return { plans, missing: Array.from(allMissing) };
}
async function mergeWithTransitions() {
  const mainClips = getSelectedVideoPaths();

  if (mainClips.length < 2) {
    alert("Cần chọn ít nhất 2 video chính để có khoảng trống chèn video nối.");
    return;
  }

  // if (!transitionFolder) {
  //   alert("Vui lòng chọn thư mục chứa video nối (transition).");
  //   return;
  // }
  const outputCount = parseInt(document.getElementById("countMerVal").value) || 1;
  const mode = document.getElementById("renderMode").value;
  const thread = typeof getThreadCount === "function" ? getThreadCount() : (parseInt(document.getElementById("threadVal").value, 10) || 1);
  const renderSize = currentOutputSize();

  const namePrefix ="merge_transition";

  const { plans, missing } = await buildTransitionMergePlans(
    mainClips, outputCount, namePrefix
  );

  if (missing.length > 0) {
    // alert(`Không tìm thấy video chèn có tên: ${missing.join(", ")} trong thư mục ${transitionFolder}.`);
    return;
  }

  if (plans.length === 0) {
    alert("Không tạo được video nào.");
    return;
  }

  renderPlanList(plans);

  const config = {
    plans,
    threads: thread,
    render_option: mode,
    width: renderSize.width,
    height: renderSize.height,
  };

  try {
    const result = await window.pywebview.api.generate_merge_video_batch(config);
    return result;
  } catch (err) {
    console.error("Lỗi khi gọi generate_merge_video_batch:", err);
  }
}
function updateRenderProgress(path, progress, label) {
    const tr = document.querySelector(
        `tr[data-path="${CSS.escape(path)}"]`
    );

    if (!tr) return;

    const progressBox = tr.querySelector(".render-progress");
    const percent = tr.querySelector(".renderPercent");
    const fill = tr.querySelector(".render-progress-fill");
    const count = tr.querySelector(".renderCount");
    const badge = tr.querySelector(".rs-badge");

    if (!progressBox || !percent || !fill) return;

    let value = parseFloat(String(progress).replace("%", ""));
    if (!Number.isFinite(value)) value = 0;
    value = Math.max(0, Math.min(100, value));

    progressBox.style.display = "block";
    if (badge) badge.style.display = "none";

    if (count) count.innerText = label || "Đang xử lý";
    percent.innerText = Math.round(value) + "%";
    fill.style.width = value + "%";
}
function hideRenderProgress(path) {
    const tr = document.querySelector(
        `tr[data-path="${CSS.escape(path)}"]`
    );

    if (!tr) return;

    const progressBox = tr.querySelector(".render-progress");
    const badge = tr.querySelector(".rs-badge");
    const fill = tr.querySelector(".render-progress-fill");
    const count = tr.querySelector(".renderCount");
    const percent = tr.querySelector(".renderPercent");

    if (progressBox) {
        progressBox.style.display = "none";
    }
    if (fill) fill.style.width = "0%";
    if (percent) percent.innerText = "0%";
    if (count) count.innerText = "";
    if (badge) badge.style.display = "";
}