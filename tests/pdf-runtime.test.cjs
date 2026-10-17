const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPdfRuntime } = require('../shared/pdf-runtime');

function document() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << >> >>'
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

test('server PDF runtime loads native geometry and explicit worker before inspecting pages', async () => {
  const [pdfjs, same] = await Promise.all([loadPdfRuntime(), loadPdfRuntime()]);
  assert.equal(pdfjs, same);
  assert.equal(typeof globalThis.DOMMatrix, 'function');
  assert.equal(typeof globalThis.pdfjsWorker.WorkerMessageHandler, 'function');
  // Parsing must use the explicitly imported worker, even without a dynamic path.
  pdfjs.GlobalWorkerOptions.workerSrc = './missing-worker.mjs';
  const task = pdfjs.getDocument({ data: document(), isEvalSupported: false, verbosity: 0 });
  try {
    const pdf = await task.promise;
    assert.equal(pdf.numPages, 1);
    const view = (await pdf.getPage(1)).getViewport({ scale: 1 });
    assert.equal(view.width, 842); assert.equal(view.height, 595);
  } finally { await task.destroy(); }
});
