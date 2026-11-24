const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whiteboardCapture', {
  listWindows: () => ipcRenderer.invoke('capture:list-windows'),
  captureWindow: sourceId => ipcRenderer.invoke('capture:window', sourceId),
  captureScreen: () => ipcRenderer.invoke('capture:screen')
});

contextBridge.exposeInMainWorld('whiteboardApp', {
  close: () => ipcRenderer.invoke('app:close'),
  minimizeToCorner: () => ipcRenderer.invoke('app:minimize-to-corner'),
  restoreCanvas: () => ipcRenderer.invoke('app:restore-canvas'),
  onMiniBackground: callback => {
    const listener = (_event, isDark) => callback(isDark);
    ipcRenderer.on('mini:background', listener);
    return () => ipcRenderer.removeListener('mini:background', listener);
  }
});
