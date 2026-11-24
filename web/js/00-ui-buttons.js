/* =========================================================
 * UI HELPERS DÙNG CHUNG: nút tròn Xoá / Sửa
 * Dùng cho: khung layer-guide (blur/hook/sub/image) trên preview
 * ========================================================= */

const DELETE_ICON_SVG = `
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#ef4444" stroke-width="2.4">
        <path d="M3 6h18"/>
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    </svg>
`;

const EDIT_ICON_SVG = `
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#3b82f6" stroke-width="2.4">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>
    </svg>
`;

/**
 * Tạo 1 nút hành động hình tròn (Xoá/Sửa/...) với style + hiệu ứng hover chung.
 * @param {Object} opts
 * @param {{left?:string,right?:string,top?:string,bottom?:string}} opts.position - vị trí absolute (vd {left:"-12px", top:"-12px"})
 * @param {string} opts.borderColor - màu viền (vd "#ef4444")
 * @param {string} opts.svgHtml - nội dung SVG icon
 * @param {(e:MouseEvent)=>void} opts.onClick - callback khi click (đã tự stopPropagation)
 */
function createRoundIconButton({ position, borderColor, svgHtml, onClick }) {
  const btn = document.createElement("div");

  btn.style.position = "absolute";
  if (position.left !== undefined) btn.style.left = position.left;
  if (position.right !== undefined) btn.style.right = position.right;
  if (position.top !== undefined) btn.style.top = position.top;
  if (position.bottom !== undefined) btn.style.bottom = position.bottom;

  btn.style.width = "22px";
  btn.style.height = "22px";
  btn.style.borderRadius = "50%";
  btn.style.background = "#ffffff";
  btn.style.border = "2px solid " + borderColor;
  btn.style.display = "flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
  btn.style.cursor = "pointer";
  btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
  btn.style.transition = "transform 0.15s ease";
  btn.style.zIndex = "2";
  btn.innerHTML = svgHtml;

  btn.addEventListener("mouseenter", () => (btn.style.transform = "scale(1.15)"));
  btn.addEventListener("mouseleave", () => (btn.style.transform = "scale(1)"));
  // tránh kích hoạt kéo/di chuyển phần tử cha khi bấm vào nút
  btn.addEventListener("mousedown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });

  return btn;
}

/** Nút Xoá — mặc định góc trên-trái (left:-12px, top:-12px) */
function createDeleteButton(onClick, position = { left: "-12px", top: "-12px" }) {
  return createRoundIconButton({
    position,
    borderColor: "#ef4444",
    svgHtml: DELETE_ICON_SVG,
    onClick,
  });
}

/** Nút Sửa — mặc định góc trên-phải (right:-12px, top:-12px) */
function createEditButton(onClick, position = { right: "-12px", top: "-12px" }) {
  return createRoundIconButton({
    position,
    borderColor: "#3b82f6",
    svgHtml: EDIT_ICON_SVG,
    onClick,
  });
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}