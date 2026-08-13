// GitHub Sync panel: save the current setup (all its scenes, props, frame
// grabs, reference points) as one JSON file (setups/<setup.id>.json,
// overwritten on every save) to a GitHub repo via the Contents API, straight
// from the browser -- no server involved, same as the rest of this static
// app. A small setups/index.json manifest ({id, name, updatedAt}[]) is kept
// alongside so the app can list/load setups without fetching every file.
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
    if (!res.ok) throw new Error(`Save of ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  function configReady(cfg) { return !!(cfg.token && cfg.owner && cfg.repo); }

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

  async function saveToGitHub() {
    const cfg = readFields();
    if (!configReady(cfg)) {
      setStatus('Fill in token, owner and repo first.', true);
      return;
    }
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));

    const setup = App.Store.getSetup();
    const path = `setups/${setup.id}.json`;

    const btn = dom.qs('#btn-save-github');
    btn.disabled = true;
    setStatus('Saving…');

    try {
      const existing = await fetchJsonFile(cfg, path);
      await putJsonFile(cfg, path, setup, existing.sha, `Save "${setup.name}" — ${new Date().toISOString()}`);

      // Keep the index manifest in sync so the Load list stays accurate.
      await updateIndex(cfg, current => {
        const entry = { id: setup.id, name: setup.name, updatedAt: setup.updatedAt, sceneCount: setup.scenes.length };
        return [entry, ...current.filter(e => e.id !== setup.id)];
      }, `Update setups index — ${setup.name}`);

      setStatus(`Saved to ${cfg.owner}/${cfg.repo}/${path}`);
      App.toast(`Setup saved to GitHub: ${path}`);
      await refreshLoadList(cfg);
    } catch (err) {
      setStatus(err.message, true);
      App.toast('GitHub save failed: ' + err.message, true);
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
      App.Store.setSetup(migrateSetup(data));
      setStatus(`Loaded "${data.name}" from GitHub.`);
      App.toast(`Loaded "${data.name}" from GitHub.`);
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
      dom.qs('#btn-save-github').addEventListener('click', saveToGitHub);
      dom.qs('#btn-refresh-github-list').addEventListener('click', () => refreshLoadList());
      dom.qs('#gh-load-picker').addEventListener('change', e => loadFromGitHub(e.target.value));
      ['#gh-token', '#gh-owner', '#gh-repo', '#gh-branch'].forEach(sel => {
        dom.qs(sel).addEventListener('change', onConfigFieldChange);
      });
      if (configReady(cfg)) refreshLoadList(cfg);
    }
  };
})();
