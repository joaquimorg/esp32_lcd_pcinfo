'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  setConfig: (config) => ipcRenderer.send('config:set', config),
  setMode: (mode, screenId = null) => ipcRenderer.send('mode:set', { mode, screenId }),
  showScreen: (id) => ipcRenderer.send('player:show', id),
  stepScreen: (dir) => ipcRenderer.send('player:step', dir),
  setCalibration: (on) => ipcRenderer.send('calibration:set', on),
  listPorts: () => ipcRenderer.invoke('ports:list'),

  exportScreen: (id) => ipcRenderer.invoke('screen:export', id),
  importScreens: () => ipcRenderer.invoke('screen:import'),

  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),
  imageSize: (file) => ipcRenderer.invoke('image:size', file),
  reloadComponents: () => ipcRenderer.invoke('components:reload'),
  openComponentsFolder: () => ipcRenderer.send('components:openFolder'),
  openSite: () => ipcRenderer.send('site:open'),
  copyAiInstructions: () => ipcRenderer.invoke('ai:copyInstructions'),
  importComponentFromClipboard: () => ipcRenderer.invoke('components:importClipboard'),
  importComponentFromFile: () => ipcRenderer.invoke('components:importFile'),

  onStatus: on('status'),
  onSensors: on('sensors'),
  onPreview: on('preview'),
  onThumb: on('thumb'),
});
