'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('displayApi', {
  onLayout: (cb) => ipcRenderer.on('layout', (_e, layout) => cb(layout)),
  onSensors: (cb) => ipcRenderer.on('sensors', (_e, sensors) => cb(sensors)),
});
