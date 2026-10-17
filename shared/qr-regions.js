'use strict';
const jsQR = require('jsqr');
const { createCanvas } = require('@napi-rs/canvas');

async function scanQrRegions(page) {
  const original=page.getViewport({scale:1});
  const viewport=page.getViewport({scale:Math.min(2,1600/Math.max(original.width,original.height))});
  const canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
  try {
    const ctx=canvas.getContext('2d');
    await page.render({canvasContext:ctx,viewport,background:'rgb(255,255,255)'}).promise;
    const {data}=ctx.getImageData(0,0,canvas.width,canvas.height), boxes=[];
    const windows=[[0,0,canvas.width,canvas.height]];
    // Nearby QR finder patterns can confuse a full-page decode. Overlapping
    // tiles isolate codes without losing a code at a tile boundary.
    const tw=Math.ceil(canvas.width*.6),th=Math.ceil(canvas.height*.75);
    for(const x of [0,canvas.width-tw]) for(const y of [0,canvas.height-th]) windows.push([x,y,tw,th]);
    for(let i=0;i<32;i++) {
      let qr,offsetX=0,offsetY=0;
      for(const [x,y,w,h] of windows) {
        const pixels=new Uint8ClampedArray(w*h*4);
        for(let row=0;row<h;row++) pixels.set(data.subarray(((y+row)*canvas.width+x)*4,((y+row)*canvas.width+x+w)*4),row*w*4);
        qr=jsQR(pixels,w,h,{inversionAttempts:'attemptBoth'});
        if(qr){offsetX=x;offsetY=y;break;}
      }
      if(!qr) return boxes;
      const corners=['topLeftCorner','topRightCorner','bottomRightCorner','bottomLeftCorner'].map(k=>({x:qr.location[k].x+offsetX,y:qr.location[k].y+offsetY}));
      const left=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.x)))-5),right=Math.min(canvas.width,Math.ceil(Math.max(...corners.map(p=>p.x)))+5);
      const top=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.y)))-5),bottom=Math.min(canvas.height,Math.ceil(Math.max(...corners.map(p=>p.y)))+5);
      boxes.push([left/canvas.width,top/canvas.height,right/canvas.width,bottom/canvas.height]);
      // Decoded payload is never returned or logged. Every detected QR remains
      // unverified; only the rectangle is retained. Remove it to find others.
      for(let y=top;y<bottom;y++) data.fill(255,(y*canvas.width+left)*4,(y*canvas.width+right)*4);
    }
    throw Object.assign(new Error('Quá nhiều QR để kiểm tra an toàn. Hãy tách tài liệu.'),{safe:true,status:422});
  } finally { canvas.width=canvas.height=1; }
}
module.exports={scanQrRegions};
