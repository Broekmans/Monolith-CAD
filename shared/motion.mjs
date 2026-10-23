// Motion Study timing (pure). Since 0.1.124 every step has its own start time: steps [{id, mate, from, to, start (s),
// dur (s), ease?}]; the list order is only the order of the rows. Files of assembly format 1 (0.1.119–0.1.123) had
// after (true = when the previous step ends, false = with the previous step) + delay instead of start — they are
// converted when opened (shared/format.mjs → toAbsolute); schedule() still reads that form for safety.
export function schedule(steps) {
  const out = [];
  let prevStart = 0, prevEnd = 0;
  (steps || []).forEach((s, i) => {
    let start;
    if (Number.isFinite(+s.start) && s.start !== null && s.start !== undefined) start = Math.max(0, +s.start);
    else start = (i && s.after === false ? prevStart : i ? prevEnd : 0) + Math.max(0, +s.delay || 0); // old form
    const end = start + Math.max(0, +s.dur || 0);
    out.push({ ...s, i, start, end });
    prevStart = start; prevEnd = Math.max(prevEnd, end);
  });
  return out;
}
// old form (after / with + delay) → own start times, the motion stays the same
export function toAbsolute(steps) {
  return schedule(steps).map(({ i, end, after, delay, base, ...s }) => ({ ...s, start: +s.start.toFixed(6) }));
}
export const totalTime = (steps) => schedule(steps).reduce((t, s) => Math.max(t, s.end), 0);
const ease = (f, kind) => (kind === 'linear' || !kind ? f : f * f * (3 - 2 * f)); // 'smooth' = ease in/out
// per mate: its steps in time order (same start: list order); a step that starts while the one before it on the same
// mate is still running starts from where that one is then (no jump), else from its own "from"
function mateTracks(steps) {
  const byMate = new Map();
  for (const s of schedule(steps)) { if (!byMate.has(s.mate)) byMate.set(s.mate, []); byMate.get(s.mate).push(s); }
  for (const list of byMate.values()) {
    list.sort((a, b) => a.start - b.start || a.i - b.i);
    let prev = null;
    for (const s of list) { s.from0 = prev && s.start < prev.end - 1e-12 ? at(prev, s.start) : s.from; prev = s; }
  }
  return byMate;
}
function at(s, t) {
  const f = s.end > s.start ? Math.min(1, Math.max(0, (t - s.start) / (s.end - s.start))) : 1;
  const from = s.from0 ?? s.from;
  return from + (s.to - from) * ease(f, s.ease);
}
// values {mateId: value} at time t: per mate the last step that has started; before its first step: that step's
// "from"; inside a step: in between; after it: its "to"
export function valuesAt(steps, t) {
  const vals = {};
  for (const [mate, list] of mateTracks(steps)) {
    let v = list[0].from;
    for (const s of list) { if (t < s.start) break; v = at(s, t); }
    vals[mate] = v;
  }
  return vals;
}
// 0.1.124: step i dragged on the timeline → its new {start, dur} (no link to the other steps any more)
export function placeStep(steps, i, start, dur) {
  const r = (x) => Math.round(x * 1e6) / 1e6;
  return { start: r(Math.max(0, start)), dur: r(Math.max(0, dur)) };
}
// list order: move step i to position j (the times stay)
export function moveStep(steps, i, j) {
  const out = [...steps];
  j = Math.max(0, Math.min(out.length - 1, j));
  const [s] = out.splice(i, 1);
  out.splice(j, 0, s);
  return out;
}
// snap a time: to the nearest target within `tolS`, else to the grid step `grid` (0 = no grid)
export function snapTime(t, targets, tolS, grid) {
  let best = null, bd = tolS;
  for (const x of targets) { const dd = Math.abs(x - t); if (dd <= bd) { bd = dd; best = x; } }
  if (best != null) return best;
  return grid > 0 ? Math.round(t / grid) * grid : t;
}
// Save Animation: the motion times of all frames. range 'once' = 0 … total, 'reciprocate' = 0 … total … 0 (one
// back-and-forth cycle). 0.1.125: loops = that many cycles one after the other ('once' starts again at 0 like Loop
// playback). The last frame of a back-and-forth run is left out so a looping GIF / video does not show the start twice;
// a 'once' run ends on its last frame (total).
// 0.1.126: speed = motion seconds per video second (0.5 = slow motion, the video is twice as long; 2 = fast)
export function frameTimes(total, fps, range = 'once', loops = 1, speed = 1) {
  const L = Math.max(1, Math.round(+loops || 1));
  fps /= +speed > 0 ? +speed : 1; // frames per motion second
  const T = range === 'reciprocate' ? 2 * total : total;
  if (!(T > 0)) return [0];
  const N = Math.round(T * fps) * L + (range === 'reciprocate' ? 0 : 1);
  const out = [];
  for (let k = 0; k < Math.max(1, N); k++) {
    const g = k / fps, last = range !== 'reciprocate' && k === N - 1;
    let c = last ? T : g - Math.floor(g / T + 1e-9) * T; // time inside the cycle
    if (c < 0) c = 0;
    c = Math.min(T, c);
    out.push(range === 'reciprocate' && c > total ? 2 * total - c : c);
  }
  return out;
}
