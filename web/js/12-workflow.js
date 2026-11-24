const WF_IDS = {
  file: "wfFile",
  inbox: "wfInbox",
  ready: "wfReady",
  posted: "wfPosted",
  failed: "wfFailed",
  copy: "wfCopyAfterRender",
  downloadAutoRender: "wfDownloadAutoRender",
  music: "wfMusicFromReady",
  move: "wfMoveAfterPost",
};

function wfSetStats(stats) {
  const s = stats || {};
  const map = [
    ["wfStatInbox", s.inbox],
    ["wfStatReady", s.ready],
    ["wfStatPosted", s.posted],
    ["wfStatFailed", s.failed],
  ];
  map.forEach(([id, n]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n ?? 0);
  });
}

function wfMsg(text, ok) {
  const el = document.getElementById("wfMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("err", ok === false);
}

async function loadWorkflowTab() {
  if (!window.pywebview?.api?.get_workflow) return;
  try {
    const data = await window.pywebview.api.get_workflow();
    syncRenderPostChecks({ tiktok: !!data.copy_after_render });
  } catch (e) {}
}

async function pickWorkflowFile(create) {
  const path = await window.pywebview.api.pick_workflow_file(!!create);
  if (!path || path.error) return;
  document.getElementById(WF_IDS.file).value = path;
}

async function pickWorkflowFolder(inputId) {
  const path = await window.pywebview.api.pick_output_folder();
  if (path) document.getElementById(inputId).value = path;
}

async function openWorkflowFolder(inputId) {
  const path = document.getElementById(inputId).value;
  if (!path) return;
  await window.pywebview.api.open_folder(path);
}

async function saveWorkflowConfig() {
  const payload = {
    file: document.getElementById(WF_IDS.file).value.trim(),
    inbox: document.getElementById(WF_IDS.inbox).value.trim(),
    ready: document.getElementById(WF_IDS.ready).value.trim(),
    posted: document.getElementById(WF_IDS.posted).value.trim(),
    failed: document.getElementById(WF_IDS.failed).value.trim(),
    copy_after_render: document.getElementById(WF_IDS.copy).checked,
    download_auto_render: document.getElementById(WF_IDS.downloadAutoRender).checked,
    music_from_ready: document.getElementById(WF_IDS.music).checked,
    move_after_post: document.getElementById(WF_IDS.move).checked,
  };
  const result = await window.pywebview.api.save_workflow(payload);
  if (result && result.ok) {
    document.getElementById(WF_IDS.file).value = result.file || payload.file;
    wfSetStats(result.stats);
    wfMsg("Đã lưu file chung. Cấu hình thư mục Render / nguồn media cũ không đổi.", true);
    syncRenderPostChecks({ tiktok: !!payload.copy_after_render });
  } else {
    wfMsg((result && result.error) || "Lưu thất bại.", false);
  }
}

(function hookShowTab() {
  const orig = window.showTab;
  window.showTab = function (tabId) {
    if (tabId === "workflow") tabId = "download";
    if (typeof orig === "function") orig(tabId);
    else {
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabId);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.id === "tab_" + tabId);
      });
    }
    if (tabId === "workflow" || tabId === "download") loadDownloadQueues();
    if (tabId === "render") syncRenderPostFromConfig();
  };
})();

function syncRenderPostChecks(flags) {
  const tt = document.getElementById("RenderToTikTok");
  const fb = document.getElementById("RenderToFacebook");
  if (flags && "tiktok" in flags && tt && typeof setCheckbox === "function") setCheckbox(tt, !!flags.tiktok);
  if (flags && "facebook" in flags && fb && typeof setCheckbox === "function") setCheckbox(fb, !!flags.facebook);
}

async function syncRenderPostFromConfig() {
  if (!window.pywebview?.api) return;
  try {
    if (window.pywebview.api.get_workflow) {
      const wf = await window.pywebview.api.get_workflow();
      syncRenderPostChecks({ tiktok: !!wf.copy_after_render });
    }
    if (window.pywebview.api.get_fb_queue) {
      const fb = await window.pywebview.api.get_fb_queue();
      syncRenderPostChecks({ facebook: !!fb.enabled });
    }
  } catch (e) {}
}

async function persistTikTokFlag(on) {
  on = !!on;
  const copy = document.getElementById(WF_IDS.copy);
  if (copy) copy.checked = on;
  syncRenderPostChecks({ tiktok: on });
  if (!window.pywebview?.api?.get_workflow || !window.pywebview.api.save_workflow) return;
  const data = await window.pywebview.api.get_workflow();
  data.copy_after_render = on;
  await window.pywebview.api.save_workflow(data);
}

async function persistDataQueueFlag(on) {
  on = !!on;
  const box = document.getElementById("dataqEnabled");
  if (box) setCheckbox(box, on);
  if (!window.pywebview?.api?.get_data_queue || !window.pywebview.api.save_data_queue) return;
  try {
    const data = await window.pywebview.api.get_data_queue();
    data.enabled = on;
    await window.pywebview.api.save_data_queue(data);
  } catch (e) {}
}

async function persistFacebookFlag(on) {
  on = !!on;
  const box = document.getElementById("fbqEnabled");
  if (box) setCheckbox(box, on);
  syncRenderPostChecks({ facebook: on });
  if (!window.pywebview?.api?.get_fb_queue || !window.pywebview.api.save_fb_queue) return;
  try {
    const fb = await window.pywebview.api.get_fb_queue();
    fb.enabled = on;
    await window.pywebview.api.save_fb_queue(fb);
  } catch (e) {}
}

document.addEventListener("change", (e) => {
  const id = e.target && e.target.id;
  if (id === "RenderToTikTok" || id === "wfCopyAfterRender") {
    persistTikTokFlag(e.target.checked);
  }
  if (id === "dataqEnabled") {
    persistDataQueueFlag(e.target.checked);
  }
  if (id === "RenderToFacebook" || id === "fbqEnabled") {
    persistFacebookFlag(e.target.checked);
  }
});

window.addEventListener("pywebviewready", function () {
  if (typeof syncRenderPostFromConfig === "function") syncRenderPostFromConfig();
  const box = document.getElementById("dataqDownloadAutoRender");
  if (!box) return;
  box.addEventListener("change", async function () {
    box.dataset.userSet = "1";
    box.dataset.loaded = "1";
    try {
      await window.pywebview.api.set_download_auto_render(!!box.checked);
    } catch (e) {}
  });
  if (window.pywebview?.api?.get_data_queue) {
    window.pywebview.api.get_data_queue().then(function (data) {
      if (box.dataset.userSet === "1") return;
      setCheckbox(box, !!(data && data.download_auto_render));
      box.dataset.loaded = "1";
    }).catch(function () {});
  }
  const cropBox = document.getElementById("dataqRenderCrop");
  if (cropBox) {
    cropBox.addEventListener("change", async function () {
      cropBox.dataset.userSet = "1";
      cropBox.dataset.loaded = "1";
      try {
        await window.pywebview.api.set_render_crop(!!cropBox.checked);
      } catch (e) {}
    });
    if (window.pywebview?.api?.get_data_queue) {
      window.pywebview.api.get_data_queue().then(function (data) {
        if (cropBox.dataset.userSet === "1") return;
        setCheckbox(cropBox, !data || data.render_crop !== false);
        cropBox.dataset.loaded = "1";
      }).catch(function () {});
    }
  }
  const cutBox = document.getElementById("dataqRenderRandomCut");
  if (cutBox) {
    cutBox.addEventListener("change", async function () {
      cutBox.dataset.userSet = "1";
      cutBox.dataset.loaded = "1";
      try {
        await window.pywebview.api.set_render_random_cut(!!cutBox.checked);
      } catch (e) {}
    });
    if (window.pywebview?.api?.get_data_queue) {
      window.pywebview.api.get_data_queue().then(function (data) {
        if (cutBox.dataset.userSet === "1") return;
        setCheckbox(cutBox, !!(data && data.render_random_cut));
        cutBox.dataset.loaded = "1";
      }).catch(function () {});
    }
  }
  const colorBox = document.getElementById("dataqRenderColor");
  if (colorBox) {
    colorBox.addEventListener("change", async function () {
      colorBox.dataset.userSet = "1";
      colorBox.dataset.loaded = "1";
      try {
        await window.pywebview.api.set_render_color(!!colorBox.checked);
      } catch (e) {}
    });
    if (window.pywebview?.api?.get_data_queue) {
      window.pywebview.api.get_data_queue().then(function (data) {
        if (colorBox.dataset.userSet === "1") return;
        setCheckbox(colorBox, !!(data && data.render_color));
        colorBox.dataset.loaded = "1";
      }).catch(function () {});
    }
  }
  const volumeBox = document.getElementById("dataqRenderVolume");
  if (volumeBox) {
    volumeBox.addEventListener("change", async function () {
      volumeBox.dataset.userSet = "1";
      volumeBox.dataset.loaded = "1";
      try {
        await window.pywebview.api.set_render_volume(!!volumeBox.checked);
      } catch (e) {}
    });
    if (window.pywebview?.api?.get_data_queue) {
      window.pywebview.api.get_data_queue().then(function (data) {
        if (volumeBox.dataset.userSet === "1") return;
        setCheckbox(volumeBox, !!(data && data.render_volume));
        volumeBox.dataset.loaded = "1";
      }).catch(function () {});
    }
  }
  const twoScreenBox = document.getElementById("dataqRenderTwoScreen");
  if (twoScreenBox) {
    twoScreenBox.addEventListener("change", async function () {
      twoScreenBox.dataset.userSet = "1";
      twoScreenBox.dataset.loaded = "1";
      try {
        await window.pywebview.api.set_render_two_screen(!!twoScreenBox.checked);
      } catch (e) {}
    });
  }
  const highlightVolumeBox = document.getElementById("dataqHighlightVolume");
  if (highlightVolumeBox) {
    highlightVolumeBox.addEventListener("change", async function () {
      highlightVolumeBox.dataset.userSet = "1";
      highlightVolumeBox.dataset.loaded = "1";
      try {
        await window.pywebview.api.set_highlight_volume(!!highlightVolumeBox.checked);
      } catch (e) {}
    });
  }
});

function fbqMsg(text, ok) {
  const el = document.getElementById("fbqMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("err", ok === false);
}

function fbqAccountLine(ok) {
  fbqMsg(ok ? "Đã kết nối tài khoản." : "Chưa kết nối tài khoản.", !!ok);
}

function fbqSetStats(stats) {
  const s = stats || {};
  const map = [
    ["fbqPending", s.pending],
    ["fbqClaimed", s.claimed],
    ["fbqPosting", s.posting],
    ["fbqPosted", s.posted],
    ["fbqFailed", s.failed],
  ];
  map.forEach(([id, n]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n ?? 0);
  });
}

function sharedOauthValue() {
  const el = document.getElementById("dataqOauth");
  return el ? el.value.trim() : "";
}

function fillSharedOauth(path, overwrite) {
  const el = document.getElementById("dataqOauth");
  if (!el) return;
  const next = String(path || "");
  if (overwrite || !el.value.trim()) el.value = next;
}

async function mirrorSharedOauth(skip) {
  const oauth = sharedOauthValue();
  if (!oauth || !window.pywebview?.api) return;
  try {
    if (skip !== "fb" && window.pywebview.api.get_fb_queue && window.pywebview.api.save_fb_queue) {
      const fb = await window.pywebview.api.get_fb_queue();
      if ((fb.oauth_json || "") !== oauth) {
        fb.oauth_json = oauth;
        await window.pywebview.api.save_fb_queue(fb);
      }
    }
    if (skip !== "data" && window.pywebview.api.get_data_queue && window.pywebview.api.save_data_queue) {
      const data = await window.pywebview.api.get_data_queue();
      if ((data.oauth_json || "") !== oauth) {
        data.oauth_json = oauth;
        await window.pywebview.api.save_data_queue(data);
      }
    }
  } catch (e) {}
}

let fbqWorkerId = "studio";

function fbqPayload() {
  const enabled = document.getElementById("fbqEnabled");
  return {
    enabled: !!(enabled && enabled.checked),
    oauth_json: sharedOauthValue(),
    folder_id: document.getElementById("fbqFolder").value.trim(),
    spreadsheet_id: document.getElementById("fbqSheet").value.trim(),
    sheet_name: "jobs",
    worker_id: fbqWorkerId || "studio",
  };
}

async function loadFbQueueTab() {
  fbqMsg("");
  if (!window.pywebview?.api?.get_fb_queue) return;
  try {
    const data = await window.pywebview.api.get_fb_queue();
    const enabled = document.getElementById("fbqEnabled");
    if (enabled) setCheckbox(enabled, !!data.enabled);
    fillSharedOauth(data.oauth_json || "", false);
    document.getElementById("fbqFolder").value = data.folder_id || "";
    document.getElementById("fbqSheet").value = data.spreadsheet_id || "";
    fbqWorkerId = data.worker_id || "studio";
    const link = document.getElementById("fbqSheetLink");
    if (link) {
      link.href = data.sheet_url || "#";
      link.style.display = data.sheet_url ? "" : "none";
    }
    fbqSetStats(data.stats);
    syncRenderPostChecks({ facebook: !!data.enabled });
    const account = await window.pywebview.api.account_fb_queue();
    fbqAccountLine(!!(account && account.ok));
  } catch (e) {
    fbqAccountLine(false);
  }
}

async function pickFbOauth() {
  await pickDataOauth();
}

async function saveFbQueueConfig() {
  const result = await window.pywebview.api.save_fb_queue(fbqPayload());
  if (result && result.ok) {
    syncRenderPostChecks({ facebook: !!(document.getElementById("fbqEnabled") && document.getElementById("fbqEnabled").checked) });
  }
  await mirrorSharedOauth("fb");
  const account = await window.pywebview.api.account_fb_queue();
  fbqAccountLine(!!(account && account.ok));
}

function sharedOauthMsg(text, ok) {
  const el = document.getElementById("sharedOauthMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("err", ok === false);
}

async function connectSharedOauth() {
  const oauth = sharedOauthValue();
  if (!oauth) {
    sharedOauthMsg("Chưa chọn file OAuth JSON.", false);
    return;
  }
  sharedOauthMsg("Đang kết nối…", true);
  try {
    const dataPayload = dataqPayload();
    const fbPayload = fbqPayload();
    if (!dataPayload.spreadsheet_id) delete dataPayload.spreadsheet_id;
    if (!fbPayload.spreadsheet_id) delete fbPayload.spreadsheet_id;
    await window.pywebview.api.save_data_queue(dataPayload);
    await window.pywebview.api.save_fb_queue(fbPayload);
    const result = await window.pywebview.api.connect_shared_oauth();
    const ok = !!(result && result.ok);
    sharedOauthMsg(ok ? "Đã kết nối tài khoản." : ((result && result.error) || "Kết nối lỗi."), ok);
    dataqAccountLine(ok);
    fbqAccountLine(ok);
  } catch (e) {
    sharedOauthMsg(String((e && e.message) || e), false);
  }
}

async function connectFbQueue() {
  await connectSharedOauth();
}

async function initFbSheet() {
  fbqMsg("Đang khởi tạo Sheet…", true);
  try {
    await window.pywebview.api.save_fb_queue(fbqPayload());
    const result = await window.pywebview.api.init_fb_sheet();
    if (result && result.ok && result.spreadsheet_id) {
      document.getElementById("fbqSheet").value = result.spreadsheet_id;
      const link = document.getElementById("fbqSheetLink");
      if (link) {
        link.href = "https://docs.google.com/spreadsheets/d/" + result.spreadsheet_id + "/edit";
        link.style.display = "";
      }
      fbqMsg("Đã khởi tạo Sheet.", true);
      return;
    }
    fbqMsg((result && result.error) || "Khởi tạo Sheet lỗi.", false);
  } catch (e) {
    fbqMsg(String((e && e.message) || e), false);
  }
}

async function refreshFbQueueStats() {
  await window.pywebview.api.save_fb_queue(fbqPayload());
  const result = await window.pywebview.api.refresh_fb_queue_stats();
  if (result && result.ok) fbqSetStats(result.stats);
  const account = await window.pywebview.api.account_fb_queue();
  fbqAccountLine(!!(account && account.ok));
}

function dataqMsg(text, ok) {
  const el = document.getElementById("dataqMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("err", ok === false);
}

function dataqAccountLine(ok) {
  dataqMsg(ok ? "Đã kết nối tài khoản." : "Chưa kết nối tài khoản.", !!ok);
}

function dataqSetStats(stats) {
  const s = stats || {};
  [
    ["dataqPending", s.pending],
    ["dataqClaimed", s.claimed],
    ["dataqPosting", s.posting],
    ["dataqPosted", s.posted],
    ["dataqFailed", s.failed],
  ].forEach(([id, n]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n ?? 0);
  });
}

function dataqPayload() {
  return {
    enabled: document.getElementById("dataqEnabled").checked,
    download_auto_render: document.getElementById("dataqDownloadAutoRender").checked,
    render_crop: document.getElementById("dataqRenderCrop").checked,
    render_random_cut: document.getElementById("dataqRenderRandomCut").checked,
    render_color: document.getElementById("dataqRenderColor").checked,
    render_volume: document.getElementById("dataqRenderVolume").checked,
    render_highlight: !!(document.getElementById("dataqRenderHighlight") && document.getElementById("dataqRenderHighlight").checked),
    render_two_screen: !!(document.getElementById("dataqRenderTwoScreen") && document.getElementById("dataqRenderTwoScreen").checked),
    highlight_volume: !!(document.getElementById("dataqHighlightVolume") && document.getElementById("dataqHighlightVolume").checked),
    highlight_score: typeof highlightScore === "function" ? highlightScore() : 0.5,
    highlight_seconds: typeof highlightSeconds === "function" ? highlightSeconds() : 60,
    oauth_json: sharedOauthValue(),
    folder_id: document.getElementById("dataqFolder").value.trim(),
    spreadsheet_id: document.getElementById("dataqSheet").value.trim(),
    sheet_name: "data",
  };
}

async function loadDataQueueTab() {
  dataqMsg("");
  if (!window.pywebview?.api?.get_data_queue) return;
  try {
    const data = await window.pywebview.api.get_data_queue();
    setCheckbox(document.getElementById("dataqEnabled"), !!data.enabled);
    setCheckbox(document.getElementById("dataqDownloadAutoRender"), !!data.download_auto_render);
    document.getElementById("dataqDownloadAutoRender").dataset.loaded = "1";
    const cropBox = document.getElementById("dataqRenderCrop");
    if (cropBox && cropBox.dataset.userSet !== "1") {
      setCheckbox(cropBox, data.render_crop !== false);
      cropBox.dataset.loaded = "1";
    }
    const cutBox = document.getElementById("dataqRenderRandomCut");
    if (cutBox && cutBox.dataset.userSet !== "1") {
      setCheckbox(cutBox, !!data.render_random_cut);
      cutBox.dataset.loaded = "1";
    }
    const colorBox = document.getElementById("dataqRenderColor");
    if (colorBox && colorBox.dataset.userSet !== "1") {
      setCheckbox(colorBox, !!data.render_color);
      colorBox.dataset.loaded = "1";
    }
    const volumeBox = document.getElementById("dataqRenderVolume");
    if (volumeBox && volumeBox.dataset.userSet !== "1") {
      setCheckbox(volumeBox, !!data.render_volume);
      volumeBox.dataset.loaded = "1";
    }
    const highlightBox = document.getElementById("dataqRenderHighlight");
    if (highlightBox && highlightBox.dataset.userSet !== "1") {
      setCheckbox(highlightBox, !!data.render_highlight);
      highlightBox.dataset.loaded = "1";
    }
    const twoScreenBox = document.getElementById("dataqRenderTwoScreen");
    if (twoScreenBox && twoScreenBox.dataset.userSet !== "1") {
      setCheckbox(twoScreenBox, !!data.render_two_screen);
      twoScreenBox.dataset.loaded = "1";
    }
    const highlightVolumeBox = document.getElementById("dataqHighlightVolume");
    if (highlightVolumeBox && highlightVolumeBox.dataset.userSet !== "1") {
      setCheckbox(highlightVolumeBox, !!data.highlight_volume);
      highlightVolumeBox.dataset.loaded = "1";
    }
    const secondsBox = document.getElementById("dataqHighlightSeconds");
    if (secondsBox && secondsBox.dataset.userSet !== "1") {
      let seconds = parseInt(data.highlight_seconds, 10);
      if (!seconds || seconds < 1) seconds = 60;
      if (seconds > 600) seconds = 600;
      secondsBox.value = String(seconds);
    }
    const scoreBox = document.getElementById("dataqHighlightScore");
    if (scoreBox && scoreBox.dataset.userSet !== "1") {
      let score = parseFloat(data.highlight_score);
      if (!score || score < 0.1) score = 0.5;
      if (score > 1) score = 1;
      score = Math.round(score * 10) / 10;
      scoreBox.value = score.toFixed(1);
    }
    if (typeof syncHighlightPanel === "function") syncHighlightPanel();
    fillSharedOauth(data.oauth_json || "", true);
    document.getElementById("dataqFolder").value = data.folder_id || "";
    document.getElementById("dataqSheet").value = data.spreadsheet_id || "";
    const link = document.getElementById("dataqSheetLink");
    if (link) {
      link.href = data.sheet_url || "#";
      link.style.display = data.sheet_url ? "" : "none";
    }
    dataqSetStats(data.stats);
    const account = await window.pywebview.api.account_data_queue();
    dataqAccountLine(!!(account && account.ok));
  } catch (e) {
    dataqAccountLine(false);
  }
}

async function pickDataOauth() {
  const path = await window.pywebview.api.pick_oauth_json();
  if (!path || path.error) return;
  document.getElementById("dataqOauth").value = path;
}

async function loadDownloadQueues() {
  await loadDataQueueTab();
  await loadFbQueueTab();
}

async function saveDataQueueConfig() {
  await window.pywebview.api.save_data_queue(dataqPayload());
  await mirrorSharedOauth("data");
  const account = await window.pywebview.api.account_data_queue();
  dataqAccountLine(!!(account && account.ok));
}

async function connectDataQueue() {
  await connectSharedOauth();
}

async function initDataSheet() {
  dataqMsg("Đang khởi tạo Sheet…", true);
  try {
    await window.pywebview.api.save_data_queue(dataqPayload());
    const result = await window.pywebview.api.init_data_sheet();
    if (result && result.ok && result.spreadsheet_id) {
      document.getElementById("dataqSheet").value = result.spreadsheet_id;
      await loadDataQueueTab();
      dataqMsg("Đã khởi tạo Sheet.", true);
      return;
    }
    dataqMsg((result && result.error) || "Khởi tạo Sheet lỗi.", false);
  } catch (e) {
    dataqMsg(String((e && e.message) || e), false);
  }
}

async function refreshDataQueueStats() {
  await window.pywebview.api.save_data_queue(dataqPayload());
  const result = await window.pywebview.api.refresh_data_queue_stats();
  if (result && result.ok) dataqSetStats(result.stats);
  const account = await window.pywebview.api.account_data_queue();
  dataqAccountLine(!!(account && account.ok));
}
