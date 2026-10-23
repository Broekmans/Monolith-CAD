// Save Animation (0.1.122, Motion Study bar): popup (format, size, frame rate, range, quality, view cube) → save
// dialog → every frame: motion time → drive (same solving as Play) → the view drawn into its own renderer at the
// chosen size → encoder (assembly/animsave.js). Progress popup with Cancel. Afterwards the model goes back to where
// it was (Options asmAnimRestore) without an undo step; else it stays at the end (one undo step, like Play).
import * as THREE from 'three';
import { h, toast, makeDraggable } from '../ui.js';
import { api } from '../api.js';
import { opt } from '../app/options.js';
import { qs } from '../popout.js';
import { OPTIONS_DEF } from '../app/options.js';
import { totalTime, frameTimes } from '../../../shared/motion.mjs';
import { SIZES, EXT, FORMAT_NAME, outSize, formatsAvailable, makeEncoder, paintBackground, guarded } from './animsave.js';

const log = (...a) => { try { window.__lithLog?.(...a); } catch { /* log optional */ } };
let last = null; // last choices in this session
const isGif = (f) => f === 'gif';
// Playback Speed choices (Options row asmMotionSpeed) and how a speed is written
export const speedChoices = () => (OPTIONS_DEF.find((d) => d.key === 'asmMotionSpeed')?.choices || [['1', '1×']]);
export const fmtSpeed = (v) => `${+(+v).toFixed(3)}×`;

export class AsmAnimation {
  // the view that is saved: the one clicked last
  animPane() { return this.viewSet?.focus || this.vp; }

  async openSaveAnimation() {
    qs('.anim-pop')?.remove();
    const steps = this.motionSteps(), total = totalTime(steps);
    if (!steps.length || total <= 0) { toast('Add steps to the Motion Study first', 'warn', 4000); return; }
    this.pauseMotion();
    if (this._animBusy) return;
    const avail = await formatsAvailable(1920, 1080, 30, opt('asmAnimHw'));
    const o = { format: opt('asmAnimFormat'), size: null, fps: null, mbps: opt('asmAnimMbps'), hud: opt('asmAnimHud'), loops: opt('asmAnimLoops'), ...(last || {}), range: this.playMode() === 'reciprocate' ? 'reciprocate' : 'once', speed: this.playSpeed() }; // range + speed follow the Motion Study bar
    if (!avail[o.format]) o.format = avail.mp4 ? 'mp4' : avail.webm ? 'webm' : 'gif';
    const sizeFor = (f) => (isGif(f) ? opt('asmAnimGifSize') : opt('asmAnimSize'));
    const fpsFor = (f) => (isGif(f) ? opt('asmAnimGifFps') : opt('asmAnimFps'));
    o.size ??= sizeFor(o.format); o.fps ??= fpsFor(o.format);
    const el = h('div', { class: 'ann-props app-pop anim-pop' });
    for (const ev of ['keydown', 'pointerdown', 'wheel', 'dblclick', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(el);
    const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
    const row = (label, input) => h('div', { class: 'ap-row' }, h('label', {}, label), input);
    const select = (val, list, on) => { const s = h('select', {}, ...list.map(([v, t, dis]) => h('option', { value: v, selected: v === val, disabled: !!dis }, t))); s.addEventListener('change', () => on(s.value)); return s; };
    const later = () => setTimeout(fill, 0); // re-fill after the event (removing a focused input fires blur/change again)
    const fill = () => {
      if (!el.isConnected) return;
      el.replaceChildren();
      el.append(h('div', { class: 'ap-head' }, h('b', {}, 'Save Animation'), h('button', { class: 'ap-x', title: 'Close (Esc)', onclick: close }, '×')));
      el.append(row('Format', select(o.format, Object.keys(EXT).map((f) => [f, FORMAT_NAME[f] + (avail[f] ? '' : ' (not on this PC)'), !avail[f]]), (v) => {
        if (isGif(v) !== isGif(o.format)) { o.size = sizeFor(v); o.fps = fpsFor(v); }
        o.format = v; later();
      })));
      const p = this.animPane(), [vw, vh] = outSize('view', p);
      el.append(row('Size', select(o.size, [['view', `As the view (${vw} × ${vh})`], ...Object.entries(SIZES).map(([k, [w, hh]]) => [k, `${w} × ${hh}${k === '2160' ? ' (4K)' : ''}`])], (v) => { o.size = v; later(); })));
      const fps = h('input', { type: 'number', min: 2, max: 60, step: 1, value: String(o.fps) });
      fps.addEventListener('change', () => { const v = Math.round(+fps.value); if (v >= 1 && v <= 120) o.fps = v; later(); });
      el.append(row('Frames per second', fps));
      el.append(row('Range', select(o.range, [['once', 'Start to end'], ['reciprocate', 'Start to end and back (one cycle)']], (v) => { o.range = v; later(); })));
      const lp = h('input', { type: 'number', min: 1, max: 100, step: 1, value: String(o.loops || 1), title: 'How many times the motion (or the back-and-forth cycle) is in the file, one after the other' });
      lp.addEventListener('change', () => { const v = Math.round(+lp.value); if (v >= 1 && v <= 100) o.loops = v; later(); });
      el.append(row('Loops', lp));
      // 0.1.126: Speed = motion seconds per video second (from the bar's Playback Speed; 0.5 = slow motion)
      const sp = h('input', { type: 'number', min: opt('asmAnimSpeedMin'), max: opt('asmAnimSpeedMax'), step: 'any', value: String(o.speed), list: 'anim-speeds', title: 'Speed of the motion in the video: 1 = as played at 1×, 0.5 = slow motion (the video is twice as long), 2 = twice as fast' });
      sp.addEventListener('change', () => { const v = +sp.value; if (v >= opt('asmAnimSpeedMin') && v <= opt('asmAnimSpeedMax')) o.speed = v; later(); });
      el.append(row('Speed (×)', sp), h('datalist', { id: 'anim-speeds' }, ...speedChoices().map(([v, t]) => h('option', { value: v }, t))));
      if (!isGif(o.format)) {
        const q = h('input', { type: 'number', min: 1, max: 50, step: 1, value: String(o.mbps) });
        q.addEventListener('change', () => { const v = +q.value; if (v > 0) o.mbps = v; });
        el.append(row('Quality (Mbit/s)', q));
      }
      const hud = h('input', { type: 'checkbox', checked: !!o.hud });
      hud.addEventListener('change', () => { o.hud = hud.checked; });
      el.append(row('View cube, triad', hud));
      const n = frameTimes(total, o.fps, o.range, o.loops, o.speed).length, [W, H] = outSize(o.size, p);
      const multi = (this.viewSet?.visible?.().length || 1) > 1;
      el.append(h('div', { class: 'ap-info' }, `${n} frames · ${W} × ${H} · ${(n / o.fps).toFixed(1)} s${o.speed !== 1 ? ` (${fmtSpeed(o.speed)})` : ''}${multi ? ' · the view you clicked last' : ''}${isGif(o.format) ? ' · GIF plays in a loop' : ''}`));
      el.append(h('div', { class: 'ap-btns' }, h('button', { class: 'ap-ok', onclick: () => { last = { ...o }; close(); this.saveAnimation({ ...o }); } }, 'Save…'), h('button', { onclick: close }, 'Cancel')));
    };
    fill();
    const host = (this.viewSet?.root || this.vp.el).getBoundingClientRect(), e = opt('appPopEdgePx');
    el.style.left = Math.max(e, host.right - el.offsetWidth - e) + 'px'; el.style.top = host.top + e + 'px';
    makeDraggable(el, '.ap-head', 'monolith.animPos');
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
  }

  // o = {format, size, fps, range, mbps, hud}; o.path skips the save dialog, o.stallS sets the stall guard (tests)
  async saveAnimation(o) {
    const steps = this.motionSteps(), total = totalTime(steps);
    if (!steps.length || total <= 0 || this._animBusy) return null;
    const ext = EXT[o.format];
    const base = (this.app.path ? this.app.path.split(/[\\/]/).pop().replace(/\.lithasm$/i, '') : this.doc.name) || 'Animation';
    const path = o.path || await api.saveFile({ defaultPath: `${base}.${ext}`, filters: [{ name: FORMAT_NAME[o.format], extensions: [ext] }], noWrite: true });
    if (!path) return null;
    this.pauseMotion();
    qs('.step-pop')?.remove();
    this.unfreeMates();
    const p = this.animPane(), [W, H] = outSize(o.size, p), times = frameTimes(total, o.fps, o.range, o.loops, o.speed || 1);
    const mt = this._mt ??= { t: 0, playing: false, sel: -1 };
    const before = this.snapshot(), wasDirty = this.app.dirty, t0 = mt.t, keepSel = this.sel, keepHover = this.hover;
    this.sel = []; this.hover = null; this.updateHighlights?.();
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1); r.setSize(W, H, false); r.setClearColor(0x000000, 0); r.autoClear = false;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: isGif(o.format) });
    // progress popup; a see-through cover stops clicks in the program while it works (Play, bars, views…)
    this._animBusy = true;
    const st = { cancel: false };
    const cover = h('div', { class: 'anim-cover', title: 'Saving the animation — press Cancel or Esc to stop' });
    for (const ev of ['pointerdown', 'wheel', 'dblclick', 'contextmenu', 'click']) cover.addEventListener(ev, (e) => { e.stopPropagation(); e.preventDefault(); });
    document.body.appendChild(cover);
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); st.cancel = true; } else { e.stopPropagation(); } };
    document.addEventListener('keydown', onEsc, true);
    const bar = h('div', { class: 'an-fill' }), txt = h('div', { class: 'ap-info' }, 'Starting…');
    const prog = h('div', { class: 'ann-props app-pop anim-prog' }, h('div', { class: 'ap-head' }, h('b', {}, 'Saving animation')), h('div', { class: 'an-bar' }, bar), txt,
      h('div', { class: 'ap-btns' }, h('button', { onclick: (e) => { st.cancel = true; e.currentTarget.textContent = 'Stopping…'; e.currentTarget.disabled = true; } }, 'Cancel')));
    for (const ev of ['keydown', 'pointerdown', 'wheel']) prog.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(prog);
    const host = (this.viewSet?.root || this.vp.el).getBoundingClientRect();
    prog.style.left = Math.round(host.left + host.width / 2 - prog.offsetWidth / 2) + 'px'; prog.style.top = Math.round(host.top + host.height / 2 - prog.offsetHeight / 2) + 'px';
    const T0 = performance.now(), stallMs = (o.stallS ?? opt('asmAnimStallS')) * 1000; // o.stallS: tests (hidden options are always factory)
    let enc = null, result = null, why = '', k = 0, msMove = 0, msDraw = 0, msEnc = 0, sFinish = 0;
    const tick = () => { txt.textContent = `Frame ${Math.min(k + 1, times.length)} of ${times.length} · ${((performance.now() - T0) / 1000).toFixed(0)} s`; };
    const clock = setInterval(tick, 500);
    try {
      enc = await guarded(makeEncoder(o.format, W, H, o.fps, { mbps: o.mbps, colors: opt('asmAnimGifColors'), keyEvery: opt('asmAnimKeyEvery'), queue: opt('asmAnimQueue'), hw: opt('asmAnimHw'), rateStepMbps: opt('asmAnimRateStepMbps'), stallMs, cancelled: () => st.cancel }), stallMs, 'the video encoder (starting)', () => st.cancel);
      const mb = (b) => `${(b / 1e6).toFixed(0)} Mbit/s`;
      const rate = enc.bitrate ? `, ${mb(enc.bitrate)}${enc.asked ? ` (asked ${mb(enc.asked)}: more than this encoder takes)` : ''}` : '';
      log(`MOTION animation start ${path}: ${FORMAT_NAME[o.format]} ${W}×${H}, ${o.fps} fps, ${times.length} frames, ${o.range} × ${o.loops || 1}, speed ${fmtSpeed(o.speed || 1)}${enc.codec ? `, ${enc.codec} ${enc.accel}` : ''}${rate}, display ${this.displayMode || 'shaded'}`);
      if (enc.asked) toast(`Quality lowered to ${mb(enc.bitrate)} — the most this video encoder takes at this size (asked ${mb(enc.asked)})`, 'warn', 6000);
      for (k = 0; k < times.length; k++) {
        if (st.cancel) { why = 'cancelled'; break; }
        const t0f = performance.now();
        const res = this.seekMotion(times[k], false, 'anim');
        if (res && res.status !== 'ok') { why = mt.msg || 'end of travel'; break; }
        const t1 = performance.now();
        msMove += t1 - t0f;
        const kpx = p.renderCapture(r, W, H, o.hud);
        g.clearRect(0, 0, W, H);
        paintBackground(g, p.el, W, H, kpx);
        g.drawImage(r.domElement, 0, 0, W, H);
        const t2 = performance.now();
        await enc.add(cv, k);
        msDraw += t2 - t1; msEnc += performance.now() - t2;
        bar.style.width = `${((k + 1) / times.length) * 100}%`;
        tick();
        await new Promise((res2) => setTimeout(res2, 0)); // let the screen and Cancel through
      }
      if (!why) {
        txt.textContent = 'Writing the file…';
        const tf = performance.now();
        const bytes = await enc.finish(); enc = null;
        sFinish = (performance.now() - tf) / 1000;
        await guarded(Promise.resolve(api.writeBytes(path, bytes)), stallMs, 'writing the file', null);
        const s = (performance.now() - T0) / 1000;
        result = { path, frames: times.length, W, H, bytes: bytes.length, s };
        log(`MOTION animation saved ${path}: ${FORMAT_NAME[o.format]} ${W}×${H}, ${o.fps} fps, ${times.length} frames, ${(times.length / o.fps).toFixed(2)} s, ${(bytes.length / 1048576).toFixed(2)} MB, made in ${s.toFixed(1)} s (per frame: motion ${(msMove / times.length).toFixed(0)} ms, drawing ${(msDraw / times.length).toFixed(0)} ms, waiting for the encoder ${(msEnc / times.length).toFixed(0)} ms; finishing the file ${sFinish.toFixed(1)} s)`);
        toast(`Animation saved: ${path.split(/[\\/]/).pop()} (${times.length} frames, ${(bytes.length / 1048576).toFixed(1)} MB)`);
      }
    } catch (e) {
      why = String(e?.message || e);
    } finally {
      clearInterval(clock);
      enc?.cancel();
      prog.remove(); cover.remove();
      document.removeEventListener('keydown', onEsc, true);
      this._animBusy = false;
      r.dispose();
      if (why) { log(`MOTION animation not saved: ${why} (at frame ${k + 1} of ${times.length}, ${((performance.now() - T0) / 1000).toFixed(1)} s${enc ? `, encoder queue ${enc.queue}, out ${enc.out}` : ''})`); toast(why === 'cancelled' ? 'Save Animation cancelled' : `Animation not saved: ${why}`, why === 'cancelled' ? '' : 'error', 5000); }
      if (opt('asmAnimRestore') || why) { // back to where it was, no undo step
        this._drv = null; this._last = null;
        mt.t = t0; mt.msg = ''; mt.err = false; // before restore: an open study holds its values at this time (0.1.134)
        this.restore(before);
        this.app.setDirty(wasDirty);
      } else this.endDriveSession();
      this.sel = keepSel.filter((s) => s.kind !== 'comp' || this.doc.components.some((c) => c.id === s.id)); this.hover = keepHover?.kind === 'mate' ? keepHover : null;
      this.updateHighlights?.();
      if (this._motionOpen) this.renderMotion();
      this.vp.requestRender();
    }
    return result;
  }
}
