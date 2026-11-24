

const wave = document.getElementById('wave');
  for(let i=0;i<28;i++){
    const bar = document.createElement('span');
    bar.style.animationDelay = (i*0.045)+'s';
    wave.appendChild(bar);
  }

let selectedFilePath = null;
let cloneAudioPath = null;
let lastOutputDir = null;
let audioPlayers = {}; // Theo dõi các audio đang phát
let selectedFiles = [];
let _genBatchWaiter = null; 
const _originalOnBackendEvent = window.onBackendEvent;   
async function pickFileSub(){
  console.log("pickFileSub() called");
  if(!window.pywebview) return;

  const info = await window.pywebview.api.pick_files();
  console.log("Picked file info:", info);
  if(!info || info.length === 0) return;

  selectedFiles = info; // mảng [{path, name, size_kb}, ...]

  document.getElementById('dropzone').classList.add('has-file');
  document.getElementById('dzEmpty').style.display = 'none';
  document.getElementById('btn_delete_files_sub_tab').style.display = 'none';

  renderFileList();

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
    document.getElementById('btn_delete_files_sub_tab').style.display = 'none';
    document.getElementById('dropzone').classList.remove('has-file');
    return;
  }
  document.getElementById('btn_delete_files_sub_tab').style.display = 'flex';
  listEl.style.display = 'flex';
  listEl.innerHTML = selectedFiles.map((f, i) => renderFileRow(f, i)).join('');
}

function clearOneFile(event, index){
  event.stopPropagation();
  selectedFiles.splice(index, 1);
  renderFileList();

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
      renderFileList();
      document.getElementById('sumFile').textContent = 'Chưa chọn file';
      document.getElementById('sumFile').classList.add('muted');
    })

}
function renderFileRow(file, index){
  return `
    <div class="dz-file-row" style="display:flex;align-items:center;width:100%;gap:12px;" data-index="${index}">
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
function toggleClone() {
    const enable = document.getElementById('enableClone').checked;
    const boxes = document.querySelectorAll('.clone-box');

    boxes.forEach(box => {
        box.classList.toggle('active', enable);
    });

    if (enable) {
        toggleVoiceDisabled(true);
        document.getElementById('sumVoice').textContent = "Giọng nhân bản";
        addStatusMessage('🔊 Nhân bản giọng nói: BẬT', 'info');
    } else {
        cloneAudioPath = null;
        toggleVoiceDisabled(false);
        document.getElementById('sumVoice').textContent =
            document.getElementById('voiceSelectName').textContent;
        document.getElementById('cloneEmpty').style.display = 'block';
        document.getElementById('cloneFilled').style.display = 'none';
        addStatusMessage('🔊 Nhân bản giọng nói: TẮT', 'info');
    }

    updateCloneSummary();
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

//
  function updateVolume(v){
    document.getElementById('volumeVal').textContent = parseFloat(v).toFixed(2)+'×';
    document.getElementById('sumVolume').textContent = parseFloat(v).toFixed(2)+'db';
  }
    function updateNumStep(v){
    document.getElementById('numStepVal').textContent = parseFloat(v)+" NT";

  }


  function setVolume(v){
    document.getElementById('volumeSlider').value = v;
    updateVolume(v)
  }
//
function setNumStep(v){
      document.getElementById('NumStepSlider').value = v;
      updateNumStep(v)
}

  function updateSpeed(v){
    document.getElementById('speedVal').textContent = parseFloat(v).toFixed(2)+'×';
    document.getElementById('sumSpeed').textContent = parseFloat(v).toFixed(2)+'×';
  }

  function setSpeed(v){
    document.getElementById('speedSlider').value = v;
    updateSpeed(v);
  }

  function updatePitch(v){
    const sign = v>0? '+':'';
    document.getElementById('pitchVal').textContent = sign+v+' st';
    document.getElementById('sumPitch').textContent = sign+v+' st';
  }

  function setPitch(v){
    document.getElementById('pitchSlider').value = v;
    updatePitch(v);
  }

  let targetDurationValue = null;

  function toggleDurationCalc(){
    document.getElementById('durationToggle').classList.toggle('open');
    document.getElementById('durationBody').classList.toggle('open');
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

    if(seconds === null || seconds <= 0){
      targetDurationValue = null;
      resultEl.textContent = 'Chưa đặt thời lượng — sẽ dùng tốc độ ở trên';
      resultEl.classList.remove('ready');

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
    resultEl.textContent = `Mục tiêu: ${formatted} — tốc độ sẽ tự động điều chỉnh sau khi tạo audio gốc`;
    resultEl.classList.add('ready');

    // Vô hiệu hoá (không ẩn) khối Tốc Độ Phát vì tốc độ giờ được tính tự động theo thời lượng
    speedSlider.disabled = true;
    speedPresetBtns.forEach(btn => btn.disabled = true);
    speedBlock.style.opacity = '0.45';
    speedBlock.style.pointerEvents = 'none';
  }

  function stepCount(delta){
    const el = document.getElementById('countInput');
    let v = parseInt(el.value)||1;
    v = Math.min(99, Math.max(1, v+delta));
    el.value = v;
    document.getElementById('sumCount').textContent = v;
  }

  function sanitizeCount(el){
    let v = el.value.replace(/[^0-9]/g,'');
    if(v==='') v='1';
    v = Math.min(99, Math.max(1, parseInt(v)));
    el.value = v;
    document.getElementById('sumCount').textContent = v;
  }

  function stepThreads(delta){
    const el = document.getElementById('threadInput');
    let v = parseInt(el.value)||1;
    v = Math.min(16, Math.max(1, v+delta));
    el.value = v;
    document.getElementById('sumThreads').textContent = v;
  }

  function sanitizeThreads(el){
    let v = el.value.replace(/[^0-9]/g,'');
    if(v==='') v='1';
    v = Math.min(16, Math.max(1, parseInt(v)));
    el.value = v;
    document.getElementById('sumThreads').textContent = v;
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
  const desCLoneSave= document.getElementById("CloneSaveText");
  const num_step = document.getElementById("NumStepSlider").value;
  let name_out ="";
  if(!selectedFiles || selectedFiles.length === 0){
    errorBanner.textContent = 'Vui lòng chọn file trước.';
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
  const getTypeName = document.getElementById("NameTSSByContent");
  if(getTypeName.checked==true){
      const contents = getContentList();
      if(contents.length==0){
         errorBanner.textContent = 'Danh sách nội dung để thay tên không có. Vui lòng thêm';
         errorBanner.classList.add('active');
         return;
      }else{
        name_out = contents[Math.floor(Math.random() * contents.length)]+'_{index}';
      }
  }else{
    name_out=document.getElementById('namePattern').value+'_{index}' || '{file}_{index}'
  }

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
    files: selectedFiles.map(f => ({ path: f.path, name: f.name })), // gửi cả danh sách
    voice: getSelectedVoice(),
    language: getSelectedLag(),
    num_step:parseInt(num_step),
    instruct: getVoiceInstruct(),
    enable_clone_save:isSaveClone.checked,
    nameCloneSave:nameCloneSave.value,
    desCLoneSave:desCLoneSave.value,
    speed: parseFloat(document.getElementById('speedSlider').value),
    pitch: parseFloat(document.getElementById('pitchSlider').value),
    count: parseInt(document.getElementById('countInput').value) || 1,
    threads: parseInt(document.getElementById('threadInput').value) || 1,
    name_pattern: name_out,
    target_duration: targetDurationValue,
    enable_clone: document.getElementById('enableClone').checked,
    clone_audio: cloneAudioPath,
    ref_text: document.getElementById('refText').value.trim(),
    enable_ai_rewrite: document.getElementById('enableAiRewrite').checked, // xử lý luôn trong backend
  };

  console.log('Config for generation:', config);
  label.textContent = 'Đang khởi tạo…';
  addStatusMessage(`Bắt đầu xử lý ${selectedFiles.length} file theo thứ tự...`, 'info');

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

    payload.files.forEach(name=>{
      const isAudio = name.endsWith('.wav');
      if (isAudio) {
        const audioId = 'audio_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        addFileMessage(name, audioId);
      } else {
        addStatusMessage('📄 ' + name, 'success');
      }
    });
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

  } else if(event === 'cancelled'){
    lastOutputDir = payload.output_dir;
    label.textContent = `Đã dừng. Hoàn tất ${payload.success_count || 0}/${payload.total_files || 0} file` +
      (payload.output_dir ? ' → ' + payload.output_dir : '');
    addStatusMessage('⏹ Đã dừng theo yêu cầu.', 'info');
    setGenButtonRunning(false);
    document.getElementById('wave').classList.add('idle');
    setStatus('ready', 'ĐÃ DỪNG');

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
  // Helper cho nhật ký trạng thái
  function addStatusMessage(text, type = 'info') {
    const container = document.getElementById('statusLogContent');
    const log = document.getElementById('statusLog');
    
    // Hiện log nếu đang ẩn
    if (!log.classList.contains('active')) {
      log.classList.add('active');
    }

    const msg = document.createElement('div');
    msg.className = `status-message ${type}`;
    
    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN').split(' ')[0]; // HH:MM:SS
    
    msg.innerHTML = `
      <div class="status-message-time">${time}</div>
      <div class="status-message-text">${text}</div>
    `;
    
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
  }

  function clearStatusLog() {
    const container = document.getElementById('statusLogContent');
    container.innerHTML = '';
  }

  // Giống addStatusMessage(), nhưng phần nội dung là audio-player thay vì text thường,
  // và luôn dùng class "status-message success" để có cùng khung/viền với các dòng log khác.
  function addFileMessage(name, audioId) {
    const container = document.getElementById('statusLogContent');
    const log = document.getElementById('statusLog');

    if (!log.classList.contains('active')) {
      log.classList.add('active');
    }

    const now = new Date();
    const time = now.toLocaleTimeString('vi-VN').split(' ')[0];

    const msg = document.createElement('div');
    msg.className = 'status-message success';

    msg.innerHTML = `
      <div class="status-message-time">${time}</div>
      <div class="status-message-text">
        <div class="audio-player" style="flex-direction:column; align-items:stretch; gap:6px;">
          <span class="filename-label">${name}</span>
          <div style="display:flex; align-items:center; gap:8px;">
            <button class="play-btn" id="btn_${audioId}">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>
            </button>
            <audio id="${audioId}" style="display:none;"></audio>
            <div class="progress-bar-mini" style="flex:1;">
              <div class="progress-bar-mini-fill" id="fill_${audioId}"></div>
            </div>
            <span class="time-display" id="time_${audioId}">0:00</span>
          </div>
        </div>
      </div>
    `;

    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;

    // Gắn sự kiện bằng JS thật, không qua chuỗi HTML (tránh lỗi escaping đường dẫn)
    const playBtn = msg.querySelector('.play-btn');
    const currentOutputDir = lastOutputDir;
    const currentName = name;
    playBtn.addEventListener('click', () => {
      toggleAudio(audioId, currentOutputDir, currentName);
    });
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

  if (tabId === 'render') {
    requestAnimationFrame(updatePreviewFrameHeight);
  }
  if (tabId === 'scene' && typeof loadSceneStudio === 'function') {
    loadSceneStudio();
  }
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
  
  function formatTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  async function toggleAudio(audioId, outputDir, filename) {
    // Dừng các audio khác đang phát
    Object.keys(audioPlayers).forEach(id => {
      if (id !== audioId) {
        const other = audioPlayers[id];
        if (other && !other.paused) {
          other.pause();
          const otherBtn = document.getElementById('btn_' + id);
          if (otherBtn) {
            otherBtn.classList.remove('playing');
            setPlayIcon(otherBtn);
          }
        }
      }
    });

    const audio = document.getElementById(audioId);
    const btn = document.getElementById('btn_' + audioId);
    if (!audio) return;

    if (!audio.src) {
      try {
        const filepath = outputDir + '/' + filename;
        let result;
        if (window.pywebview && window.pywebview.api && window.pywebview.api.serve_audio) {
          result = await window.pywebview.api.serve_audio(filepath);
        }
        if (!result || result.error || !result.url) {
          alert('Không tải được file audio: ' + (result?.error || 'không rõ đường dẫn: ' + filepath));
          return;
        }
        audio.src = result.url;

        audio.addEventListener('timeupdate', () => updateAudioUI(audioId));
        audio.addEventListener('ended', () => {
          btn.classList.remove('playing');
          setPlayIcon(btn);
          document.getElementById('fill_' + audioId).style.width = '0%';
        });
      } catch (e) {
        console.error('Failed to load audio:', e);
        alert('Không tải được file audio: ' + filename);
        return;
      }
    }

    if (audio.paused) {
      audio.play();
      btn.classList.add('playing');
      setPauseIcon(btn);
      audioPlayers[audioId] = audio;
    } else {
      audio.pause();
      btn.classList.remove('playing');
      setPlayIcon(btn);
    }
  }

  function setPlayIcon(btn) {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" style="color: var(--accent-blue); width:16px; height:16px;">
        <path d="M5 3l14 9-14 9V3z"/>
      </svg>
    `;
  }

  function setPauseIcon(btn) {
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" style="color: var(--accent-red); width:16px; height:16px;">
        <rect x="6" y="4" width="4" height="16" rx="1"/>
        <rect x="14" y="4" width="4" height="16" rx="1"/>
      </svg>
    `;
  }

  function updateAudioUI(audioId) {
    const audio = document.getElementById(audioId);
    const fillBar = document.getElementById('fill_' + audioId);
    const timeDisplay = document.getElementById('time_' + audioId);

    if (!audio) return;

    // Cập nhật thanh tiến trình
    if (audio.duration) {
      const percent = (audio.currentTime / audio.duration) * 100;
      fillBar.style.width = percent + '%';
    }

    // Cập nhật hiển thị thời gian
    timeDisplay.textContent = formatTime(audio.currentTime);
  }



  //

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
function renderCloneVoices(voices) {
    const panel = document.getElementById("voiceCloneSelectPanel");

    panel.innerHTML = "";

    if (!voices || voices.length === 0) {
        document.getElementById("voiceSelectName").textContent = "Vui lòng chọn giọng đọc";
        document.getElementById("voiceSelectTag").textContent = "Chưa chọn giọng";
        return;
    }

    voices.forEach(v => {
        const div = document.createElement("div");

        div.className = "voice-option clone-voice";

        div.dataset.voice = v.name;
        div.dataset.id = v.id;
        div.dataset.tag = v.description;

        div.onclick = function () {
            pickVoice(this);
        };

        div.innerHTML = `
            <span class="voice-name">${v.name}</span>
            <span class="voice-tag">${v.description}</span>
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
}