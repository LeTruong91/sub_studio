/* =========================================================
 * OVERLAY (ảnh chèn lên video)
 * Kéo / resize / xoay tự viết bằng tay (mousedown + mousemove + mouseup),
 * KHÔNG dùng thư viện ngoài (đã bỏ moveable.min.js).
 * Mỗi overlay có 2 nút riêng (Xoá / Sửa) gắn liền vào chính nó,
 * giống kiểu khung blur/hook/sub ở timeline — không dùng nút dùng chung nữa.
 * Cần: 01-state.js đã load trước
 * ========================================================= */

/* ---------- ADD IMAGE OVERLAY ---------- */

async function AddOverLayImage() {
  if (!window.pywebview) return;

  const files = await window.pywebview.api.pick_media();
  if (!files) return;

  for (const info of files) {
    const id = ++overlayId;
    const url = "http://127.0.0.1:9876/file?path=" + encodeURIComponent(info.path);

    const size = await getImageDisplaySize(url);

    const data = {
      id: id,
      type: "image",
      path: info.path,
      x: 50,
      y: 50,
      width: size.width,
      height: size.height,
      rotation: 0,
      opacity: 1,
      zIndex: id,
      start: 0,
      end: 10,
      sameTime: false,
    };

    overlays.push(data);
    createOverlayElement(data);
  }
}

/* Lấy kích thước thật của ảnh, thu nhỏ vừa khung preview nếu ảnh quá to (giữ tỉ lệ) */
function getImageDisplaySize(url) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => {
      const preview = document.getElementById("previewFrame");
      const maxW = preview.clientWidth * 0.8;
      const maxH = preview.clientHeight * 0.8;

      let w = img.naturalWidth;
      let h = img.naturalHeight;

      if (w > maxW || h > maxH) {
        const scale = Math.min(maxW / w, maxH / h);
        w = w * scale;
        h = h * scale;
      }

      resolve({ width: Math.round(w), height: Math.round(h) });
    };

    img.onerror = () => resolve({ width: 200, height: 200 }); // fallback nếu ảnh lỗi

    img.src = url;
  });
}

/* ---------- TẠO PHẦN TỬ OVERLAY + TAY CẦM + 2 NÚT XOÁ/SỬA ---------- */

function createOverlayElement(data) {
  const div = document.createElement("div");
  div.className = "overlay-item";
  div.dataset.id = data.id;

  div.style.position = "absolute";
  div.style.left = data.x + "px";
  div.style.top = data.y + "px";
  div.style.width = data.width + "px";
  div.style.height = data.height + "px";
  div.style.zIndex = data.zIndex;
  div.style.transform = `rotate(${data.rotation || 0}deg)`;
  div.style.cursor = "move";
  div.style.opacity = data.opacity != null ? data.opacity : 1;

  const img = document.createElement("img");
  img.src = "http://127.0.0.1:9876/file?path=" + encodeURIComponent(data.path);
  img.style.width = "100%";
  img.style.height = "100%";
  img.style.display = "block";
  img.style.pointerEvents = "none"; // để không chặn sự kiện kéo trên div cha
  div.appendChild(img);

  // Tay cầm resize — góc dưới-phải
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "overlay-resize-handle";
  resizeHandle.style.position = "absolute";
  resizeHandle.style.right = "-8px";
  resizeHandle.style.bottom = "-8px";
  resizeHandle.style.width = "16px";
  resizeHandle.style.height = "16px";
  resizeHandle.style.background = "#ffffff";
  resizeHandle.style.border = "2px solid #3b82f6";
  resizeHandle.style.borderRadius = "50%";
  resizeHandle.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
  resizeHandle.style.cursor = "nwse-resize";
  resizeHandle.style.transition = "transform 0.15s ease";
  resizeHandle.addEventListener("mouseenter", () => {
    resizeHandle.style.transform = "scale(1.2)";
  });
  resizeHandle.addEventListener("mouseleave", () => {
    resizeHandle.style.transform = "scale(1)";
  });
  div.appendChild(resizeHandle);

  // Đường nối từ overlay lên tay cầm xoay
  const rotateLine = document.createElement("div");
  rotateLine.style.position = "absolute";
  rotateLine.style.left = "50%";
  rotateLine.style.top = "-22px";
  rotateLine.style.width = "1px";
  rotateLine.style.height = "22px";
  rotateLine.style.background = "rgba(255,255,255,0.6)";
  rotateLine.style.pointerEvents = "none";
  div.appendChild(rotateLine);

  // Tay cầm xoay — phía trên, dạng nút tròn có icon xoay
  const rotateHandle = document.createElement("div");
  rotateHandle.className = "overlay-rotate-handle";
  rotateHandle.style.position = "absolute";
  rotateHandle.style.left = "50%";
  rotateHandle.style.top = "-38px";
  rotateHandle.style.width = "20px";
  rotateHandle.style.height = "20px";
  rotateHandle.style.marginLeft = "-10px";
  rotateHandle.style.borderRadius = "50%";
  rotateHandle.style.background = "#ffffff";
  rotateHandle.style.border = "2px solid #f59e0b";
  rotateHandle.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
  rotateHandle.style.cursor = "grab";
  rotateHandle.style.display = "flex";
  rotateHandle.style.alignItems = "center";
  rotateHandle.style.justifyContent = "center";
  rotateHandle.style.transition = "transform 0.15s ease";
  rotateHandle.innerHTML = `
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#f59e0b" stroke-width="2.6">
            <path d="M3 12a9 9 0 1 0 3-6.7"/>
            <path d="M3 4v5h5"/>
        </svg>
    `;
  rotateHandle.addEventListener("mouseenter", () => {
    rotateHandle.style.transform = "scale(1.2)";
  });
  rotateHandle.addEventListener("mouseleave", () => {
    rotateHandle.style.transform = "scale(1)";
  });
  div.appendChild(rotateHandle);

  // Nút XOÁ — góc trên-trái (giống style khung blur/hook/sub ở timeline)
  const deleteBtn = document.createElement("div");
  deleteBtn.className = "overlay-delete-btn";
  deleteBtn.style.position = "absolute";
  deleteBtn.style.left = "-12px";
  deleteBtn.style.top = "-12px";
  deleteBtn.style.width = "22px";
  deleteBtn.style.height = "22px";
  deleteBtn.style.borderRadius = "50%";
  deleteBtn.style.background = "#ffffff";
  deleteBtn.style.border = "2px solid #ef4444";
  deleteBtn.style.display = "flex";
  deleteBtn.style.alignItems = "center";
  deleteBtn.style.justifyContent = "center";
  deleteBtn.style.cursor = "pointer";
  deleteBtn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
  deleteBtn.style.transition = "transform 0.15s ease";
  deleteBtn.style.zIndex = "2";
  deleteBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#ef4444" stroke-width="2.4">
            <path d="M3 6h18"/>
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
    `;
  deleteBtn.addEventListener("mouseenter", () => (deleteBtn.style.transform = "scale(1.15)"));
  deleteBtn.addEventListener("mouseleave", () => (deleteBtn.style.transform = "scale(1)"));
  deleteBtn.addEventListener("mousedown", (e) => e.stopPropagation()); // tránh kích hoạt kéo overlay
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
     showConfirm("Bạn có chắc muốn xóa lớp phủ?", () => {
      div.remove();
        overlays = overlays.filter((x) => x.id !== data.id);

      if (currentOverlay === div) {
        currentOverlay = null;
        currentOverlayData = null;
      }
    });


  });
  div.appendChild(deleteBtn);

  // Nút SỬA — góc trên-phải
  const editBtn = document.createElement("div");
  editBtn.className = "overlay-edit-btn";
  editBtn.style.position = "absolute";
  editBtn.style.right = "-12px";
  editBtn.style.top = "-12px";
  editBtn.style.width = "22px";
  editBtn.style.height = "22px";
  editBtn.style.borderRadius = "50%";
  editBtn.style.background = "#ffffff";
  editBtn.style.border = "2px solid #3b82f6";
  editBtn.style.display = "flex";
  editBtn.style.alignItems = "center";
  editBtn.style.justifyContent = "center";
  editBtn.style.cursor = "pointer";
  editBtn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
  editBtn.style.transition = "transform 0.15s ease";
  editBtn.style.zIndex = "2";
  editBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#3b82f6" stroke-width="2.4">
            <path d="M12 20h9"/>
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>
        </svg>
    `;
  editBtn.addEventListener("mouseenter", () => (editBtn.style.transform = "scale(1.15)"));
  editBtn.addEventListener("mouseleave", () => (editBtn.style.transform = "scale(1)"));
  editBtn.addEventListener("mousedown", (e) => e.stopPropagation());
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openOverlayEdit(data);
  });
  div.appendChild(editBtn);

  document.getElementById("previewFrame").appendChild(div);

  bindOverlay(div, data, resizeHandle, rotateHandle);

  return div;
}

/* ---------- GẮN SỰ KIỆN KÉO / RESIZE / XOAY ---------- */

function bindOverlay(div, data, resizeHandle, rotateHandle) {
  let dragging = false;
  let resizing = false;
  let rotating = false;

  let startMouseX = 0;
  let startMouseY = 0;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let startAngle = 0;
  let startRotation = 0;

  function selectThis() {
    currentOverlay = div;
    currentOverlayData = data;
    div.style.zIndex = ++overlayId;
    data.zIndex = parseInt(div.style.zIndex);
  }

  // KÉO DI CHUYỂN — chỉ khi bấm vào chính overlay, không phải các nút/tay cầm
  div.addEventListener("mousedown", (e) => {
    if (e.target !== div && e.target !== div.querySelector("img")) return;
    e.preventDefault();
    e.stopPropagation();

    selectThis();

    dragging = true;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startX = data.x;
    startY = data.y;
  });

  // KÉO RESIZE
  resizeHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    selectThis();

    resizing = true;
    startMouseX = e.clientX;
    startMouseY = e.clientY;
    startW = data.width;
    startH = data.height;
  });

  // KÉO XOAY
  rotateHandle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    selectThis();

    rotating = true;
    rotateHandle.style.cursor = "grabbing";

    const rect = div.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
    startRotation = data.rotation || 0;
  });

  document.addEventListener("mousemove", (e) => {
    if (dragging) {
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;

      data.x = startX + dx;
      data.y = startY + dy;

      div.style.left = data.x + "px";
      div.style.top = data.y + "px";
    }

    if (resizing) {
      const dx = e.clientX - startMouseX;
      const dy = e.clientY - startMouseY;

      data.width = Math.max(20, startW + dx);
      data.height = Math.max(20, startH + dy);

      div.style.width = data.width + "px";
      div.style.height = data.height + "px";
    }

    if (rotating) {
      const rect = div.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
      const delta = angle - startAngle;

      data.rotation = startRotation + delta;
      div.style.transform = `rotate(${data.rotation}deg)`;
    }
  });

  document.addEventListener("mouseup", () => {
    dragging = false;
    resizing = false;
    rotating = false;
    rotateHandle.style.cursor = "grab";
  });
}

/* ---------- LẤY DANH SÁCH OVERLAY THEO TOẠ ĐỘ RENDER (scale theo canvas xuất) ---------- */

function getOverlays(renderWidth, renderHeight) {
  const preview = document.getElementById("previewFrame");

  const previewWidth = preview.clientWidth;
  const previewHeight = preview.clientHeight;

  const scaleX = renderWidth / previewWidth;
  const scaleY = renderHeight / previewHeight;

  return overlays.map((item) => ({
    path: item.path,
    x: Math.round(item.x * scaleX),
    y: Math.round(item.y * scaleY),
    width: Math.round(item.width * scaleX),
    height: Math.round(item.height * scaleY),
    rotate: item.rotation || 0,
    z: item.zIndex || 1,
  }));
}

/* ---------- DIALOG SỬA THỜI GIAN / OPACITY OVERLAY ---------- */

function openOverlayEdit(data) {
  editingOverlay = data;

  document.getElementById("overlayStart").value = data.start;
  document.getElementById("overlayEnd").value = data.end;
  document.getElementById("numopValEach").value = data.opacity * 10;
  document.getElementById("cb_TimeSameVideo").checked = data.sameTime;

  document.getElementById("overlayEditDialog").classList.add("show");
}

function saveOverlayTime() {
  if (!editingOverlay) return;

  editingOverlay.start = parseFloat(document.getElementById("overlayStart").value);
  editingOverlay.end = parseFloat(document.getElementById("overlayEnd").value);
  editingOverlay.opacity = parseFloat(document.getElementById("numopValEach").value / 10);
  editingOverlay.sameTime = document.getElementById("cb_TimeSameVideo").checked;

  // áp dụng opacity mới lên overlay đang hiển thị (nếu đang là overlay được chọn)
  if (currentOverlay && currentOverlayData === editingOverlay) {
    currentOverlay.style.opacity = editingOverlay.opacity;
  }

  closeOverlayEdit();
}

function closeOverlayEdit() {
  document.getElementById("overlayEditDialog").classList.remove("show");
  editingOverlay = null;
}