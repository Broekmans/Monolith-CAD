// Save Animation (0.1.122): encoders for the Motion Study export and the view background as a picture.
// Frames are drawn one by one (not recorded live), so the file plays smoothly whatever the PC's speed.
// MP4 = H.264 (WebCodecs VideoEncoder + mp4-muxer), WebM = VP9 (+ webm-muxer), GIF = gifenc (palette per frame).
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

export const SIZES = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
export const EXT = { mp4: 'mp4', webm: 'webm', gif: 'gif' };
export const FORMAT_NAME = { mp4: 'MP4 video', webm: 'WebM video', gif: 'Animated GIF' };
const even = (x) => Math.max(2, 2 * Math.round(x / 2));

// output size in pixels for a size choice ('view' = the view on screen in device pixels)
export function outSize(choice, view) {
  if (SIZES[choice]) return SIZES[choice];
  const dpr = window.devicePixelRatio || 1;
  return [even(view.width * dpr), even(view.height * dpr)];
}

// 0.1.124: an encoder config this PC supports: software encoder first (the same everywhere; a hardware encoder on
// Windows can hold frames back and stall), then whatever the PC offers. realtime = every frame comes out at once.
// 0.1.126: when no encoder takes the asked bit rate (the software H.264 encoder takes at most ≈ 288 Mbit/s), the
// highest bit rate it does take is used instead (found to within stepBps); cfg.asked = the asked bit rate then.
const supported = async (cfg) => { try { return !!(await VideoEncoder.isConfigSupported(cfg)).supported; } catch { return false; } };
async function pickConfig(codecs, W, H, fps, bitrate, hw, stepBps = 0) {
  if (typeof VideoEncoder === 'undefined') return null;
  const accel = hw === 'hardware' ? ['prefer-hardware', 'no-preference'] : hw === 'any' ? ['no-preference'] : ['prefer-software', 'no-preference'];
  const cfgOf = (codec, hardwareAcceleration, br) => ({ codec, width: W, height: H, bitrate: br, framerate: fps, hardwareAcceleration, latencyMode: 'realtime' });
  for (const a of accel) for (const codec of codecs) { const cfg = cfgOf(codec, a, bitrate); if (await supported(cfg)) return cfg; }
  if (!(stepBps > 0) || bitrate <= stepBps) return null;
  for (const a of accel) for (const codec of codecs) {
    if (!(await supported(cfgOf(codec, a, stepBps)))) continue;
    let lo = stepBps, hi = bitrate; // lo works, hi does not
    while (hi - lo > stepBps) { const m = Math.round((lo + hi) / 2); if (await supported(cfgOf(codec, a, m))) lo = m; else hi = m; }
    return { ...cfgOf(codec, a, lo), asked: bitrate };
  }
  return null;
}
// H.264 level from picture size × frame rate (macroblocks per frame / per second, H.264 table A-1); the levels above
// it follow as fallbacks, then the lists of 0.1.125 (some encoders do not check the level at all)
const AVC_LEVELS = [[0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3c, 139264, 4177920], [0x3d, 139264, 8355840], [0x3e, 139264, 16711680]];
const AVC_OLD = ['avc1.640028', 'avc1.640033', 'avc1.640034', 'avc1.4d0028', 'avc1.4d0033', 'avc1.42001f'];
export function avcFor(W, H, fps = 30) {
  const mbs = Math.ceil(W / 16) * Math.ceil(H / 16);
  let i = AVC_LEVELS.findIndex(([, f, r]) => mbs <= f && mbs * fps <= r);
  if (i < 0) i = AVC_LEVELS.length - 1;
  const lv = AVC_LEVELS.slice(i, i + 3).map(([l]) => l.toString(16).padStart(2, '0'));
  return [...new Set([...lv.map((l) => `avc1.6400${l}`), ...lv.map((l) => `avc1.4d00${l}`), ...AVC_OLD])];
}
const VP9 = ['vp09.00.10.08'];
const codecsFor = (fmt, W, H, fps) => (fmt === 'mp4' ? avcFor(W, H, fps) : VP9);
export async function formatsAvailable(W = 1920, H = 1080, fps = 30, hw = 'software') {
  const out = { gif: true, mp4: false, webm: false };
  if (typeof VideoEncoder === 'undefined') return out;
  out.mp4 = !!(await pickConfig(avcFor(W, H, fps), W, H, fps, 8e6, hw));
  out.webm = !!(await pickConfig(VP9, W, H, fps, 8e6, hw));
  return out;
}
// why a video cannot be made at this size / frame rate: the highest frame rate that does work, else the size
async function whyNot(fmt, W, H, fps, hw, low) {
  const name = fmt === 'mp4' ? 'MP4 (H.264)' : 'WebM (VP9)', other = fmt === 'mp4' ? 'WebM' : 'MP4';
  const ok = async (f) => !!(await pickConfig(codecsFor(fmt, W, H, f), W, H, f, low, hw));
  if (fps > 1 && (await ok(1))) {
    let lo = 1, hi = fps; // lo works, hi does not
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (await ok(m)) lo = m; else hi = m; }
    return `${name} at ${W} × ${H} works up to ${lo} fps on this PC — lower Frames per second (or choose ${other})`;
  }
  return `${name} at ${W} × ${H} cannot be made on this PC — choose a smaller size, ${other} or GIF`;
}
// a promise that gives up after ms (stall guard) or when cancelled() turns true
export async function guarded(p, ms, what, cancelled) {
  let t, iv;
  const stop = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} did not answer for ${Math.round(ms / 1000)} s`)), ms);
    iv = setInterval(() => { if (cancelled?.()) rej(new Error('cancelled')); }, 100);
  });
  try { return await Promise.race([p, stop]); } finally { clearTimeout(t); clearInterval(iv); }
}

// encoder: add(canvas, k) per frame (await it), finish() → Uint8Array, cancel(); o.stallMs = give up when the
// encoder takes no frame for that long, o.cancelled() = Cancel pressed (checked while waiting too)
export async function makeEncoder(fmt, W, H, fps, o = {}) {
  if (fmt === 'gif') {
    const gif = GIFEncoder();
    const delay = Math.round(1000 / fps);
    return {
      async add(cv) {
        const data = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
        const pal = quantize(data, o.colors || 256);
        gif.writeFrame(applyPalette(data, pal), W, H, { palette: pal, delay, repeat: 0 });
      },
      async finish() { gif.finish(); return gif.bytes(); },
      cancel() {},
    };
  }
  const bitrate = Math.round((o.mbps || 8) * 1e6 * Math.max(0.15, (W * H) / (1920 * 1080)));
  const step = (o.rateStepMbps || 1) * 1e6;
  const cfg = await pickConfig(codecsFor(fmt, W, H, fps), W, H, fps, bitrate, o.hw, step);
  if (!cfg) throw new Error(await whyNot(fmt, W, H, fps, o.hw, step));
  const asked = cfg.asked; delete cfg.asked;
  const muxer = fmt === 'mp4'
    ? new Mp4Muxer({ target: new Mp4Target(), video: { codec: 'avc', width: W, height: H, frameRate: fps }, fastStart: 'in-memory' })
    : new WebmMuxer({ target: new WebmTarget(), video: { codec: 'V_VP9', width: W, height: H, frameRate: fps } });
  let err = null, out = 0;
  const enc = new VideoEncoder({ output: (chunk, meta) => { out++; muxer.addVideoChunk(chunk, meta); }, error: (e) => { err = e; } });
  enc.configure({ ...cfg, ...(fmt === 'mp4' ? { avc: { format: 'avc' } } : {}) });
  const keyEvery = Math.max(1, Math.round((o.keyEvery || 2) * fps)), queue = o.queue || 8, stallMs = o.stallMs || 15000;
  const check = () => { if (err) throw err; if (enc.state === 'closed') throw new Error('the video encoder closed'); if (o.cancelled?.()) throw new Error('cancelled'); };
  return {
    codec: cfg.codec, accel: cfg.hardwareAcceleration, bitrate: cfg.bitrate, asked,
    get queue() { return enc.encodeQueueSize; }, get out() { return out; },
    async add(cv, k) {
      check();
      const t0 = performance.now();
      while (enc.encodeQueueSize > queue) { // wait for the encoder, but never for ever
        await new Promise((r) => setTimeout(r, 5));
        check();
        if (performance.now() - t0 > stallMs) throw new Error(`the video encoder stopped taking frames (frame ${k + 1}, ${enc.encodeQueueSize} waiting) — try WebM or GIF`);
      }
      const f = new VideoFrame(cv, { timestamp: Math.round((k * 1e6) / fps), duration: Math.round(1e6 / fps) });
      try { enc.encode(f, { keyFrame: k % keyEvery === 0 }); } finally { f.close(); }
    },
    async finish() {
      await guarded(enc.flush(), stallMs, 'the video encoder (finishing)', o.cancelled);
      check();
      enc.close();
      muxer.finalize();
      return new Uint8Array(muxer.target.buffer);
    },
    cancel() { try { if (enc.state !== 'closed') enc.close(); } catch { /* closed */ } },
  };
}

// the view's background (CSS: Realistic studio gradient on the pane, else the .views gradient behind all panes)
// painted on g at W × H; k = screen px per output px (renderCapture), centred on the pane
const COLOR_RE = /(rgba?\([^)]*\)|#[0-9a-f]{3,8}|transparent)\s*([\d.]+%)?/gi;
export function paintBackground(g, paneEl, W, H, k) {
  const pr = paneEl.getBoundingClientRect();
  const y = (sy) => H / 2 + (sy - (pr.top + pr.height / 2)) / k;
  for (let el = paneEl; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && /linear-gradient/.test(cs.backgroundImage)) {
      const stops = [...cs.backgroundImage.matchAll(COLOR_RE)].map((m) => ({ c: m[1], at: m[2] ? parseFloat(m[2]) / 100 : null }));
      if (stops.length >= 2) {
        stops.forEach((s, i) => { if (s.at == null) s.at = i / (stops.length - 1); });
        const er = el.getBoundingClientRect();
        const gr = g.createLinearGradient(0, y(er.top), 0, y(er.bottom));
        for (const s of stops) gr.addColorStop(Math.min(1, Math.max(0, s.at)), s.c);
        if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) { g.fillStyle = cs.backgroundColor; g.fillRect(0, 0, W, H); }
        g.fillStyle = gr; g.fillRect(0, 0, W, H);
        return;
      }
    }
    if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) { g.fillStyle = cs.backgroundColor; g.fillRect(0, 0, W, H); return; }
  }
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
}
