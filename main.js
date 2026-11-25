const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');

let mainWindow = null;

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

ipcMain.handle('app:close', () => {
  app.quit();
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    resizable: false,
    minWidth: 720,
    minHeight: 480,
    title: '數位白板',
    backgroundColor: '#00000000',
    frame: false,
    transparent: true,
    fullscreen: true,
    kiosk: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = win;
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

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
