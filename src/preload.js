"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld("nc", {
  getState: () => invoke("state:get"),
  onState: (cb) => ipcRenderer.on("state", (_e, s) => cb(s)),
  onAlertState: (cb) => ipcRenderer.on("alert:state", (_e, s) => cb(s)),
  onSound: (cb) => ipcRenderer.on("alert:sound", (_e, kind) => cb(kind)),

  login: (email, password) => invoke("auth:login", { email, password }),
  logout: () => invoke("auth:logout"),

  accept: (id) => invoke("call:accept", id),
  falseAlarm: (id, mode, block) => invoke("call:false-alarm", { id, mode, block }),
  hideAlert: () => invoke("alert:hide"),
  alertHeight: (h) => ipcRenderer.send("alert:height", h),

  disableTable: (id, mode) => invoke("table:disable", { id, mode }),
  enableTable: (id) => invoke("table:enable", id),

  setSites: (ids) => invoke("sites:set", ids),
  setSettings: (patch) => invoke("settings:set", patch),
  testAlert: () => invoke("test:alert"),
  quit: () => invoke("app:quit"),
});
