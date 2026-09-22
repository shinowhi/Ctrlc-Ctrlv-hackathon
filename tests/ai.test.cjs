const test=require('node:test');const assert=require('node:assert/strict');const {normalizeAnalysis}=require('../ai.js');
const payload={amount:12500000,vendor:'Sao Mai',invoiceNumber:'INV-01',invoiceDate:'2026-09-22',category:'printing'};
const doc={...payload,readable:true,paper:true,stamp:true,signature:true};
const raw=()=>({invoice:{...doc,documentKind:'invoice'},request:{...doc,documentKind:'request'},confidence:0.99,category:'printing',flags:[]});
test('Both documents must independently match the application',()=>{assert.equal(normalizeAnalysis(raw(),payload).status,'CLEAR');const v=raw();v.request.amount=12800000;assert.equal(normalizeAnalysis(v,payload).status,'U1');});
test('Invalid/incomplete model output cannot be CLEAR',()=>{for(const value of [null,{}, {status:'CLEAR',confidence:4}, {...raw(),flags:null},{...raw(),confidence:1.1}])assert.equal(normalizeAnalysis(value,payload).status,'U1');});
test('Explicit suspicion, low confidence and missing signatures block automation',()=>{for(const change of [v=>v.flags=['Nghi vấn giả mạo'],v=>v.confidence=0.5,v=>v.invoice.signature=false,v=>v.category='other']){const v=raw();change(v);const a=normalizeAnalysis(v,payload);assert.equal(a.status,'U1');assert.ok(a.flags.length);}});
test('Different invoice and vendor are detected even if model confidence is high',()=>{for(const key of ['invoiceNumber','vendor','invoiceDate']){const v=raw();v.invoice[key]='wrong';assert.equal(normalizeAnalysis(v,payload).status,'U1');}});
