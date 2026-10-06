'use strict'
const { contextBridge, ipcRenderer } = require('electron')
const allowed = process.argv.find(arg => arg.startsWith('--kkcode-origin='))?.slice('--kkcode-origin='.length)
if (allowed && location.origin === allowed) contextBridge.exposeInMainWorld('kkcodeDesktop', Object.freeze({
  platform: process.platform,
  openFolder: () => ipcRenderer.invoke('kkcode:choose-folder'),
  connectGateway: value => ipcRenderer.invoke('kkcode:connect-gateway', value),
  loadPreferences: () => ipcRenderer.invoke('kkcode:display-preferences'),
  savePreferences: value => ipcRenderer.invoke('kkcode:save-display-preferences', value),
}))
if (process.argv.includes('--kkcode-gateway-dialog')) contextBridge.exposeInMainWorld('kkcodeGateway', Object.freeze({
  connect: value => ipcRenderer.invoke('kkcode:gateway-dialog-connect', value),
}))
