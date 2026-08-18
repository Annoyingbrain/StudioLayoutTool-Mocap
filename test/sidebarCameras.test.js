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
