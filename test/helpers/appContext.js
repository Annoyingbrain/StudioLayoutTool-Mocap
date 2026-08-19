// Loads the app's plain <script> files into a Node vm context, so the browser
// code can be exercised without a browser. There is no build step and no
// module system in the app itself -- every file just hangs things off
// `window.App` -- which is exactly what makes this work: give the context a
// `window`, run the files in index.html's order, and `App` is fully built.
//
// This exists because browser automation isn't available on the studio
// machine, and "does this actually work" was otherwise unanswerable without
// asking someone to go and click. It verifies LOGIC, not appearance -- layout,
// colour and spacing still need a human looking at the page.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

// index.html's script order. Anything added there needs adding here too, or a
// module will load before something it reads at definition time.
const CORE = ['js/utils/dom.js', 'js/utils/id.js', 'js/utils/geometry.js'];

function loadFiles(sandbox, files) {
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sandbox, { filename: f });
  }
  return sandbox.App;
}

// --- floor PNG export ---------------------------------------------------

// A 2D context that records every drawing call instead of rasterising, with
// the paint state captured AT CALL TIME (hence the getter/setter pairs -- the
// app sets ctx.fillStyle then calls fill(), so reading the state afterwards
// would attribute the wrong colour to every op).
//
// Every op carries a `ctxId`. That matters more than it looks: the export
// recolours the camera icon on a SCRATCH canvas (js/floorPngExport.js's
// whiteCameraIcon), so without the id its drawImage is indistinguishable from
// a real one on the export, and counting icons silently comes out one high.
// ctxId 0 is the export canvas; anything higher is scratch.
function recordingContext(ops, ctxId) {
  const st = { strokeStyle: null, fillStyle: null, lineWidth: null, globalAlpha: 1, font: null, lineDash: null };
  const rec = (op, extra) => ops.push(Object.assign({ op, ctxId }, st, extra));
  return {
    set strokeStyle(v) { st.strokeStyle = v; }, get strokeStyle() { return st.strokeStyle; },
    set fillStyle(v) { st.fillStyle = v; }, get fillStyle() { return st.fillStyle; },
    set lineWidth(v) { st.lineWidth = v; }, get lineWidth() { return st.lineWidth; },
    set globalAlpha(v) { st.globalAlpha = v; }, get globalAlpha() { return st.globalAlpha; },
    set font(v) { st.font = v; }, get font() { return st.font; },
    textAlign: '', textBaseline: '', lineJoin: '', lineCap: '', globalCompositeOperation: '',
    save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
    // Recorded, not ignored: a dashed stroke is how the report's camera path
    // is told apart from the wall and the camera wedges, which are stroked in
    // the same colour. save()/restore() are no-ops here, so the dash is not
    // cleared afterwards -- that is fine for the one thing it is asked, since
    // the path is the ONLY thing in that renderer that ever sets a dash: no
    // dashed stroke at all means no path was drawn.
    setLineDash(d) { st.lineDash = d; },
    beginPath() { rec('beginPath'); }, closePath() {},
    moveTo(x, y) { rec('moveTo', { x, y }); },
    lineTo(x, y) { rec('lineTo', { x, y }); },
    stroke() { rec('stroke'); },
    fill() { rec('fill'); },
    fillRect() { rec('fillRect'); },
    arc(x, y) { rec('arc', { x, y }); },
    ellipse() { rec('ellipse'); },
    drawImage() { rec('drawImage'); },
    fillText(text, x, y) { rec('fillText', { text, x, y }); },
    // The report haloes its labels: strokeText behind, fillText over. Recorded
    // separately so `texts` stays one entry per label rather than two.
    strokeText(text, x, y) { rec('strokeText', { text, x, y }); },
    // Enough for the report's label collision pass, which only compares
    // widths against each other. Proportional to length, so a longer label
    // really does claim more room.
    measureText(text) { return { width: String(text || '').length * 6 }; }
  };
}

// Renders one scene through the real js/floorPngExport.js and returns every
// drawing op. `exportOps` is the subset on the export canvas itself.
function renderFloorPng(setup, scene) {
  const ops = [];
  let ctxSeq = 0;
  const sandbox = {
    console,
    document: {
      createElement: () => {
        const ctxId = ctxSeq++;
        return { width: 0, height: 0, getContext: () => recordingContext(ops, ctxId) };
      }
    }
  };
  sandbox.window = sandbox;
  // The export only draws the camera icon once the PNG has loaded; a real
  // Image never fires onload here, so the icon branch would never be tested.
  sandbox.Image = class {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 60; }
    set src(v) { this._src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  };
  vm.createContext(sandbox);

  const App = loadFiles(sandbox, [
    'js/utils/geometry.js', 'js/csvExport.js', 'js/studioSketch.js', 'js/floorPngExport.js'
  ]);
  App.floorPngExport.buildCanvas(setup, scene);

  const exportOps = ops.filter(o => o.ctxId === 0);
  return {
    ops,
    exportOps,
    texts: exportOps.filter(o => o.op === 'fillText').map(o => o.text),
    icons: exportOps.filter(o => o.op === 'drawImage'),
    redDots: exportOps.filter(o => o.op === 'arc' && o.fillStyle === '#ff0000'),
    strokes: exportOps.filter(o => o.op === 'stroke'),
    caption: name => exportOps.find(o => o.op === 'fillText' && o.text === name)
  };
}

// --- sidebar UI ---------------------------------------------------------

// Just enough DOM for js/ui/sidebar.js: everything it touches is duck-typed,
// so a plain object with the right method names is indistinguishable from a
// real element as far as the app is concerned.
function makeEl(tag, doc) {
  const el = {
    tagName: tag, children: [], handlers: {}, attrs: {},
    className: '', textContent: '', value: '', placeholder: '', disabled: false, style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) {
        if (on === undefined) return this._s.has(c) ? this._s.delete(c) : this._s.add(c);
        return on ? this._s.add(c) : this._s.delete(c);
      }
    },
    addEventListener(ev, fn) { (el.handlers[ev] = el.handlers[ev] || []).push(fn); },
    setAttribute(k, v) {
      el.attrs[k] = v;
      if (k === 'value') el.value = v;
      if (k === 'placeholder') el.placeholder = v;
    },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { el.children = el.children.filter(x => x !== c); return c; },
    // dom.clear() drains via firstChild, so this has to be a live getter.
    get firstChild() { return el.children[0] || null; },
    focus() { doc.activeElement = el; },
    blur() { if (doc.activeElement === el) doc.activeElement = null; },
    select() {},
    querySelector() { return null; },
    // Test affordance: invoke the app's own handler for an event.
    fire(ev, arg) {
      (el.handlers[ev] || []).forEach(fn => fn(arg || { target: el, stopPropagation() {} }));
    },
    // Stands in for querySelector('.x'), so it behaves like one on both
    // counts a real DOM would: it matches a class TOKEN rather than the whole
    // className string (rows carry state classes -- 'selected', 'active' --
    // beside the identifying one), and it searches DESCENDANTS, not just
    // direct children (a camera row wraps its controls in sub-rows).
    child(className) {
      for (const c of el.children) {
        if (String(c.className).split(/\s+/).includes(className)) return c;
        const found = c.child && c.child(className);
        if (found) return found;
      }
      return undefined;
    }
  };
  return el;
}

// A fresh, fully initialised sidebar over its own Store. Built per test:
// App.Store is a singleton created at load, so sharing one across tests would
// make them order-dependent.
function createSidebar() {
  const byId = {};
  const doc = {
    activeElement: null,
    createElement: tag => makeEl(tag, doc),
    createTextNode: text => ({ text }),
    // Memoised per selector, so the element the app bound a handler to is the
    // same one a test later reaches for.
    querySelector(sel) { return byId[sel] || (byId[sel] = makeEl('div', doc)); },
    querySelectorAll() { return []; }
  };
  const sandbox = { console, document: doc };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const App = loadFiles(sandbox, CORE.concat([
    'js/motive/motiveCalibration.js', 'js/motive/liveTracking.js',
    'js/motive/liveRecording.js', 'js/state.js', 'js/ui/sidebar.js'
  ]));
  App.toast = () => {};
  App.canvas = { draw() {} };
  App.sidebar.init();

  return { App, doc, el: sel => doc.querySelector(sel), cameras: () => App.Store.getCameras() };
}

// --- printable report ---------------------------------------------------

// Renders one scene through the real js/reportExport.js and returns every
// drawing op. This is the THIRD renderer of the same scene and the one most
// easily forgotten when something is added to the other two -- cameras were
// absent from it entirely until someone printed a report and looked.
function renderReport(setup, scene) {
  const ops = [];
  let ctxSeq = 0;
  const sandbox = {
    console,
    devicePixelRatio: 1,
    document: {
      createElement: () => {
        const ctxId = ctxSeq++;
        return {
          width: 0, height: 0,
          getContext: () => recordingContext(ops, ctxId),
          toDataURL: () => 'data:image/png;base64,stub'
        };
      }
    }
  };
  // Fires onload synchronously; a real Image never does here, so without this
  // the icon branch never runs and only the wedge fallback gets tested.
  sandbox.Image = class {
    constructor() { this.naturalWidth = 100; this.naturalHeight = 60; }
    set src(v) { this._src = v; if (this.onload) this.onload(); }
    get src() { return this._src; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const App = loadFiles(sandbox, [
    'js/utils/geometry.js', 'js/studioSketch.js', 'js/reportExport.js'
  ]);
  App.reportExport.buildLayoutSnapshot(setup, scene);

  const snapshotOps = ops.filter(o => o.ctxId === 0);
  return {
    ops,
    snapshotOps,
    texts: snapshotOps.filter(o => o.op === 'fillText').map(o => o.text),
    // drawImage on the REPORT canvas only. The icon is tinted on a scratch
    // canvas, whose own drawImage would otherwise be counted as a camera and
    // put every count one high -- the reason every op carries a ctxId.
    icons: snapshotOps.filter(o => o.op === 'drawImage'),
    strokes: snapshotOps.filter(o => o.op === 'stroke'),
    dashedStrokes: snapshotOps.filter(o => o.op === 'stroke' && o.lineDash && o.lineDash.length),
    fills: snapshotOps.filter(o => o.op === 'fill')
  };
}

module.exports = { REPO, renderFloorPng, renderReport, createSidebar };
