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

// --- colour coding ------------------------------------------------------
//
// A camera's colour is what identifies it on the exported floor PNG -- icon,
// recorded path and caption are all drawn in it (see
// test/floorPngExport.test.js) -- so two cameras sharing a colour is the plan
// telling the crew that two different marks are the same camera.
const colorsOf = ui => ui.cameras().map(c => c.color);
const allSetupColors = ui => ui.App.Store.getSetupCameraColors();

test('every camera position in a setup gets its own colour', () => {
  const ui = createSidebar();
  for (let i = 0; i < 5; i++) ui.el('#btn-add-camera').fire('click');

  const colors = colorsOf(ui);
  assert.equal(colors.length, 6);
  assert.equal(new Set(colors).size, colors.length, `repeated colour in ${colors.join(', ')}`);
  assert.ok(colors.every(Boolean), 'and every one of them actually has a colour');
});

test('a colour still in use is not handed out again after a delete', () => {
  // The trap a count falls into, and exactly the one the NAMES already guard
  // against: with three cameras, deleting the middle leaves length 2, so the
  // next index lands on a colour the third camera is still using.
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  ui.el('#btn-add-camera').fire('click');

  const doomed = ui.cameras()[1];
  ui.App.Store.removeCamera(doomed.id);
  ui.el('#btn-add-camera').fire('click');

  const colors = colorsOf(ui);
  assert.equal(new Set(colors).size, colors.length, `repeated colour in ${colors.join(', ')}`);
  assert.ok(colors.includes(doomed.color), 'the freed colour is reused, rather than being burnt');
});

test('colours are unique across the whole setup, not just the open position', () => {
  // The invariant is per CAMERA, not per position: cameras carry over, so one
  // camera legitimately appears in several positions wearing the same colour.
  // Two DIFFERENT cameras sharing one is the fault.
  //
  // Scoping the picker to the open position looks correct until a camera is
  // deleted from one position while surviving in another -- which is what this
  // builds, and what a per-position picker gets wrong.
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const survivor = ui.cameras()[1];

  ui.App.Store.addScene('Position 2');     // both cameras carry over
  ui.App.Store.removeCamera(survivor.id);  // ...and one is dropped from HERE only
  assert.ok(ui.App.Store.getScenes()[0].cameras.some(c => c.id === survivor.id),
    'fixture: the deleted camera still exists in the other position');
  assert.ok(!ui.cameras().some(c => c.id === survivor.id),
    'fixture: and is gone from this one, so a per-position picker cannot see it');

  ui.el('#btn-add-camera').fire('click');

  // One colour per camera id, across every position.
  const byId = new Map();
  ui.App.Store.getScenes().forEach(sc => sc.cameras.forEach(c => byId.set(c.id, c.color)));
  const colors = [...byId.values()];
  assert.equal(new Set(colors).size, colors.length,
    `two different cameras share a colour: ${colors.join(', ')}`);
  assert.deepEqual(allSetupColors(ui).filter(c => c === survivor.color).length, 1,
    'the surviving camera keeps its colour to itself');
});

test('past the end of the palette a camera still gets a colour', () => {
  // A repeat is the least-bad outcome once every colour is taken; failing to
  // give the camera a colour at all would draw it as nothing on the export.
  const ui = createSidebar();
  const palette = ui.App.factories.CAMERA_COLORS;
  for (let i = 0; i < palette.length + 1; i++) ui.el('#btn-add-camera').fire('click');

  const colors = colorsOf(ui);
  assert.equal(colors.length, palette.length + 2);
  assert.ok(colors.every(c => palette.includes(c)), 'all from the palette');
  // Every colour used at least once before any is used twice.
  assert.equal(new Set(colors.slice(0, palette.length)).size, palette.length,
    'the palette is exhausted before anything repeats');
});

// --- shoot days ---------------------------------------------------------
//
// One setup and one position get used across several shoot days: the studio,
// the props and the positions stay put while the camera positions are
// re-rigged. So a day filters CAMERAS and nothing else, and every camera
// belongs to exactly one day.
const dayIds = ui => ui.App.Store.getDays().map(d => d.id);
const allCamerasOf = ui => ui.App.Store.getScene().cameras;

test('a setup starts on one day, and its camera belongs to it', () => {
  const ui = createSidebar();
  const days = ui.App.Store.getDays();
  assert.equal(days.length, 1);
  assert.equal(days[0].name, 'Day 1');
  assert.equal(ui.cameras()[0].dayId, days[0].id, 'the starting camera is on that day');
});

test('a camera position is saved to the day that is open', () => {
  const ui = createSidebar();
  ui.App.Store.addDay('Day 2');
  ui.el('#btn-add-camera').fire('click');

  const [, dayTwo] = dayIds(ui);
  assert.equal(ui.App.Store.getActiveDayId(), dayTwo, 'adding a day switches to it');
  assert.ok(ui.cameras().every(c => c.dayId === dayTwo), 'everything listed belongs to the open day');
});

test("a day shows its own cameras and none of another day's", () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');            // Day 1: two cameras
  const dayOneIds = ui.cameras().map(c => c.id);

  ui.App.Store.addDay('Day 2');
  ui.el('#btn-add-camera').fire('click');            // Day 2: its own, plus the one it starts with

  const dayTwoIds = ui.cameras().map(c => c.id);
  assert.equal(dayTwoIds.filter(id => dayOneIds.includes(id)).length, 0,
    "Day 2 is showing one of Day 1's cameras");

  // Nothing was destroyed -- Day 1's cameras are still in the position, just
  // filtered out of the list.
  ui.App.Store.selectDay(dayIds(ui)[0]);
  assert.deepEqual(ui.cameras().map(c => c.id), dayOneIds, 'switching back brings them all back');
  assert.equal(allCamerasOf(ui).length, dayOneIds.length + dayTwoIds.length,
    'both days are stored side by side in the position');
});

test('a new day starts with a camera, not with an empty list', () => {
  // A day you cannot inspect or place a camera in is the same dead end as a
  // camera-less scene, which ensureCamera exists to prevent.
  const ui = createSidebar();
  ui.App.Store.addDay('Day 2');
  assert.equal(ui.cameras().length, 1);
  assert.ok(ui.App.Store.getInspectedCamera(), 'and it is inspectable straight away');
});

test('a new day does not copy the last day\'s camera positions', () => {
  // They are re-rigged for the day's shots -- that is what makes it a
  // different day -- so copies would only mean deleting them again.
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  ui.el('#btn-add-camera').fire('click');
  assert.equal(ui.cameras().length, 3);

  ui.App.Store.addDay('Day 2');
  assert.equal(ui.cameras().length, 1, 'Day 2 starts fresh');
});

test('the canvas draws only the open day', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  assert.equal(ui.App.Store.getVisibleCameras().length, 2);

  ui.App.Store.addDay('Day 2');
  assert.equal(ui.App.Store.getVisibleCameras().length, 1,
    "Day 1's cameras are not drawn on Day 2");
});

test('switching day drops a selection that is no longer on screen', () => {
  // Both routes onto another day have to clear it -- adding one, and picking
  // one from the day list -- or the inspector is left editing a camera the
  // canvas isn't drawing.
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  assert.ok(ui.App.Store.getSelectedCameraId(), 'fixture: something is selected');

  ui.App.Store.addDay('Day 2');
  assert.equal(ui.App.Store.getSelectedCameraId(), null, 'cleared when a day is added');

  // ...and again on a plain switch between two days that already exist.
  ui.el('#btn-add-camera').fire('click');
  const onDayTwo = ui.App.Store.getSelectedCameraId();
  assert.ok(onDayTwo, 'fixture: something is selected on Day 2');

  ui.App.Store.selectDay(ui.App.Store.getDays()[0].id);
  assert.equal(ui.App.Store.getSelectedCameraId(), null,
    'no stale id left pointing at a camera on another day');
  assert.equal(ui.App.Store.getSelectedCamera(), null);
});

test('deleting a day deletes its cameras in every position', () => {
  const ui = createSidebar();
  ui.App.Store.addScene('Position 2');
  ui.App.Store.addDay('Day 2');
  ui.el('#btn-add-camera').fire('click');
  const [dayOne, dayTwo] = dayIds(ui);

  const before = ui.App.Store.getScenes().map(sc => sc.cameras.length);
  assert.ok(ui.App.Store.getScenes().every(sc => sc.cameras.some(c => c.dayId === dayTwo)),
    'fixture: Day 2 has cameras in both positions');

  ui.App.Store.removeDay(dayTwo);

  assert.deepEqual(dayIds(ui), [dayOne], 'the day is gone');
  assert.equal(ui.App.Store.getActiveDayId(), dayOne, 'and the open day fell back to a real one');
  ui.App.Store.getScenes().forEach((sc, i) => {
    assert.ok(!sc.cameras.some(c => c.dayId === dayTwo), `position ${i} still holds a deleted day's camera`);
    assert.ok(sc.cameras.length < before[i], `position ${i} lost nothing`);
    assert.ok(sc.cameras.length > 0, `position ${i} was emptied`);
  });
});

test('the last day cannot be deleted', () => {
  // A setup with no days has no cameras anywhere.
  const ui = createSidebar();
  ui.App.Store.removeDay(ui.App.Store.getActiveDayId());
  assert.equal(ui.App.Store.getDays().length, 1);
  assert.equal(ui.cameras().length, 1);
});

test('camera positions carry over to a new position keeping their day', () => {
  const ui = createSidebar();
  ui.App.Store.addDay('Day 2');
  ui.el('#btn-add-camera').fire('click');
  const dayTwo = ui.App.Store.getActiveDayId();

  ui.App.Store.addScene('Position 2');

  assert.ok(ui.cameras().length >= 2, 'the day\'s cameras came across');
  assert.ok(ui.cameras().every(c => c.dayId === dayTwo), 'still on the day they were rigged for');
  assert.ok(allCamerasOf(ui).some(c => c.dayId !== dayTwo), "and the other day's came across too");
});

test('a setup saved before days existed lands entirely on Day 1', () => {
  // Anything already in such a setup was shot on one day as far as the file
  // knows. Cameras left with no day at all would make the filter mean two
  // different things depending on a camera's age.
  const ui = createSidebar();
  const legacy = {
    id: 'old', name: 'Old Setup',
    scenes: [{
      id: 's1', name: 'Position 1', props: [],
      cameras: [
        { id: 'c1', name: 'Camera 1', x: 1, y: 1, rotationDeg: 0, color: '#4da6ff' },
        { id: 'c2', name: 'Camera 2', x: 2, y: 1, rotationDeg: 0, color: '#7fd08c' }
      ],
      view: { scale: 40, originX: 0, originY: 0 }
    }],
    activeSceneId: 's1'
  };

  ui.App.Store.setSetup(legacy);

  const days = ui.App.Store.getDays();
  assert.equal(days.length, 1, 'one day was invented for it');
  assert.equal(ui.cameras().length, 2, 'and both cameras are visible on it');
  assert.ok(ui.cameras().every(c => c.dayId === days[0].id));
});

test('a camera whose day was hand-edited away is rescued, not orphaned', () => {
  // Otherwise it presents as "the list is empty and nothing brings it back".
  const ui = createSidebar();
  ui.App.Store.setSetup({
    id: 'x', name: 'Hand edited',
    days: [{ id: 'd1', name: 'Day 1' }],
    activeDayId: 'nonexistent',
    scenes: [{
      id: 's1', name: 'Position 1', props: [],
      cameras: [{ id: 'c1', name: 'Camera 1', x: 1, y: 1, rotationDeg: 0, dayId: 'gone' }],
      view: { scale: 40, originX: 0, originY: 0 }
    }],
    activeSceneId: 's1'
  });

  assert.equal(ui.App.Store.getActiveDayId(), 'd1', 'the dangling active day was repaired');
  assert.equal(ui.cameras().length, 1, 'and the orphaned camera is visible again');
});

test('a live recording keeps writing after the day is switched', () => {
  // findCamera, not getCameras(): the recording holds an id, and the list it
  // would otherwise search is filtered to whatever day is now open.
  const ui = createSidebar();
  const recording = ui.cameras()[0];
  ui.App.Store.addDay('Day 2');

  assert.equal(ui.App.Store.findCamera(recording.id).id, recording.id,
    'the camera being recorded into is still reachable by id');
  assert.ok(!ui.cameras().some(c => c.id === recording.id),
    'fixture: and it is genuinely absent from the open day');
});

// --- the day filter reaches the RENDERED panel --------------------------
//
// These assert on the rows in #camera-list, not on Store.getCameras(). The
// Store was filtered correctly and the panel still listed every day's
// cameras, because renderCameraList read scene.cameras straight off the
// scene -- and every test written at the time asked the Store, so all of them
// passed while the thing on screen was wrong. Anything claiming a day is
// filtered has to look at what was drawn.
const rowNamesOf = ui => rowsOf(ui).map(r => {
  const field = nameFieldOf(r);
  return field ? field.value : null;
});

test('the camera list draws only the open day', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  ui.el('#btn-add-camera').fire('click');
  assert.equal(rowsOf(ui).length, 3, 'fixture: Day 1 really has three rows');

  // Renamed so the rows can be told apart by what's drawn in them. Each day
  // numbers its own cameras from "Camera 1", so the default names repeat
  // across days quite legitimately and prove nothing either way.
  //
  // Blurred first: + Add Camera Position focuses the new row's name field so
  // the shot name can be typed straight away, and the panel deliberately
  // won't overwrite a field being typed into -- so the last row would keep
  // its old name and the fixture would look broken when it wasn't.
  ui.doc.activeElement = null;
  ['Wide', 'Tight', 'OTS'].forEach((name, i) => {
    ui.App.Store.updateCamera(ui.cameras()[i].id, { name });
  });
  const dayOneNames = rowNamesOf(ui);
  assert.deepEqual(dayOneNames, ['Wide', 'Tight', 'OTS'], 'fixture: the rows show those names');

  ui.App.Store.addDay('Day 2');

  assert.equal(rowsOf(ui).length, 1, "Day 1's camera rows are still on screen");
  const onDayTwo = rowNamesOf(ui);
  assert.equal(onDayTwo.filter(n => dayOneNames.includes(n)).length, 0,
    `a Day 1 row leaked into Day 2: ${onDayTwo.join(', ')}`);
});

test('the camera count counts the open day', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  assert.equal(ui.el('#camera-count').textContent, '(2)');

  ui.App.Store.addDay('Day 2');
  assert.equal(ui.el('#camera-count').textContent, '(1)',
    'the count is of what is listed, not of every day stored');
});

test('switching back redraws the day you left', () => {
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const dayOneNames = rowNamesOf(ui);
  const dayOne = ui.App.Store.getDays()[0].id;

  ui.App.Store.addDay('Day 2');
  ui.App.Store.selectDay(dayOne);

  assert.deepEqual(rowNamesOf(ui), dayOneNames, 'the rows came back intact');
});

test('the camera picker and Delete count the open day, not the position', () => {
  // Both are hidden while there is only one camera to act on. With three
  // cameras on Day 1 and one on Day 2, reading the position's whole set
  // leaves them showing on a day that has nothing to choose between.
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  ui.el('#btn-add-camera').fire('click');
  assert.ok(!ui.el('#cam-insp-picker').classList.contains('hidden'), 'fixture: shown with three');

  ui.App.Store.addDay('Day 2');

  assert.ok(ui.el('#cam-insp-picker').classList.contains('hidden'),
    'nothing to pick between on a day with one camera');
  assert.ok(ui.el('#btn-delete-camera').classList.contains('hidden'),
    'and deleting it would leave the day camera-less');
});

// --- props belong to a day too ------------------------------------------
//
// The set is struck and re-dressed between days, so a prop belongs to one day
// exactly as a camera does. It differs in how a new day STARTS: cameras fresh
// (they get re-rigged), props copied forward at their current positions (the
// set is usually yesterday's with things moved).
//
// Before this, scene.props was one array shared by every day, so dragging a
// table on Day 2 also dragged it on Day 1 -- silently rewriting a plan that
// had already been shot.
const propsOf = ui => ui.App.Store.getProps();
const propRows = ui => ui.el('#prop-list').children;

function addProp(ui, over) {
  const p = Object.assign(ui.App.factories.newProp(1, 1, 0), over || {});
  ui.App.Store.addProp(p);
  return ui.App.Store.getProps().find(x => x.id === p.id);
}

test('a prop is stamped with the day it was placed on', () => {
  const ui = createSidebar();
  const prop = addProp(ui, { name: 'Sofa' });
  assert.equal(prop.dayId, ui.App.Store.getActiveDayId());
});

test('a new day copies the props where they stand', () => {
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa', x: 2, y: 3 });
  addProp(ui, { name: 'Lamp', x: 4, y: 1 });

  ui.App.Store.addDay('Day 2');

  const copies = propsOf(ui);
  assert.equal(copies.length, 2, 'the dressing came across');
  assert.deepEqual(copies.map(p => p.name), ['Sofa', 'Lamp']);
  assert.deepEqual(copies.map(p => `${p.x},${p.y}`), ['2,3', '4,1'], 'standing where they stood');
  assert.ok(copies.every(p => p.dayId === ui.App.Store.getActiveDayId()), 'on the new day');
});

test('a copied prop is a separate object, so moving it leaves the shot day alone', () => {
  // The whole reason the copy exists. A shared array made this silently
  // rewrite a plan that had already been shot.
  const ui = createSidebar();
  const original = addProp(ui, { name: 'Sofa', x: 2, y: 3 });
  const dayOne = ui.App.Store.getActiveDayId();

  ui.App.Store.addDay('Day 2');
  const copy = propsOf(ui)[0];
  assert.notEqual(copy.id, original.id, 'a new id -- updateProp finds props by id');

  ui.App.Store.updateProp(copy.id, { x: 9, y: 9 });

  ui.App.Store.selectDay(dayOne);
  const dayOneProp = propsOf(ui)[0];
  assert.equal(dayOneProp.id, original.id);
  assert.equal(`${dayOneProp.x},${dayOneProp.y}`, '2,3', "Day 1's layout moved with Day 2's");
});

test('a day shows only its own props', () => {
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  const dayOne = ui.App.Store.getActiveDayId();

  ui.App.Store.addDay('Day 2');
  addProp(ui, { name: 'Rug' });
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Sofa', 'Rug'], 'Day 2 has the copy plus its own');

  ui.App.Store.selectDay(dayOne);
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Sofa'], 'Day 1 never gained the Day 2 prop');
});

test('the prop list draws only the open day', () => {
  // Asserts on the rendered rows, not the Store -- the camera list was
  // filtered correctly in the Store and wrong on screen for exactly this
  // reason.
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  addProp(ui, { name: 'Lamp' });
  assert.equal(propRows(ui).length, 2, 'fixture: two rows on Day 1');
  assert.equal(ui.el('#prop-count').textContent, '(2)');

  ui.App.Store.addDay('Day 2');
  ui.App.Store.removeProp(propsOf(ui)[0].id);

  assert.equal(propRows(ui).length, 1, "Day 1's prop rows are still on screen");
  assert.equal(ui.el('#prop-count').textContent, '(1)', 'the count is of what is listed');
});

test('deleting a day deletes its props in every position', () => {
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  ui.App.Store.addScene('Position 2');
  addProp(ui, { name: 'Rug' });

  ui.App.Store.addDay('Day 2');
  const dayTwo = ui.App.Store.getActiveDayId();
  assert.ok(ui.App.Store.getScenes().some(sc => sc.props.some(p => p.dayId === dayTwo)),
    'fixture: Day 2 has props');

  ui.App.Store.removeDay(dayTwo);

  ui.App.Store.getScenes().forEach((sc, i) => {
    assert.ok(!sc.props.some(p => p.dayId === dayTwo), `position ${i} kept a deleted day's prop`);
  });
  // Position 2 is the one open, and its Day 1 dressing is the Rug placed
  // there -- Sofa belongs to Position 1. Both survive; only Day 2 went.
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Rug'], "the open position's Day 1 dressing is untouched");
  assert.deepEqual(ui.App.Store.getScenes()[0].props.map(p => p.name), ['Sofa'],
    "and Position 1's Day 1 dressing survived as well");
});

test('a tracker parked on a prop follows it onto the new day', () => {
  // Otherwise the T-bar carries on driving yesterday's prop -- invisible, on
  // another day's plan -- and the measurement lands where nobody is looking.
  const ui = createSidebar();
  const sofa = addProp(ui, { name: 'Sofa' });
  ui.App.liveTracking.assign('T-bar', 'prop', sofa.id);

  ui.App.Store.addDay('Day 2');

  const copy = propsOf(ui)[0];
  assert.notEqual(copy.id, sofa.id, 'fixture: it really is a different prop');
  assert.equal(ui.App.liveTracking.getAssignmentFor('T-bar').entityId, copy.id,
    'the tracker drives the prop that is actually on screen');
});

test('switching day drops a prop selection that is no longer on screen', () => {
  const ui = createSidebar();
  const sofa = addProp(ui, { name: 'Sofa' });
  assert.equal(ui.App.Store.getSelectedPropId(), sofa.id, 'fixture: placing selects it');

  ui.App.Store.addDay('Day 2');
  assert.equal(ui.App.Store.getSelectedProp(), null, 'nothing from Day 1 is left selected');

  const copy = propsOf(ui)[0];
  ui.App.Store.selectProp(copy.id);
  ui.App.Store.selectDay(ui.App.Store.getDays()[0].id);
  assert.equal(ui.App.Store.getSelectedPropId(), null,
    'no stale id left pointing at a prop on another day');
});

test('a setup saved before days existed has its props land on Day 1 too', () => {
  const ui = createSidebar();
  ui.App.Store.setSetup({
    id: 'old', name: 'Old Setup',
    scenes: [{
      id: 's1', name: 'Position 1',
      props: [{ id: 'p1', name: 'Sofa', shape: 'rect', x: 1, y: 1, widthM: 1, depthM: 1, rotationDeg: 0 }],
      cameras: [{ id: 'c1', name: 'Camera 1', x: 1, y: 1, rotationDeg: 0 }],
      view: { scale: 40, originX: 0, originY: 0 }
    }],
    activeSceneId: 's1'
  });

  assert.equal(propsOf(ui).length, 1, 'the prop is visible rather than orphaned');
  assert.equal(propsOf(ui)[0].dayId, ui.App.Store.getDays()[0].id);
});

test('switching between two existing days redraws both lists', () => {
  // The structure keys decide whether to REBUILD a list or update it in
  // place, and selecting a day changes neither scene.props nor scene.cameras
  // -- so a key built from the position's whole set is identical either side
  // of the switch, the rebuild is skipped, and the day you left stays on
  // screen. The keys have to be day-scoped for the same reason the lists are.
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  const dayOne = ui.App.Store.getActiveDayId();

  ui.App.Store.addDay('Day 2');
  addProp(ui, { name: 'Rug' });
  ui.el('#btn-add-camera').fire('click');
  assert.equal(propRows(ui).length, 2, 'fixture: Day 2 shows two props');
  assert.equal(rowsOf(ui).length, 2, 'fixture: and two cameras');

  ui.App.Store.selectDay(dayOne);

  assert.equal(propRows(ui).length, 1, "Day 2's prop rows were left on screen");
  assert.equal(rowsOf(ui).length, 1, "Day 2's camera rows were left on screen");
});

// A setup saved in the window where cameras had days but props did not. Its
// props were shared by every day, which is the state ensureDays has to
// preserve. Reported from a real reload: the whole set came back on Day 1
// with Day 2 empty, which reads as the dressing having been deleted.
const twoDaySetupWithSharedProps = () => ({
  id: 'mid', name: 'Mid-migration Setup',
  days: [{ id: 'd1', name: 'Day 1' }, { id: 'd2', name: 'Day 2' }],
  activeDayId: 'd2',
  scenes: [{
    id: 's1', name: 'Position 1',
    props: [
      { id: 'p1', name: 'Sofa', shape: 'rect', x: 1, y: 1, widthM: 1, depthM: 1, rotationDeg: 0 },
      { id: 'p2', name: 'Lamp', shape: 'rect', x: 2, y: 2, widthM: 1, depthM: 1, rotationDeg: 0 }
    ],
    cameras: [
      { id: 'c1', name: 'Camera 1', x: 1, y: 1, rotationDeg: 0, dayId: 'd1' },
      { id: 'c2', name: 'Camera 1', x: 2, y: 1, rotationDeg: 0, dayId: 'd2' }
    ],
    view: { scale: 40, originX: 0, originY: 0 }
  }],
  activeSceneId: 's1'
});

test('props saved without a day appear on EVERY day, not just the first', () => {
  const ui = createSidebar();
  ui.App.Store.setSetup(twoDaySetupWithSharedProps());

  assert.deepEqual(propsOf(ui).map(p => p.name), ['Sofa', 'Lamp'],
    'Day 2 came back empty -- the dressing looks deleted');

  ui.App.Store.selectDay('d1');
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Sofa', 'Lamp'], 'and Day 1 still has them');
});

test('the migrated copies are independent, not the same prop twice', () => {
  // Sharing them would reintroduce the bug the migration exists to survive:
  // one drag rewriting a day that was already shot.
  const ui = createSidebar();
  ui.App.Store.setSetup(twoDaySetupWithSharedProps());

  const onDayTwo = propsOf(ui);
  ui.App.Store.selectDay('d1');
  const onDayOne = propsOf(ui);

  const ids = onDayOne.concat(onDayTwo).map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, `an id is shared between days: ${ids.join(', ')}`);

  ui.App.Store.updateProp(onDayOne[0].id, { x: 99 });
  ui.App.Store.selectDay('d2');
  assert.equal(propsOf(ui)[0].x, 1, "moving Day 1's Sofa moved Day 2's as well");
});

test('deleting a prop on one day leaves the other day alone', () => {
  // What prompted all of this: deleted on Day 2, gone from both.
  const ui = createSidebar();
  ui.App.Store.setSetup(twoDaySetupWithSharedProps());

  const sofa = propsOf(ui).find(p => p.name === 'Sofa');
  ui.App.Store.removeProp(sofa.id);
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Lamp'], 'gone from the day it was deleted on');

  ui.App.Store.selectDay('d1');
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Sofa', 'Lamp'], 'and still there on the other');
});

test('deleting a copied prop leaves the day it was copied from alone', () => {
  // The same thing, for a copy made by addDay rather than by the migration.
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  const dayOne = ui.App.Store.getActiveDayId();

  ui.App.Store.addDay('Day 2');
  ui.App.Store.removeProp(propsOf(ui)[0].id);
  assert.deepEqual(propsOf(ui).map(p => p.name), []);

  ui.App.Store.selectDay(dayOne);
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Sofa']);
});

test('a prop whose day was hand-edited to nonsense is still rescued', () => {
  // Distinct from the no-day case above: an unknown day is a broken
  // reference, not a shared prop, so it is repaired onto the first day rather
  // than copied onto all of them.
  const ui = createSidebar();
  const setup = twoDaySetupWithSharedProps();
  setup.scenes[0].props[0].dayId = 'gone';
  ui.App.Store.setSetup(setup);

  ui.App.Store.selectDay('d1');
  assert.ok(propsOf(ui).some(p => p.name === 'Sofa'), 'the orphan is visible again');
  ui.App.Store.selectDay('d2');
  assert.ok(!propsOf(ui).some(p => p.name === 'Sofa'), 'and was not also copied everywhere');
});

// --- hiding a prop ------------------------------------------------------
//
// The alternative to deleting a piece that isn't in this shot. Note this is
// the OPPOSITE rule to hiding a camera position, and the asymmetry is the
// whole point of each: a hidden camera is decluttered off the canvas while
// every export still draws it (losing a mark the crew shoots from would be
// dangerous and invisible), whereas a hidden prop is not in the shot, so a
// plan that still drew it would be wrong in the direction that matters.
// eyeOf is already declared above, for the camera rows -- the prop rows use
// the same button class, so the same helper reads both.
const visibleProps = ui => ui.App.Store.getVisibleProps();
const exported = ui => ui.App.Store.getSceneForDay();

test('Hide takes a prop off the canvas but leaves it in the setup', () => {
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  addProp(ui, { name: 'Lamp' });

  eyeOf(propRows(ui)[0]).fire('click', { target: {}, stopPropagation() {} });

  assert.deepEqual(visibleProps(ui).map(p => p.name), ['Lamp'], 'the canvas draws one');
  assert.deepEqual(propsOf(ui).map(p => p.name), ['Sofa', 'Lamp'], 'both are still in the setup');
  assert.equal(propRows(ui).length, 2, 'and both still have a row');
});

test('a hidden prop is left out of every export', () => {
  // The difference from a hidden camera, and the reason hiding is worth
  // having at all: it has to reach the plan, or it is just a screen tidy.
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  addProp(ui, { name: 'Lamp' });
  assert.deepEqual(exported(ui).props.map(p => p.name), ['Sofa', 'Lamp'], 'fixture: both export');

  ui.App.Store.togglePropHidden(propsOf(ui)[0].id);

  assert.deepEqual(exported(ui).props.map(p => p.name), ['Lamp'],
    'the floor PNG, CSV and report all read this list');
});

test('a hidden CAMERA is still exported -- the opposite rule, deliberately', () => {
  // Pinned next to the prop rule so that changing one to match the other
  // fails loudly rather than looking like a tidy-up.
  const ui = createSidebar();
  ui.el('#btn-add-camera').fire('click');
  const camera = ui.cameras()[0];

  ui.App.Store.toggleCameraHidden(camera.id);

  assert.ok(!ui.App.Store.getVisibleCameras().some(c => c.id === camera.id), 'off the canvas');
  assert.ok(exported(ui).cameras.some(c => c.id === camera.id),
    'but still on the plan the crew shoots from');
});

test('hiding a prop is per shoot day', () => {
  // Free, because props already belong to a day -- but worth pinning, since
  // it is the reason this can be used to say "not in today's shot".
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  const dayOne = ui.App.Store.getActiveDayId();

  ui.App.Store.addDay('Day 2');
  ui.App.Store.togglePropHidden(propsOf(ui)[0].id);
  assert.deepEqual(visibleProps(ui).map(p => p.name), [], 'hidden today');

  ui.App.Store.selectDay(dayOne);
  assert.deepEqual(visibleProps(ui).map(p => p.name), ['Sofa'], "yesterday's plan is untouched");
  assert.deepEqual(exported(ui).props.map(p => p.name), ['Sofa'], 'and still exports');
});

test('a hidden prop stays editable and stays selectable', () => {
  // Same as a hidden camera: nothing leaves the setup, or Hide would be a
  // slower Delete.
  const ui = createSidebar();
  const sofa = addProp(ui, { name: 'Sofa' });
  ui.App.Store.togglePropHidden(sofa.id);

  ui.App.Store.selectProp(sofa.id);
  assert.equal(ui.App.Store.getSelectedProp().id, sofa.id, 'still the selection');

  ui.App.Store.updateProp(sofa.id, { name: 'Sofa (struck)' });
  assert.equal(ui.App.Store.findProp(sofa.id).name, 'Sofa (struck)', 'still editable');
});

test('Show All Props appears only once something is hidden', () => {
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  const btn = ui.el('#btn-show-all-props');
  assert.ok(btn.classList.contains('hidden'), 'nothing hidden, nothing to offer');

  ui.App.Store.togglePropHidden(propsOf(ui)[0].id);
  assert.ok(!btn.classList.contains('hidden'), 'offered while something is hidden');
  assert.ok(btn.textContent.includes('1 hidden'), 'and says how many');

  btn.fire('click');
  assert.deepEqual(visibleProps(ui).map(p => p.name), ['Sofa'], 'everything back');
  assert.ok(btn.classList.contains('hidden'), 'and the button goes away again');
});

test('the eye button does not also change what the inspector is pointed at', () => {
  // The row's own click handler selects the prop, so without stopPropagation
  // hiding one silently re-points the inspector at it.
  //
  // Asserted on the CALL rather than on the outcome: this DOM shim invokes
  // handlers on the element they were bound to and nothing bubbles, so a
  // missing stopPropagation has no visible effect here however the test is
  // written. Spying on it is the only thing that pins the behaviour.
  const ui = createSidebar();
  addProp(ui, { name: 'Sofa' });
  const lamp = addProp(ui, { name: 'Lamp' });
  assert.equal(ui.App.Store.getSelectedPropId(), lamp.id, 'fixture: the last placed is selected');

  let stopped = false;
  eyeOf(propRows(ui)[0]).fire('click', { target: {}, stopPropagation() { stopped = true; } });

  assert.ok(stopped, 'the row handler would otherwise fire too and move the selection');
  assert.equal(ui.App.Store.getSelectedPropId(), lamp.id, 'selection is where it was');
});

test('Show All Props unhides the open day only', () => {
  // getProps(), not the position's whole set: pressing it today must not
  // quietly un-strike a piece on a day that was already shot that way.
  const ui = createSidebar();
  const sofa = addProp(ui, { name: 'Sofa' });
  ui.App.Store.togglePropHidden(sofa.id);
  const dayOne = ui.App.Store.getActiveDayId();

  ui.App.Store.addDay('Day 2');
  const copy = propsOf(ui)[0];
  assert.ok(copy.hidden, 'fixture: the copy came across hidden');
  ui.App.Store.togglePropHidden(copy.id);   // shown again today

  ui.App.Store.showAllProps();

  ui.App.Store.selectDay(dayOne);
  assert.deepEqual(visibleProps(ui).map(p => p.name), [], "Day 1's hidden prop was un-hidden too");
  assert.deepEqual(exported(ui).props.map(p => p.name), [], 'and would have come back on its plan');
});
