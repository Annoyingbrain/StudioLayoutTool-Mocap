// CSV export for import into Disguise (d3): one row per prop, position in meters,
// Z assumed 0 for a floor-plane 2D layout.
window.App = window.App || {};

App.csvExport = {
  HEADER: ['Type', 'Name', 'PosX', 'PosY', 'PosZ', 'RotZ', 'WidthM', 'DepthM', 'HeightM', 'Notes'],

  // Disguise's (0,0) -- where its tracked camera always starts -- is the studio
  // floor's near corner, not this app's internal world origin. Disguise's
  // axes also run 180 degrees rotated from this app's internal frame (the
  // same rotation the canvas display already applies for screen rendering --
  // see DISPLAY_ROTATION_DEG in js/utils/geometry.js -- but here it has to be
  // baked into the exported numbers themselves, not just the on-screen
  // transform).
  //
  // X was picked visually as mesh vertex 11.969661 (assets/mesh/
  // SA_SCREEN_floor_01.obj, world x/y map 1:1 to that OBJ's x/z -- see
  // js/studioSketch.js) and confirmed correct in direction by a real-world
  // check (2026-08-12). Y was originally guessed the same way (-0.102301,
  // that same vertex's y) but a real-world measurement against the actual
  // Disguise Y=0 (the edge of the first LED panel) found it 10cm off --
  // corrected here to 0, which the physical offset (-0.102301 + 0.10 =
  // -0.0023, i.e. essentially exact) shows was actually the mesh's own
  // natural y=0 datum line all along, not that specific vertex.
  DISGUISE_ORIGIN: { x: 11.969661, y: 0 },

  // Converts a prop's app-internal x/y/rotationDeg into Disguise's floor-plane
  // coordinate system: origin at DISGUISE_ORIGIN, axes negated (180 degree
  // rotation), so RotZ gets a matching +180 degree offset to stay physically
  // consistent with the rotated axes.
  toDisguiseSpace(prop) {
    const round3 = v => Math.round(v * 1000) / 1000;
    return {
      x: round3(this.DISGUISE_ORIGIN.x - prop.x),
      y: round3(this.DISGUISE_ORIGIN.y - prop.y),
      rotZ: Math.round((((prop.rotationDeg + 180) % 360 + 360) % 360) * 10) / 10
    };
  },

  csvEscape(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  },

  buildCsv(scene) {
    const rows = [this.HEADER.join(',')];
    scene.props.forEach(p => {
      const d = this.toDisguiseSpace(p);
      rows.push([
        'Prop', p.name, d.x, d.y, 0, d.rotZ,
        p.widthM, p.depthM, p.heightM, p.notes
      ].map(v => this.csvEscape(v)).join(','));
    });
    scene.cameras.forEach(c => {
      const d = this.toDisguiseSpace(c);
      rows.push([
        'Camera', c.name, d.x, d.y, 0, d.rotZ,
        '', '', '', c.notes
      ].map(v => this.csvEscape(v)).join(','));
    });
    return rows.join('\r\n') + '\r\n';
  },

  // Exports the given scene's props and cameras (not the whole setup) --
  // each scene is its own shot/layout and gets its own CSV.
  exportSetup(setup, scene) {
    if (!scene.props.length && !scene.cameras.length) { App.toast('No props or cameras to export yet.', true); return; }
    const csv = this.buildCsv(scene);
    const blob = new Blob([csv], { type: 'text/csv' });
    const safeName = `${setup.name || 'setup'}_Position_${scene.name || '1'}`.replace(/[^a-z0-9_\-]+/gi, '_');
    App.dom.downloadBlob(`${safeName}.csv`, blob);
  }
};
