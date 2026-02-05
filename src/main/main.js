const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');

const projectRoot = path.join(__dirname, '..', '..');
const rendererDir = path.join(projectRoot, 'src', 'renderer');
const mainDir = path.join(projectRoot, 'src', 'main');
const stateDir = path.join(projectRoot, 'state');
const stateFile = path.join(stateDir, 'agent-events.json');
const dockSvgPath = path.join(projectRoot, 'assets', 'icons', 'bird-dock.svg');
const dockIconPath = path.join(projectRoot, 'assets', 'app.png');
const dockIconFallbackPath = path.join(projectRoot, 'assets', 'icons', 'app.png');
const isDev = !app.isPackaged || process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

let mainWindow = null;
let didTriggerRestart = false;
let stateWatcherStarted = false;
let lastRenderReloadAt = 0;

function loadDotEnv() {
  const envPath = path.join(projectRoot, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getOpenAIKey() {
  return process.env.OPENAI_API_KEY || '';
}

function defaultState(prompt = '') {
  return {
    prompt,
    tasks: [],
    agents: [],
    updatedAt: new Date().toISOString()
  };
}

function ensureStateFile() {
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  if (!fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, JSON.stringify(defaultState(), null, 2), 'utf8');
  }
}

function readStateFile() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      updatedAt: parsed.updatedAt || new Date().toISOString()
    };
  } catch {
    return defaultState();
  }
}

function writeStateFile(nextState) {
  fs.writeFileSync(stateFile, JSON.stringify(nextState, null, 2), 'utf8');
}

function broadcastStateUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('state:update', readStateFile());
}

function setupStateWatcher() {
  if (stateWatcherStarted) return;
  stateWatcherStarted = true;

  fs.watchFile(stateFile, { interval: 350 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    broadcastStateUpdate();
  });
}

function reloadRendererWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  if (now - lastRenderReloadAt < 200) return;
  lastRenderReloadAt = now;
  mainWindow.webContents.reloadIgnoringCache();
}

function relaunchApp() {
  if (didTriggerRestart) return;
  didTriggerRestart = true;
  app.relaunch();
  app.exit(0);
}

function setupDevWatchers() {
  if (!isDev) return;

  const reloadTargets = [
    path.join(rendererDir, 'index.html'),
    path.join(rendererDir, 'renderer.js'),
    path.join(rendererDir, 'styles.css')
  ];
  const restartTargets = [
    path.join(mainDir, 'main.js'),
    path.join(mainDir, 'preload.js')
  ];

  for (const file of reloadTargets) {
    fs.watchFile(file, { interval: 250 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      reloadRendererWindow();
    });
  }

  for (const file of restartTargets) {
    fs.watchFile(file, { interval: 250 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      relaunchApp();
    });
  }
}

function makeDockIconWithBackground(pngPath, bgColor = '#3b82f6') {
  if (!fs.existsSync(pngPath)) return null;
  const source = nativeImage.createFromPath(pngPath).resize({ width: 1024, height: 1024, quality: 'best' });
  if (source.isEmpty()) return null;

  const fg = source.toBitmap();
  if (!fg || fg.length !== 1024 * 1024 * 4) return null;

  const r = parseInt(bgColor.slice(1, 3), 16);
  const g = parseInt(bgColor.slice(3, 5), 16);
  const b = parseInt(bgColor.slice(5, 7), 16);
  const out = Buffer.alloc(fg.length);
  const size = 1024;
  const radius = 220;
  const radiusSq = radius * radius;

  function inRoundedRect(x, y) {
    if ((x >= radius && x < size - radius) || (y >= radius && y < size - radius)) return true;
    const cx = x < radius ? radius : size - radius - 1;
    const cy = y < radius ? radius : size - radius - 1;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radiusSq;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inRoundedRect(x, y)) {
        out[i] = 0;
        out[i + 1] = 0;
        out[i + 2] = 0;
        out[i + 3] = 0;
        continue;
      }

      const alpha = fg[i + 3] / 255;
      out[i] = Math.round(fg[i] * alpha + r * (1 - alpha));
      out[i + 1] = Math.round(fg[i + 1] * alpha + g * (1 - alpha));
      out[i + 2] = Math.round(fg[i + 2] * alpha + b * (1 - alpha));
      out[i + 3] = 255;
    }
  }

  return nativeImage.createFromBitmap(out, { width: size, height: size });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 980,
    minHeight: 640,
    title: 'Voice Spec Studio',
    backgroundColor: '#00000000',
    transparent: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(rendererDir, 'index.html'));
}

app.whenReady().then(() => {
  loadDotEnv();
  ensureStateFile();
  if (process.platform === 'darwin' && app.dock) {
    if (fs.existsSync(dockIconPath)) {
      const icon = makeDockIconWithBackground(dockIconPath, '#3b82f6');
      if (icon) {
        app.dock.setIcon(icon);
      } else {
        app.dock.setIcon(dockIconPath);
      }
    } else if (fs.existsSync(dockIconFallbackPath)) {
      const icon = makeDockIconWithBackground(dockIconFallbackPath, '#3b82f6');
      if (icon) {
        app.dock.setIcon(icon);
      } else {
        app.dock.setIcon(dockIconFallbackPath);
      }
    } else if (fs.existsSync(dockSvgPath)) {
      const svg = fs.readFileSync(dockSvgPath, 'utf8');
      const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      const svgIcon = nativeImage.createFromDataURL(svgDataUrl);
      if (!svgIcon.isEmpty()) {
        app.dock.setIcon(svgIcon);
      }
    }
  }
  createWindow();
  setupStateWatcher();
  setupDevWatchers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:get-health', async () => {
  return {
    ok: true,
    app: app.getName(),
    version: app.getVersion(),
    timestamp: new Date().toISOString(),
    watchingStateFile: stateFile,
    hotReloadEnabled: isDev,
    hasOpenAIKey: Boolean(getOpenAIKey())
  };
});

ipcMain.handle('state:get', async () => {
  return readStateFile();
});

ipcMain.handle('state:seed-demo', async (_event, prompt) => {
  const safePrompt = typeof prompt === 'string' ? prompt.trim() : '';
  const nextState = {
    prompt: safePrompt,
    tasks: [
      `Parse request: ${safePrompt || 'No prompt provided'}`,
      'Create structured spec',
      'Start parallel Codex agents',
      'Prepare preview and summary'
    ],
    agents: [
      'Spec Agent: in progress',
      'UI Agent: queued',
      'Integration Agent: queued',
      'QA Agent: queued'
    ],
    updatedAt: new Date().toISOString()
  };
  writeStateFile(nextState);
  return nextState;
});

ipcMain.handle('realtime:create-call', async (_event, payload) => {
  const openAIKey = getOpenAIKey();
  if (!openAIKey) {
    throw new Error('OPENAI_API_KEY is missing. Add it to .env');
  }

  const offerSdp = typeof payload?.offerSdp === 'string' ? payload.offerSdp : '';
  if (!offerSdp) {
    throw new Error('Missing WebRTC offer SDP');
  }

  const sessionConfig = {
    type: 'realtime',
    model: 'gpt-realtime',
    instructions:
      typeof payload?.instructions === 'string' && payload.instructions.trim()
        ? payload.instructions.trim()
        : 'You are a concise voice assistant for non-technical users.',
    audio: {
      input: {
        turn_detection: { type: 'server_vad' }
      },
      output: {
        voice: 'marin'
      }
    }
  };

  const form = new FormData();
  form.set('sdp', offerSdp);
  form.set('session', JSON.stringify(sessionConfig));

  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAIKey}`,
      'OpenAI-Beta': 'realtime=v1'
    },
    body: form
  });

  const answerSdp = await response.text();
  if (!response.ok) {
    throw new Error(`Realtime call failed (${response.status}): ${answerSdp.slice(0, 300)}`);
  }

  return { answerSdp };
});
