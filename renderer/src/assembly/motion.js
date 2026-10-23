// Assembly motion (0.1.119): Drive a Distance / Angle mate with a slider, and the Motion Study timeline under the
// view (steps: mate from → to in seconds, after / with the previous step; Play / Pause / Loop / Reciprocate / scrub).
// Solving: shared/mates.mjs driveStep (same branch / dead-point protection as dragging). While driving, m._drive
// holds the value (runtime only); a drive session (slider drag, play until pause, scrub) is ONE undo step and the model
// stays where it ended (the driven values become the mates' values, M.endDrive).
// 0.1.134 "the study takes over": while the Motion Study is open, the mates its steps use follow the timeline only
// (m._drive kept between moves; their tree value and Limits do not apply; m._flip = the study's own Flip). Playing,
// scrubbing and Save Animation never write values into the tree mates and make no undo step; closing the study puts
// the model back at the tree values. Steps can have their own name; several steps can be selected (Ctrl / Shift).
import * as THREE from 'three';
import { h, fmt, toast, makeDraggable, contextMenu, promptText } from '../ui.js';
import { icon } from '../icons.js';
import { opt, OPTIONS_DEF } from '../app/options.js';
import * as M from '../../../shared/mates.mjs';
import { schedule, totalTime, valuesAt, placeStep, snapTime, moveStep } from '../../../shared/motion.mjs';
import { speedChoices, fmtSpeed } from './animation.js';
import { popOut, dock, isPopped, wantsPop, qs } from '../popout.js';
const MOTION_WIN = 'monolith.motion';

const log = (...a) => { try { window.__lithLog?.(...a); } catch { /* log optional */ } };
const isValueMate = (m) => m && (m.type === 'distance' || m.type === 'angle');
const isDrivable = (m) => isValueMate(m) && !m.suppressed;
const inField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
const unitOf = (m) => (m.type === 'angle' ? '°' : ' mm');
let drivePop = null;
// which end of a step bar is under the mouse ('start' | 'end' | null = the middle); a narrow bar: only its end
function barEdge(bar, e) {
  const b = bar.getBoundingClientRect(), ep = opt('asmMotionEdgePx');
  if (b.right - e.clientX <= ep) return 'end';
  if (e.clientX - b.left <= ep && b.width > 3 * ep) return 'start';
  return null;
}
export function closeDrive() { if (!drivePop) return; drivePop.close(); }

export class AsmMotion {
  // radius of every component for the move measure (fasteners are round: 0)
  compSizes() {
    return new Map(this.doc.components.map((k) => { const b = this.views.get(k.id)?.part?.geom?.boundingBox; return [k.id, k.lib ? 0 : b && !b.isEmpty() ? Math.max(1, b.getSize(new THREE.Vector3()).length() / 2) : 100]; }));
  }
  // how: 'play' (Play: bigger pieces + warm start + time budget per frame) | 'anim' (Save Animation: bigger pieces + warm
  // start, every frame solved to the end) | else Drive / scrub / flip (fine pieces) — 0.1.135
  driveOpts(how) {
    const o = { iters: opt('asmDriveIters'), tol: opt('asmDragTol'), ratio: opt('asmDragRatio'), minMove: opt('asmDragMinMove'), split: opt('asmDragSplit'),
      maxStepMm: opt('asmDriveStepMm'), maxStepDeg: opt('asmDriveStepDeg'), maxPieces: opt('asmDriveMaxPieces'), size: this._drv?.size || this.compSizes() };
    if (how === 'play' || how === 'anim') Object.assign(o, { maxStepMm: opt('asmPlayStepMm'), maxStepDeg: opt('asmPlayStepDeg'), warm: !!opt('asmPlayWarm'), warmMax: opt('asmPlayWarmMax') });
    if (how === 'play' && opt('asmPlayBudgetMs') > 0) Object.assign(o, { budgetMs: opt('asmPlayBudgetMs'), now: () => performance.now() });
    return o;
  }
  // current value of a mate (angles unwrapped near the mate's own value, so 250° stays 250° and not -110°)
  mateNow(m) {
    const drv = m._free ? null : m._drive; // suppressed while editing: the measured value (a study keeps its _drive meanwhile)
    const v = drv ?? M.mateValue(m, M.compMap(this.doc.components));
    if (v == null) return m.value ?? 0;
    if (m.type !== 'angle' || drv != null) return v;
    const ref = m.value ?? v;
    return v + 360 * Math.round((ref - v) / 360);
  }
  // one drive move (targets [{id, value}]); starts a session (one undo step) when none is running
  driveTo(targets, kind, how) {
    if (!this._drv) { if (kind !== 'motion') this.beginChange(); this._drv = { kind, targets: [], hist: [], size: this.compSizes(), steps: 0, nHeld: 0, ms: 0, msMax: 0, err: 0, solves: 0, cut: 0 }; }
    const d = this._drv;
    d.targets = targets;
    const t0 = performance.now();
    const res = M.driveStep(this.doc.components, this.doc.mates.filter((m) => !this.mateErr?.has(m.id)), d, this.driveOpts(how));
    const ms = performance.now() - t0;
    d.steps++; d.ms += ms; d.msMax = Math.max(d.msMax, ms); d.err = Math.max(d.err, res.err || 0); d.solves += res.solves || 0; if (res.budget) d.cut++;
    if (res.status !== 'ok') { d.nHeld++; d.lastHeld = res; } // (0.1.122: own counter — driveStep sets drive.held = true/false)
    if (res.part > 0 || res.retrace) { this.updatePoses(); this.vp.requestRender(); }
    return res;
  }
  // end of a drive session: values stored, one undo step, log line
  endDriveSession() {
    const d = this._drv;
    if (!d) return;
    this._drv = null;
    const ids = new Set(d.targets.map((t) => t.id)), driven = this.doc.mates.filter((m) => ids.has(m.id) && m._drive != null);
    const names = driven.map((m) => `${m.name} ${fmt(m._drive)}${unitOf(m).trim()}`);
    log(`MOTION ${d.kind}: ${names.join(', ') || '-'}; ${d.steps} steps, stopped at a limit ${d.nHeld}, max mate error ${(d.err || 0).toPrecision(2)} mm, ${(d.ms / Math.max(1, d.steps)).toFixed(1)} ms avg, ${d.msMax.toFixed(1)} ms max, ${(d.solves / Math.max(1, d.steps)).toFixed(1)} solves per step${d.cut ? `, solve time used up in ${d.cut} steps (rest in the next frame)` : ''}`);
    if (d.kind === 'motion') { this.solve(); this.renderTree(); return; } // 0.1.134: the study keeps its values (m._drive) — nothing written to the tree, no undo step
    M.endDrive(driven); // only the mates this session drove (a study's mates keep following the study)
    this.commit();
    this.solve();
    if (this._motionOpen) this.renderMotion();
  }

  // 0.1.123: "Suppress while editing" (step popup / Drive popup): the mate and its Limits are left out (m._free,
  // runtime only — never saved, no undo step) so the model can be dragged freely; switching it on again keeps the pose:
  // the mate takes the value it has then (one undo step). Play / scrub / Save Animation / closing the popup switch it on.
  freeMate(m, on) {
    if (!m || !!m._free === !!on) return;
    if (on) {
      if (this._drv) this.endDriveSession();
      m._free = true;
      log('MOTION suppress while editing', m.name, 'on');
      this.solve();
    } else {
      delete m._free;
      const v = +fmt(this.mateNow(m));
      if (this._motionOpen && this.studyIds().has(m.id)) { // 0.1.134: the study's mate — the tree value stays
        m._drive = v; log('MOTION suppress while editing', m.name, 'off, study value', v); this.solve(); this.renderTree(); this.liveUpdate(); return;
      }
      if (m.value !== v) { this.beginChange(); m.value = v; this.commit(); }
      const lo = m.limits ? Math.min(m.limits.min, m.limits.max) : -Infinity, hi = m.limits ? Math.max(m.limits.min, m.limits.max) : Infinity;
      log('MOTION suppress while editing', m.name, 'off, value', v);
      if (v < lo - 1e-9 || v > hi + 1e-9) toast(`${m.name} ${fmt(v)}${unitOf(m)} is outside its Limits: the model moves back to ${fmt(v < lo ? lo : hi)}${unitOf(m)}`, 'warn', 4000);
      this.solve();
    }
    this.renderTree();
    this.liveUpdate();
  }
  unfreeMates() { for (const m of this.doc.mates.filter((k) => k._free)) this.freeMate(m, false); }
  // popups that show live values (called from updatePoses: every drag / drive move)
  addLive(fn) { (this._live ??= new Set()).add(fn); return () => this._live.delete(fn); }
  liveUpdate() { for (const f of this._live || []) { try { f(); } catch { /* popup gone */ } } }
  // delete step i (popup button, Delete key, right-click)
  deleteMotionStep(i) { const s = this.motionSteps()[i]; if (s) this.deleteMotionSteps([s.id]); }
  // 0.1.134: several steps (default: the selected ones) in one undo step
  deleteMotionSteps(ids = [...(this._mt?.selIds || [])]) {
    const steps = this.motionSteps(), kill = new Set(ids), gone = steps.map((s, i) => ({ s, i })).filter((x) => kill.has(x.s.id));
    if (!gone.length) return;
    qs('.step-pop')?.remove();
    this.unfreeMates();
    if (this._mt) { this._mt.sel = -1; this._mt.selIds = new Set(); }
    const before = this.studyIds();
    this.setMotionSteps((st) => { const keep = st.filter((s) => !kill.has(s.id)); st.splice(0, st.length, ...keep); });
    for (const m of this.doc.mates) if (before.has(m.id) && !this.studyIds().has(m.id)) { delete m._drive; delete m._flip; } // no step left: back to its tree value
    this.solve();
    for (const { s, i } of gone) { const m = this.doc.mates.find((k) => k.id === s.mate); log(`MOTION step ${i + 1} deleted (${s.name ? s.name + ', ' : ''}${m?.name || s.mate} ${s.from} -> ${s.to})`); }
  }
  // 0.1.134: own name of a step (empty = the mate's name)
  async renameMotionStep(i) {
    const s = this.motionSteps()[i]; if (!s) return;
    const m = this.doc.mates.find((k) => k.id === s.mate);
    const n = await promptText('Step name', s.name || m?.name || '');
    if (n == null) return;
    const v = n.trim();
    this.setMotionSteps((st) => { st[i] = { ...st[i] }; if (v && v !== m?.name) st[i].name = v; else delete st[i].name; });
    log(`MOTION step ${i + 1} name`, v || '(mate name)');
    if (qs('.step-pop') && this._mt?.sel === i) this.editMotionStep(i);
  }
  stepName(s, m) { return s.name || (m ? m.name : '(mate deleted)'); }
  // 0.1.134: click on a step name / bar — Ctrl = add / remove, Shift = range from the last clicked step; plain = this
  // step only (and its popup). Returns true when it was a selection click (no popup).
  stepSelect(i, e) {
    const mt = this._mt ??= { t: 0, playing: false, sel: -1 };
    const steps = this.motionSteps(), id = steps[i]?.id; if (!id) return true;
    mt.selIds ??= new Set();
    if (e.shiftKey && mt.anchor != null && steps[mt.anchor]) {
      const a = Math.min(mt.anchor, i), b = Math.max(mt.anchor, i), r = steps.slice(a, b + 1).map((s) => s.id);
      mt.selIds = new Set(e.ctrlKey ? [...mt.selIds, ...r] : r);
    } else if (e.ctrlKey) { if (mt.selIds.has(id)) mt.selIds.delete(id); else mt.selIds.add(id); mt.anchor = i; } else { mt.selIds = new Set([id]); mt.anchor = i; return false; }
    qs('.step-pop')?.remove(); mt.sel = -1;
    this.renderMotion();
    return true;
  }
  stepMenu(e, i) {
    e.preventDefault(); e.stopPropagation();
    const mt = this._mt ??= { t: 0, playing: false, sel: -1 }, steps = this.motionSteps(), s = steps[i];
    if (!s) return;
    if (!mt.selIds?.has(s.id)) { mt.selIds = new Set([s.id]); mt.anchor = i; this.renderMotion(); }
    const n = mt.selIds.size, many = n > 1 ? ` (${n})` : '';
    const m = this.doc.mates.find((k) => k.id === s.mate);
    contextMenu(e.clientX, e.clientY, [
      n === 1 ? { label: 'Edit Step…', icon: 'motion', run: () => this.editMotionStep(i) } : null,
      n === 1 ? { label: 'Rename…', run: () => this.renameMotionStep(i) } : null,
      m ? { label: `${this.studyFlips().has(m.id) ? 'Unflip' : 'Flip'} ${m.name} (in this study)`, icon: 'reciprocate', run: () => this.toggleStudyFlip(m.id) } : null,
      '-', { label: 'Delete Step' + (n > 1 ? 's' : '') + many, icon: 'delete', key: 'Del', run: () => this.deleteMotionSteps() },
    ]);
  }
  // a row "Suppress while editing" for a popup; refill = rebuild the popup afterwards
  freeRow(m, refill) {
    const cb = h('input', { type: 'checkbox', checked: !!m._free });
    cb.addEventListener('change', () => { this.freeMate(this.doc.mates.find((k) => k.id === m.id), cb.checked); setTimeout(refill, 0); });
    return h('div', { class: 'ap-row', title: 'Switch this mate and its Limits off for a moment, so you can drag the model where you want it and take the value with Current. It switches on again (keeping the pose) when you untick it, close the popup or press Play.' }, h('label', {}, 'Suppress while editing'), cb);
  }

  // ---------------- Drive (right-click a Distance / Angle mate) ----------------
  openDrive(m0) {
    closeDrive();
    const id = m0.id, mate = () => this.doc.mates.find((m) => m.id === id);
    if (!isDrivable(mate())) { toast('Drive works on Distance and Angle mates'); return; }
    const el = h('div', { class: 'ann-props app-pop drive-pop' });
    for (const ev of ['keydown', 'pointerdown', 'wheel', 'dblclick', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(el);
    const st = { anim: 0, msg: '', err: false };
    const range = () => {
      const m = mate();
      if (m.limits) return { min: Math.min(m.limits.min, m.limits.max), max: Math.max(m.limits.min, m.limits.max), own: true };
      if (!st.range) { const v = this.mateNow(m), r = m.type === 'angle' ? opt('asmDriveRangeDeg') : opt('asmDriveRangeMm'); st.range = { min: v - r, max: v + r }; }
      return { ...st.range, own: false };
    };
    const show = (res) => {
      const m = mate();
      const v = this.mateNow(m);
      if (res && res.status !== 'ok') { st.msg = `End of travel at ${fmt(v)}${unitOf(m)} — ${res.status === 'jump' ? 'the mechanism is at a dead point' : 'the mates cannot be held any further'}`; st.err = true; } else if (res) { st.msg = ''; st.err = false; }
      slider.value = String(v); num.value = fmt(v);
      msg.textContent = st.msg; msg.className = 'dp-msg' + (st.err ? ' err' : '');
    };
    const go = (v) => { const res = this.driveTo([{ id, value: v }], 'drive'); show(res); return res; };
    const stopAnim = () => { if (st.anim) cancelAnimationFrame(st.anim); st.anim = 0; };
    // play to a value; bounce = Reciprocate: then back to the other end, and again, until Pause (one undo step)
    const play = (to, bounce = false) => {
      stopAnim();
      const m = mate(), from = this.mateNow(m), r = range(), T = Math.max(0.05, (+time.value || opt('asmDriveTime')) * Math.abs(to - from) / Math.max(1e-9, r.max - r.min));
      const t0 = performance.now();
      const frame = () => {
        const f = Math.min(1, (performance.now() - t0) / 1000 / T);
        const res = go(from + (to - from) * f);
        if (res.status !== 'ok' || (f >= 1 && !bounce)) { st.anim = 0; this.endDriveSession(); setTimeout(fill, 0); return; }
        if (f >= 1) { const rr = range(); play(Math.abs(to - rr.max) < 1e-9 ? rr.min : rr.max, true); return; }
        st.anim = requestAnimationFrame(frame);
      };
      st.anim = requestAnimationFrame(frame);
    };
    let slider, num, msg, time;
    const fill = () => {
      const m = mate(); if (!m) return close();
      const r = range(), step = m.type === 'angle' ? 0.1 : 0.1;
      el.replaceChildren();
      el.append(h('div', { class: 'ap-head' }, h('b', {}, 'Drive'), h('span', { class: 'ap-val' }, `${m.name} (${this.refOwner(m.a)}, ${this.refOwner(m.b)})`), h('button', { class: 'ap-x', title: 'Close (Esc)', onclick: close }, '×')));
      const row = (label, input, title = '') => h('div', { class: 'ap-row' }, h('label', { title }, label), input);
      const lim = (k) => {
        const inp = h('input', { type: 'number', step: String(step), value: fmt(r[k]) });
        inp.addEventListener('change', () => {
          const v = +inp.value; if (!Number.isFinite(v)) return;
          const mm = mate();
          if (mm.limits) { if (mm.limits[k] === v) return; this.beginChange(); mm.limits = { ...mm.limits, [k]: v }; this.commit(); this.solve(); this.renderTree(); } else st.range = { ...range(), [k]: v };
          setTimeout(fill, 0);
        });
        return inp;
      };
      const setLim = (k, v) => { const mm = mate(); if (mm.limits) { if (mm.limits[k] === v) return; this.beginChange(); mm.limits = { ...mm.limits, [k]: v }; this.commit(); this.solve(); this.renderTree(); } else st.range = { ...range(), [k]: v }; log('MOTION drive', mm.name, k, v); setTimeout(fill, 0); };
      const withCur = (k) => h('div', { class: 'ap-two' }, lim(k), h('button', { title: 'Use the value the mate has now', onclick: () => setLim(k, +fmt(this.mateNow(mate()))) }, 'Current'));
      el.append(this.freeRow(m, fill));
      el.append(row('Minimum', withCur('min'), r.own ? 'The mate\'s limits (Edit Mate › Limits)' : 'Slider range for this drive (the mate has no limits)'));
      el.append(row('Maximum', withCur('max')));
      if (!r.own) {
        const save = h('button', { onclick: () => { this.beginChange(); mate().limits = { min: range().min, max: range().max }; this.commit(); this.solve(); this.renderTree(); setTimeout(fill, 0); } }, 'Use as Limits');
        el.append(h('div', { class: 'ap-info' }, 'This mate has no limits: it holds one value. ', save));
      }
      slider = h('input', { type: 'range', min: String(r.min), max: String(r.max), step: String(step), value: String(this.mateNow(m)) });
      slider.addEventListener('input', () => { stopAnim(); go(+slider.value); });
      slider.addEventListener('change', () => this.endDriveSession());
      num = h('input', { type: 'number', step: String(step), value: fmt(this.mateNow(m)) });
      num.addEventListener('change', () => { stopAnim(); const v = Math.max(r.min, Math.min(r.max, +num.value)); if (Number.isFinite(v)) { go(v); this.endDriveSession(); } });
      el.append(h('div', { class: 'ap-sec' }, m.type === 'angle' ? 'Angle' : 'Distance'));
      el.append(h('div', { class: 'ap-row' }, h('label', {}, 'Value' + unitOf(m)), num));
      el.append(h('div', { class: 'app-sl', style: 'margin:4px 8px' }, slider));
      time = h('input', { type: 'number', step: '0.5', min: '0.1', value: String(st.time ?? opt('asmDriveTime')) });
      time.addEventListener('change', () => { st.time = +time.value; });
      el.append(row('Time (s)', time, 'Time for the whole range when you press Play'));
      const B = (ic, label, run, title) => h('button', { class: 'ms-btn', title, onclick: run }, ic ? h('span', { html: icon(ic) }) : null, label || null);
      el.append(h('div', { class: 'dp-btns' },
        B('toStart', '', () => { stopAnim(); go(range().min); this.endDriveSession(); }, 'To the Minimum'),
        B(null, '◀ Play', () => play(range().min), 'Play back to the Minimum'),
        B('pause', '', () => { stopAnim(); this.endDriveSession(); }, 'Pause'),
        B(null, 'Play ▶', () => play(range().max), 'Play to the Maximum'),
        B('reciprocate', '', () => { const rr = range(), v = this.mateNow(mate()); play(Math.abs(v - rr.max) < Math.abs(v - rr.min) ? rr.min : rr.max, true); }, 'Reciprocate: back and forth between Minimum and Maximum until Pause'),
        B('toEnd', '', () => { stopAnim(); go(range().max); this.endDriveSession(); }, 'To the Maximum')));
      msg = h('div', { class: 'dp-msg' + (st.err ? ' err' : '') }, m._free ? 'Suppressed while editing: drag the model, then use Current. Untick to drive it again.' : st.msg);
      el.append(msg);
      if (m._free) for (const x of [slider, num, ...el.querySelectorAll('.dp-btns button')]) x.disabled = true;
    };
    // live value while the model is dragged (e.g. with the mate suppressed while editing)
    const unLive = this.addLive(() => { const m = mate(); if (!m || st.anim || !num) return; const v = this.mateNow(m); if (document.activeElement !== num) num.value = fmt(v); if (document.activeElement !== slider) slider.value = String(v); });
    const close = () => { stopAnim(); this.endDriveSession(); this.freeMate(mate(), false); unLive(); clearInterval(timer); document.removeEventListener('keydown', onKey, true); el.remove(); drivePop = null; };
    fill();
    const host = (this.viewSet?.root || this.vp.el).getBoundingClientRect(), e = opt('appPopEdgePx');
    el.style.left = Math.max(e, host.right - el.offsetWidth - e) + 'px'; el.style.top = host.top + e + 'px';
    makeDraggable(el, '.ap-head', 'monolith.drivePos');
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    const timer = setInterval(() => { const r = this.viewSet?.root; if (!mate() || (r && (!r.isConnected || !r.offsetParent))) close(); }, 500);
    drivePop = { close, el, fill };
    log('MOTION drive open', m0.name);
  }

  // ---------------- Motion Study timeline (under the view) ----------------
  motionSteps() { return this.doc.motion?.steps || []; }
  // 0.1.134: the mates the study drives, and the ones it flips (doc.motion.flips = mate ids, optional)
  studyIds() { return new Set(this.motionSteps().map((s) => s.mate)); }
  studyFlips() { return new Set(this.doc.motion?.flips || []); }
  // runtime flags of the study on the mates (open) or off (closed)
  studyFlags(on = !!this._motionOpen) {
    const ids = this.studyIds(), fl = this.studyFlips();
    for (const m of this.doc.mates) {
      if (on && ids.has(m.id) && fl.has(m.id)) m._flip = true; else delete m._flip;
      if (!on && ids.has(m.id)) delete m._drive;
    }
  }
  // put the study's values at the current time straight on its mates (after undo / redo: the restored doc has none)
  studyHold() {
    if (!this._motionOpen) return;
    this.studyFlags(true);
    const vals = valuesAt(this.motionSteps(), this._mt?.t || 0);
    for (const m of this.doc.mates) if (vals[m.id] != null) m._drive = vals[m.id];
  }
  toggleMotion(on = !this._motionOpen) {
    const was = !!this._motionOpen;
    this._motionOpen = on;
    if (!on) {
      qs('.step-pop')?.remove(); this.unfreeMates(); this.pauseMotion(false);
      if (was) { this.studyFlags(false); this.solve(); this.renderTree(); log('MOTION study closed: the model is back at the tree values'); }
    } else if (!was) {
      this.studyFlags(true);
      if (this.motionSteps().length) this.seekMotion(this._mt?.t || 0, true); // the model takes the study's pose
      this.renderTree();
    }
    this.renderMotion(); this.app.cm.refresh();
  }
  // Flip for this mate in the study only (the tree mate stays as it is); one undo step
  toggleStudyFlip(mateId) {
    const fl = this.studyFlips(), on = !fl.has(mateId);
    if (on) fl.add(mateId); else fl.delete(mateId);
    this.beginChange();
    const mo = { ...(this.doc.motion || { steps: [] }) };
    if (fl.size) mo.flips = [...fl]; else delete mo.flips;
    this.doc.motion = mo;
    this.commit();
    this.studyFlags(true);
    { const m = this.doc.mates.find((k) => k.id === mateId); if (m) delete m._drive; } // the walk starts from what the model reads now (180° off)
    log('MOTION flip', this.doc.mates.find((m) => m.id === mateId)?.name || mateId, on ? 'on' : 'off');
    if (this.motionSteps().length) this.seekMotion(this._mt?.t || 0, true); else this.solve();
    this.renderMotion();
  }
  renderMotion() {
    const el = this.app.el.motion, views = this.app.el.views;
    if (!el) return;
    if (!this._motionOpen) { if (isPopped(el)) dock(el); el.style.display = 'none'; el.replaceChildren(); views.style.bottom = ''; return; }
    const H = opt('asmMotionHeightPx'), rowH = opt('asmMotionRowPx'), namesW = opt('asmMotionNamesPx');
    const pop = isPopped(el); // 0.1.129: in its own window → the 3D view gets the full height
    el.style.display = 'flex'; el.style.height = pop ? '' : H + 'px'; views.style.bottom = pop ? '' : H + 'px';
    const mt = this._mt ??= { t: 0, playing: false, sel: -1, msg: '', err: false };
    const steps = this.motionSteps(), sch = schedule(steps), total = totalTime(steps);
    const mode = this.playMode();
    const setMode = (m) => { this.beginChange(); const mo = { ...(this.doc.motion || { steps: [] }), playback: mode === m ? 'normal' : m }; delete mo.loop; this.doc.motion = mo; this.commit(); log('MOTION playback', mo.playback); this.renderMotion(); };
    const B = (ic, label, run, o = {}) => h('button', { class: 'ms-btn' + (o.on ? ' on' : ''), title: o.tip || label, disabled: o.disabled, onclick: run }, h('span', { html: icon(ic) }), label || null);
    el.replaceChildren();
    el.append(h('div', { class: 'ms-bar' },
      h('span', { class: 'ms-title' }, 'Motion Study'),
      B('toStart', '', () => this.seekMotion(0, true), { tip: 'To the start', disabled: !steps.length }),
      mt.playing ? B('pause', 'Pause', () => this.pauseMotion(), { tip: 'Pause (the model stays where it is)' }) : B('play', 'Play', () => this.playMotion(), { tip: 'Play the steps', disabled: !steps.length }),
      B('toEnd', '', () => this.seekMotion(total, true), { tip: 'To the end', disabled: !steps.length }),
      B('loop', 'Loop', () => setMode('loop'), { on: mode === 'loop', tip: 'Loop: play again from the start at the end' }),
      B('reciprocate', 'Reciprocate', () => setMode('reciprocate'), { on: mode === 'reciprocate', tip: 'Reciprocate: play forward, then backward, and again — until Pause' }),
      this.speedSelect(),
      h('span', { class: 'ms-time' }, `${mt.t.toFixed(2)} / ${total.toFixed(2)} s`),
      B('plus', 'Add Step', () => this.addMotionStep(), { tip: 'Add a step: a Distance or Angle mate from one value to another' }),
      B('film', 'Save Animation', () => this.openSaveAnimation(), { tip: 'Save the motion as a video (MP4 / WebM) or an animated GIF', disabled: !steps.length || total <= 0 }),
      h('span', { class: 'ms-msg' + (mt.err ? ' err' : '') }, mt.msg || (steps.length ? '' : '')),
      h('button', { class: 'pop-btn' + (pop ? ' on' : ''), title: pop ? 'Back into the MonoLith window' : 'Open the Motion Study in its own window (you can move it onto another screen)', onclick: () => this.motionWindow(!pop) }, '⧉'),
      h('button', { class: 'ms-x', title: 'Close the Motion Study', onclick: () => this.toggleMotion(false) }, '×')));
    const body = h('div', { class: 'ms-body' });
    const names = h('div', { class: 'ms-names', style: { width: namesW + 'px' } }, h('div', { class: 'ms-head', style: { height: rowH + 'px' } }, steps.length ? 'Step' : ''));
    const track = h('div', { class: 'ms-track' });
    const span = Math.max(1, total * 1.08);
    const X = (t) => `${(t / span) * 100}%`;
    const ruler = h('div', { class: 'ms-ruler', style: { height: rowH + 'px' } });
    const tick = span > 60 ? 10 : span > 20 ? 5 : span > 8 ? 1 : 0.5;
    for (let t = 0; t <= span + 1e-9; t += tick) ruler.append(h('div', { class: 'ms-tick', style: { left: X(t) } }, `${+t.toFixed(1)}s`));
    track.append(ruler);
    if (!steps.length) names.append(h('div', { class: 'ms-empty' }, 'No steps yet. Add Step: pick a Distance or Angle mate (give it Limits in Edit Mate), its start and end value and the time.'));
    sch.forEach((s, i) => {
      const m = this.doc.mates.find((k) => k.id === s.mate);
      const label = `${i + 1}. ${this.stepName(s, m)}  ${fmt(s.from)} → ${fmt(s.to)}${m ? unitOf(m) : ''}${m && this.studyFlips().has(m.id) ? '  (flipped)' : ''}`;
      const on = mt.sel === i || !!mt.selIds?.has(s.id); // 0.1.134: several selected
      names.append(h('div', { class: 'ms-name' + (on ? ' sel' : ''), ondblclick: (e) => { e.stopPropagation(); this.renameMotionStep(i); }, style: { height: rowH + 'px' }, 'data-i': i, title: `${label}${s.name && m ? `\nMate: ${m.name}` : ''}\n${fmt(s.start)}–${fmt(s.end)} s\nClick to edit, double-click to rename; Ctrl / Shift+click to select several; drag up / down to change the order`, onpointerdown: (e) => this.stepRowDown(e, i), oncontextmenu: (e) => this.stepMenu(e, i) }, label));
      const r = h('div', { class: 'ms-row', 'data-i': i, style: { height: rowH + 'px' } });
      const col = on ? opt('asmMotionSelColor') : opt('asmMotionBarColor');
      const bar = h('div', { class: 'ms-stepbar' + (on ? ' sel' : ''), 'data-i': i, style: { left: X(s.start), width: X(s.end - s.start), background: col, color: col }, title: `${label}\nDrag to move it (also up / down to another row), drag an end to change its time; click to edit` });
      bar.addEventListener('pointermove', (e) => { if (!this._barDrag) bar.style.cursor = barEdge(bar, e) ? 'ew-resize' : 'grab'; });
      bar.addEventListener('pointerdown', (e) => this.stepBarDown(e, i, bar, span));
      bar.addEventListener('contextmenu', (e) => this.stepMenu(e, i));
      r.append(bar);
      track.append(r);
    });
    track.append(h('div', { class: 'ms-head-line', style: { left: X(mt.t), background: opt('asmMotionHeadColor') } }));
    // scrub on the ruler
    ruler.addEventListener('pointerdown', (e) => {
      if (!steps.length) return;
      e.preventDefault();
      if (this._mt?.playing) { this.pauseMotion(); return; } // pausing rebuilds the strip
      try { ruler.setPointerCapture(e.pointerId); } catch { return; }
      this.unfreeMates();
      this.pauseMotion(false);
      const at = (ev) => { const b = ruler.getBoundingClientRect(); return Math.max(0, Math.min(total, ((ev.clientX - b.left) / b.width) * span)); };
      this.seekMotion(at(e));
      const mv = (ev) => this.seekMotion(at(ev));
      const up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); this.endDriveSession(); };
      ruler.addEventListener('pointermove', mv); ruler.addEventListener('pointerup', up);
    });
    body.append(names, track);
    el.append(body);
    this.motionGrips(el, body, H, namesW); // 0.1.128: drag the top edge / the line after the names
    if (pop) el.querySelector('.ms-resize')?.remove();
    else if (wantsPop(MOTION_WIN) && this.app.isActive?.()) setTimeout(() => this.motionWindow(true, false), 0); // it was a window last time
    for (const ev of ['keydown', 'wheel', 'dblclick', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
  }
  // row under the mouse (list order) for reordering: index of the row the step would move to, or -1 outside
  stepRowAt(y) {
    const rows = [...this.app.el.motion.querySelectorAll('.ms-row')];
    if (!rows.length) return -1;
    const r0 = rows[0].getBoundingClientRect(), rh = r0.height || 1;
    return Math.max(0, Math.min(rows.length - 1, Math.floor((y - r0.top) / rh)));
  }
  // mark the row a dragged step will move to (orange = what will be), -1 = none
  markDropRow(j, from) {
    for (const el of this.app.el.motion.querySelectorAll('.ms-row, .ms-name')) {
      const k = +el.dataset.i, on = j >= 0 && j !== from && k === j;
      el.classList.toggle('drop', on); el.classList.toggle('drop-up', on && j < from); el.classList.toggle('drop-down', on && j > from);
      el.style.setProperty('--drop', opt('asmMotionDropColor'));
    }
  }
  // 0.1.124: drag a step bar — middle = move (its own start time, free of the other steps) and up / down to another
  // row (list order), an end = change its start or its time. Snaps to the ends of the other bars / time 0 / the time
  // line (asmMotionSnapPx) and else to asmMotionSnapS. Only the bars move while dragging (rebuilding the strip would end
  // the drag); one undo step; a click without moving opens the step popup.
  stepBarDown(e, i, bar, span) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    // 0.1.124: while playing the first click only pauses (pausing rebuilds the strip → this bar is gone; setPointerCapture
    // on it threw InvalidStateError in 0.1.122/0.1.123)
    if (this._mt?.playing) { this.pauseMotion(); return; }
    try { bar.setPointerCapture(e.pointerId); } catch { return; }
    const kind = barEdge(bar, e) || 'move', mt = this._mt, mods = { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey };
    const steps0 = this.motionSteps().map((s) => ({ ...s })), sch0 = schedule(steps0), s0 = sch0[i];
    // 0.1.134: dragging one of several selected bars moves them all (same time shift; no reorder)
    const group = kind === 'move' && !mods.shiftKey && !mods.ctrlKey && mt?.selIds?.has(steps0[i].id) && mt.selIds.size > 1 ? steps0.map((s, j) => (mt.selIds.has(s.id) ? j : -1)).filter((j) => j >= 0) : [i];
    const minStart = Math.min(...group.map((j) => sch0[j].start));
    const trackW = bar.parentElement.getBoundingClientRect().width || 1, pxPerS = trackW / span;
    const tolS = opt('asmMotionSnapPx') / pxPerS, grid = opt('asmMotionSnapS'), minDur = opt('asmMotionMinDur');
    const targets = [0, mt?.t || 0, ...sch0.filter((_, j) => j !== i).flatMap((s) => [s.start, s.end])];
    const x0 = e.clientX, y0 = e.clientY, rowH = bar.parentElement.getBoundingClientRect().height || 1;
    let moved = false, cur = null, toRow = -1;
    this._barDrag = true;
    const place = (ev) => {
      const dt = (ev.clientX - x0) / pxPerS;
      let start = s0.start, dur = s0.end - s0.start;
      if (kind === 'move') {
        const raw = Math.max(s0.start - minStart, s0.start + dt);
        const a = snapTime(raw, targets, tolS, 0), b = snapTime(raw + dur, targets, tolS, 0) - dur;
        start = a !== raw && (b === raw || Math.abs(a - raw) <= Math.abs(b - raw)) ? a : b !== raw ? b : grid > 0 ? Math.round(raw / grid) * grid : raw;
        start = Math.max(s0.start - minStart, start);
        toRow = group.length === 1 && Math.abs(ev.clientY - y0) > rowH / 2 ? this.stepRowAt(ev.clientY) : -1;
      } else if (kind === 'end') {
        dur = Math.max(minDur, snapTime(s0.end + dt, targets, tolS, grid) - s0.start);
      } else {
        start = Math.max(0, Math.min(s0.end - minDur, snapTime(s0.start + dt, targets, tolS, grid)));
        dur = s0.end - start;
      }
      const steps = steps0.map((s) => ({ ...s }));
      steps[i] = { ...steps[i], ...placeStep(steps0, i, start, dur) };
      delete steps[i].after; delete steps[i].delay;
      for (const j of group) if (j !== i) { steps[j] = { ...steps[j], start: +(sch0[j].start + start - s0.start).toFixed(6), dur: sch0[j].end - sch0[j].start }; delete steps[j].after; delete steps[j].delay; }
      this.doc.motion = { ...this.doc.motion, steps };
      cur = schedule(steps)[i];
      // only the bars and the texts move
      const sch = schedule(steps), X = (t) => `${(t / span) * 100}%`;
      for (const b of this.app.el.motion.querySelectorAll('.ms-stepbar')) { const s = sch[+b.dataset.i]; if (s) { b.style.left = X(s.start); b.style.width = X(s.end - s.start); } }
      bar.style.transform = toRow >= 0 && toRow !== i ? `translateY(${(toRow - i) * rowH}px)` : '';
      this.markDropRow(toRow, i);
      const msg = this.app.el.motion.querySelector('.ms-msg');
      if (msg) { msg.className = 'ms-msg'; msg.textContent = `Step ${i + 1}: ${fmt(cur.start)} – ${fmt(cur.end)} s (${fmt(cur.end - cur.start)} s)${toRow >= 0 && toRow !== i ? ` → row ${toRow + 1}` : ''}`; }
      const tm = this.app.el.motion.querySelector('.ms-time'); if (tm) tm.textContent = `${(mt?.t || 0).toFixed(2)} / ${totalTime(steps).toFixed(2)} s`;
    };
    const mv = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < opt('asmMotionDragPx')) return;
      if (!moved) { moved = true; this.beginChange(); bar.style.cursor = kind === 'move' ? 'grabbing' : 'ew-resize'; }
      place(ev);
    };
    const up = () => {
      bar.removeEventListener('pointermove', mv); bar.removeEventListener('pointerup', up); bar.removeEventListener('pointercancel', up);
      this._barDrag = false;
      if (!moved) { if (!this.stepSelect(i, mods)) this.editMotionStep(i); return; }
      let j = i;
      if (toRow >= 0 && toRow !== i) { this.doc.motion = { ...this.doc.motion, steps: moveStep(this.doc.motion.steps, i, toRow) }; j = toRow; }
      const changed = JSON.stringify(this.doc.motion.steps) !== JSON.stringify(steps0);
      if (changed) {
        this.commit();
        log(`MOTION step ${i + 1} ${kind === 'move' ? 'moved' : 'time'}: ${fmt(cur.start)}–${fmt(cur.end)} s${j !== i ? `, now step ${j + 1}` : ''}${group.length > 1 ? ` (with ${group.length - 1} other selected step${group.length > 2 ? 's' : ''})` : ''}`);
      } else this._last = null;
      if (mt) { mt.msg = ''; if (mt.sel === i) mt.sel = j; }
      this.renderMotion();
      if (qs('.step-pop') && mt?.sel === j) this.editMotionStep(j);
    };
    bar.addEventListener('pointermove', mv); bar.addEventListener('pointerup', up); bar.addEventListener('pointercancel', up);
  }
  // 0.1.124: a step name: click = edit, drag up / down = change the order (one undo step)
  stepRowDown(e, i) {
    if (e.button !== 0) return;
    const row = e.currentTarget, y0 = e.clientY, mt = this._mt, mods = { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey };
    if (mt?.playing) { this.pauseMotion(); return; }
    try { row.setPointerCapture(e.pointerId); } catch { return; }
    let moved = false, toRow = -1;
    const mv = (ev) => {
      if (!moved && Math.abs(ev.clientY - y0) < opt('asmMotionDragPx')) return;
      moved = true; row.style.cursor = 'grabbing';
      toRow = this.stepRowAt(ev.clientY);
      row.style.transform = `translateY(${ev.clientY - y0}px)`; row.classList.add('dragging');
      this.markDropRow(toRow, i);
    };
    const up = () => {
      row.removeEventListener('pointermove', mv); row.removeEventListener('pointerup', up); row.removeEventListener('pointercancel', up);
      if (!moved) { if (!this.stepSelect(i, mods)) this.editMotionStep(i); return; }
      if (toRow >= 0 && toRow !== i) {
        this.setMotionSteps((st) => { const n = moveStep(st, i, toRow); st.splice(0, st.length, ...n); });
        log(`MOTION step ${i + 1} -> ${toRow + 1} (order)`);
        if (mt && mt.sel === i) mt.sel = toRow;
        if (qs('.step-pop')) this.editMotionStep(toRow);
      } else this.renderMotion();
    };
    row.addEventListener('pointermove', mv); row.addEventListener('pointerup', up); row.addEventListener('pointercancel', up);
  }
  // move the model to time t (one drive move; end = also close the session)
  // how (0.1.135): 'play' | 'anim' (see driveOpts); from = the time the model is at now (Play: when the solve time of
  // this frame is used up, the playhead stays where the model got to and the rest follows next frame)
  seekMotion(t, end = false, how = null, from = null) {
    const mt = this._mt ??= { t: 0, playing: false, sel: -1 };
    const steps = this.motionSteps();
    if (!steps.length) return null;
    mt.t = Math.max(0, Math.min(totalTime(steps), t));
    const vals = valuesAt(steps, mt.t);
    const res = this.driveTo(Object.entries(vals).map(([id, value]) => ({ id, value })), 'motion', how);
    if (res.budget && from != null) mt.t = from + res.part * (mt.t - from);
    if (res.status !== 'ok') this.motionHeld(res);
    else if (mt.err) { mt.msg = ''; mt.err = false; }
    if (end) this.endDriveSession();
    this.renderMotionTime();
    return res;
  }
  motionHeld(res) {
    const mt = this._mt;
    const m = this.doc.mates.find((k) => res.values && k._drive != null);
    mt.msg = `Stopped at ${mt.t.toFixed(2)} s: end of travel — ${res.status === 'jump' ? 'the mechanism is at a dead point' : 'the mates cannot be held any further'}${m ? ` (${m.name} ${fmt(m._drive)}${unitOf(m)})` : ''}`;
    mt.err = true;
  }
  // light update while playing / scrubbing (no full rebuild of the strip)
  renderMotionTime() {
    const el = this.app.el.motion; if (!el || !this._motionOpen) return;
    const steps = this.motionSteps(), total = totalTime(steps), span = Math.max(1, total * 1.08);
    const tm = el.querySelector('.ms-time'); if (tm) tm.textContent = `${this._mt.t.toFixed(2)} / ${total.toFixed(2)} s`;
    const hl = el.querySelector('.ms-head-line'); if (hl) hl.style.left = `${(this._mt.t / span) * 100}%`;
    const msg = el.querySelector('.ms-msg'); if (msg) { msg.textContent = this._mt.msg || ''; msg.className = 'ms-msg' + (this._mt.err ? ' err' : ''); }
  }
  // 0.1.129: the Motion Study in its own window (on: open / back; forget: the user docked it → not a window next time)
  motionWindow(on, forget = true) {
    const el = this.app.el.motion;
    if (!el || !this._motionOpen) return;
    if (on && !isPopped(el)) {
      popOut(el, { key: MOTION_WIN, fill: true, title: `Motion Study — ${this.doc.name}`, size: [el.offsetWidth, opt('asmMotionHeightPx')],
        onUserClose: () => this.toggleMotion(false), onDock: () => setTimeout(() => this.renderMotion(), 0) });
      this.renderMotion(); this.vp?.requestRender?.();
    } else if (!on && isPopped(el)) dock(el, { forget });
  }
  // 0.1.128: drag the strip's top edge (height) and the line after the step names (column width); live while dragging,
  // stored as the Options values asmMotionHeightPx / asmMotionNamesPx on release (so they are remembered and logged)
  motionGrips(el, body, H, namesW) {
    const views = this.app.el.views;
    const lim = (k) => OPTIONS_DEF.find((d) => d.key === k) || {};
    const drag = (grip, e, move, done) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      try { grip.setPointerCapture(e.pointerId); } catch { /* detached */ }
      grip.classList.add('on');
      const x0 = e.clientX, y0 = e.clientY;
      let last = null;
      const mv = (ev) => { last = move(ev.clientX - x0, ev.clientY - y0); };
      const up = () => { grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up); grip.classList.remove('on'); if (last != null) done(last); };
      grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    };
    const top = h('div', { class: 'ms-resize', title: 'Drag to make the Motion Study taller or lower' });
    top.addEventListener('pointerdown', (e) => {
      const L = lim('asmMotionHeightPx'), room = (this.app.el.views.parentElement?.clientHeight || 800) - opt('asmMotionMinViewPx');
      drag(top, e, (dx, dy) => { const v = Math.round(Math.max(L.min ?? 90, Math.min(L.max ?? 900, room, H - dy))); el.style.height = v + 'px'; views.style.bottom = v + 'px'; this.vp?.requestRender?.(); return v; },
        (v) => { this.app.applyOptions({ asmMotionHeightPx: v }); log('MOTION timeline height', v, 'px'); });
    });
    const col = h('div', { class: 'ms-colgrip', title: 'Drag to change the width of the step names', style: { left: namesW - 6 + 'px' } }); // inside the names column (a bar's start grip is right of the line)
    col.addEventListener('pointerdown', (e) => {
      const L = lim('asmMotionNamesPx'), names = body.querySelector('.ms-names');
      drag(col, e, (dx) => { const v = Math.round(Math.max(L.min ?? 120, Math.min(L.max ?? 800, (el.clientWidth || 1000) - 150, namesW + dx))); names.style.width = v + 'px'; col.style.left = v - 6 + 'px'; return v; },
        (v) => { this.app.applyOptions({ asmMotionNamesPx: v }); log('MOTION names width', v, 'px'); });
    });
    el.append(top); body.append(col);
  }
  // 0.1.126: Playback Speed (doc.motion.speed, optional; 1 = real time) — Play runs the timeline at this speed,
  // Save Animation starts with it
  playSpeed() { const v = +this.doc.motion?.speed; return v > 0 ? v : +opt('asmMotionSpeed') || 1; }
  speedSelect() {
    const cur = this.playSpeed(), list = speedChoices().map(([v, t]) => [+v, t]);
    if (!list.some(([v]) => Math.abs(v - cur) < 1e-9)) list.push([cur, fmtSpeed(cur)]);
    list.sort((a, b) => a[0] - b[0]);
    const sel = h('select', { class: 'ms-speed-sel' }, ...list.map(([v, t]) => h('option', { value: String(v), selected: Math.abs(v - cur) < 1e-9 }, t)));
    sel.addEventListener('change', () => this.setPlaySpeed(+sel.value));
    return h('label', { class: 'ms-speed', title: 'Playback Speed: 1× = real time, 0.5× = half as fast, 2× = twice as fast (saved with the assembly; Save Animation starts with it)' }, 'Speed', sel);
  }
  setPlaySpeed(v) {
    if (!(v > 0) || Math.abs(v - this.playSpeed()) < 1e-9) return;
    this.beginChange();
    const mo = { ...(this.doc.motion || { steps: [], playback: 'normal' }), speed: v };
    this.doc.motion = mo;
    this.commit();
    log('MOTION playback speed', fmtSpeed(v));
    this.renderMotion();
  }
  // playback mode: 'normal' | 'loop' | 'reciprocate' (back and forth); 0.1.119 files had loop: true
  playMode() { const mo = this.doc.motion; return mo?.playback || (mo?.loop ? 'loop' : 'normal'); }
  playMotion() {
    const steps = this.motionSteps(), total = totalTime(steps);
    if (!steps.length || total <= 0) return;
    this.unfreeMates();
    const mt = this._mt ??= { t: 0, playing: false, sel: -1 };
    const mode = this.playMode();
    if (mode === 'reciprocate') { if (mt.t >= total - 1e-9) mt.dir = -1; else if (mt.t <= 1e-9 || !mt.dir) mt.dir = 1; } else { mt.dir = 1; if (mt.t >= total - 1e-9) mt.t = 0; }
    mt.playing = true; mt.msg = ''; mt.err = false;
    this.renderMotion();
    log('MOTION play from', mt.t.toFixed(2), 's,', steps.length, 'steps,', total.toFixed(2), 's' + (this.playSpeed() !== 1 ? `, speed ${fmtSpeed(this.playSpeed())}` : ''));
    let last = performance.now();
    mt.slow = { frames: 0, cut: 0, real: 0, motion: 0, win: [] }; // 0.1.135: frames whose solve time was used up
    const frame = () => {
      if (!mt.playing) return;
      const now = performance.now(), dt = Math.min((now - last) / 1000, opt('asmMotionMaxDt'));
      last = now;
      const mode = this.playMode(), from = mt.t;
      let t = mt.t + (mt.dir || 1) * dt * this.playSpeed(), wrap = false;
      if (mode === 'reciprocate') { // turn round at both ends
        if (t >= total) { t = Math.max(0, 2 * total - t); mt.dir = -1; wrap = true; }
        else if (t <= 0) { t = Math.min(total, -t); mt.dir = 1; wrap = true; }
      } else if (t >= total) { if (mode === 'loop') { t -= total; wrap = true; } else t = total; }
      const res = this.seekMotion(t, false, 'play', wrap ? null : from);
      if (res) this.playSlow(res, dt, wrap ? dt * this.playSpeed() : Math.abs(mt.t - from));
      if (res && res.status !== 'ok') { this.pauseMotion(); toast(mt.msg, 'warn', 4000); return; }
      if (t >= total && !wrap && mode === 'normal') { this.pauseMotion(); return; }
      mt.anim = requestAnimationFrame(frame);
    };
    mt.anim = requestAnimationFrame(frame);
  }
  // 0.1.135: Play could not solve the whole move of some frames within the time budget → the motion runs slower than
  // the Playback Speed; the strip says so (effective speed over the last frames) and pause logs it once
  playSlow(res, dt, moved) {
    const sl = this._mt?.slow; if (!sl) return;
    sl.frames++; sl.real += dt; sl.motion += moved;
    if (res.budget) sl.cut++;
    sl.win.push([dt, moved, !!res.budget]); if (sl.win.length > 30) sl.win.shift();
    const cutNow = sl.win.some((w) => w[2]), mt = this._mt;
    if (cutNow && !mt.err) {
      const real = sl.win.reduce((a, w) => a + w[0], 0), mot = sl.win.reduce((a, w) => a + w[1], 0);
      mt.msg = `Playing at about ${fmtSpeed(Math.max(0.01, +(mot / Math.max(1e-6, real)).toPrecision(2)))} instead of ${fmtSpeed(this.playSpeed())} — solving the mates takes longer than one frame at this speed`;
      mt.slowMsg = true;
    } else if (!cutNow && mt.slowMsg) { mt.msg = ''; mt.slowMsg = false; }
  }
  // pause: the model stays where it is (one undo step for what was played)
  pauseMotion(render = true) {
    const mt = this._mt; if (!mt) return;
    if (mt.anim) cancelAnimationFrame(mt.anim);
    mt.anim = 0;
    const was = mt.playing; mt.playing = false;
    const sl = mt.slow; mt.slow = null;
    if (was && sl?.cut) log(`MOTION play: solve time per frame (${opt('asmPlayBudgetMs')} ms) used up in ${sl.cut} of ${sl.frames} frames — played at about ${fmtSpeed(+(sl.motion / Math.max(1e-6, sl.real)).toPrecision(2))} instead of ${fmtSpeed(this.playSpeed())}`);
    if (mt.slowMsg) { mt.msg = ''; mt.slowMsg = false; }
    if (this._drv?.kind === 'motion') this.endDriveSession();
    if (was) log('MOTION pause at', mt.t.toFixed(2), 's');
    if (render) this.renderMotion();
  }
  // steps: one undo step per change
  setMotionSteps(fn) {
    this.beginChange();
    const mo = this.doc.motion ? { ...this.doc.motion, steps: [...this.doc.motion.steps] } : { steps: [], playback: 'normal' };
    fn(mo.steps);
    this.doc.motion = mo;
    this.commit();
    this.renderMotion();
  }
  addMotionStep() {
    const drivable = this.doc.mates.filter(isDrivable);
    if (!drivable.length) { toast('Add a Distance or Angle mate first (give it Limits in Edit Mate to set its range)', 'warn', 4000); return; }
    const selM = this.sel.map((s) => s.kind === 'mate' && this.doc.mates.find((m) => m.id === s.id)).find(isDrivable);
    const steps = this.motionSteps(), lastSame = (id) => [...steps].reverse().find((s) => s.mate === id);
    const m = selM || this.doc.mates.find((k) => k.id === steps[steps.length - 1]?.mate && isDrivable(k)) || drivable[0];
    const from = lastSame(m.id)?.to ?? this.mateNow(m);
    let to;
    if (m.limits) { const lo = Math.min(m.limits.min, m.limits.max), hi = Math.max(m.limits.min, m.limits.max); to = Math.abs(from - hi) > Math.abs(from - lo) ? hi : lo; } else to = from + (m.type === 'angle' ? opt('asmLimitDefDeg') : opt('asmLimitDefMm'));
    const step = { id: 's' + Date.now().toString(36), mate: m.id, from: +fmt(from), to: +fmt(to), start: +fmt(totalTime(steps)), dur: opt('asmDriveTime'), ease: opt('asmMotionSmooth') ? 'smooth' : 'linear' };
    this.setMotionSteps((st) => st.push(step));
    log('MOTION add step', m.name, step.from, '->', step.to, step.dur + ' s');
    this.editMotionStep(this.motionSteps().length - 1);
  }
  // popup to edit step i (compact popup style)
  editMotionStep(i) {
    qs('.step-pop')?.remove();
    if (!drivePop) this.unfreeMates(); // the old popup's mate (a Drive popup keeps its own)
    const mt = this._mt ??= { t: 0, playing: false, sel: -1 };
    mt.sel = i; this.renderMotion();
    const el = h('div', { class: 'ann-props app-pop step-pop' });
    for (const ev of ['keydown', 'pointerdown', 'wheel', 'dblclick', 'contextmenu']) el.addEventListener(ev, (e) => e.stopPropagation());
    document.body.appendChild(el);
    let unLive = () => {};
    const close = () => { const s0 = this.motionSteps()[i]; el.remove(); unLive(); document.removeEventListener('keydown', onKey, true); if (s0) this.freeMate(this.doc.mates.find((k) => k.id === s0.mate), false); if (mt.sel === i) { mt.sel = -1; this.renderMotion(); } };
    // re-fill after the event (removing a focused input fires blur/change again)
    const later = () => setTimeout(fill, 0);
    const set = (k, v) => {
      const cur = this.motionSteps()[i]; if (!cur || cur[k] === v) return;
      this.setMotionSteps((st) => { st[i] = { ...st[i], [k]: v }; if (k === 'start') { delete st[i].after; delete st[i].delay; } });
      log(`MOTION step ${i + 1} ${k}`, k === 'mate' ? this.doc.mates.find((m) => m.id === v)?.name || v : v);
      later();
    };
    const fill = () => {
      const s = this.motionSteps()[i];
      if (!s) return close();
      const m = this.doc.mates.find((k) => k.id === s.mate);
      el.replaceChildren();
      el.append(h('div', { class: 'ap-head' }, h('b', {}, `Step ${i + 1}`), h('span', { class: 'ap-val' }, m?.name || ''), h('button', { class: 'ap-x', title: 'Close (Esc)', onclick: close }, '×')));
      const row = (label, input) => h('div', { class: 'ap-row' }, h('label', {}, label), input);
      // 0.1.123: suppressed mates stay in the list (marked) — else the list showed another mate than the step's
      const sel = h('select', {}, ...this.doc.mates.filter(isValueMate).map((k) => h('option', { value: k.id, selected: k.id === s.mate }, `${k.name} (${this.refOwner(k.a)}, ${this.refOwner(k.b)})${k.suppressed ? ' — suppressed' : ''}`)));
      sel.addEventListener('change', () => { const old = this.doc.mates.find((k) => k.id === s.mate); this.freeMate(old, false); set('mate', sel.value); });
      const nameIn = h('input', { type: 'text', value: s.name || '', placeholder: m?.name || '' });
      nameIn.addEventListener('change', () => { const v = nameIn.value.trim(); this.setMotionSteps((st) => { st[i] = { ...st[i] }; if (v && v !== m?.name) st[i].name = v; else delete st[i].name; }); log(`MOTION step ${i + 1} name`, v || '(mate name)'); later(); });
      el.append(row('Name', nameIn), row('Mate', sel)); // 0.1.134: own step name
      if (m?.suppressed) el.append(h('div', { class: 'ap-info err' }, `${m.name} is suppressed in the tree: this step does nothing until you unsuppress it.`));
      if (m && !m.suppressed) el.append(this.freeRow(m, fill));
      const now = h('span', { class: 'ap-now' }, m ? `${fmt(this.mateNow(m))}${unitOf(m)}` : '–');
      if (m) el.append(h('div', { class: 'ap-row', title: 'The value the mate has now (follows the model while you drag it)' }, h('label', {}, 'Now'), now));
      const pos = (k) => k === 'dur' || k === 'start';
      const numIn = (k, stepv = '0.1') => { const inp = h('input', { type: 'number', step: stepv, value: String(k === 'start' ? fmt(schedule(this.motionSteps())[i]?.start ?? 0) : s[k] ?? 0), min: pos(k) ? 0 : undefined }); inp.addEventListener('change', () => { const v = +inp.value; if (Number.isFinite(v)) set(k, pos(k) ? Math.max(0, v) : v); }); return inp; };
      const withCur = (k) => h('div', { class: 'ap-two' }, numIn(k), h('button', { title: 'Use the value the mate has now', onclick: () => m && set(k, +fmt(this.mateNow(m))) }, 'Current'));
      const u = m ? unitOf(m).trim() : '';
      el.append(row(`From (${u})`, withCur('from')), row(`To (${u})`, withCur('to')), row('Time (s)', numIn('dur', '0.5')));
      // 0.1.124: own start time; the buttons put it right after / together with the step above it (in the list)
      const sch = schedule(this.motionSteps()), prev = sch[i - 1];
      el.append(row('Start (s)', numIn('start', '0.1')));
      el.append(h('div', { class: 'ap-row' }, h('label', {}, ''), h('div', { class: 'ap-two' },
        h('button', { disabled: !prev, title: 'Start when the step above ends', onclick: () => set('start', +fmt(prev.end)) }, 'After previous'),
        h('button', { disabled: !prev, title: 'Start together with the step above', onclick: () => set('start', +fmt(prev.start)) }, 'With previous'))));
      const ease = h('select', {}, h('option', { value: 'smooth', selected: s.ease !== 'linear' }, 'Smooth start and end'), h('option', { value: 'linear', selected: s.ease === 'linear' }, 'Constant speed'));
      ease.addEventListener('change', () => set('ease', ease.value));
      el.append(row('Motion', ease));
      if (m) { // 0.1.134: Flip for this study only
        const fl = this.studyFlips().has(m.id);
        el.append(h('div', { class: 'ap-row', title: m.type === 'angle' ? 'Measure the angle the other way round (180° further), only in this Motion Study — the mate in the tree is not changed' : 'Measure the distance to the other side, only in this Motion Study — the mate in the tree is not changed' },
          h('label', {}, 'Flip'), h('button', { class: fl ? 'on' : '', onclick: () => { this.toggleStudyFlip(m.id); later(); } }, fl ? 'Flipped (click to undo)' : 'Flip')));
        el.append(h('div', { class: 'ap-info' }, `In the Motion Study ${m.name} follows the timeline only: its value${m.limits ? ' and Limits' : ''} in the tree do not apply, and playing does not change the tree. Closing the study puts the model back.`));
      }
      const n = this.motionSteps().length;
      el.append(h('div', { class: 'ap-btns' },
        h('button', { disabled: i === 0, onclick: () => { this.setMotionSteps((st) => { [st[i - 1], st[i]] = [st[i], st[i - 1]]; }); i--; mt.sel = i; this.renderMotion(); later(); } }, 'Move up'),
        h('button', { disabled: i >= n - 1, onclick: () => { this.setMotionSteps((st) => { [st[i + 1], st[i]] = [st[i], st[i + 1]]; }); i++; mt.sel = i; this.renderMotion(); later(); } }, 'Move down'),
        h('button', { onclick: () => { close(); this.deleteMotionStep(i); } }, 'Delete')));
      unLive(); unLive = this.addLive(() => { if (!el.isConnected) { unLive(); return; } if (m && now.isConnected) now.textContent = `${fmt(this.mateNow(m))}${unitOf(m)}`; });
    };
    fill();
    const host = (this.viewSet?.root || this.vp.el).getBoundingClientRect(), e = opt('appPopEdgePx');
    el.style.left = Math.max(e, host.right - el.offsetWidth - e) + 'px'; el.style.top = host.top + e + 'px';
    makeDraggable(el, '.ap-head', 'monolith.stepPos');
    const onKey = (ev) => {
      if (!el.isConnected) { document.removeEventListener('keydown', onKey, true); unLive(); return; } // popup removed from outside
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
      else if (ev.key === 'Delete' && !inField(ev.target)) { ev.stopPropagation(); ev.preventDefault(); const sid = this.motionSteps()[i]?.id, ids = mt.selIds?.has(sid) && mt.selIds.size > 1 ? [...mt.selIds] : [sid]; close(); this.deleteMotionSteps(ids); }
    };
    document.addEventListener('keydown', onKey, true);
  }
}
