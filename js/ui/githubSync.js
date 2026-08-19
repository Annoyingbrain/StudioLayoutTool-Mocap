// GitHub Sync panel: back up the setups folder to a GitHub repo, one JSON
// file per setup (setups/<setup.id>.json, overwritten on every save),
// straight from the browser via the Contents API -- no server involved,
// same as the rest of this static app. A small setups/index.json manifest
// ({id, name, updatedAt}[]) is kept alongside so the app can list/load
// setups without fetching every file, and is also what says which version
// of each setup is already up there.
// The token is only ever kept in this browser's local storage.
window.App = window.App || {};

(function () {
  const dom = App.dom;
  const LS_KEY = 'studioLayoutTool.githubSync.v1';
  const INDEX_PATH = 'setups/index.json';

  function loadConfig() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function readFields() {
    return {
      token: dom.qs('#gh-token').value.trim(),
      owner: dom.qs('#gh-owner').value.trim(),
      repo: dom.qs('#gh-repo').value.trim(),
      branch: dom.qs('#gh-branch').value.trim() || 'main'
    };
  }

  function populateFields(cfg) {
    dom.qs('#gh-token').value = cfg.token || '';
    dom.qs('#gh-owner').value = cfg.owner || '';
    dom.qs('#gh-repo').value = cfg.repo || '';
    dom.qs('#gh-branch').value = cfg.branch || 'main';
  }

  function setStatus(text, isError) {
    const el = dom.qs('#gh-status');
    el.textContent = text;
    el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
  }

  // UTF-8 safe base64 encode/decode (setup JSON can contain non-ASCII text
  // and already-base64 embedded images inside a JSON string).
  function toBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
  function fromBase64(b64) { return decodeURIComponent(escape(atob(b64.replace(/\n/g, '')))); }

  function authHeaders(cfg) {
    return { Authorization: `token ${cfg.token}`, Accept: 'application/vnd.github+json' };
  }

  function contentsUrl(cfg, path) {
    return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`;
  }

  // Returns { sha, data } for a JSON file in the repo, or { sha: null, data: null } if it doesn't exist yet.
  async function fetchJsonFile(cfg, path) {
    const url = `${contentsUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`;
    const res = await fetch(url, { headers: authHeaders(cfg), cache: 'no-store' });
    if (res.status === 404) return { sha: null, data: null };
    if (!res.ok) throw new Error(`Fetch of ${path} failed (${res.status}): ${await res.text()}`);
    const json = await res.json();
    if (json.content) {
      return { sha: json.sha, data: JSON.parse(fromBase64(json.content)) };
    }
    // The Contents API only inlines base64 content for files under ~1MB --
    // setups with an embedded frame grab easily exceed that. For bigger
    // files the same response still includes download_url, a direct link
    // to the raw content (a signed URL for private repos, so no auth header
    // needed) -- fetch that instead of fighting Accept-header content
    // negotiation, which turned out not to behave as GitHub's docs suggest
    // here (it kept silently returning this same metadata response).
    if (!json.download_url) {
      throw new Error(`No content or download_url for ${path} -- can't read it (too large, or not a plain file?).`);
    }
    const rawRes = await fetch(json.download_url, { cache: 'no-store' });
    if (!rawRes.ok) throw new Error(`Download of ${path} failed (${rawRes.status}): ${await rawRes.text()}`);
    return { sha: json.sha, data: JSON.parse(await rawRes.text()) };
  }

  async function putJsonFile(cfg, path, data, sha, message) {
    const body = { message, content: toBase64(JSON.stringify(data, null, 2)), branch: cfg.branch };
    if (sha) body.sha = sha;
    const res = await fetch(contentsUrl(cfg, path), {
      method: 'PUT',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg)),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await res.text();
      // GitHub answers an oversized file with a 422 whose message is about
      // its own internals ("Sorry, the file is too large to be processed.
      // Consider creating/updating the file in a local clone"), which says
      // nothing about the actual cause here -- full-resolution frame grabs
      // stored inside the setup's JSON. Say what to do instead.
      if (/too large/i.test(detail)) {
        throw new Error(`it is too big for GitHub's API — almost certainly full-resolution frame grabs stored inside the setup. Run "python shrink_frame_grabs.py --write" on the machine holding the setups folder, reload this page, and try again`);
      }
      throw new Error(`Save of ${path} failed (${res.status}): ${detail}`);
    }
    return res.json();
  }

  // A setup this big cannot go up, so there is no point spending the upload
  // to find out. Returns a reason, or null to proceed.
  //
  // The threshold is deliberately well past anything GitHub would have
  // accepted rather than close to it: a wrong skip here costs a day's work
  // not backed up, while a needless upload costs seconds -- the same trade
  // the "push when in doubt" rule below makes. Anything actually near the
  // real limit is caught by putJsonFile's 422 handling instead.
  const OVERSIZE_BYTES = 45 * 1024 * 1024;

  function oversizeReason(setup) {
    const json = JSON.stringify(setup);
    if (json.length <= OVERSIZE_BYTES) return null;
    const mb = n => (n / 1048576).toFixed(1);
    // Naming the grabs' share is what makes this actionable: it is ~99% of
    // the file every time, and without the number it reads as though the
    // props and positions were somehow the problem.
    let grabBytes = 0;
    (setup.scenes || []).forEach(scene => {
      if (scene.frameGrab && scene.frameGrab.imageDataUrl) grabBytes += scene.frameGrab.imageDataUrl.length;
      (scene.cameras || []).forEach(c => {
        if (c.frameGrab && c.frameGrab.imageDataUrl) grabBytes += c.frameGrab.imageDataUrl.length;
      });
    });
    return `it is ${mb(json.length)} MB, too big for GitHub's API — ${mb(grabBytes)} MB of that is frame grabs. `
      + 'Run "python shrink_frame_grabs.py --write" on the machine holding the setups folder, reload this page, and try again';
  }

  function configReady(cfg) { return !!(cfg.token && cfg.owner && cfg.repo); }

  // The setups folder on the server is the primary store -- the toolbar's
  // Save and "Load setup…" are the everyday path, and GitHub is a backup of
  // it. So anything restored from the repo is mirrored into that folder,
  // otherwise a setup could exist only in GitHub and be missing from the
  // list you normally work from. A failure there is reported but never fails
  // the GitHub operation itself, which has already succeeded by this point.
  // (The other direction needs no mirroring: a backup only ever pushes
  // setups that came out of that folder in the first place.)
  async function mirrorLocally(setup) {
    const res = await App.persistence.saveLocal(setup);
    if (App.toolbar && App.toolbar.refreshSetupPicker) await App.toolbar.refreshSetupPicker();
    return res;
  }

  // Read-modify-write the index with retry: two overlapping saves/refreshes
  // (e.g. the auto-refresh on load racing a manual click, or Save's own
  // index update overlapping a Refresh) can both read the same sha and then
  // have the second write rejected with a 409 because the file moved under
  // it. mutateFn receives the current array and returns the new one, or
  // null to signal "nothing to change" (skips the write). Always resolves
  // to the resulting array, whether or not a write happened.
  async function updateIndex(cfg, mutateFn, message) {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const indexFile = await fetchJsonFile(cfg, INDEX_PATH);
      const current = Array.isArray(indexFile.data) ? indexFile.data.slice() : [];
      const next = mutateFn(current);
      if (next === null) return current;
      try {
        await putJsonFile(cfg, INDEX_PATH, next, indexFile.sha, message);
        return next;
      } catch (err) {
        const isConflict = /\(409\)/.test(err.message);
        if (!isConflict || attempt === maxAttempts) throw err;
        // Someone else updated the index between our read and write -- loop
        // around and retry against the fresh version.
      }
    }
  }

  // Backs up the whole setups folder, not just the setup currently open.
  // The everyday path is Save (to server.py's setups folder), pressed many
  // times across a shoot day and usually across several setups; GitHub is
  // the end-of-day backup of that folder. Pushing only the open setup --
  // which is what this used to do -- silently left every other setup touched
  // that day un-backed-up, with nothing on screen to say so.
  //
  // "Already backed up" is decided per setup from index.json's updatedAt,
  // and Store.touch() bumps a setup's updatedAt on every edit, so untouched
  // setups are skipped: clicking again costs two listings rather than a
  // re-upload of every embedded frame grab in the folder.
  async function syncAllToGitHub() {
    const cfg = readFields();
    if (!configReady(cfg)) {
      setStatus('Fill in token, owner and repo first.', true);
      return;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));

    const btn = dom.qs('#btn-save-github');
    btn.disabled = true;
    setStatus('Checking what needs backing up…');

    const warnings = [];
    try {
      // The open setup's latest edits live only in the Store, so put them on
      // disk first -- otherwise "back up everything local" would faithfully
      // back up a stale copy of the very setup being worked on. A failure
      // here is worth saying out loud but mustn't stop the rest: the other
      // setups are already on disk and still worth pushing.
      const open = App.Store.getSetup();
      const openSave = await App.persistence.saveLocal(open);
      if (openSave.ok) {
        if (App.toolbar && App.toolbar.refreshSetupPicker) await App.toolbar.refreshSetupPicker();
      } else {
        warnings.push(`the open setup "${open.name}" could not be saved locally first (${openSave.reason})`);
      }

      const localEntries = await App.persistence.listLocal();
      if (!localEntries.length) {
        setStatus('No setups saved on this machine yet — nothing to back up.');
        App.toast('No local setups to back up.');
        return;
      }

      // The directory listing carries each file's blob sha, which is all a
      // PUT needs to overwrite it -- so this replaces what used to be a
      // per-file GET that downloaded the entire setup (frame grabs included)
      // purely to read its sha back out.
      const [repoFiles, indexFile] = await Promise.all([
        listDirectory(cfg, 'setups'),
        fetchJsonFile(cfg, INDEX_PATH)
      ]);
      const shaById = new Map();
      (Array.isArray(repoFiles) ? repoFiles : [])
        .filter(f => f.type === 'file' && f.name.endsWith('.json') && f.name !== 'index.json')
        .forEach(f => shaById.set(f.name.replace(/\.json$/, ''), f.sha));
      const indexed = Array.isArray(indexFile.data) ? indexFile.data : [];
      const backedUpAt = new Map(indexed.map(e => [e.id, e.updatedAt]));

      // Push when the repo hasn't got the file, when the index has no record
      // of it (so there's no telling which version is up there), or when the
      // local copy has been edited since. A missing timestamp on either side
      // means "can't prove it's current" -- push it, since the cost of a
      // needless upload is a few seconds and the cost of a wrong skip is a
      // day's work not backed up.
      const pending = localEntries.filter(e => {
        if (!shaById.has(e.id) || !backedUpAt.has(e.id)) return true;
        const there = backedUpAt.get(e.id);
        return !e.updatedAt || !there || e.updatedAt > there;
      });

      if (!pending.length) {
        setStatus(`All ${localEntries.length} local setup(s) are already backed up to ${cfg.owner}/${cfg.repo}.`);
        App.toast('Everything on this machine is already backed up to GitHub.');
        await refreshLoadList(cfg);
        return;
      }

      const pushed = [];
      const failed = [];
      for (let i = 0; i < pending.length; i++) {
        const entry = pending[i];
        setStatus(`Backing up ${i + 1}/${pending.length}: ${entry.name}…`);
        try {
          const setup = await App.persistence.loadLocal(entry.id);
          if (!setup) throw new Error('it is no longer in the setups folder');
          // Thrown rather than returned, so an oversized setup lands in the
          // same failed[] the status line already names -- and, like every
          // other failure here, doesn't abort the setups queued behind it.
          const oversize = oversizeReason(setup);
          if (oversize) throw new Error(oversize);
          await putJsonFile(cfg, `setups/${setup.id}.json`, setup, shaById.get(setup.id),
            `Save "${setup.name}" — ${new Date().toISOString()}`);
          pushed.push({ id: setup.id, name: setup.name, updatedAt: setup.updatedAt, sceneCount: (setup.scenes || []).length });
        } catch (err) {
          // One unreadable or rejected setup must not cost the backup of
          // every other setup queued behind it.
          failed.push(`${entry.name} (${err.message})`);
        }
      }

      // One index write for the whole batch rather than one per setup: fewer
      // commits, and fewer chances to lose the 409 retry race in updateIndex.
      if (pushed.length) {
        await updateIndex(cfg, current => {
          const ids = new Set(pushed.map(e => e.id));
          return [...pushed, ...current.filter(e => !ids.has(e.id))];
        }, `Back up ${pushed.length} setup(s) — ${new Date().toISOString()}`);
      }

      // "N of M" only when some failed -- on the happy path the two numbers
      // are equal and the longer form just reads like something went wrong.
      const skipped = localEntries.length - pending.length;
      const count = failed.length ? `${pushed.length} of ${pending.length}` : String(pushed.length);
      const parts = [`Backed up ${count} setup(s) to ${cfg.owner}/${cfg.repo}`];
      if (skipped) parts.push(`${skipped} already up to date`);
      if (failed.length) parts.push(`failed: ${failed.join('; ')}`);
      warnings.forEach(w => parts.push(w));
      const bad = failed.length > 0 || warnings.length > 0;
      setStatus(parts.join(' — ') + '.', bad);
      App.toast(bad ? parts.join(' — ') : `Backed up ${pushed.length} setup(s) to GitHub.`, bad);
      await refreshLoadList(cfg);
    } catch (err) {
      setStatus(err.message, true);
      App.toast('GitHub backup failed: ' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function listDirectory(cfg, path) {
    const res = await fetch(`${contentsUrl(cfg, path)}?ref=${encodeURIComponent(cfg.branch)}`, { headers: authHeaders(cfg), cache: 'no-store' });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Listing ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  let refreshInFlight = false;

  // Reads the index manifest, then reconciles it against what's actually in
  // the repo's setups/ folder in both directions: picks up files saved
  // before this Load feature existed (or added outside the app), and drops
  // entries whose file no longer exists (e.g. deleted from GitHub directly)
  // -- so the index doesn't drift from what's really there.
  async function refreshLoadList(cfg) {
    cfg = cfg || readFields();
    const picker = dom.qs('#gh-load-picker');
    if (!configReady(cfg) || refreshInFlight) return;
    refreshInFlight = true;
    const btn = dom.qs('#btn-refresh-github-list');
    btn.disabled = true;

    try {
      const indexFile = await fetchJsonFile(cfg, INDEX_PATH);
      const indexed = Array.isArray(indexFile.data) ? indexFile.data : [];
      const knownIds = new Set(indexed.map(e => e.id));

      const files = await listDirectory(cfg, 'setups');
      const jsonFiles = Array.isArray(files) ? files.filter(f => f.type === 'file' && f.name.endsWith('.json') && f.name !== 'index.json') : [];
      const existingIds = new Set(jsonFiles.map(f => f.name.replace(/\.json$/, '')));
      const orphanFiles = jsonFiles.filter(f => !knownIds.has(f.name.replace(/\.json$/, '')));
      const staleCount = indexed.filter(e => !existingIds.has(e.id)).length;

      const recovered = [];
      for (const f of orphanFiles) {
        try {
          const { data } = await fetchJsonFile(cfg, f.path);
          if (data && data.id) {
            recovered.push({ id: data.id, name: data.name, updatedAt: data.updatedAt, sceneCount: (data.scenes || []).length });
          }
        } catch (e) { /* unreadable/corrupt file -- skip it */ }
      }

      let entries = indexed;
      if (recovered.length || staleCount) {
        entries = await updateIndex(cfg, current => {
          const kept = current.filter(e => existingIds.has(e.id));
          const ids = new Set(kept.map(e => e.id));
          const toAdd = recovered.filter(e => !ids.has(e.id));
          const changed = kept.length !== current.length || toAdd.length;
          return changed ? [...kept, ...toAdd] : null;
        }, `Repair setups index (+${recovered.length} recovered, -${staleCount} deleted)`);
        const parts = [];
        if (recovered.length) parts.push(`found ${recovered.length} previously-saved setup(s)`);
        if (staleCount) parts.push(`removed ${staleCount} deleted setup(s)`);
        setStatus(parts.join('; ') + '.');
      }

      entries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      dom.clear(picker);
      picker.appendChild(dom.el('option', { value: '', text: entries.length ? 'Load setup from GitHub…' : 'No saved setups yet' }));
      entries.forEach(e => {
        const when = e.updatedAt ? new Date(e.updatedAt).toLocaleString() : '';
        picker.appendChild(dom.el('option', { value: e.id, text: `${e.name} (${e.sceneCount || 1} position${e.sceneCount === 1 ? '' : 's'}) — ${when}` }));
      });
    } catch (err) {
      setStatus('Could not refresh list: ' + err.message, true);
    } finally {
      refreshInFlight = false;
      btn.disabled = false;
    }
  }

  async function loadFromGitHub(id) {
    if (!id) return;
    const cfg = readFields();
    if (!configReady(cfg)) {
      setStatus('Fill in token, owner and repo first.', true);
      return;
    }
    setStatus('Loading…');
    try {
      const { data } = await fetchJsonFile(cfg, `setups/${id}.json`);
      if (!data) throw new Error('That setup file no longer exists in the repo.');
      const setup = migrateSetup(data);
      App.Store.setSetup(setup);
      // Restoring a backup should land it in the local store too, so it's
      // in the toolbar's "Load setup…" list from here on.
      const local = await mirrorLocally(setup);
      setStatus(`Restored "${setup.name}" from GitHub.` + (local.ok ? '' : ` (saving it locally failed: ${local.reason})`));
      App.toast(local.ok
        ? `Restored "${setup.name}" from GitHub — also saved on this machine.`
        : `Restored "${setup.name}", but the local save failed: ${local.reason}`, !local.ok);
    } catch (err) {
      setStatus(err.message, true);
      App.toast('GitHub load failed: ' + err.message, true);
    }
  }

  function clearLoadPicker(text) {
    const picker = dom.qs('#gh-load-picker');
    dom.clear(picker);
    picker.appendChild(dom.el('option', { value: '', text }));
  }

  // Re-fetch (or clear) the Load list whenever the repo config itself
  // changes -- e.g. pointing at a different repo, or clearing the repo
  // field -- so it doesn't keep showing setups from a repo you've since
  // moved away from.
  function onConfigFieldChange() {
    const cfg = readFields();
    if (configReady(cfg)) refreshLoadList(cfg);
    else clearLoadPicker('Fill in token/owner/repo first');
  }

  App.githubSync = {
    init() {
      const cfg = loadConfig();
      populateFields(cfg);
      dom.qs('#btn-save-github').addEventListener('click', syncAllToGitHub);
      dom.qs('#btn-refresh-github-list').addEventListener('click', () => refreshLoadList());
      dom.qs('#gh-load-picker').addEventListener('change', e => loadFromGitHub(e.target.value));
      ['#gh-token', '#gh-owner', '#gh-repo', '#gh-branch'].forEach(sel => {
        dom.qs(sel).addEventListener('change', onConfigFieldChange);
      });
      if (configReady(cfg)) refreshLoadList(cfg);
    }
  };
})();
