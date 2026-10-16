"use strict";
const app = document.getElementById("app");
const MAX_SHOWN = 4;
let calls = [], connected = true;
const faOpen = new Set();     // call ids whose false-alarm panel is open
const faBlock = new Map();    // call id -> "block this device" checkbox state
const errors = new Map();     // call id -> error text
const busy = new Set();

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "text") el.textContent = v;          // always textContent: guest notes are untrusted
    else if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
};

const waited = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  return `Waiting ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const LOC = {
  verified: ["verified", "On site"],
  unverified: ["unverified", "Location unverified"],
  outside: ["outside", "Outside venue area"],
};

async function act(id, fn) {
  busy.add(id); errors.delete(id); render();
  const r = await fn();
  busy.delete(id);
  if (r && r.error) errors.set(id, r.error);
  faOpen.delete(id);
  render();
}

function falsePanel(c) {
  const opt = (label, mode) => h("button", { text: label, onclick: () =>
    act(c.id, () => nc.falseAlarm(c.id, mode, !!faBlock.get(c.id))) });
  const block = h("input", { type: "checkbox", checked: !!faBlock.get(c.id),
    onchange: (e) => faBlock.set(c.id, e.target.checked) });
  return h("div", { class: "fa" },
    h("p", { text: "Mark as false alarm and…" }),
    h("div", { class: "opts" },
      opt("Just dismiss", "none"), opt("Disable table 15 min", "15"), opt("1 hour", "60"),
      opt("Rest of today", "today"), opt("Until I turn it on", "forever")),
    c.test ? null : h("label", {}, block, " Also block this phone for an hour"));
}

function callView(c) {
  const [locClass, locText] = LOC[c.location_status] || LOC.unverified;
  const isBusy = busy.has(c.id);
  return h("div", { class: "call" },
    h("div", { class: "top" },
      h("span", { class: "table", text: c.table_label }),
      h("span", { class: "req", text: c.request_label }),
      h("span", { class: "wait", "data-created": c.created_at, text: waited(c.created_at) })),
    c.site_name ? h("div", { class: "site", text: c.site_name }) : null,
    c.note ? h("div", { class: "note", text: c.note }) : null,
    c.test ? null : h("span", { class: "loc " + locClass, text: locText }),
    h("div", { class: "btns" },
      h("button", { class: "accept", text: isBusy ? "Working…" : "Accept", disabled: isBusy,
        onclick: () => act(c.id, () => nc.accept(c.id)) }),
      h("button", { class: "false", text: "False alarm", disabled: isBusy,
        onclick: () => { faOpen.has(c.id) ? faOpen.delete(c.id) : faOpen.add(c.id); render(); } })),
    faOpen.has(c.id) ? falsePanel(c) : null,
    errors.has(c.id) ? h("div", { class: "err", text: "Couldn't complete that: " + errors.get(c.id) }) : null);
}

function render() {
  const shown = calls.slice(0, MAX_SHOWN);
  app.replaceChildren(
    h("div", { class: "head" },
      h("img", { src: "logo.png", alt: "", width: "24", height: "24" }),
      h("h1", { text: calls.length === 1 ? "Call waiting" : `${calls.length} calls waiting` }),
      h("button", { text: "Hide", title: "Hide for now - it will remind you", onclick: () => nc.hideAlert() })),
    connected ? null : h("div", { class: "offline", text: "Connection lost - new calls may not appear." }),
    ...shown.map(callView),
    calls.length > MAX_SHOWN ? h("div", { class: "more", text: `+ ${calls.length - MAX_SHOWN} more waiting` }) : null);
  requestAnimationFrame(() => nc.alertHeight(app.offsetHeight));
}

// ---------------------------------------------------------------- sound
let ctx = null;
function beep(freq, start, dur) {
  const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + start;
  o.type = "sine"; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur + 0.05);
}
function chime(kind) {
  ctx = ctx || new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  const reps = kind === "new" ? 3 : 2;
  for (let i = 0; i < reps; i++) { beep(880, i * 0.9, 0.35); beep(660, i * 0.9 + 0.4, 0.45); }
}

// ---------------------------------------------------------------- wiring
function setState(s) {
  calls = s.calls; connected = s.connected;
  const ids = new Set(calls.map((c) => c.id));
  for (const m of [faOpen, busy]) for (const id of [...m]) if (!ids.has(id)) m.delete(id);
  render();
}
nc.onAlertState(setState);
nc.onSound(chime);
nc.getState().then(setState);
setInterval(() => document.querySelectorAll(".wait").forEach((el) => { el.textContent = waited(el.dataset.created); }), 1000);
