// Camera positions in the left panel (js/ui/sidebar.js + js/state.js).
//
// One prop layout is often shot from several camera positions, so a scene can
// carry more than one camera. The interesting part isn't that adding works --
// it's that the list rebuild must NOT destroy the name field being typed into,
// which is the trap this panel keeps re-encountering at 30 Hz.
const { test } = require('node:test');
const assert = require('node:assert');
const { createSidebar } = require('./helpers/appContext');

const namesOf = ui => ui.cameras().map(c => c.name);
const rowsOf = ui => ui.el('#camera-list').children;
const nameFieldOf = row => row.child('prop-row-name-input');

test('a scene starts with exactly one, numbered, camera', () => {
  const ui = createSidebar();
  assert.equal(ui.cameras().length, 1);
  // "Camera 1", not a bare "Camera": next to "Camera 2" the latter reads as an
  // odd one out rather than the first of a set.
  assert.deepEqual(namesOf(ui), ['Camera 1']);
});

test('Add Camera Position adds a camera to the scene you are already in', () => {
  const ui = createSidebar();
  const propsBefore = ui.App.Store.getScene().props.length;

  ui.el('#btn-add-camera').fire('click');

  assert.equal(ui.cameras().length, 2);
  assert.deepEqual(namesOf(ui), ['Camera 1', 'Camera 2']);
  assert.equal(ui.App.Store.getScene().props.length, propsBefore, 'props are untouched');
});

test('a new camera position is selected, so it can be named immediately', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  assert.equal(ui.App.Store.getSelectedCameraId(), ui.cameras()[1].id);
});

test('a new camera position is offset, not stacked on the last one', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const [first, second] = ui.cameras();
  // Dropped exactly on an existing camera it would be invisible and
  // impossible to grab on the canvas.
  assert.notEqual(`${first.x},${first.y}`, `${second.x},${second.y}`);
});

test('each camera position is a full entity, not a bare marker', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const cam = ui.cameras()[1];
  for (const field of ['focalLengthMm', 'heightM', 'tiltDeg', 'notes', 'trail', 'trailEndpoints']) {
    assert.ok(field in cam, `missing ${field}`);
  }
});

test('naming skips a name already taken by hand', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  ui.el('#btn-add-camera').fire('click');
  assert.deepEqual(namesOf(ui), ['Camera 1', 'Camera 2', 'Camera 3']);

  // Rename one onto the next number the counter would reach, then add again.
  ui.App.Store.updateCamera(ui.cameras()[2].id, { name: 'Camera 4' });
  ui.el('#btn-add-camera').fire('click');

  const names = namesOf(ui);
  assert.equal(new Set(names).size, names.length, `duplicate name in ${names.join(', ')}`);
});

test('the name is editable in the row itself, not only the Inspector', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');

  const field = nameFieldOf(rowsOf(ui)[1]);
  assert.ok(field, 'the row carries a name field');

  field.value = 'Wide shot';
  field.fire('input', { target: field, stopPropagation() {} });

  assert.equal(ui.cameras()[1].name, 'Wide shot');
});

test('a live re-render does not destroy the field being typed into', () => {
  // The 30 Hz trap: frames arrive continuously while tracking, and rebuilding
  // the list on each emit would replace the <input> mid-keystroke. This is why
  // cameraListStructureKey deliberately excludes the camera name.
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');

  const field = nameFieldOf(rowsOf(ui)[1]);
  ui.doc.activeElement = field;
  const rowBefore = rowsOf(ui)[1];

  field.value = 'Interview 2';
  field.fire('input', { target: field, stopPropagation() {} });
  ui.App.Store.touch();   // stands in for a live frame landing

  assert.equal(rowsOf(ui)[1], rowBefore, 'the row element survived the re-render');
  assert.equal(nameFieldOf(rowsOf(ui)[1]), field, 'and so did the field itself');
  assert.equal(field.value, 'Interview 2', 'the half-typed value was not overwritten');
});

test('a rename from elsewhere still reaches the row when not being typed into', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const field = nameFieldOf(rowsOf(ui)[1]);

  ui.doc.activeElement = null;                      // nobody is typing
  ui.App.Store.updateCamera(ui.cameras()[1].id, { name: 'From inspector' });

  assert.equal(field.value, 'From inspector');
});

test('camera positions carry over to a new position, props do not', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const idsBefore = ui.cameras().map(c => c.id);

  ui.App.Store.addScene();

  // Same ids, so a live tracking assignment keeps driving the right camera
  // across a position switch instead of silently going nowhere.
  assert.deepEqual(ui.cameras().map(c => c.id), idsBefore);
  assert.equal(ui.App.Store.getScene().props.length, 0, 'props are dressed per shot');
});

// --- hiding a camera position on the canvas ------------------------------
//
// Several camera positions in one prop layout overlap into a pile, so each
// row can take itself off the canvas. The trap this guards is that "hidden"
// must mean hidden FROM THE CANVAS and nothing else -- not removed, not
// un-editable, and above all not absent from the exports.

const eyeOf = row => row.child('prop-row-eye');

test('Hide takes a camera off the canvas but leaves it in the setup', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const [first] = ui.cameras();

  eyeOf(rowsOf(ui)[0]).fire('click');

  assert.equal(ui.App.Store.getVisibleCameras().length, 1, 'the canvas draws one');
  assert.equal(ui.cameras().length, 2, 'the scene still holds both');
  assert.ok(ui.cameras().find(c => c.id === first.id), 'nothing was deleted');
});

test('a hidden camera keeps its row, so it can be found and shown again', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');

  eyeOf(rowsOf(ui)[0]).fire('click');
  assert.equal(rowsOf(ui).length, 2, 'both rows are still listed');

  const btn = eyeOf(rowsOf(ui)[0]);
  assert.equal(btn.textContent, 'Show', 'the button offers the way back');
  btn.fire('click');
  assert.equal(ui.App.Store.getVisibleCameras().length, 2);
});

test('a hidden camera is still editable', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const target = ui.cameras()[0];

  eyeOf(rowsOf(ui)[0]).fire('click');

  const nameEl = nameFieldOf(rowsOf(ui)[0]);
  nameEl.value = 'Wide';
  nameEl.fire('input');
  assert.equal(ui.cameras()[0].name, 'Wide', 'renaming a hidden camera works');
  assert.equal(ui.cameras()[0].id, target.id);
});

test('Show All appears only once something is hidden', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const btn = ui.el('#btn-show-all-cameras');
  assert.ok(btn.classList.contains('hidden'), 'nothing hidden, nothing to offer');

  eyeOf(rowsOf(ui)[0]).fire('click');
  assert.ok(!btn.classList.contains('hidden'));
  assert.ok(btn.textContent.includes('1 hidden'), 'says how many');

  btn.fire('click');
  assert.equal(ui.App.Store.getVisibleCameras().length, 2, 'all back');
  assert.ok(btn.classList.contains('hidden'), 'and it withdraws again');
});

test('hiding one camera does not change which camera is selected', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const selected = ui.App.Store.getSelectedCameraId();

  // The row's own click handler would re-point the inspector; the button
  // stops propagation precisely so it doesn't.
  eyeOf(rowsOf(ui)[0]).fire('click');
  assert.equal(ui.App.Store.getSelectedCameraId(), selected);
});

// --- frame grabs belong to a camera position ------------------------------
//
// They used to hang off the scene, one per position. One prop layout is shot
// from several camera positions, though, so a single picture could only ever
// describe one of them.

const GRAB = { imageDataUrl: 'data:image/png;base64,AAA', caption: 'wide' };

test('a frame grab attaches to the camera being inspected, not the position', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click'); // selects the new one

  ui.App.Store.setFrameGrab(GRAB);

  const [first, second] = ui.cameras();
  assert.equal(second.frameGrab, GRAB, 'landed on the inspected camera');
  assert.equal(first.frameGrab, null, 'and nowhere else');
  assert.equal(ui.App.Store.getScene().frameGrab, undefined, 'nothing left on the scene');
});

test('each camera position carries its own frame grab', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const [first, second] = ui.cameras();

  ui.App.Store.setFrameGrab(GRAB);
  ui.App.Store.selectCamera(first.id);
  ui.App.Store.setFrameGrab({ imageDataUrl: 'data:image/png;base64,BBB', caption: 'tight' });

  assert.equal(ui.App.Store.getFrameGrab().caption, 'tight', 'reads back the inspected one');
  assert.equal(second.frameGrab.caption, 'wide', 'the other is untouched');
});

test('with several cameras and none picked there is nothing to write to', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  ui.App.Store.selectCamera(null);

  // Better a no-op than silently writing the grab to an arbitrary camera.
  assert.equal(ui.App.Store.getFrameGrab(), null);
  ui.App.Store.setFrameGrab(GRAB);
  assert.ok(ui.cameras().every(c => !c.frameGrab), 'nothing was written');
});

test('a frame grab does not carry over to a new position', () => {
  const ui = createSidebar();
  ui.App.Store.setFrameGrab(GRAB); // single camera needs no picking
  assert.equal(ui.cameras()[0].frameGrab, GRAB);

  ui.App.Store.addScene('Position 2');

  // The camera carries over, but a grab is a picture of a shot and the new
  // position is a different prop layout.
  assert.equal(ui.cameras()[0].frameGrab, null);
});

test('a setup saved with the grab on the scene has it moved to a camera', () => {
  const ui = createSidebar();
  const setup = ui.App.factories.newSetup('Old');
  const scene = setup.scenes[0];
  scene.frameGrab = GRAB;          // where it used to live
  delete scene.cameras[0].frameGrab;

  ui.App.Store.setSetup(setup);

  assert.equal(ui.cameras()[0].frameGrab, GRAB, 'handed to the first camera');
  assert.equal(ui.App.Store.getScene().frameGrab, undefined, 'and removed from the scene');
});
