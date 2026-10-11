// Kernel workers: main geometry worker (all ops, in order) + helper pool for parallel part rebuilds, and the point cloud worker.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.join(__dirname, '..');
const isTest = !!process.env.MONOLITH_TEST;

// ---------------- kernel worker ----------------
let worker = null;
let nextId = 1;
const pending = new Map();
// ---------------- point cloud worker ----------------
let pcWorker = null;
let pcNext = 1;
const pcPending = new Map();
function pcCall(op, args, sender) {
  if (!pcWorker) {
    const p = path.join(ROOT, 'kernel', 'pointcloud.mjs').replace('app.asar', 'app.asar.unpacked');
    pcWorker = new Worker(pathToFileURL(p));
    pcWorker.on('message', (m) => {
      const q = pcPending.get(m.id);
      if (!q) return;
      if (m.progress !== undefined) { if (!q.sender.isDestroyed()) q.sender.send('pc-progress', m.progress); return; }
      pcPending.delete(m.id);
      if (m.error) q.reject(new Error(m.error)); else q.resolve(m.result);
    });
    pcWorker.on('error', (e) => { for (const q of pcPending.values()) q.reject(e); pcPending.clear(); pcWorker = null; });
  }
  return new Promise((resolve, reject) => {
    const id = pcNext++;
    pcPending.set(id, { resolve, reject, sender });
    pcWorker.postMessage({ id, op, args });
  });
}

// Main worker handles everything (in order). 'regen' requests are stateless, so when several
// queue up (e.g. opening an assembly) extra helper workers are started to rebuild parts in
// parallel; helpers stop again after a minute without work to free memory.
const KERNEL_PATH = () => path.join(ROOT, 'kernel', 'worker.mjs').replace('app.asar', 'app.asar.unpacked');
const MAX_HELPERS = process.env.MONOLITH_HELPERS != null ? +process.env.MONOLITH_HELPERS : Math.max(0, Math.min(3, Math.floor(os.cpus().length / 2) - 1));
const helpers = []; // { w, ready, busy, job, idleTimer }
const regenQueue = []; // { op, args, resolve }
let mainBusy = 0; // regen jobs currently running on the main worker
function startWorker() {
  worker = new Worker(pathToFileURL(KERNEL_PATH()));
  worker.on('message', (m) => {
    if (m.ready || m.fatal) { if (m.fatal) console.error('Kernel failed:', m.fatal); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (p.regen) { mainBusy--; setImmediate(pumpRegen); }
    if (m.error) p.resolve({ __error: m.error }); else p.resolve(m.result);
  });
  worker.on('error', (e) => { console.error('Kernel worker error', e); for (const p of pending.values()) p.resolve({ __error: String(e) }); pending.clear(); mainBusy = 0; startWorker(); });
}
function startHelper() {
  const h = { w: new Worker(pathToFileURL(KERNEL_PATH())), ready: false, busy: false, job: null, idleTimer: null };
  helpers.push(h);
  const drop = () => { const i = helpers.indexOf(h); if (i >= 0) helpers.splice(i, 1); clearTimeout(h.idleTimer); };
  h.w.on('message', (m) => {
    if (m.ready) { h.ready = true; pumpRegen(); return; }
    if (m.fatal) { drop(); h.w.terminate(); return; }
    const job = h.job; h.job = null; h.busy = false;
    if (job) { if (m.error) job.resolve({ __error: m.error }); else job.resolve(m.result); }
    pumpRegen();
  });
  h.w.on('error', () => { drop(); if (h.job) regenQueue.unshift(h.job); pumpRegen(); });
}
function pumpRegen() {
  while (regenQueue.length) {
    const h = helpers.find((x) => x.ready && !x.busy);
    if (h) {
      const job = regenQueue.shift();
      clearTimeout(h.idleTimer); h.idleTimer = null; h.busy = true; h.job = job;
      h.w.postMessage({ id: 0, op: job.op, args: job.args });
      continue;
    }
    if (pending.size === 0) { // main worker idle: it takes the next job itself
      const job = regenQueue.shift(); mainBusy++;
      const id = nextId++;
      pending.set(id, { resolve: job.resolve, regen: true });
      worker.postMessage({ id, op: job.op, args: job.args });
      continue;
    }
    break;
  }
  // more work waiting than workers: start helpers (they take ~seconds to boot)
  const starting = helpers.filter((x) => !x.ready).length;
  if (regenQueue.length >= 3 + starting * 3 && helpers.length < MAX_HELPERS) startHelper();
  for (const h of helpers) if (h.ready && !h.busy && !h.idleTimer) {
    h.idleTimer = setTimeout(() => { if (!h.busy) { const i = helpers.indexOf(h); if (i >= 0) helpers.splice(i, 1); h.w.terminate(); } else h.idleTimer = null; }, 60000);
  }
}
function kernel(op, args) {
  if (op === 'regen' && args?.parallel) {
    const { parallel: _p, ...rest } = args;
    return new Promise((resolve) => { regenQueue.push({ op, args: rest, resolve }); pumpRegen(); });
  }
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    worker.postMessage({ id, op, args });
  });
}

function stopWorkers() { worker?.terminate(); pcWorker?.terminate(); for (const h of helpers) h.w.terminate(); }

module.exports = { pcCall, startWorker, kernel, stopWorkers };
