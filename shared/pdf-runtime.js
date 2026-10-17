'use strict';

// Explicit imports let serverless tracing include PDF.js's runtime dependencies.
// PDF.js's dynamic createRequire/worker path is not followed by Vercel tracing.
let runtime;
async function loadPdfRuntime() {
  if (!runtime) runtime = (async () => {
    const { DOMMatrix, Path2D } = require('@napi-rs/canvas');
    globalThis.DOMMatrix ||= DOMMatrix;
    globalThis.Path2D ||= Path2D;
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    globalThis.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler };
    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })().catch(error => { runtime = undefined; throw error; });
  return runtime;
}
module.exports = { loadPdfRuntime };
