/* =========================================================
 * UI CONTROLS
 * Tabs, mode-card, ratio pills, checkbox, slider, stepper, content list
 * Không phụ thuộc file khác (thuần thao tác DOM/UI)
 * ========================================================= */

/* ---------- TABS ---------- */

document.querySelectorAll(".rs-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".rs-tab").forEach((t) => t.classList.remove("rs-active"));
    document.querySelectorAll(".rs-tab-content").forEach((c) => c.classList.remove("rs-active"));

    tab.classList.add("rs-active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("rs-active");
  });
});

/* ---------- MODE CARDS ---------- */

document.querySelectorAll(".rs-mode-card").forEach((card) => {
  card.addEventListener("click", () => {
    document.querySelectorAll(".rs-mode-card").forEach((c) => c.classList.remove("rs-active"));
    card.classList.add("rs-active");

    const mode = card.dataset.mode;
    mode_selected = mode;
    processJobKind = null;

    document.querySelectorAll(".rs-ratio-row").forEach((row) => (row.style.display = "none"));

    const option = document.getElementById(mode + "_option");
    if (option) option.style.display = "flex";
  });
});

/* ---------- RATIO PILLS ---------- */

document.querySelectorAll(".rs-ratio-pill").forEach((p) => {
  p.addEventListener("click", () => {
    document.querySelectorAll(".rs-ratio-pill").forEach((x) => x.classList.remove("rs-active"));
    p.classList.add("rs-active");
  });
});

document.querySelectorAll(".rs-ratio-mer").forEach((p) => {
  p.addEventListener("click", () => {
    document.querySelectorAll(".rs-ratio-mer").forEach((x) => x.classList.remove("rs-active"));
    p.classList.add("rs-active");
  });
});

function setMerRatio(el, option) {
  if (currentMerOption === el) {
    el.classList.remove("rs_active_mer");
    currentMerOption = null;
    return;
  }

  document.querySelectorAll(".rs-ratio-mer").forEach((x) => x.classList.remove("rs_active_mer"));

  el.classList.add("rs_active_mer");
  optionMer = option;
}

/* ---------- CHECKBOX (custom style) ---------- */

// document.querySelectorAll(".rs-checkbox").forEach((cb) => {
//   cb.addEventListener("click", () => {
//     console.log("GOI")
//     cb.classList.toggle("rs-on");
//     const input = cb.querySelector("input");
//     input.checked = cb.classList.contains("rs-on");
//   });
// });
// document.addEventListener("click", (e) => {
//   const cb = e.target.closest(".rs-checkbox");
//   if (!cb) return;
 
//   cb.classList.toggle("rs-on");
//   const input = cb.querySelector("input");
//   console.log(input)
//   if (input) input.checked = cb.classList.contains("rs-on");
//   const target = document.querySelector(
//       '.rs-stepper input[data-target="layerEditEnd"]'
//   );

//   target?.closest(".rs-stepper")?.classList.toggle("rs-disabled", input.checked);
// });
// document.addEventListener("click", (e) => {
//     const cb = e.target.closest(".rs-checkbox");
//     if (!cb) return;
//     e.stopPropagation();
//     const input = cb.querySelector("input");
//     if (!input) return;

//     input.checked = !input.checked;
//     cb.classList.toggle("rs-on", input.checked);
//     input.dispatchEvent(new Event("change", { bubbles: true })); 
//     // Không có data-target thì dừng
//     if (!cb.dataset.target) return;

//     const target = document.getElementById(cb.dataset.target);
//     console.log(target)
//     if (target) {
//       // console.log(target)
//       //   target.closest(".rs-stepper")
//       //         ?.classList.toggle("rs-disabled", input.checked);
//       const stepper = target.closest(".rs-stepper");
//       console.log(stepper)
//       if (!stepper) return;
//       const reverse = target.id === "countword_hook";
//       stepper.classList.toggle(
//           "rs-disabled",
//           reverse ? !input.checked : input.checked
//       );
//     }
// });
document.addEventListener("click", (e) => {
    const cb = e.target.closest(".rs-checkbox");
    if (!cb) return;

    const input = cb.querySelector("input");
    if (!input) return;

    if (e.target.tagName === "INPUT") {
      requestAnimationFrame(() => cb.classList.toggle("rs-on", input.checked));
      return;
    }

    e.stopPropagation();

    input.checked = !input.checked;
    cb.classList.toggle("rs-on", input.checked);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    e.preventDefault();

    if (!cb.dataset.target) return;

    const target = document.getElementById(cb.dataset.target);
    if (target) {
      const stepper = target.closest(".rs-stepper") || target.closest(".rs-sub-textarea-wrap");
      if (!stepper) return;
      const reverse = target.id === "countword_hook";
      stepper.classList.toggle(
          "rs-disabled",
          reverse ? !input.checked : input.checked
      );
    }
}, true); // <-- true = capture phase, chạy TRƯỚC listener click của <tr>
function setCheckbox(input, checked) {
    if (!input) return;
    input.checked = !!checked;

    const box = input.closest(".rs-checkbox");
    if (box) {
        box.classList.toggle("rs-on", !!checked);
    }
}

document.addEventListener("change", (e) => {
    const input = e.target;
    if (!input || input.type !== "checkbox") return;
    const box = input.closest && input.closest(".rs-checkbox");
    if (box) box.classList.toggle("rs-on", !!input.checked);
});
/* ---------- FOLDER TOGGLE ---------- */

function applyPreviewAspect() {
  const frame = document.getElementById("previewFrame");
  const toggle = document.getElementById("folderToggle");
  if (!frame) return;
  frame.style.aspectRatio = (toggle && toggle.checked) ? "16/9" : "9/16";
  if (typeof updateVideoContainer === "function") updateVideoContainer();
}

document.getElementById("folderToggle").addEventListener("change", function () {
  applyPreviewAspect();
});

/* ---------- SLIDER (input range) hiển thị giá trị ---------- */

document.querySelectorAll("input[type=range]").forEach((r) => {
  r.addEventListener("input", () => {
    const valEl = r.closest(".rs-slider-field")?.querySelector(".rs-val");
    if (valEl && !r.hasAttribute("oninput")) {
      valEl.innerText = (r.value / 10).toFixed(2).replace(/0$/, "").replace(/\.$/, ".0");
    }
  });
});

/* ---------- STEPPER (nút +/-) ---------- */

function getThreadCount() {
  const input = document.getElementById("threadVal");
  const n = parseInt(input && input.value, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function stepThread(delta) {
  const input = document.getElementById("threadVal");
  let v = parseInt(input.value) + delta;
  if (v < 1) v = 1;
  if (v > 64) v = 64;
  input.value = v;
}

function stepCountMerge(delta) {
  const input = document.getElementById("countMerVal");
  let v = parseInt(input.value) + delta;
  if (v < 1) v = 1;
  input.value = v;
}

function stepCountI2v(delta) {
  const input = document.getElementById("countI2V");
  let v = parseInt(input.value) + delta;
  if (v < 1) v = 1;
  input.value = v;
}
function stepHoldHand(delta) {
  const input = document.getElementById("HoldI2V");
    let v = parseFloat(input.value) || 0;

    // Chuyển sang đơn vị 0.1 giây
    let value10 = Math.round(v * 10);

    // delta = 0.1 → +1
    // delta = -0.1 → -1
    value10 += Math.round(delta * 10);

    if (value10 < 1) {
        value10 = 1;
    }

    input.value = value10 / 10;
}
function stepCountword_hook(delta) {
  const input = document.getElementById("countword_hook");
  let v = parseInt(input.value) + delta;
  if (v < 1) v = 1;
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}


function stepstepBorderHook(delta) {
  const input = document.getElementById("valBorderHook");
  let v = parseInt(input.value) + delta;
  if (v < 1) v = 0;
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function stepstepBorderSub(delta) {
  const input = document.getElementById("valBorderSub");
  let v = parseInt(input.value) + delta;
  if (v < 1) v = 0;
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function stepsCountWordSub(delta) {
  const input = document.getElementById("CountWordSub");
  let v = parseInt(input.value) + delta;
  if (v < 1) v = 1;
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function stepFontSizeSub(delta) {
  const input = document.getElementById("valFontSizeSub");
  let v = (parseInt(input.value, 10) || 18) + delta;
  if (v < 8) v = 8;
  if (v > 200) v = 200;
  input.value = v;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function stepOverlayStart(delta) {
  const input = document.getElementById("overlayStart");
    let v = parseFloat(input.value) || 0;

    // Chuyển sang đơn vị 0.1 giây
    let value10 = Math.round(v * 10);

    // delta = 0.1 → +1
    // delta = -0.1 → -1
    value10 += Math.round(delta * 10);

    if (value10 < 1) {
        value10 = 1;
    }

    input.value = value10 / 10;
}

function stepOverlayEnd(delta) {
  const input = document.getElementById("overlayEnd");
  let v = parseFloat(input.value) || 0;

    // Chuyển sang đơn vị 0.1 giây
    let value10 = Math.round(v * 10);

    // delta = 0.1 → +1
    // delta = -0.1 → -1
    value10 += Math.round(delta * 10);

    if (value10 < 1) {
        value10 = 1;
    }

    input.value = value10 / 10;
}


function steplayerEditStart(delta) {
  const input = document.getElementById("layerEditStart");
    let v = parseFloat(input.value) || 0;

    // Chuyển sang đơn vị 0.1 giây
    let value10 = Math.round(v * 10);

    // delta = 0.1 → +1
    // delta = -0.1 → -1
    value10 += Math.round(delta * 10);

    if (value10 < 1) {
        value10 = 1;
    }

    input.value = value10 / 10;
}

function steplayerEditEnd(delta) {
  const input = document.getElementById("layerEditEnd");
    let v = parseFloat(input.value) || 0;

    // Chuyển sang đơn vị 0.1 giây
    let value10 = Math.round(v * 10);

    // delta = 0.1 → +1
    // delta = -0.1 → -1
    value10 += Math.round(delta * 10);

    if (value10 < 1) {
        value10 = 1;
    }

    input.value = value10 / 10;
}
/* ---------- RENDER MODE SELECT (hiển thị pill GPU) ---------- */

function optionMode() {
  const select = document.getElementById("renderMode");
  const text = select.options[select.selectedIndex].text;
  // document.getElementById("rs-gpu-pill").innerHTML = text;
}

/* ---------- CONTENT LIST (textarea -> danh sách) ---------- */

function addContentToList() {
  const textarea = document.getElementById("txtContent");
  const list = document.querySelector(".rs-content-list");

  const lines = textarea.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  lines.forEach((text) => {
    list.insertAdjacentHTML(
      "beforeend",
      `
            <div class="rs-item">
                <span>${text}</span>
                <button class="rs-remove">&times;</button>
            </div>
            `
    );
  });

  textarea.value = "";
}

function getContentList() {
  const result = [];

  document.querySelectorAll(".rs-content-list .rs-item span").forEach((span) => {
    result.push(span.textContent.trim());
  });

  return result;
}

document.querySelector(".rs-content-list").addEventListener("click", function (e) {
  if (e.target.classList.contains("rs-remove")) {
    e.target.closest(".rs-item").remove();
  }
});

function clearContent() {
  showConfirm("Bạn có chắc muốn xóa tất cả nội dung?", () => {
    document.querySelector(".rs-content-list").innerHTML = "";
  });
}
function setDisabled(inputId, disabled) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const stepper = input.closest(".rs-stepper") || input.closest(".rs-sub-textarea-wrap");
    if (!stepper) return;

    stepper.classList.toggle("rs-disabled", disabled);
}
function updateLayerGuide(layer) {
    const guide = document.querySelector(
        `.rs-layer-guide[data-layer-id="${layer.id}"]`
    );

    if (!guide) return;

    if (layer.type === "hook") {
        const content = guide.querySelector(".rs-layer-guide-content");
        if (!content) return;

        content.textContent = layer.data.text;
        content.style.fontSize = (typeof previewFontPx === "function"
          ? previewFontPx(layer.data.FontSize, 18)
          : layer.data.FontSize) + "px";
    }
}

async function loadFont(fontName, fontUrl) {

    if (typeof fontUrl === "object" && fontUrl.url) {
        fontUrl = fontUrl.url;
    }

    console.log(
        "Loading font:",
        fontName,
        fontUrl
    );


    const font = new FontFace(
        fontName,
        `url("${fontUrl}")`
    );

    try {

        await font.load();

        document.fonts.add(font);


        console.log(
            "Font loaded:",
            fontName,
            document.fonts.check(
                `18px "${fontName}"`
            )
        );


    } catch(e) {

        console.error(
            "Font load failed:",
            e
        );
    }
}
// function updateFontStyles(fontName) {

//     const styleSelect = document.getElementById("FontStyle");

//     const fonts = systemFonts.filter(f => f.name === fontName);

//     styleSelect.innerHTML = fonts.map(f => `
//         <option value="${f.style}">
//             ${f.style.charAt(0).toUpperCase() + f.style.slice(1)}
//         </option>
//     `).join("");
// }
function updateFontStyles(fontName, styleSelectId = "FontStyle") {

    const styleSelect = document.getElementById(styleSelectId);
    if (!styleSelect) return;

    const fonts = systemFonts.filter(f => f.name === fontName);

    styleSelect.innerHTML = fonts.map(f => `
        <option value="${f.style}">
            ${f.style.charAt(0).toUpperCase() + f.style.slice(1)}
        </option>
    `).join("");
}
function getActiveProcessMode() {
  const card = document.querySelector(".rs-mode-card.rs-active");
  return (card && card.dataset.mode) || "";
}

function restoreProcessModeFromUi() {
  let mode = getActiveProcessMode();
  if (!mode) {
    const renderCard = document.querySelector('.rs-mode-card[data-mode="render"]');
    document.querySelectorAll(".rs-mode-card").forEach((c) => c.classList.remove("rs-active"));
    if (renderCard) renderCard.classList.add("rs-active");
    mode = "render";
    const option = document.getElementById("render_option");
    document.querySelectorAll(".rs-ratio-row").forEach((row) => (row.style.display = "none"));
    if (option) option.style.display = "flex";
  }
  mode_selected = mode;
  processJobKind = null;
  return mode;
}

function onSubtitleBatchDone() {
  const btn = document.getElementById("startBtn");
  const label = document.getElementById("startLabel");
  if (btn) {
    btn.classList.remove("rs-running");
    btn.disabled = false;
  }
  if (label) label.innerText = "BẮT ĐẦU XỬ LÝ";
  if (typeof setOcrRunLive === "function") setOcrRunLive(false);
  restoreProcessModeFromUi();
}
function deleteAudioBG(){
    showConfirm("Bạn có chắc muốn xóa tất cả audio?", () => {
      audioList=[];
      const listAudioID = document.getElementById("countListbgAuido");
      const deleteAudioBG = document.getElementById("deleteAudioBG");
      listAudioID.innerText="Chọn nhạc nền…";
      deleteAudioBG.style.display="none";

  });
}

function updateCropProgress(progress, completed, total) {
  document.getElementById("mediaCount").innerText = `${total} tệp · ${completed} đã xử lý`;
}
const EDITOR_PANEL_H_KEY = "rs-editor-panel-h";

function getEditorPanelHeight() {
  const workspace = document.querySelector(".rs-workspace");
  const raw = workspace && getComputedStyle(workspace).getPropertyValue("--editor-panel-h");
  const n = parseInt(raw, 10);
  if (!isNaN(n) && n > 0) return n;
  return 280;
}

function clampEditorPanelHeight(h) {
  const minH = 180;
  const maxH = Math.max(minH, window.innerHeight - 300);
  return Math.max(minH, Math.min(maxH, Math.round(h)));
}

function setEditorPanelHeight(h, persist) {
  const workspace = document.querySelector(".rs-workspace");
  const panel = document.querySelector(".rs-editor-panel");
  h = clampEditorPanelHeight(h);
  if (workspace) {
    workspace.style.setProperty("--editor-panel-h", h + "px");
    workspace.style.gridTemplateRows = `minmax(180px, 1fr) ${h}px`;
  }
  if (panel) panel.style.height = h + "px";
  if (persist) {
    try { localStorage.setItem(EDITOR_PANEL_H_KEY, String(h)); } catch (e) {}
  }
  return h;
}

function updatePreviewFrameHeight() {
  const previewFrame = document.getElementById("previewFrame");
  const previewPhanCanh = document.getElementById("previewPhanCanh");
  const rs_workspace = document.querySelector(".rs-workspace");
  if (!previewFrame) return;

  const editorH = getEditorPanelHeight();
  const OFFSET = 230;
  let available = window.innerHeight - OFFSET - editorH;
  available = Math.max(180, Math.min(available, 720));

  previewFrame.style.setProperty("--preview-max-h", available + "px");
  if (rs_workspace) {
    rs_workspace.style.setProperty("--preview-max-h", available + "px");
    rs_workspace.style.gridTemplateRows = `minmax(180px, 1fr) ${editorH}px`;
  }

  const applyPhanCanhHeight = () => {
    if (!previewPhanCanh) return;
    const phanhH = Math.max(180, available - 60);
    previewPhanCanh.style.height = phanhH + "px";
    previewPhanCanh.style.maxHeight = phanhH + "px";
    previewPhanCanh.style.minHeight = phanhH + "px";
  };
  applyPhanCanhHeight();
  requestAnimationFrame(applyPhanCanhHeight);

  if (typeof syncLayerGuides === "function") syncLayerGuides();
  if (typeof refreshOverlayTextFonts === "function") refreshOverlayTextFonts();
}

function initEditorPanelResize() {
  const handle = document.getElementById("editorPanelResize");
  const workspace = document.querySelector(".rs-workspace");
  if (!handle || !workspace) return;

  let saved = 280;
  try {
    saved = parseInt(localStorage.getItem(EDITOR_PANEL_H_KEY), 10) || 280;
  } catch (e) {}
  setEditorPanelHeight(saved, false);

  let dragging = false;
  let startY = 0;
  let startH = 0;

  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = getEditorPanelHeight();
    workspace.classList.add("rs-resizing-editor");
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const next = startH + (startY - e.clientY);
    setEditorPanelHeight(next, false);
    updatePreviewFrameHeight();
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    workspace.classList.remove("rs-resizing-editor");
    setEditorPanelHeight(getEditorPanelHeight(), true);
    updatePreviewFrameHeight();
    if (typeof renderRuler === "function") renderRuler();
    if (typeof arrangeHookSegments === "function") arrangeHookSegments();
  });
}

window.addEventListener("load", () => {
  initEditorPanelResize();
  updatePreviewFrameHeight();
  if (typeof arrangeHookSegments === "function") arrangeHookSegments();
});
window.addEventListener("resize", updatePreviewFrameHeight);
document.getElementById("videoResolution")?.addEventListener("change", () => {
  updatePreviewFrameHeight();
  if (typeof refreshOverlayTextFonts === "function") refreshOverlayTextFonts();
});
async function ReloadCloneVoice(){
      try {

        // gọi python lấy config
        let config = await window.pywebview.api.get_clone_config();
        if (config) {
            renderCloneVoices(config);
        }
      }
      catch (e) {
          showCheck("Sever Voice chưa được mở. Vui lòng mở Sever rồi tải lại!", () => {
        });

      }
}
const TRACK_INFO_MAP = {
  blurTrack: "infoBlur",
  hookTrack: "infoHook",
  trimTrack: "infoTrim",
  cropTrack: "infoCrop",
  ocrTrack: "infoOcr",
  imageTrack: "infoImage",
};

const TRACK_ROW_H = 42;
const TRACK_LAYER_TYPES = {
  imageTrack: ["image"],
  hookTrack: ["hook", "sub", "text"],
  trimTrack: ["trim"],
  cropTrack: ["crop"],
  blurTrack: ["blur"],
  ocrTrack: ["ocr"],
};

function syncVisibleTracks() {
  const layers = typeof timelineLayers !== "undefined" ? timelineLayers : [];
  Object.entries(TRACK_LAYER_TYPES).forEach(([trackId, types]) => {
    const used = layers.some((l) => types.includes(l.type));
    const track = document.getElementById(trackId);
    const row = document.getElementById(TRACK_INFO_MAP[trackId]);
    if (track) track.hidden = !used;
    if (row) {
      row.hidden = !used;
      if (!used) {
        const chk = row.querySelector(".rs-track-check");
        if (chk) {
          chk.checked = false;
          const box = chk.closest(".rs-checkbox");
          if (box) box.classList.remove("rs-on");
        }
      }
    }
  });
  if (typeof syncTrackDeleteBtn === "function") syncTrackDeleteBtn();
}

function syncTrackDeleteBtn() {
  const btn = document.getElementById("trackDeleteBtn");
  if (!btn) return;
  const any = Array.from(document.querySelectorAll(".rs-track-check-box")).some(
    (box) => box.classList.contains("rs-on") && !box.closest("[hidden]")
  );
  btn.hidden = !any;
}

function deleteCheckedTracks() {
  const names = {
    imageTrack: "Image",
    hookTrack: "Text",
    trimTrack: "Trim",
    cropTrack: "Crop",
    blurTrack: "Blur",
    ocrTrack: "OCR",
  };
  const types = [];
  const labels = [];
  document.querySelectorAll(".rs-track-check").forEach((el) => {
    if (!el.checked || el.closest("[hidden]")) return;
    const extra = TRACK_LAYER_TYPES[el.dataset.track] || [];
    extra.forEach((t) => types.push(t));
    const name = names[el.dataset.track] || el.dataset.track;
    if (name && !labels.includes(name)) labels.push(name);
  });
  if (!types.length) {
    syncTrackDeleteBtn();
    return;
  }
  const ask =
    typeof showConfirm === "function"
      ? showConfirm
      : (msg, cb) => {
          if (window.confirm(msg)) cb();
        };
  ask("Xóa toàn bộ lớp trên track " + labels.join(", ") + "?", () => {
    document.querySelectorAll(".rs-track-check").forEach((el) => {
      if (!el.checked) return;
      el.checked = false;
      const box = el.closest(".rs-checkbox");
      if (box) box.classList.remove("rs-on");
    });
    if (typeof timelineLayers === "undefined") return;
    timelineLayers = timelineLayers.filter((l) => !types.includes(l.type));
    if (typeof selectedLayer !== "undefined" && selectedLayer && types.includes(selectedLayer.type)) {
      selectedLayer = null;
    }
    if (typeof closePropsIfEditingMissing === "function") closePropsIfEditingMissing();
    syncTrackDeleteBtn();
    if (typeof renderTimeline === "function") renderTimeline();
  }, { okText: "Xóa", cancelText: "Hủy" });
}

function syncTrackInfoHeights() {
  const main = document.querySelector(".rs-timeline-main");
  const info = document.querySelector(".rs-track-info");
  if (main && info) {
    const paneH = main.clientHeight || main.offsetHeight;
    if (paneH > 0) info.style.height = paneH + "px";
  }

  syncVisibleTracks();

  Object.entries(TRACK_INFO_MAP).forEach(([trackId, infoId]) => {
    const track = document.getElementById(trackId);
    const row = document.getElementById(infoId);
    if (!track || !row || track.hidden) return;

    const h = track.style.height ? parseFloat(track.style.height) : (track.offsetHeight || TRACK_ROW_H);
    row.style.height = h + "px";
    row.style.minHeight = h + "px";
    row.style.maxHeight = h + "px";
  });

  const tracksScroll = document.getElementById("tracksScroll");
  const infoScroll = document.getElementById("trackInfoScroll");
  if (tracksScroll && infoScroll) {
    infoScroll.style.flex = "";
    infoScroll.style.height = "";
    infoScroll.style.minHeight = "";
    infoScroll.style.maxHeight = "";
    if (infoScroll.scrollTop !== tracksScroll.scrollTop) {
      infoScroll.scrollTop = tracksScroll.scrollTop;
    }
  }
  updateOcrStickyState();
}

function updateOcrStickyState() {
  const scroller = document.getElementById("tracksScroll");
  const track = document.getElementById("ocrTrack");
  const info = document.getElementById("infoOcr");
  if (!scroller || !track) return;
  const canScroll = scroller.scrollHeight > scroller.clientHeight + 1;
  const layoutBottom = track.offsetTop + track.offsetHeight;
  const visibleBottom = scroller.scrollTop + scroller.clientHeight;
  const stuck = !track.hidden && canScroll && layoutBottom > visibleBottom + 1;
  track.classList.toggle("is-stuck", stuck);
  if (info) info.classList.toggle("is-stuck", stuck);
}


function arrangeStackedTrack(trackId, types) {
  const track = document.getElementById(trackId);
  if (!track) return;

  const layers = timelineLayers.filter((l) => types.includes(l.type));
  layers.forEach((layer) => {
    const seg = track.querySelector(`.rs-seg[data-id="${layer.id}"]`);
    if (!seg) return;
    const row = layer.row || 0;
    seg.style.top = `${row * TRACK_ROW_H}px`;
  });

  const maxRow = layers.reduce((max, l) => Math.max(max, l.row || 0), 0);
  const height = layers.length ? (maxRow + 1) * TRACK_ROW_H : TRACK_ROW_H;
  track.style.height = `${height}px`;
}

function arrangeHookSegments() {
  arrangeStackedTrack("hookTrack", ["hook", "sub", "text"]);
  arrangeStackedTrack("imageTrack", ["image"]);
  arrangeStackedTrack("ocrTrack", ["ocr"]);
  arrangeStackedTrack("blurTrack", ["blur"]);
  syncTrackInfoHeights();
}
function syncTrackInfoScroll(){
  const tracksScroll = document.getElementById("tracksScroll");
  const trackInfo = document.getElementById("trackInfoScroll") || document.querySelector(".rs-track-info");
  if (!tracksScroll || !trackInfo) return;

  let syncing = false;

  tracksScroll.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    trackInfo.scrollTop = tracksScroll.scrollTop;
    syncing = false;
    updateOcrStickyState();
  });

  trackInfo.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    tracksScroll.scrollTop = trackInfo.scrollTop;
    syncing = false;
    updateOcrStickyState();
  });
}
document.addEventListener("DOMContentLoaded", syncTrackInfoScroll);
document.addEventListener("DOMContentLoaded", () => {
  const main = document.querySelector(".rs-timeline-main");
  if (main && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => syncTrackInfoHeights()).observe(main);
    const tracksScroll = document.getElementById("tracksScroll");
    if (tracksScroll) new ResizeObserver(() => syncTrackInfoHeights()).observe(tracksScroll);
  }
  syncTrackInfoHeights();
});
(function initGlobalTooltip(){
  let tip = document.getElementById("rsGlobalTooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "rsGlobalTooltip";
    document.body.appendChild(tip);
  }

  function showTooltip(target){
    const text = target.getAttribute("data-tooltip");
    if (!text) return;

    tip.textContent = text;
    tip.classList.add("show");

    const rect = target.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.top - tipRect.height - 10;

    left = Math.max(6, Math.min(left, window.innerWidth - tipRect.width - 6));
    if (top < 4) top = rect.bottom + 10;

    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function hideTooltip(){
    tip.classList.remove("show");
  }

  document.addEventListener("mouseenter", (e) => {
    const el = e.target.closest?.(".rs-tooltip");
    if (el) showTooltip(el);
  }, true);

  document.addEventListener("mouseleave", (e) => {
    const el = e.target.closest?.(".rs-tooltip");
    if (el) hideTooltip();
  }, true);
})();