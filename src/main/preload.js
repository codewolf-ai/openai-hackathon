const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioApi', {
  getHealth: () => ipcRenderer.invoke('app:get-health'),
  getState: () => ipcRenderer.invoke('state:get'),
  seedDemoState: (prompt) => ipcRenderer.invoke('state:seed-demo', prompt),
  getRouting: () => ipcRenderer.invoke('routing:get'),
  createAgentTask: (payload) => ipcRenderer.invoke('routing:create-task', payload),
  deleteAgentTasks: (payload) => ipcRenderer.invoke('routing:delete-tasks', payload),
  assignAgentTasks: (payload) => ipcRenderer.invoke('routing:assign-tasks', payload),
  logRealtime: (message, meta) => ipcRenderer.invoke('realtime:log', { message, meta }),
  readRealtimeLog: () => ipcRenderer.invoke('realtime:log-read'),
  createRealtimeCall: (payload) => ipcRenderer.invoke('realtime:create-call', payload),
  openCodexBinary: () => ipcRenderer.invoke('app:open-codex-binary'),
  openCodexApp: () => ipcRenderer.invoke('app:open-codex-app'),
  getCodexCapabilities: () => ipcRenderer.invoke('codex:get-capabilities'),
  listCodexProjects: () => ipcRenderer.invoke('codex:list-projects'),
  listCodexThreads: () => ipcRenderer.invoke('codex:list-threads'),
  getCodexThreadLogs: (payload) => ipcRenderer.invoke('codex:get-thread-logs', payload),
  createCodexThread: (payload) => ipcRenderer.invoke('codex:create-thread', payload),
  listCodexSkills: () => ipcRenderer.invoke('codex:list-skills'),
  listCodexAutomations: () => ipcRenderer.invoke('codex:list-automations'),
  onRoutingUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('routing:update', listener);
    return () => ipcRenderer.removeListener('routing:update', listener);
  },
  onStateUpdate: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },
  onTaskResult: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('task:result', listener);
    return () => ipcRenderer.removeListener('task:result', listener);
  }
});
