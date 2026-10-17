/* Original PDF and review canvases live only in this page's memory. */
(function (root) {
  async function review(file, plan, loadPdfJs) {
    if (!Array.isArray(plan.pages) || !plan.pages.length || plan.pages.length > 2 || typeof CompressionStream !== 'function') throw new Error('Trình duyệt chưa hỗ trợ bước che an toàn hoặc số trang không hợp lệ.');
    const dialog = document.createElement('dialog');
    dialog.className = 'privacy-dialog';
    dialog.setAttribute('aria-labelledby', 'privacyTitle');
    dialog.innerHTML = `<h2 id="privacyTitle">Kiểm tra bản hóa đơn đã che</h2>
      <p>Azure đã đọc bản gốc và xác nhận yêu cầu xóa kết quả tạm. Supabase chưa nhận file.</p>
      <p>Vùng đen chỉ là gợi ý tự động. Kiểm tra và che thêm tên, địa chỉ, điện thoại, email, giấy tờ, mã số thuế, tài khoản, QR, chữ ký và mọi thông tin định danh còn sót trên <strong>tất cả các trang</strong>.</p>
      <p>Bản lưu chỉ có ảnh đã che. Người phụ trách cần đối chiếu chứng từ ngoài hệ thống để xác minh các trường đã che và kiểm tra trùng.</p>
      <div class="privacy-pages"></div><p class="privacy-status" role="status" aria-live="polite">Đang dựng bản xem trước…</p>
      <div class="form-actions"><button type="button" data-cancel>Hủy, không lưu</button><button type="button" class="primary-button" data-confirm disabled>Xác nhận mọi trang và lưu bản đã che</button></div>`;
    document.body.append(dialog);
    const previousFocus = document.activeElement;
    dialog.showModal();
    const states = []; let task, cancelled = false, exporting = false;
    const confirm = dialog.querySelector('[data-confirm]'), cancel = dialog.querySelector('[data-cancel]');
    const status = dialog.querySelector('.privacy-status');
    let resolveChoice;
    const choice = new Promise(resolve => { resolveChoice = resolve; });
    function abort() { if (exporting) return; cancelled = true; resolveChoice(false); }
    cancel.onclick = abort;
    dialog.addEventListener('cancel', event => { event.preventDefault(); abort(); });
    function checkReady() { confirm.disabled = cancelled || states.length !== plan.pages.length || states.some(s => !s.confirmed.checked); }
    try {
      const pdfjs = await loadPdfJs();
      if (cancelled) return null;
      task = pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false,
        cMapUrl: './vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: './vendor/pdfjs/standard_fonts/',
        wasmUrl: './vendor/pdfjs/wasm/', iccUrl: './vendor/pdfjs/iccs/' });
      const pdf = await task.promise;
      if (pdf.numPages !== plan.pages.length) throw new Error('Số trang không khớp kết quả phân tích. Không lưu file.');
      for (let index = 0; index < pdf.numPages; index++) {
        if (cancelled) return null;
        const page = await pdf.getPage(index + 1), initial = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(initial.width, initial.height)) });
        if (Math.abs(initial.width / initial.height - plan.pages[index].width / plan.pages[index].height) > 0.02) throw new Error('Hướng trang không khớp; không lưu file.');
        const source = document.createElement('canvas');
        source.width = Math.ceil(viewport.width); source.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: source.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise;
        if (cancelled) { source.width = source.height = 0; return null; }
        const section = document.createElement('section'); section.className = 'privacy-page';
        section.innerHTML = `<h3>Trang ${index + 1} / ${pdf.numPages}</h3><p>Kéo trên trang để che thêm, hoặc nhập vùng theo phần trăm bên dưới.</p>
          <div class="privacy-canvas-wrap"><canvas aria-label="Bản đã che trang ${index + 1}"></canvas></div>
          <div class="privacy-coordinates">${[['x', 'Trái'], ['y', 'Trên'], ['w', 'Rộng'], ['h', 'Cao']].map(([key, label]) => `<label>${label} (%)<input data-coord="${key}" type="number" min="0" max="100" step="0.1" value="${key === 'w' || key === 'h' ? 10 : 0}"></label>`).join('')}</div>
          <div class="form-actions"><button type="button" data-add>Che vùng đã nhập</button><button type="button" data-full>Che cả trang</button><button type="button" data-undo disabled>Bỏ vùng vừa thêm</button></div>
          <label class="plain-check"><input type="checkbox" data-reviewed> Tôi đã kiểm tra toàn bộ trang ${index + 1}, gồm QR/chữ ký, và không còn thông tin định danh cần che.</label>`;
        dialog.querySelector('.privacy-pages').append(section);
        const canvas = section.querySelector('canvas'); canvas.width = source.width; canvas.height = source.height;
        const confirmed = section.querySelector('[data-reviewed]');
        const manual = [], automatic = plan.pages[index].rectangles;
        if (!Array.isArray(automatic) || automatic.some(box => !Array.isArray(box) || box.length !== 4 || box.some(n => !Number.isFinite(n) || n < 0 || n > 1) || box[2] < box[0] || box[3] < box[1])) throw new Error('Vùng che không hợp lệ. Không lưu file.');
        const state = { canvas, source, confirmed }; states.push(state);
        const undo = section.querySelector('[data-undo]');
        function draw() {
          const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0); ctx.fillStyle = '#000';
          for (const [x1, y1, x2, y2] of [...automatic, ...manual]) {
            const left = Math.max(0, Math.floor(x1 * canvas.width) - 3), top = Math.max(0, Math.floor(y1 * canvas.height) - 3);
            ctx.fillRect(left, top, Math.ceil(x2 * canvas.width) - left + 3, Math.ceil(y2 * canvas.height) - top + 3);
          }
          confirmed.checked = false; undo.disabled = !manual.length; checkReady();
        }
        function add(box) { manual.push(box); draw(); }
        section.querySelector('[data-full]').onclick = () => add([0, 0, 1, 1]);
        undo.onclick = () => { manual.pop(); draw(); };
        section.querySelector('[data-add]').onclick = () => {
          const values = ['x', 'y', 'w', 'h'].map(k => Number(section.querySelector(`[data-coord="${k}"]`).value) / 100);
          const [x, y, w, h] = values;
          if (values.some(n => !Number.isFinite(n) || n < 0 || n > 1) || w <= 0 || h <= 0 || x + w > 1 || y + h > 1) { status.textContent = 'Vùng che phải nằm trong trang và có chiều rộng/cao lớn hơn 0.'; return; }
          add([x, y, x + w, y + h]);
        };
        let start;
        const point = event => { const rect = canvas.getBoundingClientRect(); return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))]; };
        canvas.onpointerdown = event => { if (event.button !== 0) return; start = point(event); canvas.setPointerCapture(event.pointerId); };
        canvas.onpointerup = event => { if (!start) return; const end = point(event), box = [Math.min(start[0], end[0]), Math.min(start[1], end[1]), Math.max(start[0], end[0]), Math.max(start[1], end[1])]; start = null; if (box[2] - box[0] > 0.001 && box[3] - box[1] > 0.001) add(box); };
        canvas.onpointercancel = () => { start = null; };
        confirmed.onchange = checkReady;
        draw();
      }
      status.textContent = 'Chưa lưu file. Xác nhận riêng từng trang sau khi đã kiểm tra.';
      confirm.onclick = () => { if (!confirm.disabled) resolveChoice(true); };
      checkReady();
      if (!(await choice)) return null;
      exporting = true; confirm.disabled = true; cancel.disabled = true;
      dialog.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
      status.textContent = 'Đang tạo ảnh đã che để lưu…';
      const pages = [], parts = []; let total = 0;
      for (const state of states) {
        const { canvas } = state, rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const rgb = new Uint8Array(canvas.width * canvas.height * 3);
        for (let s = 0, d = 0; s < rgba.length; s += 4) { rgb[d++] = rgba[s]; rgb[d++] = rgba[s + 1]; rgb[d++] = rgba[s + 2]; }
        const packed = await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
        total += packed.byteLength;
        if (total > 4 * 1024 * 1024) throw new Error('Bản đã che vượt 4 MB. Không lưu file; hãy dùng PDF nhỏ hơn.');
        pages.push({ width: canvas.width, height: canvas.height, length: packed.byteLength, confirmed: true });
        parts.push(packed);
      }
      return { pages, parts, confirmed: true, receipt: plan.receipt };
    } finally {
      for (const state of states) { state.canvas.width = state.canvas.height = state.source.width = state.source.height = 0; }
      try { if (task) await task.destroy(); }
      finally { dialog.close(); dialog.remove(); previousFocus?.focus(); }
    }
  }
  root.FinRefPrivacy = { review };
})(globalThis);
