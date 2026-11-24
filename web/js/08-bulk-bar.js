// Không đụng tới các hàm sẵn có — chỉ lắng nghe sự kiện change trên checkbox
// document.addEventListener("change", (e) => {
//   if (!e.target.classList.contains("rs-row-check")) return;
//   updateBulkBar();
// });

function updateBulkBar() {
//   const bar = document.getElementById("rsBulkBar");
//   const count = document.querySelectorAll("#videoTable .rs-row-check:checked").length;
//   if (count > 0) {
//     bar.style.display = "flex";
//     bar.innerHTML = `<span>✓ Đã chọn ${count} media</span>`;
//   } else {
//     bar.style.display = "none";
//   }
}

// Gộp hiển thị "thời lượng · dung lượng" mà không sửa addMediaRow gốc
const mediaObserver = new MutationObserver((mutations) => {
  mutations.forEach(m => {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1 || node.tagName !== "TR") return;
      const durationTd = node.children[5];   // td thứ 6 (index 5)
      const sizeEl = node.querySelector(".rs-fsub");
      if (durationTd && sizeEl && !durationTd.dataset.merged) {
        durationTd.innerHTML = `${durationTd.textContent.trim()} · ${sizeEl.textContent.trim()}`;
        durationTd.dataset.merged = "1";
      }
    });
  });
});
mediaObserver.observe(document.getElementById("mediaTableBody"), { childList: true });