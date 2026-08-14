// Parses a Motive (OptiTrack) CSV export -- specifically a single Rigid Body
// asset ("tracker", the measurement wand) tracked by its Rigid Body Markers
// (Motive's solved/idealized marker positions) and its raw global Markers
// (the actual reconstructed per-frame positions). The raw Markers are used
// as the source of truth for tip computation (js/motive/wandTip.js), not
// the idealized ones.
//
// Format (Motive 1.25+): a fixed 8-row header block, then one data row per
// frame. Row 1 carries take-level metadata as alternating key,value pairs.
// Rows 3-6 (0-indexed 2-5) describe each data column (Type/Name/ID/Parent),
// stacked so column N's meaning is read down all of them together; row 7
// labels Rotation vs Position; row 8 is the actual Frame/Time/X/Y/Z/...
// header. Column groups are discovered from the Type/Name rows rather than
// hardcoded indices, so this doesn't assume a specific asset name or marker
// count.
window.App = window.App || {};

App.motiveCsv = (function () {
  // Minimal CSV line split -- handles double-quoted fields (with embedded
  // commas/escaped quotes), since free-text fields like Take Notes aren't
  // guaranteed comma-free even though none of the sample data needs it.
  function splitCsvLine(line) {
    const out = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
        } else cur += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        out.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out;
  }

  function parseMeta(line) {
    const cells = splitCsvLine(line);
    const meta = {};
    for (let i = 0; i < cells.length - 1; i += 2) meta[cells[i]] = cells[i + 1];
    return meta;
  }

  // Groups data columns (index >= 2, after Frame/Time) into named entities
  // by consecutive (Type, Name) runs.
  function groupColumns(typeRow, nameRow) {
    const groups = []; // { type, name, startCol, count }
    for (let col = 2; col < typeRow.length; col++) {
      const type = typeRow[col], name = nameRow[col];
      const last = groups[groups.length - 1];
      if (last && last.type === type && last.name === name && col === last.startCol + last.count) {
        last.count++;
      } else {
        groups.push({ type, name, startCol: col, count: 1 });
      }
    }
    return groups;
  }

  function readXYZ(row, startCol) {
    return { x: parseFloat(row[startCol]), y: parseFloat(row[startCol + 1]), z: parseFloat(row[startCol + 2]) };
  }

  function isValidXYZ(p) {
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  }

  return {
    // text: raw CSV file content. Returns null (with a console warning) if
    // it doesn't look like a Motive rigid-body export at all -- the caller
    // decides how to surface that to the user.
    parse(text) {
      const rawLines = text.split(/\r\n|\r|\n/);
      while (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
      if (rawLines.length < 9) { console.warn('[motiveCsv] file too short to be a Motive export'); return null; }

      const meta = parseMeta(rawLines[0]);
      if (meta['Length Units'] && meta['Length Units'] !== 'Millimeters') {
        console.warn(`[motiveCsv] expected Length Units=Millimeters, got "${meta['Length Units']}" -- positions will be wrong unless this is handled`);
      }

      const typeRow = splitCsvLine(rawLines[2]);
      const nameRow = splitCsvLine(rawLines[3]);
      const groups = groupColumns(typeRow, nameRow);

      const rbGroup = groups.find(g => g.type === 'Rigid Body' && g.count === 7);
      const allMarkerGroups = groups.filter(g => g.type === 'Marker' && g.count === 3);
      // Only the primary Rigid Body's own markers matter for capture math --
      // a real take often has other tracked objects or stray "Unlabeled"
      // reflections in view too, and those shouldn't cause an otherwise-good
      // frame (this asset fully tracked) to be dropped by the isValidXYZ
      // check below just because something unrelated had a dropout.
      const markerGroups = rbGroup
        ? allMarkerGroups.filter(g => g.name === rbGroup.name || g.name.startsWith(rbGroup.name + ':'))
        : allMarkerGroups;
      const rbMarkerGroups = groups.filter(g => g.type === 'Rigid Body Marker' && g.count === 3);

      if (!rbGroup) console.warn('[motiveCsv] no 7-column Rigid Body group found (rotation quat + position)');
      if (markerGroups.length < 4) console.warn(`[motiveCsv] expected >=4 raw Markers, found ${markerGroups.length}`);

      const frames = [];
      for (let i = 8; i < rawLines.length; i++) {
        if (!rawLines[i]) continue;
        const row = splitCsvLine(rawLines[i]);
        const frame = parseInt(row[0], 10);
        const timeSec = parseFloat(row[1]);
        if (!Number.isFinite(frame)) continue;

        const markers = markerGroups.map(g => readXYZ(row, g.startCol));
        if (markers.some(m => !isValidXYZ(m))) continue; // drop incomplete/dropout rows (e.g. trailing blank frame)

        const rbMarkers = rbMarkerGroups.map(g => readXYZ(row, g.startCol));
        let rigidBody = null;
        if (rbGroup) {
          const quat = { x: parseFloat(row[rbGroup.startCol]), y: parseFloat(row[rbGroup.startCol + 1]), z: parseFloat(row[rbGroup.startCol + 2]), w: parseFloat(row[rbGroup.startCol + 3]) };
          const pos = readXYZ(row, rbGroup.startCol + 4);
          if (isValidXYZ(pos)) rigidBody = { quat, pos };
        }

        frames.push({ frame, timeSec, rigidBody, rbMarkers, markers });
      }

      return { meta, markerLabels: markerGroups.map(g => g.name), frames };
    }
  };
})();
