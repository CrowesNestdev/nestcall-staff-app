"use strict";
const root = document.getElementById("root");
let state = null, lastSig = "", busy = false;

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") el.textContent = v;
    else if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
};

const natural = (a, b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true });
const isDisabled = (t) => t.disabled_until && (t.disabled_until === "infinity" || new Date(t.disabled_until) > new Date());
const disabledText = (t) => t.disabled_until === "infinity" ? "Disabled until turned back on"
  : "Disabled until " + new Date(t.disabled_until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

// ----------------------------------------------------------------- views
function loginView() {
  const err = h("div", { class: "err", hidden: true, role: "alert" });
  const email = h("input", { type: "email", autocomplete: "username", required: true });
  const pass = h("input", { type: "password", autocomplete: "current-password", required: true });
  const btn = h("button", { class: "primary", type: "submit", text: "Sign in", style: "width:100%" });
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; btn.textContent = "Signing in…"; err.hidden = true;
    const r = await nc.login(email.value, pass.value);
    if (r && r.error) { err.textContent = r.error; err.hidden = false; btn.disabled = false; btn.textContent = "Sign in"; }
  } },
    err, h("label", { text: "Email" }), email, h("label", { text: "Password" }), pass, btn);
  return h("div", { class: "login" }, h("h1", { text: "Nest Call" }),
    h("p", { class: "muted", style: "text-align:center", text: "Sign in to receive table calls on this PC." }),
    h("div", { class: "card" }, form));
}

function messageView(title, text) {
  return h("div", { class: "login" }, h("h1", { text: "Nest Call" }),
    h("div", { class: "card" }, h("h2", { text: title }), h("p", { class: "muted", text }),
      h("button", { text: "Sign out", onclick: () => nc.logout() })));
}

function sitesView(s, changing) {
  const picked = new Set(s.siteIds);
  const boxes = s.sites.map((site) => h("label", { class: "site" },
    h("input", { type: "checkbox", checked: picked.has(site.id), "data-id": site.id }), site.name));
  const err = h("div", { class: "err", hidden: true });
  const card = h("div", { class: "card" },
    h("h2", { text: "Which sites should this PC receive calls for?" }),
    h("p", { class: "muted", text: "You can change this later from Settings." }),
    ...boxes, err,
    h("div", { class: "actions" },
      h("button", { class: "primary", text: "Save", onclick: async () => {
        const ids = [...card.querySelectorAll("input[type=checkbox]:checked")].map((i) => i.dataset.id);
        const r = await nc.setSites(ids);
        if (r && r.error) { err.textContent = r.error; err.hidden = false; } else { changingSites = false; render(true); }
      } }),
      changing ? h("button", { text: "Cancel", onclick: () => { changingSites = false; render(true); } }) : null));
  return h("div", { class: "wrap" }, card);
}

function dashboardView(s) {
  const tablesSorted = [...s.tables].sort(natural);
  const siteName = Object.fromEntries(s.sites.map((x) => [x.id, x.name]));
  const showSite = s.siteIds.length > 1;

  const rows = tablesSorted.map((t) => {
    const off = isDisabled(t);
    const action = off
      ? h("button", { text: "Turn back on", onclick: async () => { await nc.enableTable(t.id); } })
      : h("select", { onchange: async (e) => { const m = e.target.value; if (m) { await nc.disableTable(t.id, m); } } },
          h("option", { value: "", text: "Disable…" }),
          h("option", { value: "15", text: "For 15 minutes" }),
          h("option", { value: "60", text: "For 1 hour" }),
          h("option", { value: "today", text: "For the rest of today" }),
          h("option", { value: "forever", text: "Until I turn it back on" }));
    return h("tr", {},
      h("td", { text: (showSite ? (siteName[t.site_id] || "") + " · " : "") + t.label }),
      h("td", {}, h("span", { class: "tag" + (off ? " off" : ""), text: off ? disabledText(t) : "Active" })),
      h("td", { style: "text-align:right" }, action));
  });

  const pending = s.calls.filter((c) => !c.test);
  return h("div", { class: "wrap" },
    h("header", { class: "top" }, h("h1", { text: "Nest Call" }),
      h("span", { class: "pill " + (s.connected ? "ok" : "bad"), text: s.connected ? "Connected" : "Offline" })),
    s.connected ? null : h("div", { class: "banner", text: "Not connected - new calls may not appear. Check this PC's internet connection." }),
    h("div", { class: "card" }, h("h2", { text: "Calls waiting" }),
      pending.length ? h("p", { text: `${pending.length} call${pending.length === 1 ? "" : "s"} waiting - see the popup.` })
        : h("p", { class: "muted", text: "No calls waiting. New calls pop up on top of whatever you're doing." }),
      h("div", { class: "actions" }, h("button", { text: "Send test alert", onclick: () => nc.testAlert() }))),
    h("div", { class: "card" }, h("h2", { text: "Tables" }),
      rows.length ? h("table", {}, ...rows) : h("p", { class: "muted", text: "No tables found for the selected sites." })),
    h("div", { class: "card" }, h("h2", { text: "Settings" }),
      h("div", { class: "row" }, h("label", { for: "sound", text: "Play a sound for new calls" }),
        h("input", { id: "sound", type: "checkbox", checked: !!s.settings.sound, onchange: (e) => nc.setSettings({ sound: e.target.checked }) })),
      h("div", { class: "row" }, h("label", { for: "startup", text: "Start Nest Call when this PC starts" }),
        h("input", { id: "startup", type: "checkbox", checked: !!s.settings.launchAtStartup, onchange: (e) => nc.setSettings({ launchAtStartup: e.target.checked }) })),
      h("div", { class: "row" }, h("label", { for: "realert", text: "Remind me about unanswered calls every" }),
        h("select", { id: "realert", onchange: (e) => nc.setSettings({ realertSeconds: Number(e.target.value) }) },
          ...[[30, "30 seconds"], [60, "1 minute"], [120, "2 minutes"], [300, "5 minutes"]].map(([v, l]) =>
            h("option", { value: v, text: l, selected: Number(s.settings.realertSeconds) === v })))),
      h("div", { class: "actions" },
        s.sites.length > 1 ? h("button", { text: "Change sites…", onclick: () => { changingSites = true; render(true); } }) : null,
        h("button", { text: "Sign out", onclick: () => nc.logout() }),
        h("button", { text: "Quit Nest Call", onclick: () => nc.quit() }))),
    h("p", { class: "muted", style: "text-align:center", text: `Signed in as ${s.email} · v${s.version}. Closing this window keeps Nest Call running in the tray.` }));
}

// ---------------------------------------------------------------- render
let changingSites = false;
function render(force) {
  if (!state) return;
  const s = state;
  // Skip redraws when nothing visible changed (keeps open dropdowns from resetting)
  const sig = JSON.stringify([s.signedIn, s.noAccess, s.needsSites, s.connected, s.siteIds, s.settings, changingSites,
    s.calls.filter((c) => !c.test).length, s.tables.map((t) => [t.id, t.disabled_until])]);
  if (!force && sig === lastSig) return;
  lastSig = sig;

  root.replaceChildren(
    !s.signedIn ? loginView()
    : s.noAccess ? messageView("No venue linked to your account", "Ask your manager to invite you, then sign in again.")
    : (s.needsSites || changingSites) ? sitesView(s, changingSites && !s.needsSites)
    : dashboardView(s));
}

nc.onState((s) => { state = s; render(false); });
nc.getState().then((s) => { state = s; render(true); });
