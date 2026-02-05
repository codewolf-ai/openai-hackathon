const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioApi', {
  getHealth: () => ipcRenderer.invoke('app:get-health'),
  getState: () => ipcRenderer.invoke('state:get'),
  seedDemoState: (prompt) => ipcRenderer.invoke('state:seed-demo', prompt),
  createRealtimeCall: (payload) => ipcRenderer.invoke('realtime:create-call', payload),
  onStateUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  }
});
