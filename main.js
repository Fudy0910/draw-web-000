const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, shell, Tray } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const packageMetadata = require('./package.json');

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isQuitting = false;
let restoreMainAfterSettings = false;
let restoreMiniAfterSettings = false;
let restoreMiniBounds = null;
let nextPageRequestId = 0;
const pendingPageRequests = new Map();
const launchedHidden = process.argv.includes('--hidden');
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const toolbarSettingIds = [
  'close', 'select', 'pen', 'eraser', 'text', 'color', 'zoom', 'undo', 'redo',
  'openFile', 'screenshot', 'pageNavigation', 'newPage', 'deletePage', 'clear',
  'save', 'minimize'
];

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setKiosk(true);
  mainWindow.setFullScreen(true);
  mainWindow.show();
  mainWindow.focus();
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  restoreMainAfterSettings = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  restoreMiniAfterSettings = false;
  restoreMiniBounds = null;
  if (restoreMainAfterSettings) {
    const bounds = mainWindow.getBounds();
    restoreMiniAfterSettings = bounds.width <= 200 && bounds.height <= 100;
    if (restoreMiniAfterSettings) {
      restoreMiniBounds = bounds;
      const { bounds: displayBounds } = screen.getDisplayMatching(bounds);
      mainWindow.setAlwaysOnTop(false);
      mainWindow.setFocusable(true);
      mainWindow.setBounds(displayBounds);
      mainWindow.setKiosk(true);
      mainWindow.setFullScreen(true);
    }
    mainWindow.hide();
  }

  const win = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 480,
    minHeight: 520,
    title: '數位白板 - 系統設定',
    icon: path.join(__dirname, 'app-icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
    if (restoreMainAfterSettings && !isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      if (restoreMiniAfterSettings && restoreMiniBounds) {
        mainWindow.setKiosk(false);
        mainWindow.setFullScreen(false);
        mainWindow.setMinimumSize(0, 0);
        mainWindow.setFocusable(false);
        mainWindow.setAlwaysOnTop(true, 'floating');
        mainWindow.setBounds(restoreMiniBounds);
        mainWindow.showInactive();
      } else {
        showMainWindow();
      }
    }
    restoreMainAfterSettings = false;
    restoreMiniAfterSettings = false;
    restoreMiniBounds = null;
  });
  win.loadFile(path.join(__dirname, 'settings.html'));
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'app-icon.png'));
  tray.setToolTip('數位白板');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟全螢幕白板', click: showMainWindow },
    { label: '系統設定', click: openSettingsWindow },
    { type: 'separator' },
    { label: '結束程式', click: () => app.quit() },
    { type: 'separator' },
    {
      label: `數位白板 v${app.getVersion()}｜${packageMetadata.author} 開發｜${new Date().getFullYear()} 年`,
      enabled: false
    }
  ]));
  tray.on('click', openSettingsWindow);
}

function normalizeToolbarSettings(settings) {
  if (!settings || !Array.isArray(settings.order) || !Array.isArray(settings.hidden)) {
    throw new Error('工具列設定格式無效。');
  }
  const validIds = new Set(toolbarSettingIds);
  const order = settings.order;
  const hidden = settings.hidden;
  if (
    order.length !== toolbarSettingIds.length ||
    order.some(id => !validIds.has(id)) ||
    new Set(order).size !== toolbarSettingIds.length ||
    hidden.some(id => !validIds.has(id)) ||
    new Set(hidden).size !== hidden.length
  ) {
    throw new Error('工具列設定包含無效或重複的工具。');
  }
  return { version: 1, order: order.slice(), hidden: hidden.slice() };
}

ipcMain.handle('app:get-toolbar-settings', async () => {
  try {
    const contents = await fs.readFile(path.join(app.getPath('userData'), 'toolbar-settings.json'), 'utf8');
    const savedSettings = JSON.parse(contents);
    const normalizedSettings = normalizeToolbarSettings(savedSettings);
    if (savedSettings.version === undefined) {
      normalizedSettings.order = normalizedSettings.order.filter(id => id !== 'minimize');
      normalizedSettings.order.push('minimize');
      await fs.writeFile(
        path.join(app.getPath('userData'), 'toolbar-settings.json'),
        JSON.stringify(normalizedSettings, null, 2),
        'utf8'
      );
    } else if (savedSettings.version !== 1) {
      throw new Error('不支援此版本的工具列設定。');
    }
    return normalizedSettings;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
});

ipcMain.handle('app:save-toolbar-settings', async (_event, settings) => {
  const normalizedSettings = normalizeToolbarSettings(settings);
  const settingsPath = path.join(app.getPath('userData'), 'toolbar-settings.json');
  await fs.writeFile(settingsPath, JSON.stringify(normalizedSettings, null, 2), 'utf8');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:toolbar-settings-updated', normalizedSettings);
  }
  return normalizedSettings;
});

function requestPageRenderer(action, data = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('白板尚未啟動，無法管理頁面。');
  }

  const win = mainWindow;
  const requestId = ++nextPageRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingPageRequests.delete(requestId);
      reject(new Error('白板頁面管理逾時，請重試。'));
    }, 30000);
    pendingPageRequests.set(requestId, { resolve, reject, timeout });

    const sendRequest = () => {
      if (win.isDestroyed()) {
        clearTimeout(timeout);
        pendingPageRequests.delete(requestId);
        reject(new Error('白板視窗已關閉，無法管理頁面。'));
        return;
      }
      win.webContents.send('app:page-request', { requestId, action, ...data });
    };
    if (win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', sendRequest);
    } else {
      sendRequest();
    }
  });
}

ipcMain.handle('app:get-pages', () => requestPageRenderer('list'));
ipcMain.handle('app:add-page', () => requestPageRenderer('add'));
ipcMain.handle('app:delete-page', (_event, pageIndex) => {
  if (!Number.isInteger(pageIndex) || pageIndex < 0) {
    throw new Error('無效的頁碼。');
  }
  return requestPageRenderer('delete', { pageIndex });
});

ipcMain.on('app:page-request-response', (event, response) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (!response || !Number.isInteger(response.requestId)) return;

  const pendingRequest = pendingPageRequests.get(response.requestId);
  if (!pendingRequest) return;
  clearTimeout(pendingRequest.timeout);
  pendingPageRequests.delete(response.requestId);
  if (typeof response.error === 'string' && response.error) {
    pendingRequest.reject(new Error(response.error));
  } else {
    pendingRequest.resolve(response.result);
  }
});

ipcMain.handle('app:confirm-close', async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) throw new Error('白板視窗已關閉。');

  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '數位白板',
    message: '即將關閉白板，是否儲存？',
    buttons: ['是', '否'],
    defaultId: 0,
    cancelId: 1
  });
  return response === 0;
});

function getOwnWindowHandle(win) {
  const handle = win.getNativeWindowHandle();
  const value = handle.length >= 8
    ? handle.readBigUInt64LE(0)
    : BigInt(handle.readUInt32LE(0));
  return value.toString();
}

function getWindowHandleFromSourceId(sourceId) {
  const match = /^window:(\d+)(?::\d+)?$/.exec(sourceId);
  return match ? BigInt(match[1]).toString() : null;
}

function isOwnWindowSource(source, win) {
  return getWindowHandleFromSourceId(source.id) === getOwnWindowHandle(win);
}

function getCaptureSize() {
  const displays = screen.getAllDisplays();
  return {
    width: Math.max(...displays.map(display => Math.round(display.bounds.width * display.scaleFactor))),
    height: Math.max(...displays.map(display => Math.round(display.bounds.height * display.scaleFactor)))
  };
}

async function updateMiniBackground(win) {
  if (win.isDestroyed()) return;
  const bounds = win.getBounds();
  if (bounds.width > 200 || bounds.height > 100) return;

  const display = screen.getDisplayMatching(bounds);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 }
  });
  const source = sources.find(item => item.display_id === String(display.id)) || sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('無法讀取迷你面板周圍的螢幕亮度。');
  }

  const { width, height } = source.thumbnail.getSize();
  const bitmap = source.thumbnail.toBitmap();
  const left = (bounds.x - display.bounds.x) * width / display.bounds.width;
  const top = (bounds.y - display.bounds.y) * height / display.bounds.height;
  const boxWidth = bounds.width * width / display.bounds.width;
  const boxHeight = bounds.height * height / display.bounds.height;
  const padding = 20 * width / display.bounds.width;
  const samples = [];

  [0.2, 0.5, 0.8].forEach(ratio => {
    samples.push([left - padding, top + boxHeight * ratio]);
    samples.push([left + boxWidth + padding, top + boxHeight * ratio]);
    samples.push([left + boxWidth * ratio, top - padding]);
    samples.push([left + boxWidth * ratio, top + boxHeight + padding]);
  });

  const luminance = samples.reduce((total, point) => {
    const x = Math.round(point[0]);
    const y = Math.round(point[1]);
    if (x < 0 || y < 0 || x >= width || y >= height) return total;
    const offset = (y * width + x) * 4;
    const blue = bitmap[offset];
    const green = bitmap[offset + 1];
    const red = bitmap[offset + 2];
    return total + (0.2126 * red + 0.7152 * green + 0.0722 * blue);
  }, 0) / samples.filter(point =>
    point[0] >= 0 && point[1] >= 0 && point[0] < width && point[1] < height
  ).length;

  if (Number.isFinite(luminance)) {
    win.webContents.send('mini:background', luminance < 105);
  }
}

ipcMain.handle('capture:screen', async event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const wasVisible = !!win && !win.isDestroyed() && win.isVisible();

  if (wasVisible) win.hide();
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: getCaptureSize()
    });
    const source = sources.find(item => item.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error('無法擷取目前螢幕，請重試。');
    }
    return source.thumbnail.toDataURL();
  } finally {
    if (wasVisible && !win.isDestroyed()) win.showInactive();
  }
});

ipcMain.handle('capture:list-windows', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  });
  return sources
    .filter(source => !mainWindow || !isOwnWindowSource(source, mainWindow))
    .map(source => ({
      id: source.id,
      name: source.name.trim() || `未命名視窗 (${source.id})`,
      thumbnail: source.thumbnail.toDataURL()
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-TW'));
});

ipcMain.handle('capture:window', async (_event, sourceId) => {
  if (typeof sourceId !== 'string' || !sourceId.startsWith('window:')) {
    throw new Error('無效的視窗來源。');
  }

  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: getCaptureSize()
  });
  const source = sources.find(item =>
    item.id === sourceId && (!mainWindow || !isOwnWindowSource(item, mainWindow))
  );

  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('無法擷取所選視窗，請重新選取。');
  }
  return source.thumbnail.toDataURL();
});

ipcMain.handle('file:save-whiteboard', async (event, content) => {
  if (typeof content !== 'string') {
    throw new Error('無效的白板檔案內容。');
  }

  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) {
    throw new Error('白板視窗已關閉，無法儲存。');
  }

  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '儲存可續畫白板檔',
    defaultPath: path.join(app.getPath('downloads'), '數位白板.dwb'),
    filters: [{ name: '可續畫白板檔', extensions: ['dwb'] }]
  });
  if (canceled || !filePath) return { canceled: true };

  const outputPath = filePath.toLowerCase().endsWith('.dwb')
    ? filePath
    : `${filePath}.dwb`;
  await fs.writeFile(outputPath, content, 'utf8');
  return { canceled: false, filePath: outputPath };
});

ipcMain.handle('app:hide-to-tray', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

ipcMain.handle('app:minimize-to-corner', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;

  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const width = 52;
  const height = 96;
  const margin = 12;

  win.setKiosk(false);
  win.setFullScreen(false);
  win.setResizable(false);
  win.setMinimumSize(0, 0);
  win.setFocusable(false);
  win.setAlwaysOnTop(true, 'floating');
  win.setBounds({
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + workArea.height - height - margin,
    width,
    height
  });
  win.showInactive();
  updateMiniBackground(win).catch(error => {
    console.error('無法判斷迷你面板周圍的亮度。', error);
  });
});

ipcMain.handle('app:restore-canvas', event => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;

  const { bounds } = screen.getDisplayMatching(win.getBounds());
  win.setAlwaysOnTop(false);
  win.setFocusable(true);
  win.setResizable(false);
  win.setMinimumSize(720, 480);
  win.setBounds(bounds);
  win.setKiosk(true);
  win.setFullScreen(true);
  win.show();
  win.focus();
});

function createWindow(showOnReady = true) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    resizable: false,
    minWidth: 720,
    minHeight: 480,
    title: '數位白板',
    icon: path.join(__dirname, 'app-icon.png'),
    backgroundColor: '#00000000',
    frame: false,
    transparent: true,
    fullscreen: true,
    kiosk: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = win;
  win.once('ready-to-show', () => {
    if (showOnReady) showMainWindow();
  });
  win.on('close', event => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  let backgroundCheckTimer = null;
  win.on('move', () => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    if (bounds.width > 200 || bounds.height > 100) return;

    const { workArea } = screen.getDisplayMatching(bounds);
    const x = Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width));
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height));
    if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y);

    clearTimeout(backgroundCheckTimer);
    backgroundCheckTimer = setTimeout(() => {
      updateMiniBackground(win).catch(error => {
        console.error('無法判斷迷你面板周圍的亮度。', error);
      });
    }, 500);
  });
  win.on('closed', () => {
    clearTimeout(backgroundCheckTimer);
    if (mainWindow === win) mainWindow = null;
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

if (hasSingleInstanceLock) {
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(() => {
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: true,
        args: ['--hidden']
      });
    }
    createTray();
    createWindow(!launchedHidden);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(true);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
