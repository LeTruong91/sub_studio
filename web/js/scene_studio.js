let flowState = null;
let flowLive = {};
let flowTimer = 0;
let flowLoaded = false;

function flowMsg(text, ok) {
  const el = document.getElementById("flowMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-ok", !!ok);
  el.classList.toggle("is-err", ok === false);
}

function escapeFlow(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function flowChipClass(text) {
  if (text === "Xong") return "is-ok";
  if (text === "Đang sinh" || text === "Đang chờ") return "is-run";
  if (text === "Lỗi") return "is-err";
  return "";
}

function blankFlow() {
  return {
    agent_dir: "",
    flow_project_id: "",
    project_id: "",
    video_id: "",
    name: "",
    story: "",
    material: "realistic",
    language: "vi",
    orientation: "VERTICAL",
    entities: [],
    scenes: [],
  };
}

function readFlowDom() {
  const prev = flowState || blankFlow();
  const entities = [...document.querySelectorAll("#flowEntities .scene-row")].map((row) => {
    const id = row.dataset.id;
    const old = (prev.entities || []).find((item) => item.id === id) || {};
    return {
      id,
      name: row.querySelector("[data-field=name]")?.value || "",
      kind: row.querySelector("[data-field=kind]")?.value || "character",
      appearance: row.querySelector("[data-field=appearance]")?.value || "",
      character_id: old.character_id || "",
    };
  });
  const scenes = [...document.querySelectorAll("#flowScenes .scene-card")].map((row) => {
    const id = row.dataset.id;
    const old = (prev.scenes || []).find((item) => item.id === id) || {};
    const entityIds = [...row.querySelectorAll("input[data-entity]:checked")].map((box) => box.dataset.entity);
    return {
      id,
      prompt: row.querySelector("[data-field=prompt]")?.value || "",
      entity_ids: entityIds,
      scene_id: old.scene_id || "",
    };
  });
  flowState = {
    agent_dir: document.getElementById("flowAgentDir")?.value || prev.agent_dir || "",
    flow_project_id: document.getElementById("flowProjectPin")?.value || "",
    project_id: prev.project_id || "",
    video_id: prev.video_id || "",
    name: document.getElementById("flowName")?.value || "",
    story: document.getElementById("flowStory")?.value || "",
    material: document.getElementById("flowMaterial")?.value || "realistic",
    language: document.getElementById("flowLanguage")?.value || "vi",
    orientation: document.getElementById("flowOrient")?.value || "VERTICAL",
    entities,
    scenes,
  };
  return flowState;
}

function setFlowValue(id, value) {
  const el = document.getElementById(id);
  if (!el || document.activeElement === el) return;
  el.value = value || "";
}

function renderFlow() {
  const state = flowState || blankFlow();
  setFlowValue("flowAgentDir", state.agent_dir);
  setFlowValue("flowProjectPin", state.flow_project_id);
  setFlowValue("flowName", state.name);
  setFlowValue("flowStory", state.story);
  setFlowValue("flowMaterial", state.material);
  setFlowValue("flowLanguage", state.language);
  setFlowValue("flowOrient", state.orientation);
  const entities = document.getElementById("flowEntities");
  const scenes = document.getElementById("flowScenes");
  if (!entities || !scenes) return;
  entities.innerHTML = state.entities.map((row) => `
    <div class="scene-row" data-id="${escapeFlow(row.id)}">
      <div class="scene-row-top">
        <input data-field="name" value="${escapeFlow(row.name)}" placeholder="Tên">
        <select data-field="kind">
          <option value="character"${row.kind === "character" ? " selected" : ""}>Nhân vật</option>
          <option value="location"${row.kind === "location" ? " selected" : ""}>Địa điểm</option>
          <option value="prop"${row.kind === "prop" ? " selected" : ""}>Đạo cụ</option>
        </select>
        <span class="flow-chip" data-chip="entity" data-id="${escapeFlow(row.id)}">Chưa sinh</span>
        <div class="scene-row-actions">
          <button type="button" class="rs-btn rs-btn-ghost" onclick="regenFlow('character','${escapeFlow(row.id)}')">Tạo lại ảnh</button>
          <button type="button" class="rs-btn rs-btn-ghost" onclick="removeFlowEntity('${escapeFlow(row.id)}')">Xóa</button>
        </div>
      </div>
      <textarea data-field="appearance" placeholder="Ngoại hình, chỉ viết một lần">${escapeFlow(row.appearance)}</textarea>
    </div>
  `).join("") || `<p class="scene-hint">Chưa có nhân vật, địa điểm hay đạo cụ.</p>`;
  scenes.innerHTML = state.scenes.map((row, index) => {
    const refs = state.entities.filter((item) => item.name).map((item) => `
      <label>
        <input type="checkbox" data-entity="${escapeFlow(item.id)}"${row.entity_ids.includes(item.id) ? " checked" : ""}>
        ${escapeFlow(item.name)}
      </label>
    `).join("");
    return `
      <div class="scene-card" data-id="${escapeFlow(row.id)}">
        <div class="scene-head">
          <strong>Cảnh ${index + 1}</strong>
          <span class="flow-chip" data-chip="image" data-id="${escapeFlow(row.id)}">Ảnh: chưa sinh</span>
          <span class="flow-chip" data-chip="video" data-id="${escapeFlow(row.id)}">Clip: chưa sinh</span>
          <div class="scene-row-actions">
            <button type="button" class="rs-btn rs-btn-ghost" onclick="moveFlowScene('${escapeFlow(row.id)}',-1)">Lên</button>
            <button type="button" class="rs-btn rs-btn-ghost" onclick="moveFlowScene('${escapeFlow(row.id)}',1)">Xuống</button>
            <button type="button" class="rs-btn rs-btn-ghost" onclick="regenFlow('image','${escapeFlow(row.id)}')">Tạo lại ảnh</button>
            <button type="button" class="rs-btn rs-btn-ghost" onclick="regenFlow('video','${escapeFlow(row.id)}')">Tạo lại clip</button>
            <button type="button" class="rs-btn rs-btn-ghost" onclick="removeFlowScene('${escapeFlow(row.id)}')">Xóa</button>
          </div>
        </div>
        <textarea data-field="prompt" placeholder="Hành động của cảnh, gọi đúng tên tham chiếu">${escapeFlow(row.prompt)}</textarea>
        <div class="scene-refs">${refs || `<span class="scene-hint">Chưa có tên tham chiếu để chọn.</span>`}</div>
      </div>
    `;
  }).join("") || `<p class="scene-hint">Chưa có cảnh.</p>`;
  paintFlowStatus();
}

function paintFlowStatus() {
  const live = flowLive || {};
  const agent = document.getElementById("flowAgentLine");
  if (agent) {
    const agentText = live.agent_running ? "Agent đang chạy" : "Agent chưa chạy";
    const extText = live.extension_connected ? "Extension đã nối" : "Extension chưa nối";
    const project = flowState?.project_id ? `Project ${flowState.project_id}` : "Chưa đồng bộ project";
    agent.textContent = `${agentText}. ${extText}. ${project}.`;
  }
  const ready = document.getElementById("flowReady");
  if (ready) ready.textContent = live.ready || "Chưa chọn thư mục Ready";
  const jobs = document.getElementById("flowJobs");
  if (jobs) {
    const box = live.jobs || {};
    jobs.textContent = `chờ ${box.pending || 0}, đang sinh ${box.processing || 0}, lỗi ${box.failed || 0}, xong ${box.completed || 0}`;
  }
  document.querySelectorAll("[data-chip=entity]").forEach((el) => {
    const chip = (live.entities || {})[el.dataset.id] || {};
    const text = chip.text || "Chưa sinh";
    el.textContent = text;
    el.title = chip.error || "";
    el.className = "flow-chip " + flowChipClass(text);
  });
  document.querySelectorAll("[data-chip=image]").forEach((el) => {
    const chip = (live.scenes || {})[el.dataset.id] || {};
    const text = chip.image || "Chưa sinh";
    el.textContent = "Ảnh: " + text;
    el.title = chip.image_error || "";
    el.className = "flow-chip " + flowChipClass(text);
  });
  document.querySelectorAll("[data-chip=video]").forEach((el) => {
    const chip = (live.scenes || {})[el.dataset.id] || {};
    const text = chip.video || "Chưa sinh";
    el.textContent = "Clip: " + text;
    el.title = chip.video_error || "";
    el.className = "flow-chip " + flowChipClass(text);
  });
}

async function loadSceneStudio() {
  const api = window.pywebview?.api;
  if (!flowLoaded && api?.flowkit_get) {
    try {
      const data = await api.flowkit_get();
      if (data?.draft) flowState = data.draft;
      if (data) flowLive = data;
      if (data && data.ok === false) flowMsg(data.error || "Không tải được Flow Kit.", false);
    } catch (err) {
      flowMsg(String(err || "Không tải được Flow Kit."), false);
    }
    flowLoaded = true;
  } else if (document.getElementById("flowName")) {
    readFlowDom();
  }
  renderFlow();
  if (!flowTimer) flowTimer = setInterval(pollFlow, 4000);
}

async function pollFlow() {
  if (!document.getElementById("tab_scene")?.classList.contains("active")) return;
  const api = window.pywebview?.api;
  if (!api?.flowkit_status) return;
  try {
    const live = await api.flowkit_status();
    if (!live || live.ok === false) return;
    flowLive = live;
    paintFlowStatus();
  } catch (err) {
    /* Agent có thể tắt. Lần poll sau sẽ cập nhật. */
  }
}

function applyFlowResult(result, okText) {
  if (!result || result.ok === false) {
    flowMsg(result?.error || "Flow Kit không thực hiện được.", false);
    return false;
  }
  if (result.draft) flowState = result.draft;
  flowLive = result;
  renderFlow();
  const notes = (result.notes || []).filter(Boolean);
  if (okText || notes.length) {
    flowMsg([okText, notes.join(" ")].filter(Boolean).join(" "), notes.length === 0);
  }
  return true;
}

async function saveFlowDraft() {
  const api = window.pywebview?.api;
  if (!api?.flowkit_save) {
    flowMsg("Mở trong ứng dụng Sub Studio để lưu.", false);
    return null;
  }
  readFlowDom();
  const result = await api.flowkit_save(flowState);
  if (!result?.ok) {
    flowMsg(result?.error || "Không lưu được.", false);
    return null;
  }
  flowState = result.draft || flowState;
  renderFlow();
  flowMsg("Đã lưu nháp.", true);
  return flowState;
}

async function pickFlowAgent() {
  const api = window.pywebview?.api;
  if (!api?.flowkit_pick_agent) return;
  const picked = await api.flowkit_pick_agent();
  if (!picked?.path) return;
  if (!flowState) flowState = blankFlow();
  flowState.agent_dir = picked.path;
  const input = document.getElementById("flowAgentDir");
  if (input) input.value = picked.path;
  await saveFlowDraft();
}

async function startFlowAgent() {
  const api = window.pywebview?.api;
  if (!api?.flowkit_start) return;
  readFlowDom();
  const saved = await api.flowkit_save(flowState);
  if (!saved?.ok) {
    flowMsg(saved?.error || "Không lưu được thư mục agent.", false);
    return;
  }
  flowState = saved.draft || flowState;
  flowMsg("Đang mở agent...", true);
  const result = await api.flowkit_start();
  if (!result?.ok) {
    flowMsg(result?.error || "Không mở được agent.", false);
    return;
  }
  flowMsg(result.already ? "Agent đã chạy." : "Đã mở agent.", true);
  await pollFlow();
}

async function syncFlow() {
  const api = window.pywebview?.api;
  if (!api?.flowkit_sync) return;
  readFlowDom();
  flowMsg("Đang đồng bộ...", true);
  const result = await api.flowkit_sync(flowState);
  applyFlowResult(result, "Đã đồng bộ sang Flow Kit.");
}

async function enqueueFlow(stage) {
  const api = window.pywebview?.api;
  if (!api?.flowkit_enqueue) return;
  readFlowDom();
  const saved = await api.flowkit_save(flowState);
  if (!saved?.ok) {
    flowMsg(saved?.error || "Không lưu được.", false);
    return;
  }
  flowState = saved.draft || flowState;
  const result = await api.flowkit_enqueue(stage);
  const label = stage === "refs" ? "Đã xếp hàng ảnh tham chiếu." : stage === "images" ? "Đã xếp hàng ảnh cảnh." : "Đã xếp hàng clip.";
  applyFlowResult(result, result?.queued ? label : "Không có mục nào cần sinh.");
}

async function regenFlow(kind, localId) {
  const api = window.pywebview?.api;
  if (!api?.flowkit_regen) return;
  readFlowDom();
  await api.flowkit_save(flowState);
  const result = await api.flowkit_regen(kind, localId);
  applyFlowResult(result, "Đã xếp hàng tạo lại.");
}

async function exportFlow() {
  const api = window.pywebview?.api;
  if (!api?.flowkit_export) return;
  flowMsg("Đang ghép clip...", true);
  const result = await api.flowkit_export();
  if (!result?.ok) {
    flowMsg(result?.error || "Không ghép được.", false);
    return;
  }
  flowMsg("Đã đưa vào Ready: " + (result.path || ""), true);
}

async function forgetFlowProject() {
  const api = window.pywebview?.api;
  if (!api?.flowkit_forget) return;
  readFlowDom();
  const saved = await api.flowkit_save(flowState);
  if (!saved?.ok) {
    flowMsg(saved?.error || "Không lưu được.", false);
    return;
  }
  flowState = saved.draft || flowState;
  const result = await api.flowkit_forget();
  applyFlowResult(result, "Đã tách nháp khỏi project cũ. Bấm Đồng bộ để tạo project mới.");
}

function addFlowEntity() {
  readFlowDom();
  flowState.entities.push({
    id: "en" + Date.now().toString(36),
    name: "",
    kind: "character",
    appearance: "",
    character_id: "",
  });
  renderFlow();
}

async function removeFlowEntity(id) {
  readFlowDom();
  const row = flowState.entities.find((item) => item.id === id);
  if (row?.character_id && window.pywebview?.api?.flowkit_remove) {
    const result = await window.pywebview.api.flowkit_remove("character", row.character_id);
    if (!result?.ok) {
      flowMsg(result?.error || "Chưa xóa được trên Flow Kit.", false);
      return;
    }
  }
  flowState.entities = flowState.entities.filter((item) => item.id !== id);
  flowState.scenes.forEach((scene) => {
    scene.entity_ids = scene.entity_ids.filter((item) => item !== id);
  });
  renderFlow();
  await saveFlowDraft();
}

function addFlowScene() {
  readFlowDom();
  flowState.scenes.push({
    id: "sc" + Date.now().toString(36),
    prompt: "",
    entity_ids: [],
    scene_id: "",
  });
  renderFlow();
}

async function removeFlowScene(id) {
  readFlowDom();
  const row = flowState.scenes.find((item) => item.id === id);
  if (row?.scene_id && window.pywebview?.api?.flowkit_remove) {
    const result = await window.pywebview.api.flowkit_remove("scene", row.scene_id);
    if (!result?.ok) {
      flowMsg(result?.error || "Chưa xóa được cảnh trên Flow Kit.", false);
      return;
    }
  }
  flowState.scenes = flowState.scenes.filter((item) => item.id !== id);
  renderFlow();
  await saveFlowDraft();
}

function moveFlowScene(id, step) {
  readFlowDom();
  const index = flowState.scenes.findIndex((item) => item.id === id);
  const next = index + step;
  if (index < 0 || next < 0 || next >= flowState.scenes.length) return;
  const rows = flowState.scenes;
  const [row] = rows.splice(index, 1);
  rows.splice(next, 0, row);
  renderFlow();
}
