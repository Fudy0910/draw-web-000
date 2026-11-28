const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whiteboardCapture', {
  listWindows: () => ipcRenderer.invoke('capture:list-windows'),
  captureWindow: sourceId => ipcRenderer.invoke('capture:window', sourceId),
  captureScreen: () => ipcRenderer.invoke('capture:screen')
});

contextBridge.exposeInMainWorld('whiteboardApp', {
  hideToTray: () => ipcRenderer.invoke('app:hide-to-tray'),
  confirmClose: () => ipcRenderer.invoke('app:confirm-close'),
  minimizeToCorner: () => ipcRenderer.invoke('app:minimize-to-corner'),
  restoreCanvas: () => ipcRenderer.invoke('app:restore-canvas'),
  saveWhiteboardFile: content => ipcRenderer.invoke('file:save-whiteboard', content),
  getToolbarSettings: () => ipcRenderer.invoke('app:get-toolbar-settings'),
  saveToolbarSettings: settings => ipcRenderer.invoke('app:save-toolbar-settings', settings),
  getPages: () => ipcRenderer.invoke('app:get-pages'),
  addPage: () => ipcRenderer.invoke('app:add-page'),
  deletePage: pageIndex => ipcRenderer.invoke('app:delete-page', pageIndex),
  onMiniBackground: callback => {
    const listener = (_event, isDark) => callback(isDark);
    ipcRenderer.on('mini:background', listener);
    return () => ipcRenderer.removeListener('mini:background', listener);
  },
  onToolbarSettingsUpdated: callback => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('app:toolbar-settings-updated', listener);
    return () => ipcRenderer.removeListener('app:toolbar-settings-updated', listener);
  },
  onPageRequest: callback => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on('app:page-request', listener);
    return () => ipcRenderer.removeListener('app:page-request', listener);
  },
  respondToPageRequest: response => {
    ipcRenderer.send('app:page-request-response', response);
  }
});
