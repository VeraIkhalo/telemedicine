// Amrutam test console: a thin UI over the REST API. No framework, no build step.
(() => {
  'use strict';

  const API = '/api/v1';
  const $ = (sel) => document.querySelector(sel);
  const main = $('#main');

  const S = {
    token: null,
    me: null,
    tab: null,
    doctors: [],
    slotsByDoctor: {},
    lastBooking: null, // { key, body } — lets the user resend the same request to see idempotency
    authView: 'login', // 'login' | 'register'
  };

  try { S.token = sessionStorage.getItem('amrutam.token'); } catch { /* storage unavailable */ }

  // ---------- helpers ----------
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rupees = (cents) => '₹' + (Number(cents || 0) / 100).toLocaleString('en-IN');
  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const shortId = (id) => String(id).slice(0, 8);
  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const badge = (s) => `<span class="badge ${esc(s)}">${esc(String(s).replace('_', ' '))}</span>`;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function saveToken(token) {
    S.token = token;
    try { token ? sessionStorage.setItem('amrutam.token', token) : sessionStorage.removeItem('amrutam.token'); } catch { /* ignore */ }
  }

  // ---------- API client + request log ----------
  async function api(method, path, { body, idem } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (S.token) headers.Authorization = `Bearer ${S.token}`;
    if (idem) headers['Idempotency-Key'] = idem;

    const started = performance.now();
    let res, data;
    try {
      res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    } catch (err) {
      logCall({ method, path, status: 0, ms: 0, body, data: String(err), idem });
      throw new Error('Cannot reach the backend. Is `npm start` running?');
    }
    const replayed = res.headers.get('Idempotent-Replayed') === 'true';
    logCall({ method, path, status: res.status, ms: Math.round(performance.now() - started), body, data, idem, replayed });

    if (res.status === 401 && S.me) { logout('Your session has ended. Please log in again.', { remote: false }); }
    if (!res.ok) {
      const e = new Error(data?.error?.message || `Request failed (${res.status})`);
      e.status = res.status;
      e.data = data;
      throw e;
    }
    return { data, status: res.status, replayed };
  }

  function logCall({ method, path, status, ms, body, data, idem, replayed }) {
    const li = document.createElement('li');
    const cls = status >= 200 && status < 300 ? 'ok' : status >= 400 && status < 500 ? 'pending' : 'err';
    li.innerHTML = `<details>
      <summary><span class="badge ${cls}">${status || 'ERR'}</span><b>${esc(method)}</b><span class="path">${esc(path)}</span>
        <small>${ms} ms</small>${replayed ? '<span class="badge ok">idempotent replay</span>' : ''}</summary>
      ${idem ? `<div><small>Idempotency-Key: <code>${esc(idem)}</code></small></div>` : ''}
      ${body !== undefined ? `<div><small>Request</small><pre>${esc(JSON.stringify(redact(body), null, 2))}</pre></div>` : ''}
      <div><small>Response</small><pre>${esc(typeof data === 'string' ? data : JSON.stringify(data, null, 2))}</pre></div>
    </details>`;
    $('#log').prepend(li);
  }
  const redact = (b) => (b && b.password ? { ...b, password: '••••••' } : b);
  $('#clear-log').addEventListener('click', () => { $('#log').innerHTML = ''; });

  // API log is a developer aid: hidden by default, toggled from the header.
  $('#toggle-log').addEventListener('click', () => {
    const panel = $('#log-panel');
    panel.hidden = !panel.hidden;
    document.body.classList.toggle('with-log', !panel.hidden);
    $('#toggle-log').textContent = panel.hidden ? 'Show API log' : 'Hide API log';
  });

  // Run an async action and show any error as a toast.
  async function run(fn) {
    try { await fn(); } catch (e) { toast(e.message); }
  }

  // ---------- auth ----------
  async function loadMe() {
    const { data } = await api('GET', '/auth/me');
    S.me = data;
    S.tab = { patient: 'find', doctor: 'consultations', admin: 'analytics' }[data.role];
  }

  // Ends the session on the server first (so the token stops working everywhere),
  // then wipes everything this page knows about the user.
  async function logout(msg, { remote = true } = {}) {
    if (remote && S.token) {
      try { await api('POST', '/auth/logout'); } catch { /* already ended — still clear locally */ }
    }
    saveToken(null);
    Object.assign(S, { me: null, tab: null, doctors: [], slotsByDoctor: {}, lastBooking: null, authView: 'login' });
    $('#log').innerHTML = '';
    render();
    if (msg) toast(msg);
  }

  function renderWho() {
    const who = $('#who');
    if (!S.me) { who.innerHTML = ''; return; }
    who.innerHTML = `<span>${esc(S.me.full_name)} ${badge(S.me.role)}</span><button class="ghost small" data-action="logout">Log out</button>`;
  }

  function authView() {
    return `<div class="auth-wrap">${S.authView === 'register' ? registerView() : loginView()}</div>`;
  }

  function loginView() {
    return `
      <section class="card">
        <h2>Log in</h2>
        <p class="muted">Use a demo account, or your own after registering.</p>
        <div class="demo-users">
          <button class="ghost" data-action="demo" data-email="patient@amrutam.dev"><span>Patient — Priya</span><small>book &amp; view</small></button>
          <button class="ghost" data-action="demo" data-email="doctor@amrutam.dev"><span>Doctor — Dr. Arjun</span><small>slots, consult, prescribe</small></button>
          <button class="ghost" data-action="demo" data-email="admin@amrutam.dev"><span>Admin</span><small>analytics &amp; audit</small></button>
        </div>
        <form id="login-form">
          <label>Email</label><input name="email" type="email" required>
          <label>Password</label><input name="password" type="password" required>
          <label>MFA code (only if you enabled MFA)</label><input name="totp" inputmode="numeric" pattern="\\d{6}" placeholder="123456">
          <div class="actions"><button type="submit">Log in</button></div>
        </form>
        <p class="switch">New here? <button class="linkish" data-action="auth-view" data-view="register">Create an account</button></p>
      </section>`;
  }

  function registerView() {
    return `
      <section class="card">
        <h2>Create an account</h2>
        <form id="register-form">
          <label>Account type</label>
          <select name="role"><option value="patient">Patient</option><option value="doctor">Doctor</option></select>
          <label>Full name</label><input name="fullName" required>
          <label>Email</label><input name="email" type="email" required>
          <label>Password <small>(10+ chars, upper, lower, digit)</small></label><input name="password" type="password" required>
          <div id="doctor-fields" hidden>
            <div class="row">
              <div><label>Specialization</label><input name="specialization" placeholder="Ayurveda"></div>
              <div><label>Years experience</label><input name="yearsExperience" type="number" min="0" value="5"></div>
            </div>
            <div class="row">
              <div><label>Fee (₹)</label><input name="fee" type="number" min="0" value="400"></div>
              <div><label>Languages</label><input name="languages" placeholder="english, hindi"></div>
            </div>
            <div class="callout warn">New doctors appear in search only after an admin verifies them.</div>
          </div>
          <div class="actions"><button type="submit">Create account</button></div>
        </form>
        <p class="switch">Already have an account? <button class="linkish" data-action="auth-view" data-view="login">Log in</button></p>
      </section>`;
  }

  // ---------- views ----------
  const TABS = {
    patient: [['find', 'Find a doctor'], ['consultations', 'My consultations'], ['account', 'Account & MFA']],
    doctor: [['consultations', 'My consultations'], ['availability', 'Availability'], ['account', 'Account & MFA']],
    admin: [['analytics', 'Analytics'], ['doctors', 'Doctors'], ['audit', 'Audit log'], ['account', 'Account & MFA']],
  };

  function tabsBar() {
    return `<nav class="tabs">${TABS[S.me.role]
      .map(([id, label]) => `<button class="${S.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}">${label}</button>`)
      .join('')}</nav>`;
  }

  async function render() {
    renderWho();
    if (!S.me) {
      main.innerHTML = authView();
      return;
    }
    main.innerHTML = tabsBar() + '<div id="view"><div class="card muted">Loading…</div></div>';
    const view = $('#view');
    try {
      const fn = VIEWS[S.me.role + ':' + S.tab] || VIEWS[S.tab];
      view.innerHTML = await fn();
    } catch (e) {
      view.innerHTML = `<div class="card"><b>Couldn't load this view.</b><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  const VIEWS = {
    // ----- patient -----
    async 'patient:find'() {
      // Show every available doctor straight away; filters narrow it down.
      if (!S.doctors.length) S.doctors = (await api('GET', '/doctors?limit=50')).data.data;
      return `
      <section class="card">
        <h2>Find a doctor</h2>
        <form id="search-form" class="row">
          <div><label>Name or specialty</label><input name="q" placeholder="e.g. Ayurveda, skin, Meera"></div>
          <div><label>Language</label><input name="language" placeholder="hindi"></div>
          <div><label>Max fee (₹)</label><input name="maxFee" type="number" min="0"></div>
          <div><label>Available on</label><input name="availableOn" type="date"></div>
          <div class="shrink"><button type="submit">Search</button></div>
        </form>
      </section>
      <section class="card"><div id="results">${doctorList()}</div></section>
      <section class="card" id="booking-result" ${S.lastBooking ? '' : 'hidden'}>${bookingResult()}</section>`;
    },

    async consultations() {
      const { data } = await api('GET', '/consultations?limit=50');
      const rows = data.data;
      const isDoc = S.me.role === 'doctor';
      if (!rows.length) {
        return `<section class="card"><h2>My consultations</h2><p class="muted">${isDoc ? 'No bookings yet. Add slots in the Availability tab, then book one as the patient.' : 'No consultations yet. Book one from "Find a doctor".'}</p></section>`;
      }
      const pending = rows.some((r) => r.status === 'pending_payment');
      if (pending) setTimeout(() => { if (S.tab === 'consultations') render(); }, 2000);
      return `<section class="card"><h2>My consultations</h2>
        ${pending ? '<div class="callout warn">A payment is processing in the background worker. This list refreshes automatically.</div>' : ''}
        <div class="list" style="margin-top:.8rem">${rows.map((c) => consultationItem(c, isDoc)).join('')}</div></section>`;
    },

    async account() {
      return `
      <section class="card">
        <h2>Account</h2>
        <table><tbody>
          <tr><th>Name</th><td>${esc(S.me.full_name)}</td></tr>
          <tr><th>Email</th><td>${esc(S.me.email)}</td></tr>
          <tr><th>Role</th><td>${badge(S.me.role)}</td></tr>
          <tr><th>User ID</th><td><code>${esc(S.me.id)}</code></td></tr>
          <tr><th>MFA</th><td>${S.me.mfa_enabled ? badge('ok').replace('ok<', 'enabled<') : '<span class="badge">off</span>'}</td></tr>
        </tbody></table>
      </section>
      <section class="card">
        <h2>Two-factor authentication (TOTP)</h2>
        <p class="muted">Step 1 generates a secret. Add it to Google Authenticator / Authy (manual entry), then enter the 6-digit code to switch MFA on. After that, login asks for the code.</p>
        <div class="actions"><button data-action="mfa-setup">1. Generate secret</button></div>
        <div id="mfa-secret"></div>
        <form id="mfa-form" class="row" style="margin-top:.6rem">
          <div><label>2. Code from your app</label><input name="totp" inputmode="numeric" pattern="\\d{6}" required></div>
          <div class="shrink"><button type="submit">Enable MFA</button></div>
        </form>
      </section>`;
    },

    // ----- doctor -----
    async 'doctor:availability'() {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 14 * 864e5).toISOString();
      const { data } = await api('GET', `/doctors/${S.me.id}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
      return `
      <section class="card">
        <h2>Publish availability</h2>
        <form id="slots-form" class="row">
          <div><label>Date</label><input name="date" type="date" value="${tomorrow}" required></div>
          <div><label>First slot starts</label><input name="time" type="time" value="10:00" required></div>
          <div><label>Number of 30-min slots</label><input name="count" type="number" min="1" max="20" value="4" required></div>
          <div class="shrink"><button type="submit">Add slots</button></div>
        </form>
      </section>
      <section class="card">
        <h2>Next 14 days</h2>
        ${data.length ? `<div class="table-wrap"><table><thead><tr><th>Start</th><th>End</th><th>Status</th></tr></thead><tbody>
          ${data.map((s) => `<tr><td>${when(s.start_time)}</td><td>${when(s.end_time)}</td><td>${badge(s.status)}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">No slots yet.</p>'}
      </section>`;
    },

    // ----- admin -----
    async 'admin:analytics'() {
      const { data: a } = await api('GET', '/admin/analytics?days=30');
      const total = a.consultationsByStatus.reduce((n, r) => n + r.count, 0);
      return `
      <section class="card">
        <h2>Last 30 days</h2>
        <div class="stats">
          <div class="stat"><small>Consultations</small><b>${total}</b></div>
          <div class="stat"><small>Revenue</small><b>${rupees(a.revenueCents)}</b></div>
          <div class="stat"><small>Paid consultations</small><b>${a.paidConsultations}</b></div>
          ${a.usersByRole.map((u) => `<div class="stat"><small>${esc(u.role)}s</small><b>${u.count}</b></div>`).join('')}
        </div>
        <div class="grid2">
          <div><h3>By status</h3><table><tbody>${a.consultationsByStatus.map((r) => `<tr><td>${badge(r.status)}</td><td>${r.count}</td></tr>`).join('') || '<tr><td class="muted">No data</td></tr>'}</tbody></table></div>
          <div><h3>Top doctors (completed)</h3><table><tbody>${a.topDoctors.map((d) => `<tr><td>${esc(d.full_name)}</td><td>${d.completed}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</tbody></table></div>
        </div>
        <h3 style="margin-top:1rem">Daily volume</h3>
        <table><tbody>${a.daily.map((d) => `<tr><td>${esc(String(d.day).slice(0, 10))}</td><td>${d.consultations}</td></tr>`).join('') || '<tr><td class="muted">No data</td></tr>'}</tbody></table>
      </section>`;
    },

    async 'admin:doctors'() {
      const { data } = await api('GET', '/admin/doctors');
      return `<section class="card"><h2>Doctors</h2>
        <p class="muted">Unverified doctors are hidden from patient search until verified.</p>
        <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Specialization</th><th>Fee</th><th>Status</th><th></th></tr></thead><tbody>
        ${data.map((d) => `<tr><td>${esc(d.full_name)}</td><td>${esc(d.email)}</td><td>${esc(d.specialization)}</td><td>${rupees(d.fee_cents)}</td>
          <td>${d.verified ? '<span class="badge ok">verified</span>' : '<span class="badge pending">unverified</span>'}</td>
          <td>${d.verified ? '' : `<button class="small" data-action="verify" data-id="${esc(d.id)}">Verify</button>`}</td></tr>`).join('')}
        </tbody></table></div></section>`;
    },

    async 'admin:audit'() {
      const { data } = await api('GET', '/admin/audit-logs?limit=100');
      return `<section class="card"><h2>Audit log</h2>
        <p class="muted">Append-only: the database rejects any UPDATE or DELETE on this table.</p>
        <div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Entity</th><th>Actor</th><th>Details</th></tr></thead><tbody>
        ${data.map((l) => `<tr><td>${when(l.created_at)}</td><td><code>${esc(l.action)}</code></td>
          <td>${esc(l.entity)} <small>${esc(l.entity_id ? shortId(l.entity_id) : '')}</small></td>
          <td><small>${esc(l.actor_id ? shortId(l.actor_id) : 'system')}</small></td>
          <td><small>${esc(Object.keys(l.metadata || {}).length ? JSON.stringify(l.metadata) : '')}</small></td></tr>`).join('')}
        </tbody></table></div></section>`;
    },
  };

  function doctorList() {
    if (!S.doctors.length) return '<p class="muted">Search to see verified doctors. Leave filters empty to list everyone.</p>';
    return `<div class="list">${S.doctors.map((d) => {
      const slots = S.slotsByDoctor[d.id];
      return `<div class="item">
        <div class="item-head"><div><b>${esc(d.full_name)}</b> <small>${esc(d.specialization)} · ${d.years_experience} yrs · ${esc((d.languages || []).join(', '))}</small></div>
          <div><b>${rupees(d.fee_cents)}</b> <small>★ ${esc(d.rating)}</small></div></div>
        ${slots === undefined
          ? `<div class="actions"><button class="ghost small" data-action="slots" data-id="${esc(d.id)}">Show open slots</button></div>`
          : slots.length
            ? `<div class="slots">${slots.map((s) => `<button class="slot small" data-action="book" data-slot="${esc(s.id)}" title="Book this slot">${when(s.start_time)}</button>`).join('')}</div>
               <small class="muted">Click a time to book it.</small>`
            : '<p class="muted">No open slots in the next 14 days.</p>'}
      </div>`;
    }).join('')}</div>`;
  }

  function bookingResult() {
    if (!S.lastBooking) return '';
    const b = S.lastBooking;
    return `<h2>Booking request</h2>
      <p>Status: ${b.result ? badge(b.result.status) : ''} ${b.replayed ? '<span class="badge ok">replayed — no new booking created</span>' : ''}</p>
      <p class="muted">Idempotency-Key: <code>${esc(b.key)}</code></p>
      <div class="callout"><b>Test idempotency:</b> resend the exact same request with the same key. The server returns the original
        response instead of booking twice (watch for <i>idempotent replay</i> in the request log).</div>
      <div class="actions">
        <button data-action="resend">Resend same request</button>
        <button class="ghost" data-action="tab" data-tab="consultations">Go to my consultations</button>
      </div>`;
  }

  function consultationItem(c, isDoc) {
    const other = isDoc ? `Patient: ${esc(c.patient_name)}` : `Doctor: ${esc(c.doctor_name)}`;
    const btn = (status, label, cls = '') => `<button class="small ${cls}" data-action="status" data-id="${esc(c.id)}" data-status="${status}">${label}</button>`;
    let actions = '';
    if (isDoc && c.status === 'scheduled') actions += btn('in_progress', 'Start consultation') + btn('no_show', 'Mark no-show', 'ghost');
    if (isDoc && c.status === 'in_progress') actions += btn('completed', 'Complete');
    if (isDoc && ['in_progress', 'completed'].includes(c.status)) actions += `<button class="small ghost" data-action="rx-open" data-id="${esc(c.id)}">Write prescription</button>`;
    if (['scheduled', 'pending_payment'].includes(c.status)) actions += btn('cancelled', 'Cancel', 'danger');
    actions += `<button class="small ghost" data-action="details" data-id="${esc(c.id)}">Details</button>`;
    return `<div class="item" id="c-${esc(c.id)}">
      <div class="item-head"><div><b>${when(c.start_time)}</b> <small>${other}</small></div>${badge(c.status)}</div>
      ${c.reason ? `<small class="muted">Reason: ${esc(c.reason)}</small>` : ''}
      <div class="actions">${actions}</div>
      <div class="extra"></div>
    </div>`;
  }

  function rxForm(id) {
    return `<form class="rx-form" data-id="${esc(id)}" style="margin-top:.6rem">
      <div class="row">
        <div><label>Medicine</label><input name="medicine" value="Triphala churna" required></div>
        <div><label>Dosage</label><input name="dosage" value="1 tsp" required></div>
        <div><label>Frequency</label><input name="frequency" value="At night with warm water" required></div>
        <div><label>Days</label><input name="durationDays" type="number" min="1" value="30" required></div>
      </div>
      <label>Advice</label><input name="advice" value="Avoid heavy dinners">
      <div class="actions"><button type="submit">Save prescription</button></div>
    </form>`;
  }

  // ---------- events ----------
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    const { action } = el.dataset;

    if (action === 'logout') return logout();
    if (action === 'auth-view') { S.authView = el.dataset.view; return render(); }
    if (action === 'tab') { S.tab = el.dataset.tab; return render(); }

    if (action === 'demo') {
      const form = $('#login-form');
      form.email.value = el.dataset.email;
      form.password.value = 'Passw0rd!234';
      return form.requestSubmit();
    }

    if (action === 'slots') return run(async () => {
      const { data } = await api('GET', `/doctors/${el.dataset.id}/slots`);
      S.slotsByDoctor[el.dataset.id] = data.filter((s) => s.status === 'open');
      $('#results').innerHTML = doctorList();
    });

    if (action === 'book') return run(async () => {
      const reason = prompt('Reason for consultation (optional):', 'Digestive issues') ?? null;
      if (reason === null) return;
      const body = { slotId: el.dataset.slot, ...(reason ? { reason } : {}) };
      const key = newKey();
      try {
        const { data, replayed } = await api('POST', '/consultations', { body, idem: key });
        S.lastBooking = { key, body, result: data, replayed };
        toast('Booked! Payment is being processed in the background.');
      } catch (e) {
        if (e.status === 409) toast('That slot was just taken — pick another.');
        else throw e;
      }
      // refresh slots for that doctor
      for (const id of Object.keys(S.slotsByDoctor)) {
        const { data } = await api('GET', `/doctors/${id}/slots`);
        S.slotsByDoctor[id] = data.filter((s) => s.status === 'open');
      }
      $('#results').innerHTML = doctorList();
      const box = $('#booking-result');
      if (box && S.lastBooking) { box.hidden = false; box.innerHTML = bookingResult(); }
    });

    if (action === 'resend') return run(async () => {
      const b = S.lastBooking;
      const { data, replayed } = await api('POST', '/consultations', { body: b.body, idem: b.key });
      S.lastBooking = { ...b, result: data, replayed };
      $('#booking-result').innerHTML = bookingResult();
      toast(replayed ? 'Same response replayed — no duplicate booking.' : 'Request processed.');
    });

    if (action === 'status') return run(async () => {
      let notes;
      if (el.dataset.status === 'in_progress') notes = prompt('Clinical notes (stored encrypted):', 'Vata imbalance, poor appetite') || undefined;
      if (el.dataset.status === 'cancelled' && !confirm('Cancel this consultation? The slot will reopen and any payment is refunded.')) return;
      await api('PATCH', `/consultations/${el.dataset.id}/status`, { body: { status: el.dataset.status, ...(notes ? { notes } : {}) }, idem: newKey() });
      toast('Status updated.');
      render();
    });

    if (action === 'rx-open') {
      const extra = $(`#c-${CSS.escape(el.dataset.id)} .extra`);
      extra.innerHTML = extra.innerHTML ? '' : rxForm(el.dataset.id);
      return;
    }

    if (action === 'details') return run(async () => {
      const { data } = await api('GET', `/consultations/${el.dataset.id}`);
      const extra = $(`#c-${CSS.escape(el.dataset.id)} .extra`);
      extra.innerHTML = `<div class="callout">
        <div><b>Notes:</b> ${data.notes ? esc(data.notes) : '<span class="muted">none</span>'}</div>
        <div><b>Prescriptions:</b> ${data.prescriptions.length ? '' : '<span class="muted">none</span>'}</div>
        ${data.prescriptions.map((p) => `<ul>${p.items.map((i) => `<li>${esc(i.medicine)} — ${esc(i.dosage)}, ${esc(i.frequency)}, ${i.durationDays} days</li>`).join('')}</ul>
          ${p.advice ? `<small>Advice: ${esc(p.advice)}</small>` : ''}`).join('')}
      </div>`;
    });

    if (action === 'verify') return run(async () => {
      await api('POST', `/admin/doctors/${el.dataset.id}/verify`);
      toast('Doctor verified — now visible in search.');
      render();
    });

    if (action === 'mfa-setup') return run(async () => {
      const { data } = await api('POST', '/auth/mfa/setup');
      $('#mfa-secret').innerHTML = `<div class="callout">Secret: <code>${esc(data.secret)}</code><br><small>otpauth URL: <code>${esc(data.otpauthUrl)}</code></small></div>`;
    });
  });

  document.addEventListener('change', (ev) => {
    if (ev.target.name === 'role' && ev.target.closest('#register-form')) {
      $('#doctor-fields').hidden = ev.target.value !== 'doctor';
    }
  });

  document.addEventListener('submit', (ev) => {
    const form = ev.target;
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));

    if (form.id === 'login-form') return run(async () => {
      const body = { email: f.email, password: f.password, ...(f.totp ? { totp: f.totp } : {}) };
      const { data } = await api('POST', '/auth/login', { body });
      if (data.mfaRequired) { toast('MFA is on for this account — enter the 6-digit code.'); form.totp.focus(); return; }
      saveToken(data.accessToken);
      await loadMe();
      render();
    });

    if (form.id === 'register-form') return run(async () => {
      const body = { email: f.email, password: f.password, fullName: f.fullName, role: f.role };
      if (f.role === 'doctor') {
        body.doctor = {
          specialization: f.specialization || 'Ayurveda',
          yearsExperience: Number(f.yearsExperience || 0),
          feeCents: Math.round(Number(f.fee || 0) * 100),
          languages: (f.languages || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
        };
      }
      try {
        await api('POST', '/auth/register', { body });
      } catch (e) {
        const fields = e.data?.error?.details?.fieldErrors;
        if (fields) throw new Error(Object.entries(fields).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · '));
        throw e;
      }
      toast('Account created — logging you in.');
      const { data } = await api('POST', '/auth/login', { body: { email: f.email, password: f.password } });
      saveToken(data.accessToken);
      await loadMe();
      render();
    });

    if (form.id === 'search-form') return run(async () => {
      const q = new URLSearchParams();
      if (f.q?.trim()) q.set('q', f.q.trim());
      if (f.language) q.set('language', f.language.trim().toLowerCase());
      if (f.maxFee) q.set('maxFee', String(Math.round(Number(f.maxFee) * 100)));
      if (f.availableOn) q.set('availableOn', f.availableOn);
      const { data } = await api('GET', '/doctors?' + q);
      S.doctors = data.data;
      S.slotsByDoctor = {};
      $('#results').innerHTML = doctorList() || '';
      if (!S.doctors.length) $('#results').innerHTML = '<p class="muted">No doctors match these filters. Try a broader search, or clear the filters to see everyone.</p>';
    });

    if (form.id === 'slots-form') return run(async () => {
      const start = new Date(`${f.date}T${f.time}`);
      const slots = Array.from({ length: Number(f.count) }, (_, i) => {
        const s = new Date(start.getTime() + i * 30 * 60000);
        return { startTime: s.toISOString(), endTime: new Date(s.getTime() + 30 * 60000).toISOString() };
      });
      const { data } = await api('POST', '/doctors/me/slots', { body: { slots } });
      toast(`${data.length} slot(s) added${data.length < slots.length ? ' (duplicates skipped)' : ''}.`);
      render();
    });

    if (form.id === 'mfa-form') return run(async () => {
      await api('POST', '/auth/mfa/enable', { body: { totp: f.totp } });
      toast('MFA enabled. You will need a code at next login.');
      await loadMe();
      render();
    });

    if (form.classList.contains('rx-form')) return run(async () => {
      const id = form.dataset.id;
      await api('POST', `/consultations/${id}/prescriptions`, {
        idem: newKey(),
        body: {
          items: [{ medicine: f.medicine, dosage: f.dosage, frequency: f.frequency, durationDays: Number(f.durationDays) }],
          ...(f.advice ? { advice: f.advice } : {}),
        },
      });
      toast('Prescription saved.');
      form.remove();
    });
  });

  // ---------- boot ----------
  (async () => {
    if (S.token) {
      try { await loadMe(); } catch { saveToken(null); S.me = null; }
    }
    render();
  })();
})();
