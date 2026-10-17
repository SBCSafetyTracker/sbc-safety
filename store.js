/* SBC Safety – storage client: Google Sheet + Drive via Apps Script, phone-first (works offline) */
(function () {
  'use strict';
  const CFG = window.SBC_CONFIG || {};

  /* ---- sign-in token (arrives as #t=... from the login page) ---- */
  function readHash() {
    const m = /[#&]t=([A-Za-z0-9]+)/.exec(location.hash || '');
    if (m) {
      try { localStorage.setItem('sbc_token', m[1]); } catch (e) {}
      history.replaceState(null, '', location.pathname + location.search);
    }
  }
  readHash();
  function token() { try { return localStorage.getItem('sbc_token') || ''; } catch (e) { return ''; } }

  /* ---- tiny IndexedDB key/value store ---- */
  let dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      const r = indexedDB.open('sbc-safety', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return idb().then(function (d) {
      return new Promise(function (res, rej) {
        const t = d.transaction('kv', mode); const s = t.objectStore('kv'); const out = fn(s);
        t.oncomplete = function () { res(out && 'result' in out ? out.result : undefined); };
        t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); };
      });
    });
  }
  const kv = {
    get: function (k) { return tx('readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return tx('readwrite', function (s) { s.put(v, k); }); },
    del: function (k) { return tx('readwrite', function (s) { s.delete(k); }); }
  };

  /* ---- state ---- */
  let rows = {};          // "col/id" -> {col,id,data}
  let since = 0;
  let outbox = [];        // [{k:'w',col,id,data}|{k:'w',col,id,del:true}|{k:'p',pid}]
  let me = null;
  try { me = JSON.parse(localStorage.getItem('sbc_me') || 'null'); } catch (e) {}
  const colL = {}, docL = {};
  let errorCb = function () {}, statusCb = function () {};

  function persistRows() { clearTimeout(persistRows.t); persistRows.t = setTimeout(function () { kv.set('rows', rows).catch(function () {}); kv.set('since', since).catch(function () {}); }, 300); }
  function persistOutbox() { return kv.set('outbox', outbox).catch(function () { errorCb('Phone storage is full.'); }); }

  function emit(col) {
    if (col === 'config') {
      const r = rows['config/settings'];
      (docL['config/settings'] || []).forEach(function (cb) { cb({ exists: !!r, data: function () { return r ? JSON.parse(JSON.stringify(r.data)) : undefined; } }); });
      return;
    }
    const docs = Object.keys(rows).filter(function (k) { return rows[k].col === col; }).map(function (k) {
      const r = rows[k]; return { id: r.id, data: function () { return JSON.parse(JSON.stringify(r.data)); } };
    });
    (colL[col] || []).forEach(function (cb) { cb({ docs: docs }); });
  }
  function emitAll() { Object.keys(colL).forEach(emit); emit('config'); }

  function localWrite(col, id, data) {
    const key = col + '/' + id;
    if (data === null) delete rows[key]; else rows[key] = { col: col, id: id, data: data };
    persistRows(); emit(col);
  }

  /* ---- server calls ---- */
  async function api(op, payload, timeoutMs) {
    if (!CFG.api) { const e0 = new Error('not set up'); e0.code = 'setup'; throw e0; }
    const ctl = new AbortController(); const tm = setTimeout(function () { ctl.abort(); }, timeoutMs || 60000);
    let r;
    try {
      r = await fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ t: token(), op: op }, payload || {})), signal: ctl.signal, redirect: 'follow' });
    } finally { clearTimeout(tm); }
    const j = await r.json();
    if (!j.ok) {
      const e = new Error(j.message || j.code); e.code = j.code;
      if (j.code === 'signin') { try { localStorage.removeItem('sbc_token'); } catch (x) {} statusCb('signin'); }
      throw e;
    }
    return j;
  }

  function b64(blob) { return new Promise(function (res, rej) { const fr = new FileReader(); fr.onload = function () { res(String(fr.result).split(',')[1]); }; fr.onerror = rej; fr.readAsDataURL(blob); }); }

  let flushing = false;
  async function flush() {
    if (flushing || !outbox.length || !navigator.onLine || !token()) return;
    flushing = true; statusCb('sending');
    try {
      while (outbox.length) {
        const o = outbox[0];
        if (o.k === 'p') {
          const blob = await kv.get('p:' + o.pid);
          if (blob) {
            try { await api('photo', { pid: o.pid, data: await b64(blob) }, 120000); }
            catch (e) { if (e.code === 'not_allowed') errorCb('Your role cannot add photos.'); else throw e; }
          }
          outbox.shift();
        } else {
          let n = 0; while (n < outbox.length && n < 25 && outbox[n].k === 'w') n++;
          const batch = outbox.slice(0, n);
          try { await api('write', { ops: batch.map(function (w) { return w.del ? { col: w.col, id: w.id, del: true } : { col: w.col, id: w.id, data: w.data }; }) }); }
          catch (e) { if (e.code === 'not_allowed') { errorCb('Your role cannot change these records.'); } else throw e; }
          outbox.splice(0, n);
        }
        await persistOutbox();
      }
    } catch (e) { /* offline or server busy: keep for later */ }
    flushing = false; statusCb('idle');
  }

  let pulling = false;
  async function pull() {
    if (pulling || !navigator.onLine || !token()) return;
    pulling = true;
    try {
      const j = await api('pull', { since: since });
      const pend = {}; outbox.forEach(function (o) { if (o.k === 'w') pend[o.col + '/' + o.id] = 1; });
      const touched = {};
      j.rows.forEach(function (r) {
        const key = r.col + '/' + r.id; if (pend[key]) return;
        if (r.deleted) delete rows[key]; else rows[key] = { col: r.col, id: r.id, data: r.data };
        touched[r.col] = 1;
      });
      since = j.since; persistRows();
      if (me && j.role && me.role !== j.role) { me.role = j.role; saveMe(); }
      Object.keys(touched).forEach(emit);
    } catch (e) {}
    pulling = false;
  }
  function saveMe() { try { localStorage.setItem('sbc_me', JSON.stringify(me)); } catch (e) {} }

  async function sync() { await flush(); await pull(); }

  /* ---- photos ---- */
  const purl = {}, pwait = {};
  function photo(pid) {
    if (purl[pid]) return Promise.resolve(purl[pid]);
    if (pwait[pid]) return pwait[pid];
    pwait[pid] = (async function () {
      let blob = await kv.get('p:' + pid).catch(function () { return null; });
      if (!blob) {
        const j = await api('getphoto', { pid: pid }, 90000);
        const bin = atob(j.data); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        blob = new Blob([u8], { type: j.type || 'image/jpeg' });
        kv.set('p:' + pid, blob).catch(function () {});
      }
      purl[pid] = URL.createObjectURL(blob); return purl[pid];
    })();
    pwait[pid].catch(function () { setTimeout(function () { delete pwait[pid]; }, 60000); });
    return pwait[pid];
  }
  function newId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }

  /* ---- the API the app uses ---- */
  function docRef(col, id) {
    return {
      set: async function (body) {
        const data = JSON.parse(JSON.stringify(body));
        localWrite(col, id, data);
        outbox = outbox.filter(function (o) { return !(o.k === 'w' && o.col === col && o.id === id); });
        outbox.push({ k: 'w', col: col, id: id, data: data }); await persistOutbox(); flush();
      },
      delete: async function () {
        localWrite(col, id, null);
        outbox = outbox.filter(function (o) { return !(o.k === 'w' && o.col === col && o.id === id); });
        outbox.push({ k: 'w', col: col, id: id, del: true }); await persistOutbox(); flush();
      },
      onSnapshot: function (cb) { const k = col + '/' + id; (docL[k] = docL[k] || []).push(cb); emit(col); return function () {}; }
    };
  }
  const db = {
    collection: function (col) {
      return {
        doc: function (id) { return docRef(col, String(id)); },
        onSnapshot: function (cb) { (colL[col] = colL[col] || []).push(cb); emit(col); return function () {}; }
      };
    },
    doc: function (path) { const p = path.split('/'); return docRef(p[0], p[1]); }
  };
  const assets = {
    upload: async function (blob) {
      const pid = newId();
      await kv.set('p:' + pid, blob);
      outbox.push({ k: 'p', pid: pid }); await persistOutbox(); flush();
      purl[pid] = URL.createObjectURL(blob);
      return { id: pid, url: purl[pid] };
    }
  };
  async function importPhoto(pid, blob) {
    pid = String(pid).replace(/[^A-Za-z0-9_-]/g, '');
    if (!pid) return;
    await kv.set('p:' + pid, blob);
    outbox.push({ k: 'p', pid: pid }); await persistOutbox();
    purl[pid] = URL.createObjectURL(blob);
  }
  function nameOf(id) { return String(id || '').split('@')[0].replace(/[._]/g, ' '); }
  const user = {
    me: async function () { return { id: me.email, isOwner: !!me.isOwner, canEdit: true, name: nameOf(me.email), role: me.role }; },
    profiles: async function (ids) { const o = {}; ids.forEach(function (id) { o[id] = { id: id, name: id }; }); return o; },
    search: async function (q) {
      q = String(q || '').trim().toLowerCase(); if (!q) return [];
      const email = q.indexOf('@') >= 0 ? q : q + '@' + (CFG.domain || 'sbcmail.in');
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return [];
      return [{ id: email, name: email, isMe: me && me.email === email }];
    }
  };
  const dl = {
    save: async function (o) {
      const blob = o.data instanceof Blob ? o.data : new Blob([o.data], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename;
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
  };

  async function init() {
    try {
      const r = await kv.get('rows'); if (r) rows = r;
      since = (await kv.get('since')) || 0;
      outbox = (await kv.get('outbox')) || [];
    } catch (e) {}
    if (navigator.onLine) {
      try { const j = await api('me', {}, 20000); me = { email: j.email, isOwner: j.isOwner, role: j.role }; saveMe(); }
      catch (e) { if (e.code === 'signin') return false; }
    }
    if (!me) return false;
    emitAll();
    sync();
    setInterval(function () { if (document.visibilityState === 'visible') sync(); }, 45000);
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sync(); });
    return true;
  }

  async function signOut() {
    try { await api('logout', {}, 10000); } catch (e) {}
    try { localStorage.removeItem('sbc_token'); localStorage.removeItem('sbc_me'); } catch (e) {}
    location.reload();
  }

  window.SBCStore = {
    token: token, init: init, db: db, assets: assets, importPhoto: importPhoto, user: user, dl: dl, photo: photo, sync: sync, signOut: signOut,
    loginUrl: CFG.login || '', configured: !!(CFG.api && CFG.login),
    pending: function () { return outbox.length; },
    onError: function (cb) { errorCb = cb; }, onStatus: function (cb) { statusCb = cb; }
  };
  // signed in from another tab (e.g. the login page opened in Chrome) -> reload into the app
  window.addEventListener('storage', function (e) { if (e.key === 'sbc_token' && e.newValue) location.reload(); });
  window.addEventListener('hashchange', function () { const had = token(); readHash(); if (!had && token()) location.reload(); });
})();
