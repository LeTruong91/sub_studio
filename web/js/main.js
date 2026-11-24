

const wave = document.getElementById('wave');
  for(let i=0;i<28;i++){
    const bar = document.createElement('span');
    bar.style.animationDelay = (i*0.045)+'s';
    wave.appendChild(bar);
  }

let selectedFilePath = null;
let cloneAudioPath = null;
let lastOutputDir = null;
let selectedFiles = [];
let _genBatchWaiter = null; 
const _originalOnBackendEvent = window.onBackendEvent;   
async function pickFileSub(){
  console.log("pickFileSub() called");
  if(!window.pywebview) return;

  const info = await window.pywebview.api.pick_files();
  console.log("Picked file info:", info);
  if(!info || info.length === 0) return;

  const seenPaths = new Set(selectedFiles.map(f => f.path.toLowerCase()));
  let addedCount = 0;
  info.forEach(f => {
    if (!seenPaths.has(f.path.toLowerCase())) {
      seenPaths.add(f.path.toLowerCase());
      selectedFiles.push(f);
      addedCount++;
    }
  });
  if (addedCount === 0) return;

  document.getElementById('dropzone').classList.add('has-file');
  document.getElementById('dzEmpty').style.display = 'none';

  renderFileList();

  loadContentEditor();

  document.getElementById('sumFile').textContent =
    selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles.length} file`;
  document.getElementById('sumFile').classList.remove('muted');

  addStatusMessage(`📁 Đã chọn ${selectedFiles.length} file: ` + selectedFiles.map(f => f.name).join(', '), 'info');
}

function renderFileList(){
  const listEl = document.getElementById('dzFilledList');

  if (selectedFiles.length === 0){
    listEl.style.display = 'none';
    listEl.innerHTML = '';
    document.getElementById('dzEmpty').style.display = 'flex';
    syncFileActionButtons();
    document.getElementById('dropzone').classList.remove('has-file');
    return;
  }
  syncFileActionButtons();
  listEl.style.display = 'flex';
  listEl.innerHTML = selectedFiles.map((f, i) => renderFileRow(f, i)).join('');
}

function syncFileActionButtons(){
  const del = document.getElementById('btnDeleteAllFiles');
  const exp = document.getElementById('btnExpandFileList');
  const listEl = document.getElementById('dzFilledList');
  if (del) del.disabled = selectedFiles.length === 0;
  if (exp) {
    exp.disabled = selectedFiles.length <= 1;
    if (selectedFiles.length <= 1 && listEl.classList.contains('expanded')) {
      listEl.classList.remove('expanded');
      exp.classList.remove('open');
      exp.title = 'Xem toàn bộ danh sách';
    }
  }
}

function toggleFileListExpand(event){
  if (event) event.stopPropagation();
  const listEl = document.getElementById('dzFilledList');
  const btn = document.getElementById('btnExpandFileList');
  const open = listEl.classList.toggle('expanded');
  btn.classList.toggle('open', open);
  btn.title = open ? 'Thu gọn danh sách' : 'Xem toàn bộ danh sách';
}

function clearOneFile(event, index){
  event.stopPropagation();
  selectedFiles.splice(index, 1);
  if (index < _activeFileIndex) _activeFileIndex--;
  else if (index === _activeFileIndex) _activeFileIndex = Math.min(_activeFileIndex, selectedFiles.length - 1);
  if (_activeFileIndex < 0) _activeFileIndex = 0;
  renderFileList();
  loadContentEditor();

  if (selectedFiles.length === 0){
    document.getElementById('sumFile').textContent = 'Chưa chọn file';
    document.getElementById('sumFile').classList.add('muted');
  } else {
    document.getElementById('sumFile').textContent =
      selectedFiles.length === 1 ? selectedFiles[0].name : `${selectedFiles.length} file`;
  }
}

function clearFile(event){
  event.stopPropagation();
   showConfirm("Bạn có chắc muốn xóa tất cả file sub?", () => {

      selectedFiles = [];
      _activeFileIndex = 0;
      renderFileList();
      loadContentEditor();
      document.getElementById('sumFile').textContent = 'Chưa chọn file';
      document.getElementById('sumFile').classList.add('muted');
    })

}
function renderFileRow(file, index){
  return `
    <div class="dz-file-row${index === _activeFileIndex ? ' active' : ''}" style="display:flex;align-items:center;width:100%;gap:12px;" data-index="${index}" onclick="selectEditorFile(event, ${index})">
      <div class="dz-icon">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8l-5-5z" stroke="currentColor" stroke-width="1.5" />
          <path d="M13 3v5h5" stroke="currentColor" stroke-width="1.5" />
        </svg>
      </div>
      <div style="flex:1;min-width:0;">
        <div class="dz-file-name">${file.name}</div>
        <div class="dz-file-meta">${file.size_kb ? file.size_kb + ' KB' : ''}</div>
      </div>
      <button type="button" class="dz-clear" onclick="clearOneFile(event, ${index})">Xóa</button>
    </div>
  `;
}
/* ===== Ô nội dung + chip cảm xúc (kiểu VieNeu) ===== */
let _contentEditorFile = null;
let _activeFileIndex = 0;
let _contentSaveTimer = null;
let _contentEditorBound = false;
let _freeText = '';

function updateCharCount(){
  const editor = document.getElementById('contentEditor');
  const n = editor ? editor.value.length : 0;
  const cc = document.getElementById('charCount');
  if(cc) cc.textContent = n + ' ký tự';
}

async function loadContentEditor(){
  const wrap = document.getElementById('contentEditorWrap');
  const editor = document.getElementById('contentEditor');
  const saved = document.getElementById('contentEditorSaved');
  const chips = document.querySelectorAll('.emotion-chip');
  if(!wrap || !editor) return;
  if(!_contentEditorBound){
    _contentEditorBound = true;
    editor.addEventListener('input', scheduleContentSave);
  }
  if(!selectedFiles || selectedFiles.length === 0){
    _contentEditorFile = null;
    editor.value = _freeText || '';
    chips.forEach(c => c.disabled = false);
    document.getElementById('contentEditorFile').textContent = '-';
    if(saved) saved.textContent = '';
    updateCharCount();
    return;
  }
  if (_activeFileIndex >= selectedFiles.length) _activeFileIndex = Math.max(0, selectedFiles.length - 1);
  const file = selectedFiles[_activeFileIndex];
  _contentEditorFile = file;
  chips.forEach(c => c.disabled = false);
  document.getElementById('contentEditorFile').textContent = file.name;
  if(saved) saved.textContent = 'Đang tải…';
  if(!window.pywebview){
    editor.value = '';
    if(saved) saved.textContent = 'Chưa kết nối app';
    updateCharCount();
    return;
  }
  try{
    const res = await window.pywebview.api.read_text_file(file.path);
    if(res && res.ok){
      editor.value = res.text || '';
      if(saved) saved.textContent = '';
    } else {
      editor.value = '';
      if(saved) saved.textContent = 'Không đọc được file: ' + (res && res.error ? res.error : '');
    }
  }catch(e){
    if(saved) saved.textContent = 'Không đọc được file.';
  }
  updateCharCount();
}

function selectEditorFile(event, index){
  if (event) event.stopPropagation();
  if (index === _activeFileIndex) return;
  if (_contentSaveTimer) {
    clearTimeout(_contentSaveTimer);
    _contentSaveTimer = null;
    saveContentEditor();
  }
  _activeFileIndex = index;
  renderFileList();
  loadContentEditor();
}

function insertEmotionTag(tag){
  const editor = document.getElementById('contentEditor');
  if(!editor) return;
  editor.focus();
  const start = (editor.selectionStart !== null && editor.selectionStart !== undefined) ? editor.selectionStart : editor.value.length;
  const end = (editor.selectionEnd !== null && editor.selectionEnd !== undefined) ? editor.selectionEnd : editor.value.length;
  editor.value = editor.value.slice(0, start) + ' ' + tag + editor.value.slice(end);
  const pos = start + tag.length + 1;
  try{ editor.setSelectionRange(pos, pos); }catch(e){}
  scheduleContentSave();
}

function scheduleContentSave(){
  const saved = document.getElementById('contentEditorSaved');
  const editor = document.getElementById('contentEditor');
  if(editor && !_contentEditorFile) _freeText = editor.value;
  if(saved) saved.textContent = 'Đang lưu…';
  updateCharCount();
  clearTimeout(_contentSaveTimer);
  _contentSaveTimer = setTimeout(saveContentEditor, 800);
}

async function saveContentEditor(){
  const editor = document.getElementById('contentEditor');
  const saved = document.getElementById('contentEditorSaved');
  if(!editor || !window.pywebview) return;
  if(!_contentEditorFile){ if(saved) saved.textContent = ''; return; }
  try{
    const ok = await window.pywebview.api.save_text_file(_contentEditorFile.path, editor.value);
    if(saved) saved.textContent = ok ? 'Đã lưu ✓' : 'Lưu thất bại';
  }catch(e){
    if(saved) saved.textContent = 'Lưu thất bại';
  }
}

  function toggleVoiceDropdown(){
    document.getElementById('voiceDropdown').classList.toggle('open');
  }

  function pickVoice(el){
    document.querySelectorAll('.voice-option').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
    const voice = el.dataset.voice;
    const tag = el.dataset.tag;
    document.getElementById('voiceSelectName').textContent = voice;
    document.getElementById('voiceSelectTag').textContent = tag;
    document.getElementById('sumVoice').textContent = voice;
    document.getElementById('voiceDropdown').classList.remove('open');
    addStatusMessage('🎤 Đã chọn giọng: ' + voice + ' (' + tag + ')', 'info');
  }
  function pickLag(el){
    document.querySelectorAll('.lag-option').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
    const voice = el.dataset.lag;
    const tag = el.dataset.tag;
    document.getElementById('lagSelectName').textContent = voice;
    document.getElementById('lagSelectTag').textContent = tag;
    document.getElementById('sumVoice').textContent = voice;
    document.getElementById('voiceLagDropdown').classList.remove('open');
    addStatusMessage('🎤 Đã chọn ngôn ngữ: ' + voice + ' (' + tag + ')', 'info');
  }

  document.addEventListener('click', (e)=>{
    const dd = document.getElementById('voiceDropdown');
    if(dd && !dd.contains(e.target)) dd.classList.remove('open');
  });

  function getSelectedVoice(){
    return document.querySelector('.voice-option.selected').dataset.id;
  }
  function getSelectedLag(){
    return document.querySelector('.lag-option.selected').dataset.lag;
  }
  function getVoiceInstruct() {
    const ids = ["instructGender", "instructAge", "instructPitch", "instructStyle", "instructAccent"];
    return ids
      .map((id) => {
        const el = document.getElementById(id);
        return el ? String(el.value || "").trim() : "";
      })
      .filter(Boolean)
      .join(", ");
  }
let cloneCloseTimer = null;

function toggleClone() {
    const enable = document.getElementById('enableClone').checked;
    const boxes = document.querySelectorAll('.clone-box');
    const form = document.getElementById('cloneForm');

    if (enable) {
        clearTimeout(cloneCloseTimer);
        boxes.forEach(box => {
            box.classList.add('active');
        });
        form.classList.add('open');
        if (!cloneAudioPath) {
            document.getElementById('cloneEmpty').style.display = 'block';
            document.getElementById('cloneFilled').style.display = 'none';
        }
    } else {
        form.classList.remove('open');
        cloneCloseTimer = setTimeout(() => {
            boxes.forEach(box => {
                box.classList.remove('active');
            });
            document.getElementById('cloneEmpty').style.display = 'block';
            document.getElementById('cloneFilled').style.display = 'none';
        }, 450);
    }

    const saveCb = document.getElementById('enableSaveClone');
    saveCb.disabled = !enable;
    if (!enable) {
        saveCb.checked = false;
        document.getElementById('cloneSaveFields').classList.remove('open');
    }

    if (enable) {
        toggleVoiceDisabled(true);
        document.getElementById('sumVoice').textContent = "Giọng nhân bản";
        addStatusMessage('🔊 Nhân bản giọng nói: BẬT', 'info');
    } else {
        cloneAudioPath = null;
        toggleVoiceDisabled(false);
        document.getElementById('sumVoice').textContent =
            document.getElementById('voiceSelectName').textContent;
        addStatusMessage('🔊 Nhân bản giọng nói: TẮT', 'info');
    }

    updateCloneSummary();
}

function toggleSaveClone(){
    const on = document.getElementById('enableSaveClone').checked;
    document.getElementById('cloneSaveFields').classList.toggle('open', on);
}
  function toggleVoiceDisabled(disabled){
    const btn = document.getElementById('voiceSelectBtn');
    const dropdown = document.getElementById('voiceDropdown');
    if(disabled){
      btn.disabled = true;
      dropdown.style.opacity = "0.45";
      dropdown.style.pointerEvents = "none";
    } else {
      btn.disabled = false;
      dropdown.style.opacity = "1";
      dropdown.style.pointerEvents = "auto";
    }
  }


  function toggleLagDropdown(){
    document.getElementById('voiceLagDropdown').classList.toggle('open');
  }

  async function pickCloneAudio(){
    if(!window.pywebview) return;
    const info = await window.pywebview.api.pick_audio();
    if(!info) return;
    cloneAudioPath = info.path;
    document.getElementById('cloneEmpty').style.display='none';
    document.getElementById('cloneFilled').style.display='block';
    document.getElementById('cloneFileName').textContent = info.name;
    document.getElementById('cloneFileMeta').textContent = info.size_kb + " KB";
    updateCloneSummary();
    addStatusMessage('🎵 Đã chọn mẫu âm thanh: ' + info.name + ' (' + info.size_kb + ' KB)', 'info');
  }

  function updateCloneSummary(){
    const enabled = document.getElementById('enableClone').checked;
    const el = document.getElementById('sumClone');
    if(enabled && cloneAudioPath){
      el.textContent="Đã bật";
      el.classList.remove('muted');
    } else if(enabled){
      el.textContent="Chưa có audio";
      el.classList.add('muted');
    } else {
      el.textContent="Tắt";
      el.classList.add('muted');
    }
  }

    


  function updateSpeed(v){
    document.getElementById('speedVal').textContent = parseFloat(v).toFixed(2)+'×';
    document.getElementById('sumSpeed').textContent = parseFloat(v).toFixed(2)+'×';
  }

  function setSpeed(v){
    document.getElementById('speedSlider').value = v;
    updateSpeed(v);
  }



  let targetDurationValue = null;

  function syncDurationFromSave(value){
    const main = document.getElementById('durationInput');
    if (main && main.value !== value) main.value = value;
    updateDurationTarget(value);
  }


  function parseDurationToSeconds(str){
    str = (str || '').trim();
    if(!str) return null;
    if(str.includes(':')){
      const parts = str.split(':').map(p => parseFloat(p));
      if(parts.some(isNaN)) return null;
      if(parts.length === 2) return parts[0]*60 + parts[1];
      if(parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
      return null;
    }
    const v = parseFloat(str);
    return isNaN(v) ? null : v;
  }

  function updateDurationTarget(value){
    const seconds = parseDurationToSeconds(value);
    const resultEl = document.getElementById('durationResult');
    const speedBlock = document.getElementById('speedBlock');
    const speedSlider = document.getElementById('speedSlider');
    const speedPresetBtns = speedBlock.querySelectorAll('.preset-btn');
    // Đồng bộ ô thời lượng mini ở hàng Lưu thành
    const saveInput = document.getElementById('durationInputSave');
    if (saveInput && saveInput.value !== value) saveInput.value = value;

    if(seconds === null || seconds <= 0){
      targetDurationValue = null;
      if (resultEl) {
        resultEl.textContent = 'Chưa đặt thời lượng — sẽ dùng tốc độ ở trên';
        resultEl.classList.remove('ready');
      }

      // Bật lại khối Tốc Độ Phát
      speedSlider.disabled = false;
      speedPresetBtns.forEach(btn => btn.disabled = false);
      speedBlock.style.opacity = '1';
      speedBlock.style.pointerEvents = 'auto';
      return;
    }

    targetDurationValue = seconds;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const formatted = `${mins}:${secs.toString().padStart(2,'0')}`;
    if (resultEl) {
      resultEl.textContent = `Mục tiêu: ${formatted} — tốc độ sẽ tự động điều chỉnh sau khi tạo audio gốc`;
      resultEl.classList.add('ready');
    }

    // Vô hiệu hoá (không ẩn) khối Tốc Độ Phát vì tốc độ giờ được tính tự động theo thời lượng
    speedSlider.disabled = true;
    speedPresetBtns.forEach(btn => btn.disabled = true);
    speedBlock.style.opacity = '0.45';
    speedBlock.style.pointerEvents = 'none';
  }

  function setStatus(kind, text){
    const dot = document.getElementById('statusDot');
    dot.classList.remove('busy','error');
    if(kind==='busy') dot.classList.add('busy');
    if(kind==='error') dot.classList.add('error');
    document.getElementById('statusText').textContent = text;
  }

  
  function setGenButtonRunning(running){
    const btn = document.getElementById('genBtn');
    const label = document.getElementById('genLabel');
    if (!btn) return;
    if (running) {
      btn.classList.add('gen-running');
      if (label) label.textContent = 'ĐANG XỬ LÝ — NHẤN ĐỂ DỪNG';
    } else {
      btn.classList.remove('gen-running');
      btn.disabled = false;
      if (label) label.textContent = 'Tạo Ngay';
    }
  }

  
// Ghep mo ta giong de luu: gioi tinh lam tien to (kieu preset "Nam - Bac - ...").
// Server chi chap nhan chu cai/so/khoang trang/./-/_ nen dau "·" phai doi thanh "-".
function composeCloneDescription(){
  const descEl = document.getElementById('descSaveClone');
  const genEl = document.getElementById('genderSaveClone');
  let out = descEl ? (descEl.value || '').trim().replace(/\u00b7/g, '-') : '';
  const gender = genEl ? (genEl.value || '') : '';
  const label = gender === 'male' ? 'Nam' : gender === 'female' ? 'Nữ' : '';
  const first = (out.split(/[\s-]+/)[0] || '').toLowerCase();
  if (label && first !== 'nam' && first !== 'nữ') {
    out = out ? label + ' - ' + out : label;
  }
  return out.slice(0, 64);
}

async function runGenerate(){
  const btn = document.getElementById('genBtn');
  if (btn.classList.contains('gen-running')) {
    addStatusMessage('Đang dừng… phiên bản hiện tại sẽ chạy xong rồi dừng.', 'info');
    setStatus('busy', 'ĐANG DỪNG');
    try {
      await window.pywebview.api.stop_generate_batch();
    } catch (e) {
      console.error(e);
    }
    return;
  }

  const statusLog = document.getElementById('statusLog');
  const wrap = document.getElementById('progressWrap');
  const fill = document.getElementById('progressFill');
  const pct = document.getElementById('progressPct');
  const label = document.getElementById('progressText');
  const errorBanner = document.getElementById('errorBanner');
  const isSaveClone = document.getElementById("enableSaveClone");
  const nameCloneSave = document.getElementById("nameSaveClone");
  let name_out ="";
  const editorText = (document.getElementById('contentEditor').value || '').trim();
  const hasFiles = selectedFiles && selectedFiles.length > 0;
  if(!hasFiles && !editorText){
    errorBanner.textContent = 'Vui lòng chọn file hoặc nhập văn bản trước.';
    errorBanner.classList.add('active');
    return;
  }


  if(document.getElementById('enableClone').checked && !cloneAudioPath){
    errorBanner.textContent = 'Đã bật nhân bản giọng nói nhưng chưa chọn mẫu âm thanh.';
    errorBanner.classList.add('active');
    return;
  }
  if(isSaveClone.checked && nameCloneSave.value=="" ){
    errorBanner.textContent = 'Vui lòng nhập tên Clone Voice';
    errorBanner.classList.add('active');
    nameCloneSave.focus();
    return;
  }
  name_out=document.getElementById('namePattern').value+'_{index}' || '{file}_{index}'

  errorBanner.classList.remove('active');
  setGenButtonRunning(true);

  statusLog.classList.add('active');
  wrap.classList.add('active');
  document.getElementById('wave').classList.remove('idle');
  clearStatusLog();
  fill.style.width = '0%';
  pct.textContent = '0%';
  setStatus('busy', 'ĐANG XỬ LÝ');
  
  const config = {
    files: hasFiles ? selectedFiles.map(f => ({ path: f.path, name: f.name })) : [], // gửi cả danh sách
    voice: getSelectedVoice(),
    language: getSelectedLag(),
    instruct: getVoiceInstruct(),
    enable_clone_save:isSaveClone.checked,
    nameCloneSave:nameCloneSave.value,
    desCLoneSave: composeCloneDescription(),
    genderCloneSave: (document.getElementById("genderSaveClone").value || ""),
    speed: parseFloat(document.getElementById('speedSlider').value),
    pitch: 0,
    count: 1,
    threads: 1,
    name_pattern: name_out,
    target_duration: targetDurationValue,
    enable_clone: document.getElementById('enableClone').checked,
    clone_audio: cloneAudioPath,
    ref_text: document.getElementById('refText').value.trim(),
  };

  if(!hasFiles) config.text = editorText;

  console.log('Config for generation:', config);
  label.textContent = 'Đang khởi tạo…';
  addStatusMessage(hasFiles ? `Bắt đầu xử lý ${selectedFiles.length} file theo thứ tự...` : 'Bắt đầu xử lý văn bản trong ô soạn…', 'info');

  await window.pywebview.api.generate_batch(config);

}
// Biến theo dõi tiến trình toàn batch (nhiều file)
let batchTotalFiles = 1;
let batchCurrentFileIndex = 1;

window.onBackendEvent = function(event, payload){
  const fill = document.getElementById('progressFill');
  const pct = document.getElementById('progressPct');
  const label = document.getElementById('progressText');
  const btn = document.getElementById('genBtn');
  const errorBanner = document.getElementById('errorBanner');

  if(event === 'batch_start'){
    // Bắt đầu cả batch nhiều file
    batchTotalFiles = payload.total_files || 1;
    batchCurrentFileIndex = 1;
    fill.style.width = '0%';
    pct.textContent = '0%';
    addStatusMessage(`Bắt đầu xử lý ${batchTotalFiles} file theo thứ tự...`, 'info');

  } else if(event === 'file_start'){
    batchCurrentFileIndex = payload.file_index;
    batchTotalFiles = payload.total_files;
    label.textContent = `[${payload.file_index}/${payload.total_files}] Bắt đầu: ${payload.file_name}`;
    addStatusMessage(`— File ${payload.file_index}/${payload.total_files}: ${payload.file_name} —`, 'info');

  } else if(event === 'status'){
    label.textContent = payload.message;
    addStatusMessage(payload.message, 'info');

  } else if(event === 'paraphrase_status'){
    label.textContent = payload.message;
    addStatusMessage(payload.message, 'info');

  } else if(event === 'progress'){
    lastOutputDir = payload.output_dir;

    let overallPct;
    if (payload.total_overall){
      // Chế độ nhiều file chạy song song — dùng tiến trình TOÀN BATCH do backend tính sẵn
      overallPct = Math.round((payload.done_overall / payload.total_overall) * 100);
      label.textContent = `Tổng tiến trình: ${payload.done_overall}/${payload.total_overall} phiên bản` +
        ` (file "${payload.file_name}": ${payload.done}/${payload.total})`;
      addStatusMessage(`✓ [${payload.file_name}] Phiên bản ${payload.done}/${payload.total} — Tổng: ${payload.done_overall}/${payload.total_overall}`, 'success');
    } else if (payload.total_files){
      // fallback cũ (nếu backend chưa gửi total_overall)
      const fileBase = (payload.file_index - 1) / payload.total_files;
      const fileFrac = (payload.done / payload.total) / payload.total_files;
      overallPct = Math.round((fileBase + fileFrac) * 100);
      label.textContent = `[${payload.file_index}/${payload.total_files}] Đang xử lý ${payload.done}/${payload.total}…`;
      addStatusMessage(`✓ [${payload.file_name}] Đã tạo ${payload.done}/${payload.total} phiên bản`, 'success');
    } else {
      overallPct = Math.round((payload.done / payload.total) * 100);
      label.textContent = 'Đang xử lý ' + payload.done + '/' + payload.total + '…';
      addStatusMessage(`Đã tạo ${payload.done}/${payload.total} file`, 'success');
    }

    fill.style.width = overallPct + '%';
    pct.textContent = overallPct + '%';

    refreshRecentList();
  }else if(event === 'file_done'){
    addStatusMessage(`✅ [${payload.file_name}] Xử lý xong (${payload.file_index}/${payload.total_files}).`, 'success');

  } else if(event === 'file_error'){
    addStatusMessage(`✗ [${payload.file_name}] Lỗi: ${payload.message}`, 'error');
    // Không dừng cả batch — file lỗi được bỏ qua, tiếp tục file kế tiếp (backend đã tự continue)

  } else if(event === 'paraphrase_done'){
    addStatusMessage('✓ Viết lại bằng AI hoàn tất: ' + payload.txt_name, 'success');
    label.textContent = 'Sẵn sàng tạo giọng nói…';

  } else if(event === 'done'){
    // Hỗ trợ cả 2 dạng payload: cũ (count/output_dir) và mới (nhiều file: success_count/error_count/total_files)
    if (payload.total_files !== undefined){
      fill.style.width = '100%';
      pct.textContent = '100%';
      label.textContent = `Hoàn tất: ${payload.success_count}/${payload.total_files} file thành công` +
        (payload.error_count ? `, ${payload.error_count} lỗi` : '') +
        ' → ' + payload.output_dir;
      lastOutputDir = payload.output_dir;
      addStatusMessage(
        `🏁 Hoàn tất ${payload.total_files} file. Thành công: ${payload.success_count}, Lỗi: ${payload.error_count}`,
        payload.error_count ? 'error' : 'success'
      );
      setStatus(payload.error_count ? 'error' : 'ready', payload.error_count ? 'CÓ LỖI' : 'SẴN SÀNG');
    } else {
      // Trường hợp cũ (1 file, không có total_files)
      label.textContent = 'Hoàn tất: ' + payload.count + ' phiên bản → ' + payload.output_dir;
      lastOutputDir = payload.output_dir;
      addStatusMessage('✓ Đã hoàn tất tạo hàng loạt! ' + payload.count + ' file được tạo', 'success');
      setStatus('ready', 'SẴN SÀNG');
    }

    btn.disabled = false;
    setGenButtonRunning(false);
    document.getElementById('wave').classList.add('idle');
    refreshRecentList();

  } else if(event === 'cancelled'){
    lastOutputDir = payload.output_dir;
    label.textContent = `Đã dừng. Hoàn tất ${payload.success_count || 0}/${payload.total_files || 0} file` +
      (payload.output_dir ? ' → ' + payload.output_dir : '');
    addStatusMessage('⏹ Đã dừng theo yêu cầu.', 'info');
    setGenButtonRunning(false);
    document.getElementById('wave').classList.add('idle');
    setStatus('ready', 'ĐÃ DỪNG');
    refreshRecentList();

  } else if(event === 'error'){
    errorBanner.textContent = 'Lỗi: ' + payload.message;
    errorBanner.classList.add('active');
    label.textContent = 'Đã dừng do gặp lỗi.';
    addStatusMessage('✗ Lỗi: ' + payload.message, 'error');
    setGenButtonRunning(false);
    document.getElementById('wave').classList.add('idle');
    setStatus('error', 'LỖI');

  } else if(event === 'paraphrase_error'){
    errorBanner.textContent = 'Lỗi viết lại: ' + payload.message;
    errorBanner.classList.add('active');
    addStatusMessage('✗ Lỗi viết lại: ' + payload.message, 'error');
    btn.disabled = false;
    setStatus('error', 'LỖI');
  }
};
// window.onBackendEvent = function(event, payload){
//   const btn = document.getElementById('genBtn');
//   const fill = document.getElementById('progressFill');
//   const pct = document.getElementById('progressPct');
//   const label = document.getElementById('progressText');

//   switch(event){
//     case 'file_start':
//       label.textContent = `[${payload.file_index}/${payload.total_files}] Bắt đầu: ${payload.file_name}`;
//       addStatusMessage(`— File ${payload.file_index}/${payload.total_files}: ${payload.file_name} —`, 'info');
//       break;

//     case 'status':
//       label.textContent = payload.message;
//       addStatusMessage('🔧 ' + payload.message, 'info');
//       break;

//     case 'progress': {
//       // tiến trình tổng: kết hợp % file đã xong + % phiên bản trong file hiện tại
//       const fileBase = (payload.file_index - 1) / payload.total_files;
//       const fileFrac = (payload.done / payload.total) / payload.total_files;
//       const overallPct = Math.round((fileBase + fileFrac) * 100);
//       fill.style.width = overallPct + '%';
//       pct.textContent = overallPct + '%';
//       addStatusMessage(`✓ [${payload.file_name}] Hoàn tất phiên bản ${payload.done}/${payload.total}`, 'success');
//       break;
//     }

//     case 'file_done':
//       addStatusMessage(`✅ [${payload.file_name}] Xử lý xong.`, 'success');
//       break;

//     case 'file_error':
//       addStatusMessage(`✗ [${payload.file_name}] Lỗi: ${payload.message}`, 'error');
//       break;

//     case 'done':
//       fill.style.width = '100%';
//       pct.textContent = '100%';
//       label.textContent = `Hoàn tất: ${payload.success_count}/${payload.total_files} file thành công` +
//         (payload.error_count ? `, ${payload.error_count} lỗi` : '');
//       addStatusMessage(
//         `🏁 Hoàn tất ${payload.total_files} file. Thành công: ${payload.success_count}, Lỗi: ${payload.error_count}`,
//         payload.error_count ? 'error' : 'success'
//       );
//       document.getElementById('wave').classList.add('idle');
//       setStatus(payload.error_count ? 'error' : 'success', payload.error_count ? 'CÓ LỖI' : 'HOÀN TẤT');
//       btn.disabled = false;
//       break;

//     case 'error':
//       addStatusMessage('✗ Lỗi: ' + payload.message, 'error');
//       document.getElementById('wave').classList.add('idle');
//       setStatus('error', 'LỖI');
//       btn.disabled = false;
//       break;
//   }
// };
  // Nhật ký đã bỏ — chỉ giữ hàm rỗng để các chỗ gọi cũ không lỗi
  function addStatusMessage(text, type = 'info') {
    return;
  }

  function clearStatusLog() {
    return;
  }

  // ===== Bản ghi gần đây (kiểu VieNeu) =====
  let _recentFiles = [];
  let _recentOutputDir = '';
  let _recentReq = 0;
  let _recentAudio = null;
  let _recentPlayingPath = '';

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  }

  async function refreshRecentList() {
    const listEl = document.getElementById('recentList');
    const countEl = document.getElementById('recentCount');
    if (!listEl || !window.pywebview || !window.pywebview.api || !window.pywebview.api.list_recent_files) return;
    const req = ++_recentReq;
    let res;
    try {
      res = await window.pywebview.api.list_recent_files(10);
    } catch (e) {
      return;
    }
    if (req !== _recentReq) return;
    _recentFiles = res.files || [];
    _recentOutputDir = res.output_dir || '';
    if (countEl) countEl.textContent = `(${_recentFiles.length})`;
    if (!_recentFiles.length) {
      listEl.innerHTML = '<div class="vn-rec-empty">Chưa có bản ghi nào — tạo giọng xong sẽ hiện ở đây.</div>';
      return;
    }
    listEl.innerHTML = _recentFiles.map((f, i) => {
      const meta = [f.duration, 'WAV ' + f.size, f.time].filter(Boolean).join(' · ');
      return `<div class="vn-rec-row">
        <button class="vn-rec-play" data-i="${i}" title="Phát">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8V4z"/></svg>
        </button>
        <div class="vn-rec-main">
          <div class="vn-rec-title" title="${escHtml(f.name)}">${escHtml(f.name)}</div>
          <div class="vn-rec-meta">${escHtml(meta)}</div>
        </div>
        <div class="vn-rec-actions">
          <button class="vn-rec-act" data-act="rename" data-i="${i}" title="Đổi tên">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button class="vn-rec-act" data-act="folder" data-i="${i}" title="Mở thư mục">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
          </button>
          <button class="vn-rec-act music" data-act="open" data-i="${i}" title="Mở bằng trình phát mặc định">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          </button>
          <button class="vn-rec-act danger" data-act="delete" data-i="${i}" title="Xóa">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>`;
    }).join('');
    listEl.querySelectorAll('.vn-rec-play').forEach(btn => btn.addEventListener('click', () => toggleRecentPlay(+btn.dataset.i)));
    listEl.querySelectorAll('.vn-rec-act').forEach(btn => btn.addEventListener('click', () => recentAction(btn.dataset.act, +btn.dataset.i)));
  }

  function setRecentPlayIcon(btn, playing) {
    if (!btn) return;
    btn.classList.toggle('playing', !!playing);
    btn.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4l13 8-13 8V4z"/></svg>';
  }

  async function toggleRecentPlay(i) {
    const f = _recentFiles[i];
    if (!f || !window.pywebview || !window.pywebview.api || !window.pywebview.api.serve_audio) return;
    const btn = document.querySelectorAll('.vn-rec-play')[i];
    if (_recentPlayingPath === f.path && _recentAudio && !_recentAudio.paused) {
      _recentAudio.pause();
      _recentPlayingPath = '';
      setRecentPlayIcon(btn, false);
      return;
    }
    if (_recentAudio) {
      _recentAudio.pause();
      _recentAudio = null;
    }
    document.querySelectorAll('.vn-rec-play.playing').forEach(b => setRecentPlayIcon(b, false));
    let res;
    try {
      res = await window.pywebview.api.serve_audio(f.path);
    } catch (e) {
      res = null;
    }
    if (!res || res.error || !res.url) {
      const eb = document.getElementById('errorBanner');
      if (eb) {
        eb.textContent = 'Không tải được file audio: ' + (res && res.error ? res.error : f.name);
        eb.classList.add('active');
      }
      return;
    }
    const audio = new Audio(res.url);
    _recentAudio = audio;
    _recentPlayingPath = f.path;
    setRecentPlayIcon(btn, true);
    audio.addEventListener('ended', () => {
      _recentPlayingPath = '';
      setRecentPlayIcon(btn, false);
    });
    try {
      await audio.play();
    } catch (e) {
      _recentPlayingPath = '';
      setRecentPlayIcon(btn, false);
    }
  }

  async function openRecentFolder() {
    if (!_recentOutputDir || !window.pywebview || !window.pywebview.api || !window.pywebview.api.open_folder) return;
    try {
      await window.pywebview.api.open_folder(_recentOutputDir);
    } catch (e) {}
  }

  async function recentAction(act, i) {
    const f = _recentFiles[i];
    if (!f || !window.pywebview || !window.pywebview.api) return;
    if (act === 'folder') {
      openRecentFolder();
    } else if (act === 'open') {
      try {
        await window.pywebview.api.open_folder(f.path);
      } catch (e) {}
    } else if (act === 'delete') {
      showConfirm(`Xóa bản ghi "${f.name}.wav"?`, async () => {
        try {
          await window.pywebview.api.delete_recent_file(f.path);
        } catch (e) {}
        refreshRecentList();
      }, { title: 'Xóa bản ghi', okText: 'Xóa', cancelText: 'Hủy' });
    } else if (act === 'rename') {
      startRecentRename(i);
    }
  }

  function startRecentRename(i) {
    const f = _recentFiles[i];
    const row = document.querySelectorAll('.vn-rec-row')[i];
    const titleEl = row ? row.querySelector('.vn-rec-title') : null;
    if (!f || !titleEl) return;
    const input = document.createElement('input');
    input.className = 'vn-rec-rename';
    input.value = f.name;
    input.spellcheck = false;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() && input.value.trim() !== f.name) {
        try {
          const res = await window.pywebview.api.rename_recent_file(f.path, input.value.trim());
          if (res && !res.ok) {
            const eb = document.getElementById('errorBanner');
            if (eb) {
              eb.textContent = 'Không đổi được tên: ' + (res.error || '');
              eb.classList.add('active');
            }
          }
        } catch (e) {}
      }
      refreshRecentList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
  }

  // function showTab(tabId) {
  //   document.querySelectorAll('.tab-btn').forEach(btn => {
  //     btn.classList.toggle('active', btn.dataset.tab === tabId);
  //   });
  //   document.querySelectorAll('.tab-panel').forEach(panel => {
  //     panel.classList.toggle('active', panel.id === 'tab_' + tabId);
  //   });
  // }
function showTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === 'tab_' + tabId);
  });

}
  // window.onBackendEvent = function(event, payload){
  //   const fill = document.getElementById('progressFill');
  //   const pct = document.getElementById('progressPct');
  //   const label = document.getElementById('progressText');
  //   const btn = document.getElementById('genBtn');
  //   const errorBanner = document.getElementById('errorBanner');

  //   if(event === 'status'){
  //     label.textContent = payload.message;
  //     addStatusMessage(payload.message, 'info');
  //   } else if(event === 'paraphrase_status'){
  //     label.textContent = payload.message;
  //     addStatusMessage(payload.message, 'info');
  //   } else if(event === 'progress'){
  //       lastOutputDir = payload.output_dir;   
  //       const p = Math.round((payload.done/payload.total)*100);
  //       fill.style.width = p+'%';
  //       pct.textContent = p+'%';
  //       label.textContent = 'Đang xử lý ' + payload.done + '/' + payload.total + '…';
  //       addStatusMessage(`Đã tạo ${payload.done}/${payload.total} file`, 'success');

  //       payload.files.forEach(name=>{
  //         const isAudio = name.endsWith('.wav');

  //         if (isAudio) {
  //           const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  //           addFileMessage(name, audioId);
  //         } else {
  //           addStatusMessage('📄 ' + name, 'success');
  //         }
  //       });
  //   } else if(event === 'paraphrase_done'){
  //     addStatusMessage('✓ Viết lại bằng AI hoàn tất: ' + payload.txt_name, 'success');
  //     label.textContent = 'Sẵn sàng tạo giọng nói…';
  //   } else if(event === 'done'){
  //     label.textContent = 'Hoàn tất: ' + payload.count + ' phiên bản → ' + payload.output_dir;
  //     lastOutputDir = payload.output_dir;
  //     addStatusMessage('✓ Đã hoàn tất tạo hàng loạt! ' + payload.count + ' file được tạo', 'success');
  //     btn.disabled = false;
  //     document.getElementById('wave').classList.add('idle');
  //     setStatus('ready', 'SẴN SÀNG');
  //   } else if(event === 'error'){
  //     errorBanner.textContent = 'Lỗi: ' + payload.message;
  //     errorBanner.classList.add('active');
  //     label.textContent = 'Đã dừng do gặp lỗi.';
  //     addStatusMessage('✗ Lỗi: ' + payload.message, 'error');
  //     btn.disabled = false;
  //     document.getElementById('wave').classList.add('idle');
  //     setStatus('error', 'LỖI');
  //   } else if(event === 'paraphrase_error'){
  //     errorBanner.textContent = 'Lỗi viết lại: ' + payload.message;
  //     errorBanner.classList.add('active');
  //     addStatusMessage('✗ Lỗi viết lại: ' + payload.message, 'error');
  //     btn.disabled = false;
  //     setStatus('error', 'LỖI');
  //   }
  // };

  // ==================== PHÁT ÂM THANH ====================
  
let currentEmotion = "Kể chuyện";


// function setEmotion(value)
// {
//     currentEmotion = value;

//     document.getElementById("emotionVal").innerText = value;


//     document.querySelectorAll(".emotion-btn")
//     .forEach(btn =>
//     {
//         btn.classList.remove("active");

//         if(btn.innerText.includes(value))
//         {
//             btn.classList.add("active");
//         }
//     });


//     console.log("Emotion:", value);
// }

  //
  // Cho phép click vào thanh tiến trình để tua
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('progress-bar-mini')) {
      const bar = e.target;
      const rect = bar.getBoundingClientRect();
      const percent = (e.clientX - rect.left) / rect.width;
      
      // Tìm phần tử audio tương ứng
      const audioId = e.target.parentElement.querySelector('audio').id;
      const audio = document.getElementById(audioId);
      
      if (audio && audio.duration) {
        audio.currentTime = percent * audio.duration;
      }
    }
  });

  ///
//  function showConfirm(message, callback) {

//     const dialog = document.getElementById("confirmDialog");

//     dialog.querySelector(".rs-dialog-body").textContent = message;

//     dialog.classList.add("show");

//     document.getElementById("confirmCancel").onclick = () => {
//         dialog.classList.remove("show");
//     };

//     document.getElementById("confirmOk").onclick = () => {
//         dialog.classList.remove("show");
//         callback();
//     };
// }
function showConfirm(message, callback, options) {
    options = options || {};
    const dialog = document.getElementById("confirmDialog");
    const okBtn = document.getElementById("confirmOk");
    const cancelBtn = document.getElementById("confirmCancel");
    const titleEl = dialog.querySelector(".rs-dialog-title");
    const bodyEl = dialog.querySelector(".rs-dialog-body");
    const prevOk = okBtn ? okBtn.textContent : "";
    const prevCancel = cancelBtn ? cancelBtn.textContent : "";
    const prevTitle = titleEl ? titleEl.textContent : "";
    const prevOkClass = okBtn ? okBtn.className : "";

    if (options.html) bodyEl.innerHTML = message;
    else bodyEl.textContent = message;
    if (titleEl && options.title) titleEl.textContent = options.title;
    dialog.classList.toggle("is-wide", !!options.wide);
    if (okBtn && options.okText) okBtn.textContent = options.okText;
    if (cancelBtn && options.cancelText) cancelBtn.textContent = options.cancelText;
    if (okBtn && options.okClass) okBtn.className = options.okClass;

    dialog.classList.add("show");

    const closeDialog = (accepted) => {
        dialog.classList.remove("show");
        dialog.classList.remove("is-wide");
        document.removeEventListener("keydown", handleKeyDown);
        if (okBtn) okBtn.textContent = prevOk;
        if (okBtn) okBtn.className = prevOkClass;
        if (cancelBtn) cancelBtn.textContent = prevCancel;
        if (titleEl) titleEl.textContent = prevTitle;
        if (bodyEl) bodyEl.textContent = "";
        if (accepted) {
            if (typeof callback === "function") callback();
        } else if (typeof options.onCancel === "function") {
            options.onCancel();
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            closeDialog(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            closeDialog(false);
        }
    };

    document.addEventListener("keydown", handleKeyDown);

    document.getElementById("confirmCancel").onclick = () => {
        closeDialog(false);
    };

    document.getElementById("confirmOk").onclick = () => {
        closeDialog(true);
    };
}

function askQuitApp() {
    const dialog = document.getElementById("confirmDialog");
    if (dialog && dialog.classList.contains("show")) return;
    showConfirm("Bạn có chắc chắn muốn tắt ứng dụng?", function () {
        if (window.pywebview && window.pywebview.api && window.pywebview.api.quit_app) {
            window.pywebview.api.quit_app();
        }
    }, {
        okText: "Tắt",
        cancelText: "Hủy",
        onCancel: function () {
            if (window.pywebview && window.pywebview.api && window.pywebview.api.quit_prompt_dismissed) {
                window.pywebview.api.quit_prompt_dismissed();
            }
        }
    });
}
window.__askQuitApp = askQuitApp;

async function pollQuitPrompt() {
    try {
        if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.consume_quit_prompt) return;
        const need = await window.pywebview.api.consume_quit_prompt();
        if (need) askQuitApp();
    } catch (e) {}
}
setInterval(pollQuitPrompt, 200);
let _toastTimer = null;
function showToast(message, kind) {
  const el = document.getElementById("rsToast");
  if (!el) return;
  el.textContent = message || "";
  el.classList.remove("rs-toast-ok");
  if (kind === "ok") el.classList.add("rs-toast-ok");
  el.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 2200);
}

 function showCheck(message, callback) {

    const dialog = document.getElementById("okDialog");

    dialog.querySelector(".rs-dialog-body").textContent = message;

    dialog.classList.add("show");

    document.getElementById("okCancel").onclick = () => {
        dialog.classList.remove("show");
    };

    document.getElementById("okOk").onclick = () => {
        dialog.classList.remove("show");
        callback();
    };
}

// function renderCloneVoices(voices) {
//     const panel = document.getElementById("voiceCloneSelectPanel");

//     voices.forEach(v => {
//         const div = document.createElement("div");
//         div.className = "voice-option clone-voice";

//         div.dataset.voice = v.name;           // dùng khi render
//         div.dataset.id = v.id;          // file .pt
//         div.dataset.tag = v.description;    // mô tả

//         div.onclick = function () {
//             pickVoice(this);
//         };

//         div.innerHTML = `
//             <span class="voice-name">${v.name}</span>
//             <span class="voice-tag">${v.description}</span>
//         `;

//         panel.appendChild(div);
//     });
// }
// Rut gon mo ta giong de hien trong danh sach:
// "Nam - Bac - Phong cach tu nhien" -> "Nam - Mien Bac", "Nu - Bac" -> "Nu - Mien Bac".
// Mo ta khong theo mau gioi tinh - vung thi giu nguyen.
function shortVoiceDesc(desc){
  const m = String(desc || '').match(/^\s*(Nam|N\u1eef)\s*[\u00b7\-]\s*(B\u1eafc|Trung|Nam)\b/);
  return m ? m[1] + ' - Mi\u1ec1n ' + m[2] : (desc || '');
}

function renderCloneVoices(voices) {
    const panel = document.getElementById("voiceCloneSelectPanel");

    panel.innerHTML = "";

    if (!voices || voices.length === 0) {
        document.getElementById("voiceSelectName").textContent = "Vui lòng chọn giọng đọc";
        document.getElementById("voiceSelectTag").textContent = "Chưa chọn giọng";
        const vc0 = document.getElementById("voiceCount");
        if (vc0) vc0.textContent = "(0)";
        return;
    }

    voices.forEach(v => {
        const div = document.createElement("div");

        div.className = "voice-option clone-voice";

        div.dataset.voice = v.name;
        div.dataset.id = v.id;
        div.dataset.tag = shortVoiceDesc(v.description);

        div.onclick = function () {
            pickVoice(this);
        };

        div.innerHTML = `
            <span class="voice-name">${v.name}</span>
            <span class="voice-tag">${shortVoiceDesc(v.description)}</span>
        `;

        panel.appendChild(div);
    });

    // =========================
    // TỰ ĐỘNG CHỌN VOICE ĐẦU TIÊN
    // =========================
    const firstVoice = panel.querySelector(".voice-option");

    if (firstVoice) {
        pickVoice(firstVoice);
    }

    const vc = document.getElementById("voiceCount");
    if (vc) vc.textContent = "(" + voices.length + ")";
}

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

// Nut Mo Server o sidebar: chi hien khi server chua ket noi.
// Bam -> mo server, cho len roi tai lai danh sach giong.
let _serverPollTimer = null;
function showServerError(msg){
  const eb = document.getElementById('errorBanner');
  if(!eb) return;
  eb.textContent = msg;
  eb.classList.add('active');
}
async function refreshServerButton(){
  const btn = document.getElementById('serverStartBtn');
  if(!btn || !window.pywebview) return true;
  try{
    const st = await window.pywebview.api.check_voice_server();
    if(st && st.connected){
      btn.style.display = 'none';
      if(_serverPollTimer){ clearInterval(_serverPollTimer); _serverPollTimer = null; }
      return false;
    }
  }catch(e){}
  btn.style.display = '';
  return true;
}
async function onServerStartClick(){
  const btn = document.getElementById('serverStartBtn');
  if(!btn || btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Đang mở…';
  try{
    const res = await window.pywebview.api.start_voice_server();
    if(res && res.ok){
      let waited = 0;
      if(_serverPollTimer) clearInterval(_serverPollTimer);
      _serverPollTimer = setInterval(async () => {
        waited += 1;
        const disconnected = await refreshServerButton();
        if(!disconnected){
          btn.disabled = false; btn.textContent = 'Mở Server';
          if(typeof ReloadCloneVoice === 'function') ReloadCloneVoice();
        } else if(waited >= 180){
          clearInterval(_serverPollTimer); _serverPollTimer = null;
          btn.disabled = false; btn.textContent = 'Mở Server';
          showServerError('Server chưa lên sau 3 phút — xem _tmp/server.log rồi thử lại.');
        }
      }, 1000);
    } else {
      btn.disabled = false; btn.textContent = 'Mở Server';
      showServerError('Không mở được Server: ' + (res && res.error ? res.error : 'lỗi không rõ'));
    }
  }catch(e){
    btn.disabled = false; btn.textContent = 'Mở Server';
    showServerError('Không mở được Server: ' + e);
  }
}
