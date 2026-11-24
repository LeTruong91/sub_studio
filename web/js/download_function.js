let downloadRunning = false;
let downloadJobActive = false;
let scanTimer = null;

function scanIntervalMinutes() {
  const el = document.getElementById("downloadScanMinutes");
  let n = parseInt(el && el.value, 10);
  if (!n || n < 1) n = 5;
  if (n > 1440) n = 1440;
  if (el) el.value = String(n);
  return n;
}

function setRenderProgressLabel(rendering) {
  const btn = document.getElementById("renderProgressBtn");
  if (!btn) return;
  const on = !!rendering;
  btn.textContent = on ? "Đang Render" : "Tiến trình Render";
  btn.classList.toggle("is-rendering", on);
  btn.disabled = false;
}

function askStopRender() {
  const btn = document.getElementById("renderProgressBtn");
  if (!btn || !btn.classList.contains("is-rendering")) return;
  const ask = typeof showConfirm === "function"
    ? showConfirm
    : function (message, callback) { if (window.confirm(message) && typeof callback === "function") callback(); };
  ask("Bạn có chắc chắn dừng tiến trình render?", async function () {
    appendDownloadLog("Đang dừng render…");
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api.stop_render_studio_batch) {
        await window.pywebview.api.stop_render_studio_batch();
      }
    } catch (e) {}
  }, {
    title: "Dừng render",
    okText: "OK",
    cancelText: "Hủy",
    okClass: "rs-btn-confim rs-btn-ok",
  });
}

function setDownloadButtonRunning(running) {
  downloadRunning = !!running;
  const btn = document.getElementById("downloadToggleBtn");
  if (!btn) return;
  btn.textContent = downloadRunning ? "Stop" : "Download";
  btn.classList.toggle("download-btn-start", !downloadRunning);
  btn.classList.toggle("download-btn-stop", downloadRunning);
}

async function toggleDownload() {
  if (downloadRunning) {
    const auto = document.getElementById("downloadScanAuto");
    if (auto && auto.checked) {
      setCheckbox(auto, false);
      autoScanWasOn = false;
      const hadTimer = !!scanTimer;
      stopAutoScan();
      if (hadTimer) appendDownloadLog("Đã tắt tự động quét.");
    }
    await stopDownload();
    downloadJobActive = false;
    setDownloadButtonRunning(false);
    return;
  }
  const ok = await confirmEnabledOptions("Download");
  if (!ok) return;
  await startDownload();
}

async function saveDownloadScanSettings() {
  if (!window.pywebview) return;
  try {
    const config = (await window.pywebview.api.get_folder_config()) || {};
    config.scan_video_api = (document.getElementById("downloadScanApi").value || "").trim();
    config.scan_video_minutes = scanIntervalMinutes();
    config.render_per_channel_day = renderPerChannelDay();
    delete config.scan_video_auto;
    await window.pywebview.api.save_folder_config(config);
  } catch (error) {}
}

function stopAutoScan() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

let autoScanWasOn = false;

function armAutoScan(runNow) {
  stopAutoScan();
  const minutes = scanIntervalMinutes();
  setDownloadButtonRunning(true);
  scanTimer = setInterval(runAutoScan, minutes * 60 * 1000);
  if (runNow) {
    appendDownloadLog("Tự động quét mỗi " + minutes + " phút.");
    runAutoScan();
  }
}

function apiLinkOn() {
  return optionChecked("downloadShowAutoPost");
}

function syncAutoScanAvailability() {
  const scan = document.getElementById("downloadScanAuto");
  const label = document.querySelector(".download-scan-auto");
  const allowed = apiLinkOn();
  if (label) label.classList.toggle("is-locked", !allowed);
  if (scan) scan.disabled = !allowed;
  if (allowed || !scan || !scan.checked) return;
  setCheckbox(scan, false);
  autoScanWasOn = false;
  const hadTimer = !!scanTimer;
  stopAutoScan();
  if (hadTimer) appendDownloadLog("Đã tắt tự động quét vì Link từ API đang tắt.");
  if (!downloadJobActive) setDownloadButtonRunning(false);
}

async function onAutoScanChanged() {
  await saveDownloadScanSettings();
  const box = document.getElementById("downloadScanAuto");
  const on = !!(box && box.checked);
  if (on && !apiLinkOn()) {
    setCheckbox(box, false);
    appendDownloadLog("Tự động quét chỉ chạy khi Link từ API được bật.");
    return;
  }
  if (!on) {
    autoScanWasOn = false;
    const hadTimer = !!scanTimer;
    stopAutoScan();
    if (hadTimer) appendDownloadLog("Đã tắt tự động quét.");
    if (!downloadJobActive) setDownloadButtonRunning(false);
    return;
  }
  if (autoScanWasOn) {
    armAutoScan(false);
    return;
  }
  const ok = await confirmEnabledOptions("Tự động quét");
  if (!ok || !box.checked) {
    setCheckbox(box, false);
    return;
  }
  autoScanWasOn = true;
  armAutoScan(true);
}

function optionChecked(id) {
  const el = document.getElementById(id);
  return !!(el && el.checked);
}

function optionText(title, detail) {
  return "<li><strong>" + title + "</strong><span>" + detail + "</span></li>";
}

function enabledOptionItems() {
  const items = [];
  const apiMode = optionChecked("downloadShowAutoPost");
  const highlightOn = optionChecked("dataqRenderHighlight");
  const autoRender = optionChecked("dataqDownloadAutoRender");
  const encode = document.getElementById("downloadEncodeMode");
  const encodeGpu = !encode || encode.value !== "cpu";

  if (optionChecked("downloadScanAuto")) {
    items.push(optionText(
      "Tự động quét",
      "Cứ mỗi " + scanIntervalMinutes() + " phút gọi API và tải video mới, cho đến khi tắt ô này."
    ));
  }
  if (apiMode) {
    items.push(optionText(
      "Link từ API",
      "Lấy link từ API quét video. Danh sách URL dán tay không được dùng."
    ));
  } else {
    items.push(optionText(
      "Danh sách URL",
      "Tải đúng các link đã dán. API quét không được gọi ở lượt này."
    ));
  }
  if (optionChecked("downloadUseProxy")) {
    items.push(optionText(
      "Sử dụng proxy",
      "Mỗi lượt tải đi qua một proxy SOCKS5 trong danh sách."
    ));
  }
  items.push(optionText(
    "Luồng",
    "Tải cùng lúc " + downloadThreadCount() + " video."
  ));
  items.push(optionText(
    encodeGpu ? "GPU · NVENC" : "CPU · x264",
    encodeGpu
      ? "Video HEVC được chuyển sang H.264 bằng GPU để xem được trong app."
      : "Video HEVC được chuyển sang H.264 bằng CPU để xem được trong app."
  ));
  items.push(optionText(
    "Video/kênh/ngày",
    "Mỗi kênh chỉ render tối đa " + renderPerChannelDay() + " video trong một ngày."
  ));
  const later = autoRender ? "" : " Chỉ chạy khi Auto Render được bật.";
  if (autoRender) {
    items.push(optionText(
      "Auto Render",
      "Tải xong sẽ render vào thư mục rendeFinal."
    ));
  }
  if (highlightOn) {
    items.push(optionText(
      "Lấy đoạn hay cho video dài",
      "Cắt các đoạn được xem nhiều có số điểm từ " + highlightScore().toFixed(1) + " trở lên, mỗi file " + highlightSeconds() + " giây. Crop, cắt ngẫu nhiên, đổi màu và đổi âm lượng ở cột bên phải không chạy." + later
    ));
    if (optionChecked("dataqRenderTwoScreen")) {
      items.push(optionText(
        "Render 2 màn hình",
        "Mỗi đoạn hay thành video 9:16. Video nằm ở giữa. Viền trên và viền dưới là cùng hình được phóng to và làm mờ." + later
      ));
    }
    if (optionChecked("dataqHighlightVolume")) {
      items.push(optionText(
        "Thay đổi âm lượng",
        "Âm lượng gốc của mỗi đoạn hay được tăng hoặc giảm ngẫu nhiên." + later
      ));
    }
  } else {
    if (optionChecked("dataqRenderCrop")) {
      items.push(optionText("Crop 9:16", "Cắt video về khung dọc 1080×1920." + later));
    }
    if (optionChecked("dataqRenderRandomCut")) {
      items.push(optionText("Cắt đoạn ngẫu nhiên", "Lấy một đoạn ngẫu nhiên trong video thay vì giữ nguyên độ dài." + later));
    }
    if (optionChecked("dataqRenderColor")) {
      items.push(optionText("Thay đổi màu sắc", "Đổi màu video ngẫu nhiên." + later));
    }
    if (optionChecked("dataqRenderVolume")) {
      items.push(optionText("Thay đổi âm lượng", "Âm lượng gốc được tăng hoặc giảm ngẫu nhiên." + later));
    }
  }
  if (optionChecked("dataqEnabled")) {
    items.push(optionText("Upload TikTok", "Sau khi render, tải file lên Drive và ghi sheet TikTok." + later));
  }
  if (optionChecked("fbqEnabled")) {
    items.push(optionText("Upload Facebook", "Sau khi render, tải file lên Drive và ghi sheet Facebook." + later));
  }
  return items;
}

function confirmEnabledOptions(title) {
  const html = "<p class=\"dl-opt-note\">Các tùy chọn đang bật. Nhấn OK để bắt đầu.</p><ul class=\"dl-opt-list\">"
    + enabledOptionItems().join("")
    + "</ul>";
  return new Promise((resolve) => {
    if (typeof showConfirm !== "function") {
      resolve(true);
      return;
    }
    showConfirm(html, () => resolve(true), {
      html: true,
      wide: true,
      title: "Xác nhận " + title,
      okText: "OK",
      cancelText: "Hủy",
      okClass: "rs-btn-confim rs-btn-ok",
      onCancel: () => resolve(false),
    });
  });
}

async function runAutoScan() {
  if (!document.getElementById("downloadScanAuto").checked) return;
  if (!apiLinkOn()) {
    syncAutoScanAvailability();
    return;
  }
  if (downloadJobActive) {
    appendDownloadLog("Đang tải, bỏ qua lượt quét.");
    return;
  }
  await startDownload({ autoScan: true });
}

async function loadDownloadScanApi() {
  const input = document.getElementById("downloadScanApi");
  if (!input || !window.pywebview) return;
  try {
    const config = await window.pywebview.api.get_folder_config();
    if (!config) return;
    if (config.scan_video_api) input.value = config.scan_video_api;
    const proxies = document.getElementById("downloadProxyList");
    if (proxies && config.download_proxies) proxies.value = config.download_proxies;
    const useProxy = document.getElementById("downloadUseProxy");
    if (useProxy) setCheckbox(useProxy, !!config.download_use_proxy);
    const minutes = document.getElementById("downloadScanMinutes");
    if (minutes && config.scan_video_minutes) minutes.value = String(config.scan_video_minutes);
    const perDay = document.getElementById("renderPerChannelDay");
    if (perDay && config.render_per_channel_day) perDay.value = String(config.render_per_channel_day);
    const auto = document.getElementById("downloadScanAuto");
    if (auto) setCheckbox(auto, false);
  } catch (error) {}
}

function renderPerChannelDay() {
  let n = parseInt((document.getElementById("renderPerChannelDay") || {}).value, 10);
  if (!n || n < 1) n = 5;
  if (n > 100) n = 100;
  const el = document.getElementById("renderPerChannelDay");
  if (el) el.value = String(n);
  return n;
}

function downloadThreadCount() {
  let n = parseInt((document.getElementById("threadCountDownload") || {}).value, 10);
  if (!n || n < 1) n = 1;
  if (n > 100) n = 100;
  const el = document.getElementById("threadCountDownload");
  if (el) el.value = String(n);
  return n;
}

async function startDownload(opts) {
  const autoScan = !!(opts && opts.autoScan);
  const apiMode = apiLinkOn();
  if (autoScan && !apiMode) {
    appendDownloadLog("Tự động quét chỉ chạy khi Link từ API được bật.");
    syncAutoScanAvailability();
    return;
  }
  const useLinks = !apiMode;
  const urls = useLinks
    ? document
        .getElementById("txtUrls")
        .value.split("\n")
        .map((x) => x.trim())
        .filter((x) => x)
    : [];
  const scanApis = useLinks
    ? []
    : (document.getElementById("downloadScanApi").value || "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter((x) => x);

  if (useLinks && !urls.length) {
    appendDownloadLog("❌ Dán URL vào danh sách link.");
    return;
  }
  if (!useLinks && !scanApis.length) {
    appendDownloadLog("❌ Chưa có API quét video.");
    return;
  }

  const useProxy = !!(document.getElementById("downloadUseProxy") && document.getElementById("downloadUseProxy").checked);
  const proxyLines = (document.getElementById("downloadProxyList").value || "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x);
  const config = {
    urls,
    scan_api: scanApis,
    auto_scan: autoScan,
    link_mode: useLinks,
    use_proxy: useProxy,
    proxies: useProxy ? proxyLines : [],
    proxy_lines: proxyLines,
    threads: downloadThreadCount(),
    render_per_day: renderPerChannelDay(),
    auto_render: await downloadAutoRenderEnabled(),
    encode_mode: (document.getElementById("downloadEncodeMode") || {}).value || "gpu",
  };

  const progress = document.getElementsByClassName("download-progress");
  if (progress[0]) progress[0].style.display = "block";

  setDownloadButtonRunning(true);
  downloadJobActive = true;
  try {
    await window.pywebview.api.start_download(config);
  } catch (error) {
    downloadJobActive = false;
    const auto = document.getElementById("downloadScanAuto");
    if (!(auto && auto.checked)) setDownloadButtonRunning(false);
  }
}

async function stopDownload() {
  try {
    await window.pywebview.api.stop_download();
  } catch (error) {}
  clearDownloadFileStatus();
}

function toggleDownloadAutoView(fromUser) {
  const box = document.getElementById("downloadShowAutoPost");
  if (fromUser && box) box.dataset.userSet = "1";
  const on = !!(box && box.checked);
  const api = document.getElementById("downloadApiPanel");
  const urls = document.getElementById("downloadUrlPanel");
  if (api) api.hidden = !on;
  if (urls) urls.hidden = on;
  syncAutoScanAvailability();
  if (typeof loadDownloadQueues === "function") loadDownloadQueues();
  else if (typeof loadDataQueueTab === "function") loadDataQueueTab();
}

async function onDownloadFinished(files) {
  clearDownloadFileStatus();
  try {
    await renderDownloadsIfEnabled(files || []);
  } finally {
    downloadJobActive = false;
    const auto = document.getElementById("downloadScanAuto");
    if (!(auto && auto.checked)) setDownloadButtonRunning(false);
  }
}

function highlightSeconds() {
  let n = parseInt((document.getElementById("dataqHighlightSeconds") || {}).value, 10);
  if (!n || n < 1) n = 60;
  if (n > 600) n = 600;
  const el = document.getElementById("dataqHighlightSeconds");
  if (el) el.value = String(n);
  return n;
}

function highlightScore() {
  let n = parseFloat((document.getElementById("dataqHighlightScore") || {}).value);
  if (!n || n < 0.1) n = 0.1;
  if (n > 1) n = 1;
  n = Math.round(n * 10) / 10;
  const el = document.getElementById("dataqHighlightScore");
  if (el) el.value = n.toFixed(1);
  return n;
}

function syncHighlightPanel() {
  const box = document.getElementById("dataqRenderHighlight");
  const on = !!(box && box.checked);
  const highlightRow = document.querySelector(".tt-highlight-row");
  if (highlightRow) {
    highlightRow.classList.toggle("is-locked", !on);
    highlightRow.querySelectorAll("input").forEach((el) => {
      el.disabled = !on;
    });
  }
  ["dataqRenderCrop", "dataqRenderRandomCut", "dataqRenderColor", "dataqRenderVolume"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = on;
    const label = el.closest(".tt-opt");
    if (label) label.classList.toggle("is-locked", on);
  });
}

async function saveHighlightScore() {
  const n = highlightScore();
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_highlight_score) {
    try { await api.set_highlight_score(n); } catch (e) {}
  }
}

async function saveHighlightSeconds() {
  const n = highlightSeconds();
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_highlight_seconds) {
    try { await api.set_highlight_seconds(n); } catch (e) {}
  }
}

async function onRenderHighlight() {
  const box = document.getElementById("dataqRenderHighlight");
  if (!box) return;
  box.dataset.userSet = "1";
  box.dataset.loaded = "1";
  syncHighlightPanel();
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_render_highlight) {
    try { await api.set_render_highlight(!!box.checked); } catch (e) {}
  }
  if (box.checked) await saveHighlightSeconds();
}

async function renderCropEnabled() {
  const box = document.getElementById("dataqRenderCrop");
  if (box && (box.dataset.userSet === "1" || box.dataset.loaded === "1")) {
    return !!box.checked;
  }
  try {
    const data = await window.pywebview.api.get_data_queue();
    const on = !data || data.render_crop !== false;
    if (box && box.dataset.userSet !== "1") {
      setCheckbox(box, on);
      box.dataset.loaded = "1";
    }
    return on;
  } catch (e) {
    return !box || box.checked;
  }
}

async function renderRandomCutEnabled() {
  const box = document.getElementById("dataqRenderRandomCut");
  if (box && (box.dataset.userSet === "1" || box.dataset.loaded === "1")) {
    return !!box.checked;
  }
  try {
    const data = await window.pywebview.api.get_data_queue();
    const on = !!(data && data.render_random_cut);
    if (box && box.dataset.userSet !== "1") {
      setCheckbox(box, on);
      box.dataset.loaded = "1";
    }
    return on;
  } catch (e) {
    return !!(box && box.checked);
  }
}

async function renderColorEnabled() {
  const box = document.getElementById("dataqRenderColor");
  if (box && (box.dataset.userSet === "1" || box.dataset.loaded === "1")) {
    return !!box.checked;
  }
  try {
    const data = await window.pywebview.api.get_data_queue();
    const on = !!(data && data.render_color);
    if (box && box.dataset.userSet !== "1") {
      setCheckbox(box, on);
      box.dataset.loaded = "1";
    }
    return on;
  } catch (e) {
    return !!(box && box.checked);
  }
}

async function renderVolumeEnabled() {
  const box = document.getElementById("dataqRenderVolume");
  if (box && (box.dataset.userSet === "1" || box.dataset.loaded === "1")) {
    return !!box.checked;
  }
  try {
    const data = await window.pywebview.api.get_data_queue();
    const on = !!(data && data.render_volume);
    if (box && box.dataset.userSet !== "1") {
      setCheckbox(box, on);
      box.dataset.loaded = "1";
    }
    return on;
  } catch (e) {
    return !!(box && box.checked);
  }
}

async function downloadAutoRenderEnabled() {
  const box = document.getElementById("dataqDownloadAutoRender");
  if (box && (box.dataset.userSet === "1" || box.dataset.loaded === "1")) {
    return !!box.checked;
  }
  try {
    const data = await window.pywebview.api.get_data_queue();
    const on = !!(data && data.download_auto_render);
    if (box && box.dataset.userSet !== "1") {
      setCheckbox(box, on);
      box.dataset.loaded = "1";
    }
    return on;
  } catch (e) {
    return !!(box && box.checked);
  }
}

async function renderDownloadsIfEnabled(files) {
  const items = (files || []).map((item) => {
    if (item && typeof item === "object") {
      const path = String(item.path || "").trim();
      if (!path) return null;
      return { path: path, url: String(item.url || "").trim() };
    }
    const path = String(item || "").trim();
    return path ? { path: path, url: "" } : null;
  }).filter(Boolean);
  if (!items.length) return;
  const on = await downloadAutoRenderEnabled();
  if (!on) return;
  appendDownloadLog("Download xong. Đang render " + items.length + " video vào thư mục rendeFinal…");
  try {
    const ok = await renderDownloadedFiles(items);
    if (ok === false) appendDownloadLog("Tự động render chưa xong hết. Xem log phía trên.");
  } catch (error) {
    appendDownloadLog("Tự động render lỗi: " + (error && error.message ? error.message : error));
  }
}

function downloadBuildRenderConfig(renderWidth, renderHeight, threadVal, renderOption, contents) {
  if (typeof buildRenderConfig === "function") {
    return buildRenderConfig(renderWidth, renderHeight, threadVal, renderOption, contents);
  }
  const rect = typeof previewFrameSize === "function"
    ? previewFrameSize()
    : { width: 315, height: 560 };
  const scaleX = rect.width ? renderWidth / rect.width : 1;
  const scaleY = rect.height ? renderHeight / rect.height : 1;
  const timelineData = typeof getAllTimelineLayersData === "function" ? getAllTimelineLayersData() : {};
  const pieces = typeof scaleTimelineDataForRender === "function"
    ? scaleTimelineDataForRender(timelineData, renderWidth, renderHeight)
    : {};
  const sourceOverlays = typeof overlays !== "undefined" && overlays ? overlays : [];
  const renderOverlays = sourceOverlays.map((item) => ({
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
    end: item.end,
  }));
  return {
    thread: parseInt(threadVal, 10) || 1,
    threads: parseInt(threadVal, 10) || 1,
    render_option: renderOption,
    width: renderWidth,
    height: renderHeight,
    contents: contents || [],
    overlays: renderOverlays,
    ...pieces,
    scale: {
      scaleX: scaleX,
      scaleY: scaleY,
      previewWidth: rect.width,
      previewHeight: rect.height,
      renderWidth: renderWidth,
      renderHeight: renderHeight,
    },
  };
}

async function renderDownloadedFiles(items) {
  const rows = (items || []).map((item) => {
    if (item && typeof item === "object") {
      return { path: String(item.path || "").trim(), url: String(item.url || "").trim() };
    }
    return { path: String(item || "").trim(), url: "" };
  }).filter((item) => item.path);
  const contents = typeof getContentList === "function" ? getContentList() : [];
  const input = String(downloadThreadCount());
  const mode = (document.getElementById("renderMode") || {}).value || "2";
  const renderSize = typeof currentOutputSize === "function"
    ? currentOutputSize()
    : { width: 1080, height: 1920 };
  const RenderOverlay = !!(document.getElementById("RenderOverlay") && document.getElementById("RenderOverlay").checked);
  const RenderAudio = !!(document.getElementById("RenderAudio") && document.getElementById("RenderAudio").checked);
  const RenderRenderAutoTrim = !!(document.getElementById("RenderRenderAutoTrim") && document.getElementById("RenderRenderAutoTrim").checked);
  const RenderFillter = !!(document.getElementById("RenderFillter") && document.getElementById("RenderFillter").checked);
  const postToTikTok = !!(document.getElementById("RenderToTikTok") && document.getElementById("RenderToTikTok").checked);
  const postToFacebook = !!(document.getElementById("RenderToFacebook") && document.getElementById("RenderToFacebook").checked);
  const RenameVideo = !!(document.getElementById("reNameVideoByContent") && document.getElementById("reNameVideoByContent").checked);
  const muteOriginalAudio = !!(document.getElementById("muteOriginalAudio") && document.getElementById("muteOriginalAudio").checked);
  const addAudioFile = !!(document.getElementById("addAudioFile") && document.getElementById("addAudioFile").checked);
  if (RenameVideo && contents.length === 0) {
    appendDownloadLog("Tự động render: danh sách nội dung đang trống, tắt Đổi tên theo nội dung hoặc thêm nội dung.");
    return false;
  }
  if (addAudioFile && !muteOriginalAudio) {
    appendDownloadLog("Tự động render: đang bật thêm file âm thanh nhưng chưa tắt âm thanh gốc.");
    return false;
  }
  const buidConfig = downloadBuildRenderConfig(renderSize.width, renderSize.height, input, mode, contents);
  const num = (id) => parseFloat((document.getElementById(id) || {}).value || 0);
  const audioConfig = {
    muteOriginalAudio: muteOriginalAudio,
    volumeOriginalAudio: num("valVolum") / 10,
    pitchOriginalAudio: num("valPitch") / 10,
    tempoOriginalAudio: num("valTempo") / 10,
    volumeBgAudio: num("valVolumeBg") / 10,
    fadeInBgAudio: num("valFadeIn") / 10,
    fadeOutBgAudio: num("valFadeOut") / 10,
    addBgAudio: typeof audioList !== "undefined" && audioList.length > 0,
    addAudioFile: addAudioFile,
    listBgAudo: typeof audioList !== "undefined" ? audioList : [],
  };
  if (typeof flushCurrentTracks === "function") flushCurrentTracks();
  const layers = typeof getWorkingLayersForMedia === "function" ? getWorkingLayersForMedia(null) : null;
  const pieces = typeof scaleTimelineDataForRender === "function"
    ? scaleTimelineDataForRender(
        typeof getAllTimelineLayersData === "function" ? getAllTimelineLayersData(layers) : {},
        renderSize.width,
        renderSize.height
      )
    : {};
  const config = {
    files: rows.map((item) => ({
      path: item.path,
      source_url: item.url,
      name: item.path.split(/[/\\]/).pop(),
      duration: "",
      files: [],
      ...pieces,
    })),
    RenameVideo: RenameVideo,
    AddOverlay: RenderOverlay,
    AddAudio: RenderAudio,
    RenderRenderAutoTrim: RenderRenderAutoTrim,
    AddFillter: RenderFillter,
    postToTikTok: postToTikTok,
    postToFacebook: postToFacebook,
    muteOriginalAudio: muteOriginalAudio,
    audioConfig: audioConfig,
    output_beside_source: true,
    output_suffix: "",
    ...buidConfig,
    crop_fill: false,
  };
  const cropOn = await renderCropEnabled();
  const randomCut = await renderRandomCutEnabled();
  const highlightOn = !!(document.getElementById("dataqRenderHighlight") && document.getElementById("dataqRenderHighlight").checked);
  config.use_highlight = highlightOn;
  config.highlight_seconds = highlightSeconds();
  config.highlight_score = highlightScore();
  const filterTwo = typeof renderTwoScreenSelected === "function" && renderTwoScreenSelected();
  config.use_two_screen = filterTwo || (highlightOn && !!(document.getElementById("dataqRenderTwoScreen") && document.getElementById("dataqRenderTwoScreen").checked));
  config.use_highlight_volume = highlightOn && !!(document.getElementById("dataqHighlightVolume") && document.getElementById("dataqHighlightVolume").checked);
  config.use_crop = highlightOn ? false : cropOn;
  config.use_color = highlightOn ? false : await renderColorEnabled();
  config.use_volume = highlightOn ? false : await renderVolumeEnabled();
  config.use_random_cut = highlightOn ? false : randomCut;
  if (!highlightOn && (cropOn || randomCut)) {
    config.crop_segments = true;
    if (cropOn) {
      config.width = 1080;
      config.height = 1920;
    }
  }
  setRenderProgressLabel(true);
  try {
    const result = await window.pywebview.api.generate_render_batch(config);
    if (result && result.message) appendDownloadLog(result.message);
    return !!(result && result.success);
  } finally {
    setRenderProgressLabel(false);
  }
}

const DOWNLOAD_LOG_LIMIT = 200;

function appendDownloadLog(msg) {
  const txt = document.getElementById("txtLog");
  if (!txt) return;
  String(msg == null ? "" : msg).split(/\r?\n/).forEach((part) => {
    if (!part) return;
    const line = document.createElement("div");
    line.className = "download-log-line";
    line.textContent = part;
    txt.appendChild(line);
  });
  while (txt.childElementCount > DOWNLOAD_LOG_LIMIT) {
    txt.removeChild(txt.firstElementChild);
  }
  txt.scrollTop = txt.scrollHeight;
}

function refreshDownloadCookieHint() {
  const hint = document.getElementById("downloadCookieHint");
  const box = document.getElementById("txtUrls");
  if (!hint || !box) return;
  const low = (box.value || "").toLowerCase();
  hint.hidden = !(
    low.includes("douyin.com")
    || low.includes("iesdouyin.com")
    || low.includes("xiaohongshu.com")
    || low.includes("xhslink.com")
    || low.includes("instagram.com")
  );
}

function applyDefaultAutoPost() {
  const box = document.getElementById("downloadShowAutoPost");
  if (!box || box.dataset.userSet === "1") return;
  setCheckbox(box, true);
  toggleDownloadAutoView();
}

window.addEventListener("pywebviewready", loadDownloadScanApi);
document.addEventListener("DOMContentLoaded", applyDefaultAutoPost);
if (document.readyState !== "loading") applyDefaultAutoPost();
document.getElementById("txtUrls")?.addEventListener("input", refreshDownloadCookieHint);

function updateDownloadFileStatus(name, percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const full = String(name || "video");
  const short = full.length > 48 ? full.slice(0, 45) + "…" : full;
  const label = "Đang tải " + short + " " + value + "%";
  const status = document.getElementById("statusText");
  const dot = document.getElementById("statusDot");
  if (status) status.textContent = label;
  if (dot) {
    dot.classList.add("busy");
    dot.classList.remove("error");
  }
  const box = document.querySelector(".download-progress");
  if (box) box.style.display = "block";
  const pct = document.getElementById("downloadPercent");
  const fill = document.getElementById("downloadProgressFill");
  if (pct) pct.innerText = value + "%";
  if (fill) fill.style.width = value + "%";
  const txt = document.getElementById("txtLog");
  if (!txt) return;
  let line = document.getElementById("downloadLiveFile");
  if (!line) {
    line = document.createElement("div");
    line.id = "downloadLiveFile";
    line.className = "download-log-line";
    txt.appendChild(line);
  }
  line.textContent = "Đang tải " + full + " " + value + "%";
  txt.scrollTop = txt.scrollHeight;
}

function clearDownloadFileStatus() {
  const status = document.getElementById("statusText");
  const dot = document.getElementById("statusDot");
  if (status && String(status.textContent || "").indexOf("Đang tải ") === 0) {
    status.textContent = "Sẵn sàng";
  }
  if (dot) dot.classList.remove("busy");
  const line = document.getElementById("downloadLiveFile");
  if (line) line.remove();
}

function updateDownloadProgress(progress, completed, total) {
  document.getElementById("downloadPercent").innerText = progress + "%";
  document.getElementById("downloadCount").innerText = completed + " / " + total;
  document.getElementById("downloadProgressFill").style.width = progress + "%";
}

function updateHighlightProgress(percent, label) {
  const box = document.querySelector(".download-progress");
  if (box) box.style.display = "block";
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const pct = document.getElementById("downloadPercent");
  const fill = document.getElementById("downloadProgressFill");
  const count = document.getElementById("downloadCount");
  if (pct) pct.innerText = value + "%";
  if (fill) fill.style.width = value + "%";
  const text = String(label == null ? "" : label);
  const part = text.match(/Part\s+(\d+)\s*\/\s*(\d+)/i);
  if (count) count.innerText = part ? ("Part " + part[1] + " / " + part[2]) : (value + "%");
  const txt = document.getElementById("txtLog");
  if (!txt) return;
  let line = document.getElementById("downloadLiveProgress");
  if (!line) {
    line = document.createElement("div");
    line.id = "downloadLiveProgress";
    line.className = "download-log-line";
    txt.appendChild(line);
  }
  line.textContent = text;
  txt.scrollTop = txt.scrollHeight;
}
