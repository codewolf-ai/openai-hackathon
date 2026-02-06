const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');

const projectRoot = path.join(__dirname, '..', '..');
const rendererDir = path.join(projectRoot, 'src', 'renderer');
const mainDir = path.join(projectRoot, 'src', 'main');
const stateDir = path.join(projectRoot, 'state');
const stateFile = path.join(stateDir, 'agent-events.json');
const routingFile = path.join(stateDir, 'agent-routing.json');
const realtimeLogFile = path.join(stateDir, 'realtime-debug.log');
const codexHomeDir = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const codexGlobalStateFile = path.join(codexHomeDir, '.codex-global-state.json');
const codexSqliteFile = path.join(codexHomeDir, 'sqlite', 'codex-dev.db');
const codexSkillsDir = path.join(codexHomeDir, 'skills');
const dockSvgPath = path.join(projectRoot, 'assets', 'icons', 'bird-dock.svg');
const dockIconPath = path.join(projectRoot, 'assets', 'app.png');
const dockIconFallbackPath = path.join(projectRoot, 'assets', 'icons', 'app.png');
const isDev = !app.isPackaged || process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
const AGENT_CATALOG = {
  email_ops: { name: 'Email Ops Agent' },
  web_updates: { name: 'Website Update Agent' },
  seo_analyst: { name: 'SEO Analyst Agent' },
  analytics_ops: { name: 'Analytics Ops Agent' },
  content_ops: { name: 'Content Ops Agent' }
};
const APP_SERVER_NOISY_METHODS = new Set([
  'turn/output',
  'codex/event/token_count',
  'thread/tokenUsage/updated',
  'account/rateLimits/updated',
  'codex/event/agent_message_delta',
  'codex/event/agent_message_content_delta',
  'item/agentMessage/delta',
  'codex/event/reasoning_content_delta',
  'item/reasoning/summaryTextDelta',
  'codex/event/agent_reasoning_delta'
]);

let mainWindow = null;
let didTriggerRestart = false;
let stateWatcherStarted = false;
let routingWatcherStarted = false;
let lastRenderReloadAt = 0;
const agentRunQueues = new Map();
let codexCapabilitiesCache = null;

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

function resolveCodexBinaryPath() {
  const result = spawnSync('which', ['codex'], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8'
  });
  if (result.status !== 0) return '';
  const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!output) return '';
  return fs.existsSync(output) ? output : '';
}

function openCodexDesktopApp() {
  const openByName = spawnSync('open', ['-a', 'Codex'], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 8000
  });
  if (openByName.status === 0) {
    return { ok: true, method: 'open -a Codex' };
  }

  const candidates = [
    '/Applications/Codex.app',
    path.join(process.env.HOME || '', 'Applications', 'Codex.app')
  ];
  for (const appPath of candidates) {
    if (!appPath || !fs.existsSync(appPath)) continue;
    const err = shell.openPath(appPath);
    if (!err) {
      return { ok: true, method: 'shell.openPath', path: appPath };
    }
  }
  return {
    ok: false,
    error: 'codex_app_not_found',
    stderr: String(openByName.stderr || '').slice(0, 300)
  };
}

function isCodexCommand(command) {
  if (!command || typeof command !== 'string') return false;
  const base = path.basename(command).toLowerCase();
  return base === 'codex' || base === 'codex.cmd' || base === 'codex.exe';
}

function readJsonFileSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function readCodexGlobalState() {
  return readJsonFileSafe(codexGlobalStateFile, {});
}

function writeCodexGlobalState(nextState) {
  if (!fs.existsSync(codexHomeDir)) {
    fs.mkdirSync(codexHomeDir, { recursive: true });
  }
  writeJsonFileSafe(codexGlobalStateFile, nextState);
}

function getCodexVersion() {
  const result = spawnSync('codex', ['--version'], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 8000
  });
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function probeCodexAppServerSupport() {
  const binaryPath = resolveCodexBinaryPath();
  if (!binaryPath) {
    return { supported: false, reason: 'codex_not_found' };
  }
  const outDir = path.join(stateDir, '.codex-app-server-schema-probe');
  try {
    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outDir, { recursive: true });
  } catch {}

  const result = spawnSync(binaryPath, ['app-server', 'generate-json-schema', '--out', outDir], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: 12000
  });
  try {
    fs.rmSync(outDir, { recursive: true, force: true });
  } catch {}

  if (result.status === 0) {
    return { supported: true, reason: 'ok' };
  }
  const stderr = String(result.stderr || '').slice(0, 500);
  const stdout = String(result.stdout || '').slice(0, 500);
  const reason =
    stderr || stdout
      ? 'app_server_probe_failed'
      : result.signal
        ? `signal_${result.signal}`
        : `exit_${result.status}`;
  return { supported: false, reason, stderr, stdout };
}

function getCodexCapabilities(force = false) {
  if (!force && codexCapabilitiesCache) return codexCapabilitiesCache;
  const { cmd, args } = parseCommand(process.env.CODEX_APP_SERVER_CMD);
  const appServerProbe = probeCodexAppServerSupport();
  codexCapabilitiesCache = {
    checkedAt: new Date().toISOString(),
    codexVersion: getCodexVersion(),
    codexBinaryPath: resolveCodexBinaryPath() || '',
    configuredCommand: [cmd, ...args].join(' ').trim(),
    appServer: appServerProbe
  };
  return codexCapabilitiesCache;
}

function listCodexProjects() {
  const state = readCodexGlobalState();
  const roots = Array.isArray(state['electron-saved-workspace-roots']) ? state['electron-saved-workspace-roots'] : [];
  const active = new Set(
    Array.isArray(state['active-workspace-roots']) ? state['active-workspace-roots'] : []
  );
  const labels = state['electron-workspace-root-labels'] && typeof state['electron-workspace-root-labels'] === 'object'
    ? state['electron-workspace-root-labels']
    : {};
  return roots.map((cwd) => ({
    id: cwd,
    cwd,
    label: typeof labels[cwd] === 'string' && labels[cwd].trim() ? labels[cwd].trim() : path.basename(cwd),
    active: active.has(cwd)
  }));
}

function listCodexThreads() {
  const state = readCodexGlobalState();
  const threadTitles = state['thread-titles'] && typeof state['thread-titles'] === 'object' ? state['thread-titles'] : {};
  const titles = threadTitles.titles && typeof threadTitles.titles === 'object' ? threadTitles.titles : {};
  const order = Array.isArray(threadTitles.order) ? threadTitles.order : [];
  const ranked = [];
  for (const id of order) {
    if (!titles[id]) continue;
    ranked.push({ id, title: titles[id] });
  }
  for (const [id, title] of Object.entries(titles)) {
    if (ranked.find((item) => item.id === id)) continue;
    ranked.push({ id, title });
  }

  const sessionsDir = path.join(codexHomeDir, 'sessions');
  const seen = new Set(ranked.map((item) => item.id));
  if (fs.existsSync(sessionsDir)) {
    const stack = [sessionsDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        const match = entry.name.match(/rollout-.*-([0-9a-z-]{20,})\.jsonl$/i);
        if (!match) continue;
        const threadId = match[1];
        if (!threadId || seen.has(threadId)) continue;
        ranked.push({ id: threadId, title: threadId });
        seen.add(threadId);
      }
    }
  }

  return ranked;
}

function findThreadSessionFiles(threadId) {
  if (!threadId || typeof threadId !== 'string') return [];
  const sessionsDir = path.join(codexHomeDir, 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];
  const out = [];
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.jsonl')) continue;
      if (!entry.name.includes(threadId)) continue;
      try {
        const stat = fs.statSync(fullPath);
        out.push({ path: fullPath, mtimeMs: stat.mtimeMs || 0, size: stat.size || 0 });
      } catch {
        // Ignore unreadable files.
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function readThreadLogTail(threadId, options = {}) {
  const files = findThreadSessionFiles(threadId);
  if (files.length === 0) {
    return { ok: false, error: 'thread_logs_not_found', thread_id: threadId, files: [] };
  }

  const limit = Math.max(10, Math.min(200, Number.parseInt(options.limit || '80', 10) || 80));
  const maxChars = Math.max(2000, Math.min(40000, Number.parseInt(options.max_chars || '12000', 10) || 12000));
  const primary = files[0];
  let raw = '';
  try {
    raw = fs.readFileSync(primary.path, 'utf8');
  } catch (error) {
    return { ok: false, error: 'thread_log_read_failed', thread_id: threadId, path: primary.path, details: String(error) };
  }
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(Math.max(0, lines.length - limit));

  const events = [];
  for (const line of tail) {
    try {
      const parsed = JSON.parse(line);
      const eventType = parsed?.type || parsed?.event?.type || parsed?.msg?.type || parsed?.method || 'event';
      const text = extractAgentMessageText(parsed);
      const command =
        parsed?.command ||
        parsed?.params?.command ||
        parsed?.params?.exec_command?.command ||
        parsed?.params?.item?.command ||
        null;
      const output =
        parsed?.params?.output_delta ||
        parsed?.params?.delta ||
        parsed?.params?.output ||
        parsed?.output ||
        '';
      events.push({
        type: String(eventType).slice(0, 80),
        text: text ? text.slice(0, 240) : '',
        command: Array.isArray(command)
          ? command.join(' ').slice(0, 240)
          : typeof command === 'string'
            ? command.slice(0, 240)
            : '',
        output: typeof output === 'string' ? output.replace(/\s+/g, ' ').trim().slice(0, 240) : ''
      });
    } catch {
      // Keep going even if one line is not JSON.
    }
  }

  const compactEvents = events.filter((evt) => evt.type || evt.text || evt.command || evt.output);
  const summaryChunks = [];
  for (const evt of compactEvents.slice(-40)) {
    const parts = [];
    if (evt.type) parts.push(`type=${evt.type}`);
    if (evt.command) parts.push(`command="${evt.command}"`);
    if (evt.text) parts.push(`text="${evt.text}"`);
    if (evt.output) parts.push(`output="${evt.output}"`);
    if (parts.length > 0) summaryChunks.push(parts.join(' | '));
  }
  const summary = summaryChunks.join('\n').slice(0, maxChars);

  return {
    ok: true,
    thread_id: threadId,
    path: primary.path,
    lines: lines.length,
    files: files.map((item) => item.path),
    summary,
    events: compactEvents.slice(-20)
  };
}

async function createCodexThread(title) {
  const safeTitle = typeof title === 'string' && title.trim() ? title.trim() : 'New thread';
  const { cmd, args } = parseCommand(process.env.CODEX_APP_SERVER_CMD);
  const model = process.env.CODEX_APP_MODEL || 'gpt-5.2-codex';
  const timeoutMs = Number.parseInt(process.env.CODEX_APP_TIMEOUT_MS || '120000', 10);
  const { sandbox, approvalPolicy } = getAppServerPolicy();
  const appServerRequested = isCodexCommand(cmd) && args[0] === 'app-server';

  if (!appServerRequested) {
    const error = 'CODEX_APP_SERVER_CMD must be set to a codex app-server command.';
    appendRealtimeLog('create thread failed', { error, command: [cmd, ...args].join(' ') });
    return { ok: false, error };
  }

  return new Promise((resolve) => {
    let finished = false;
    let buffer = '';
    let stderr = '';
    let threadId = '';

    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      child.kill();
      resolve(result);
    }

    appendRealtimeLog('codex app-server thread spawn', {
      command: [cmd, ...args].join(' '),
      model,
      title: safeTitle,
      sandbox,
      approvalPolicy
    });

    const child = spawn(cmd, args, {
      cwd: projectRoot,
      env: process.env
    });

    const timer = setTimeout(() => {
      finish({ ok: false, error: 'timeout', stderr: stderr.slice(0, 1200) });
    }, Number.isFinite(timeoutMs) ? timeoutMs : 120000);

    child.on('error', (error) => {
      finish({ ok: false, error: String(error) });
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      stderr += text;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        appendRealtimeLog('codex app-server stderr', { line: line.slice(0, 600) });
      }
    });

    function send(method, id, params) {
      if (!child.stdin || child.stdin.destroyed) return;
      child.stdin.write(createRpcLine(method, id, params));
    }

    child.stdout.on('data', (chunk) => {
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg = null;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          appendRealtimeLog('codex app-server stdout', { line: trimmed.slice(0, 600) });
          continue;
        }

        if (msg.id === 1 && msg.error) {
          finish({ ok: false, error: 'initialize_failed', details: msg.error });
          return;
        }
        if (msg.id === 2 && msg.error) {
          finish({ ok: false, error: 'thread_start_failed', details: msg.error });
          return;
        }

        if (msg.id === 2 && msg.result?.thread?.id) {
          threadId = msg.result.thread.id;
          finish({
            ok: true,
            thread: {
              id: threadId,
              title: safeTitle
            }
          });
          return;
        }
      }
    });

    child.on('exit', (code) => {
      if (!finished) {
        finish({ ok: false, error: 'process_exited', exitCode: code });
      }
    });

    send('initialize', 1, {
      clientInfo: {
        name: 'voice_spec_studio',
        title: 'Voice Spec Studio',
        version: app.getVersion()
      }
    });
    send('initialized', undefined, {});
    send('thread/start', 2, {
      model,
      cwd: projectRoot,
      approvalPolicy,
      sandbox,
      summary: 'detailed',
      personality: 'friendly',
      title: safeTitle
    });
  });
}

function listCodexSkills() {
  if (!fs.existsSync(codexSkillsDir)) return [];
  const out = [];

  function walk(dirPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name !== 'SKILL.md') continue;
      const parent = path.basename(path.dirname(full));
      out.push({
        id: parent,
        name: parent,
        path: full
      });
    }
  }

  walk(codexSkillsDir);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function listCodexAutomations() {
  if (!fs.existsSync(codexSqliteFile)) return [];
  const result = spawnSync(
    'sqlite3',
    [
      '-json',
      codexSqliteFile,
      'select id,name,status,next_run_at,last_run_at,rrule,cwds,updated_at from automations order by updated_at desc limit 100;'
    ],
    {
      cwd: projectRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: 8000
    }
  );
  if (result.status !== 0) {
    appendRealtimeLog('list automations failed', { stderr: String(result.stderr || '').slice(0, 400) });
    return [];
  }
  try {
    const rows = JSON.parse(String(result.stdout || '[]'));
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      rrule: row.rrule,
      cwds: (() => {
        try {
          return JSON.parse(row.cwds || '[]');
        } catch {
          return [];
        }
      })(),
      updated_at: row.updated_at
    }));
  } catch {
    return [];
  }
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

  if (!fs.existsSync(routingFile)) {
    fs.writeFileSync(
      routingFile,
      JSON.stringify(
        {
          task_summary: 'No agents working.',
          agents: []
        },
        null,
        2
      ),
      'utf8'
    );
  }

  if (!fs.existsSync(realtimeLogFile)) {
    fs.writeFileSync(realtimeLogFile, '', 'utf8');
  }
}

function appendRealtimeLog(message, meta) {
  const timestamp = new Date().toISOString();
  const safeMessage = typeof message === 'string' ? message : JSON.stringify(message);
  const safeMeta = meta ? ` ${JSON.stringify(meta).slice(0, 1200)}` : '';
  const line = `[${timestamp}] ${safeMessage}${safeMeta}\n`;
  fs.appendFileSync(realtimeLogFile, line, 'utf8');
  console.log(`[realtime] ${safeMessage}${safeMeta}`);
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

function readRoutingFile() {
  try {
    const raw = fs.readFileSync(routingFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      task_summary: typeof parsed.task_summary === 'string' ? parsed.task_summary : '',
      agents: Array.isArray(parsed.agents) ? parsed.agents : []
    };
  } catch {
    return { task_summary: '', agents: [] };
  }
}

function writeRoutingFile(nextRouting) {
  fs.writeFileSync(routingFile, JSON.stringify(nextRouting, null, 2), 'utf8');
}

function updateRouting(mutator) {
  const current = readRoutingFile();
  const next = mutator({
    task_summary: current.task_summary || '',
    agents: Array.isArray(current.agents) ? current.agents : []
  });
  const normalized = {
    task_summary: typeof next?.task_summary === 'string' ? next.task_summary : current.task_summary || '',
    agents: Array.isArray(next?.agents) ? next.agents : current.agents,
    updatedAt: new Date().toISOString()
  };
  writeRoutingFile(normalized);
  broadcastRoutingUpdate();
  return normalized;
}

function parseCommand(commandText) {
  const raw = typeof commandText === 'string' && commandText.trim() ? commandText.trim() : 'codex app-server';
  const parts = raw.split(/\s+/);
  return {
    cmd: parts[0],
    args: parts.slice(1)
  };
}

function createRpcLine(method, id, params) {
  return JSON.stringify({ method, id, params }) + '\n';
}

function getAppServerPolicy() {
  const sandboxRaw = String(process.env.CODEX_APP_SANDBOX || 'workspace-write').trim().toLowerCase();
  const approvalRaw = String(process.env.CODEX_APP_APPROVAL_POLICY || 'never').trim().toLowerCase();

  const sandbox =
    sandboxRaw === 'danger-full-access' || sandboxRaw === 'read-only' || sandboxRaw === 'workspace-write'
      ? sandboxRaw
      : 'workspace-write';
  const approvalPolicy =
    approvalRaw === 'never' || approvalRaw === 'on-request' || approvalRaw === 'unless-trusted'
      ? approvalRaw
      : 'never';

  let sandboxPolicy;
  if (sandbox === 'danger-full-access') {
    sandboxPolicy = { type: 'dangerFullAccess' };
  } else if (sandbox === 'read-only') {
    sandboxPolicy = { type: 'readOnly', networkAccess: false };
  } else {
    sandboxPolicy = {
      type: 'workspaceWrite',
      writableRoots: [projectRoot],
      networkAccess: true
    };
  }

  return { sandbox, approvalPolicy, sandboxPolicy };
}

function collectTextFragments(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextFragments(item, out);
    return;
  }
  if (typeof value === 'object') {
    const preferredKeys = ['text', 'delta', 'message', 'content', 'summary', 'output_text'];
    for (const key of preferredKeys) {
      if (key in value) {
        collectTextFragments(value[key], out);
      }
    }
  }
}

function extractAgentMessageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const parts = [];
  collectTextFragments(msg.params, parts);
  collectTextFragments(msg.result, parts);
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.slice(0, 2000);
}

function summarizeAppServerEvent(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const method = typeof msg.method === 'string' ? msg.method : '';
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  const commandValue =
    params.command ||
    params.exec_command?.command ||
    params.item?.command ||
    params.commandExecution?.command ||
    null;

  if (method === 'codex/event/exec_command_begin') {
    if (Array.isArray(commandValue) && commandValue.length > 0) {
      return `Command started: ${commandValue.join(' ')}`;
    }
    if (typeof commandValue === 'string' && commandValue.trim()) {
      return `Command started: ${commandValue.trim()}`;
    }
    return 'Command started';
  }

  if (method === 'codex/event/exec_command_end') {
    const exitCode =
      params.exit_code ??
      params.exitCode ??
      params.commandExecution?.exit_code ??
      params.commandExecution?.exitCode;
    if (typeof exitCode === 'number') {
      return `Command finished with exit code ${exitCode}`;
    }
    return 'Command finished';
  }

  if (method === 'codex/event/exec_command_output_delta' || method === 'item/commandExecution/outputDelta') {
    const output =
      params.output_delta ||
      params.delta ||
      params.output ||
      params.commandExecution?.output_delta ||
      params.commandExecution?.output ||
      '';
    const text = String(output || '').replace(/\s+/g, ' ').trim();
    return text ? `Command output: ${text.slice(0, 240)}` : '';
  }

  if (method === 'codex/event/agent_message') {
    const text = extractAgentMessageText(msg);
    return text ? `Agent: ${text.slice(0, 320)}` : '';
  }

  if (method === 'codex/event/error' || method === 'error') {
    const err = params.error || msg.error;
    const text = typeof err === 'string' ? err : JSON.stringify(err || {});
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    return clean ? `Error: ${clean.slice(0, 280)}` : 'Error';
  }

  return '';
}

async function runCodexQuietTask({ requestText, model, timeoutMs, agentId, codexCmd = 'codex', baseArgs = [] }) {
  return new Promise((resolve) => {
    const prefixArgs = Array.isArray(baseArgs) ? baseArgs.filter(Boolean) : [];
    const args = [...prefixArgs, '-q', '-m', model, requestText];
    appendRealtimeLog('codex quiet spawn', {
      command: [codexCmd, ...args].join(' '),
      agent: agentId || null
    });
    const child = spawn(codexCmd, args, {
      cwd: projectRoot,
      env: process.env
    });

    let finished = false;
    let stderr = '';
    let stdout = '';
    let assistantText = '';
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      resolve({ ok: false, reason: 'timeout', stderr: stderr.slice(0, 2000) });
    }, Number.isFinite(timeoutMs) ? timeoutMs : 120000);

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: 'spawn_failed', error: String(error) });
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk || '');
      stdout += text;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        appendRealtimeLog('codex quiet stdout', { line: line.slice(0, 600) });
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === 'message' && parsed?.role === 'assistant' && Array.isArray(parsed?.content)) {
            const outputText = parsed.content
              .filter((item) => item?.type === 'output_text' && typeof item?.text === 'string')
              .map((item) => item.text.trim())
              .filter(Boolean)
              .join('\n');
            if (outputText) {
              assistantText = outputText;
            }
          }
        } catch {
          // Non-JSON line; ignore for semantic status parsing.
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      stderr += text;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        appendRealtimeLog('codex quiet stderr', { line: line.slice(0, 600) });
      }
    });

    child.on('exit', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const normalizedAssistant = assistantText
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"');
      const blockedPatterns = [
        "i don't have access",
        'i do not have access',
        "i can't access",
        'i cannot access',
        "i can't review",
        'i cannot review',
        "can't review messages directly",
        'share the relevant',
        'if you can share',
        'no access to your'
      ];
      const looksBlocked = blockedPatterns.some((pattern) => normalizedAssistant.includes(pattern));
      const ok = code === 0 && !looksBlocked;
      resolve({
        ok,
        reason: code === 0 ? (looksBlocked ? 'blocked_no_access' : 'completed') : 'process_exited',
        exitCode: code,
        output: stdout.slice(0, 5000),
        assistantText: assistantText.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
        durationMs: Date.now() - startedAt
      });
    });
  });
}

async function runCodexAppServerTask(agent, taskText) {
  const { cmd, args } = parseCommand(process.env.CODEX_APP_SERVER_CMD);
  const model = process.env.CODEX_APP_MODEL || 'gpt-5.2-codex';
  const timeoutMs = Number.parseInt(process.env.CODEX_APP_TIMEOUT_MS || '120000', 10);
  const requestText = String(taskText || '').trim();
  const { sandbox, approvalPolicy, sandboxPolicy } = getAppServerPolicy();

  if (!requestText) {
    return { ok: false, skipped: true, reason: 'empty_task' };
  }

  const appServerRequested = isCodexCommand(cmd) && args[0] === 'app-server';
  if (!appServerRequested) {
    return {
      ok: false,
      reason: 'app_server_required',
      error: 'CODEX_APP_SERVER_CMD must point to a codex app-server command.'
    };
  }

  return new Promise((resolve) => {
    let finished = false;
    let buffer = '';
    let stderr = '';
    let threadId = null;
    let turnStartedAt = Date.now();
    let doneStatus = null;
    let agentMessageDelta = '';
    let agentMessageFinal = '';
    let lastErrorMessage = '';
    const appServerLogs = [];

    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      child.kill();
      appendRealtimeLog('codex app-server finished', {
        agent: agent?.id || null,
        ok: result?.ok === true,
        reason: result?.reason || result?.status || null,
        exitCode: result?.exitCode ?? null
      });
      resolve(result);
    }

    appendRealtimeLog('codex app-server spawn', {
      command: [cmd, ...args].join(' '),
      model,
      agent: agent?.id || null,
      prompt_preview: requestText.slice(0, 160),
      sandbox,
      approvalPolicy
    });

    const child = spawn(cmd, args, {
      cwd: projectRoot,
      env: process.env
    });

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', stderr: stderr.slice(0, 2000) });
    }, Number.isFinite(timeoutMs) ? timeoutMs : 120000);

    child.on('error', (error) => {
      finish({ ok: false, reason: 'spawn_failed', error: String(error) });
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk || '');
      stderr += text;
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        lastErrorMessage = line;
        appendRealtimeLog('codex app-server stderr', { line: line.slice(0, 600) });
      }
    });

    function send(method, id, params) {
      if (!child.stdin || child.stdin.destroyed) return;
      child.stdin.write(createRpcLine(method, id, params));
    }

    child.stdout.on('data', (chunk) => {
      buffer += String(chunk || '');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg = null;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          appendRealtimeLog('codex app-server stdout', { line: trimmed.slice(0, 600) });
          continue;
        }

        if (msg.method && !APP_SERVER_NOISY_METHODS.has(msg.method)) {
          appendRealtimeLog('codex app-server event', {
            method: msg.method,
            id: msg.id ?? null
          });
        }

        if (msg.error) {
          lastErrorMessage = JSON.stringify(msg.error).slice(0, 600);
        }

        const method = typeof msg.method === 'string' ? msg.method : '';
        if (method === 'codex/event/agent_message_content_delta' || method === 'item/agentMessage/delta') {
          const deltaText = extractAgentMessageText(msg);
          if (deltaText) agentMessageDelta = `${agentMessageDelta}${deltaText}`;
        } else if (method === 'codex/event/agent_message') {
          const finalText = extractAgentMessageText(msg);
          if (finalText) agentMessageFinal = finalText;
        }
        const eventSummary = summarizeAppServerEvent(msg);
        if (eventSummary) {
          const clean = eventSummary.replace(/\s+/g, ' ').trim().slice(0, 320);
          if (clean) {
            appServerLogs.push(clean);
            if (appServerLogs.length > 40) appServerLogs.shift();
            if (
              method === 'codex/event/exec_command_begin' ||
              method === 'codex/event/exec_command_end' ||
              method === 'codex/event/exec_command_output_delta' ||
              method === 'codex/event/agent_message'
            ) {
              appendRealtimeLog('codex app-server detail', {
                method,
                detail: clean
              });
            }
          }
        }

        if (msg.id === 1 && msg.error) {
          finish({
            ok: false,
            reason: 'initialize_failed',
            error: msg.error,
            errorMessage: lastErrorMessage || 'initialize_failed'
          });
          return;
        }
        if (msg.id === 2 && msg.error) {
          finish({
            ok: false,
            reason: 'thread_start_failed',
            error: msg.error,
            errorMessage: lastErrorMessage || 'thread_start_failed'
          });
          return;
        }
        if (msg.id === 3 && msg.error) {
          finish({
            ok: false,
            reason: 'turn_start_failed',
            error: msg.error,
            errorMessage: lastErrorMessage || 'turn_start_failed'
          });
          return;
        }

        if (msg.id === 2 && msg.result?.thread?.id) {
          threadId = msg.result.thread.id;
          turnStartedAt = Date.now();
          send('turn/start', 3, {
            threadId,
            input: [{ type: 'text', text: requestText }],
            cwd: projectRoot,
            model,
            summary: 'detailed',
            approvalPolicy,
            sandboxPolicy
          });
        }

        if (msg.method === 'turn/completed') {
          doneStatus = msg.params?.turn?.status || 'completed';
          const assistantMessage = (agentMessageFinal || agentMessageDelta).replace(/\s+/g, ' ').trim().slice(0, 2000);
          const logSummary = appServerLogs.join('\n').slice(0, 6000);
          finish({
            ok: doneStatus === 'completed',
            status: doneStatus,
            threadId,
            durationMs: Date.now() - turnStartedAt,
            assistantMessage,
            errorMessage: lastErrorMessage || '',
            logSummary
          });
          return;
        }
      }
    });

    child.on('exit', (code) => {
      if (!finished) {
        finish({
          ok: doneStatus === 'completed',
          reason: doneStatus ? 'turn_completed_before_exit' : 'process_exited',
          exitCode: code,
          status: doneStatus,
          assistantMessage: (agentMessageFinal || agentMessageDelta).replace(/\s+/g, ' ').trim().slice(0, 2000),
          errorMessage: lastErrorMessage || '',
          logSummary: appServerLogs.join('\n').slice(0, 6000)
        });
      }
    });

    send('initialize', 1, {
      clientInfo: {
        name: 'voice_spec_studio',
        title: 'Voice Spec Studio',
        version: app.getVersion()
      }
    });
    send('initialized', undefined, {});
    send('thread/start', 2, {
      model,
      cwd: projectRoot,
      approvalPolicy,
      sandbox,
      summary: 'detailed',
      personality: 'friendly'
    });
  });
}

function normalizeIncomingTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((task, index) => {
      if (!task || typeof task !== 'object') return null;
      const id = typeof task.id === 'string' && task.id.trim() ? task.id.trim() : `task_${Date.now()}_${index}`;
      const agent_id = typeof task.agent_id === 'string' ? task.agent_id.trim() : '';
      const title = typeof task.title === 'string' ? task.title.trim() : '';
      const details = typeof task.details === 'string' ? task.details.trim() : '';
      const text = title || details;
      if (!agent_id || !text) return null;
      return { id, agent_id, title: title || details, details };
    })
    .filter(Boolean);
}

function normalizeTaskDraft(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const agent_id = typeof payload.agent_id === 'string' ? payload.agent_id.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const description = typeof payload.description === 'string' ? payload.description.trim() : '';
  const details = typeof payload.details === 'string' ? payload.details.trim() : '';
  const thread_id = typeof payload.thread_id === 'string' ? payload.thread_id.trim() : '';
  const body = description || details;
  if (!agent_id || !title) return null;
  return {
    id: typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : `task_${Date.now()}`,
    agent_id,
    title,
    description: body,
    thread_id: thread_id || ''
  };
}

function normalizeDeleteRequest(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const all = payload.all === true;
  const agent_id = typeof payload.agent_id === 'string' ? payload.agent_id.trim() : '';
  const task_id = typeof payload.task_id === 'string' ? payload.task_id.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  if (!all && !agent_id && !task_id && !title) return null;
  return { all, agent_id, task_id, title };
}

function normalizeKnownStatus(status) {
  const value = typeof status === 'string' ? status.toLowerCase() : '';
  if (value === 'working' || value === 'running' || value === 'in_progress') return 'working';
  if (value === 'completed' || value === 'complete' || value === 'done') return 'completed';
  if (value === 'failed' || value === 'error') return 'failed';
  return 'not_started';
}

function summarizeWorkingAgents(agents) {
  const workingCount = Array.isArray(agents)
    ? agents.filter((item) => normalizeKnownStatus(item?.status) === 'working').length
    : 0;
  return workingCount === 0 ? 'No agents working.' : `${workingCount} agents working.`;
}

function enqueueAgentRun(agentId, runner) {
  const key = String(agentId || 'agent');
  const prev = agentRunQueues.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => runner())
    .catch((error) => {
      appendRealtimeLog('codex assignment queue error', { agent: key, error: String(error) });
    });
  agentRunQueues.set(key, next);
  next.finally(() => {
    if (agentRunQueues.get(key) === next) {
      agentRunQueues.delete(key);
    }
  });
}

function runAgentTaskExecution({ agent_id, task_id, title, prompt }) {
  enqueueAgentRun(agent_id, async () => {
    appendRealtimeLog('codex assignment started', { agent: agent_id, task: title });
    const startedAt = Date.now();
    const run = await runCodexAppServerTask({ id: agent_id }, prompt || title);
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const runReason = run.reason || run.status || run.error || 'unknown';
    const resultMessage = String(
      run.assistantMessage ||
        run.logSummary ||
        (run.ok
          ? 'Task completed.'
          : run.errorMessage || run.stderr || `Task failed (${runReason}).`)
    )
      .replace(/\u001b\[[0-9;]*m/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1600);

    updateRouting((current) => {
      const nextAgents = current.agents.map((item) => {
        if (item.id !== agent_id) return item;
        const nextTasks = Array.isArray(item.tasks)
          ? item.tasks.map((taskItem) => {
              if (taskItem?.id !== task_id) return taskItem;
              return {
                ...taskItem,
                status: run.ok ? 'completed' : 'failed',
                elapsed_seconds: elapsedSeconds,
                result_reason: run.ok ? 'completed' : runReason,
                result_message: resultMessage || undefined,
                result_log: run.logSummary ? String(run.logSummary).slice(0, 6000) : undefined,
                thread_id:
                  typeof run.threadId === 'string' && run.threadId.trim()
                    ? run.threadId.trim()
                    : typeof taskItem?.thread_id === 'string'
                      ? taskItem.thread_id
                      : '',
                completed_at: new Date().toISOString()
              };
            })
          : [];

        const hasWorkingTask = nextTasks.some((taskItem) => normalizeKnownStatus(taskItem?.status) === 'working');
        const hasCompletedTask = nextTasks.some((taskItem) => normalizeKnownStatus(taskItem?.status) === 'completed');
        const hasFailedTask = nextTasks.some((taskItem) => normalizeKnownStatus(taskItem?.status) === 'failed');
        const latestTask = nextTasks[nextTasks.length - 1];

        return {
          ...item,
          status: hasWorkingTask ? 'working' : hasFailedTask ? 'failed' : hasCompletedTask ? 'completed' : 'not_started',
          elapsed_seconds: elapsedSeconds,
          current_task: latestTask?.title || item.current_task || '',
          task_details: latestTask?.description || latestTask?.title || item.task_details || '',
          tasks: nextTasks,
          last_error: run.ok ? undefined : runReason || 'codex_task_failed',
          last_result_message: resultMessage || undefined,
          last_result_reason: run.ok ? 'completed' : runReason
        };
      });

      return {
        ...current,
        task_summary: summarizeWorkingAgents(nextAgents),
        agents: nextAgents
      };
    });

    appendRealtimeLog('codex assignment finished', {
      agent: agent_id,
      task: title,
      ok: Boolean(run.ok),
      reason: runReason || null,
      message: resultMessage ? resultMessage.slice(0, 200) : null
    });

    broadcastTaskResult({
      task_id,
      agent_id,
      title,
      status: run.ok ? 'completed' : 'failed',
      reason: runReason || null,
      thread_id: typeof run.threadId === 'string' ? run.threadId : '',
      result_message: resultMessage || '',
      elapsed_seconds: elapsedSeconds
    });
  });
}

async function deleteAgentTasks(payload) {
  appendRealtimeLog('delete_agent_tasks invoked', { payload: payload || null });
  const req = normalizeDeleteRequest(payload);
  if (!req) {
    appendRealtimeLog('delete_agent_tasks invalid payload', { payload: payload || null });
    return { ok: false, error: 'Missing delete criteria' };
  }

  if (req.all) {
    updateRouting((current) => ({
      ...current,
      task_summary: 'No agents working.',
      agents: []
    }));
    appendRealtimeLog('coordinator tasks deleted', { all: true });
    return { ok: true, deleted: 'all', deleted_count: 'all' };
  }

  let deletedCount = 0;
  const normalizedTitle = req.title.toLowerCase();
  const matches = (task, agentId) => {
    if (!task || typeof task !== 'object') return false;
    if (req.agent_id && agentId !== req.agent_id) return false;
    if (req.task_id && task.id === req.task_id) return true;
    if (normalizedTitle && typeof task.title === 'string' && task.title.toLowerCase().includes(normalizedTitle)) return true;
    if (req.agent_id && !req.task_id && !normalizedTitle) return true;
    return false;
  };

  const next = updateRouting((current) => {
    const nextAgents = [];
    for (const agent of current.agents) {
      const taskList = Array.isArray(agent.tasks) ? agent.tasks : [];
      const filteredTasks = taskList.filter((task) => {
        const remove = matches(task, agent.id);
        if (remove) deletedCount += 1;
        return !remove;
      });

      if (req.agent_id && agent.id !== req.agent_id && !req.task_id && !normalizedTitle) {
        nextAgents.push(agent);
        continue;
      }

      if (filteredTasks.length === 0) {
        if (req.agent_id && agent.id !== req.agent_id) {
          nextAgents.push(agent);
          continue;
        }
        // Drop empty agents from active state to keep UI clean.
        continue;
      }

      const latestTask = filteredTasks[filteredTasks.length - 1];
      nextAgents.push({
        ...agent,
        tasks: filteredTasks,
        current_task: latestTask?.title || '',
        task_details: latestTask?.description || latestTask?.title || '',
        last_task_id: latestTask?.id || '',
        status: 'not_started',
        elapsed_seconds: 0
      });
    }

    return {
      ...current,
      task_summary: nextAgents.length === 0 ? 'No agents working.' : 'Tasks updated by coordinator.',
      agents: nextAgents
    };
  });

  appendRealtimeLog('coordinator tasks deleted', {
    all: false,
    agent_id: req.agent_id || null,
    task_id: req.task_id || null,
    title: req.title || null,
    deletedCount
  });
  return { ok: true, deleted: deletedCount, remaining_agents: next.agents.length };
}

async function createAgentTask(payload) {
  appendRealtimeLog('create_agent_task invoked', { payload: payload || null });
  const draft = normalizeTaskDraft(payload);
  if (!draft) {
    appendRealtimeLog('create_agent_task invalid payload', { payload: payload || null });
    return { ok: false, error: 'Missing required fields: agent_id, title' };
  }

  const createdAt = new Date().toISOString();
  const routing = updateRouting((current) => {
    const nextAgents = Array.isArray(current.agents) ? current.agents.slice() : [];
    const idx = nextAgents.findIndex((agent) => agent.id === draft.agent_id);
    const agentBase = idx >= 0 ? nextAgents[idx] : buildAgentShell(draft.agent_id);
    const existingTasks = Array.isArray(agentBase.tasks) ? agentBase.tasks.slice() : [];
    existingTasks.push({
      id: draft.id,
      title: draft.title,
      description: draft.description,
      thread_id: draft.thread_id,
      status: 'working',
      created_at: createdAt,
      elapsed_seconds: 0
    });

    const updatedAgent = {
      ...agentBase,
      status: 'working',
      current_task: draft.title,
      task_details: draft.description || draft.title,
      last_task_id: draft.id,
      started_at: createdAt,
      elapsed_seconds: Number.isFinite(agentBase.elapsed_seconds) ? agentBase.elapsed_seconds : 0,
      tasks: existingTasks
    };

    if (idx >= 0) {
      nextAgents[idx] = updatedAgent;
    } else {
      nextAgents.push(updatedAgent);
    }

    return {
      ...current,
      task_summary: 'Task created by coordinator.',
      agents: nextAgents
    };
  });

  appendRealtimeLog('coordinator task created', {
    agent: draft.agent_id,
    title: draft.title,
    thread_id: draft.thread_id || null
  });

  runAgentTaskExecution({
    agent_id: draft.agent_id,
    task_id: draft.id,
    title: draft.title,
    prompt: draft.description || draft.title
  });

  return { ok: true, task: draft, agents: routing.agents };
}

function buildAgentShell(agentId) {
  const meta = AGENT_CATALOG[agentId] || { name: agentId };
  return {
    id: agentId,
    name: meta.name,
    status: 'not_started',
    elapsed_seconds: 0
  };
}

async function assignAgentTasks(payload) {
  appendRealtimeLog('assign_agent_tasks invoked', { payload: payload || null });
  const incoming = normalizeIncomingTasks(payload?.tasks);
  if (incoming.length === 0) {
    appendRealtimeLog('assign_agent_tasks invalid payload', { payload: payload || null });
    return { ok: false, error: 'No valid tasks provided', assigned: [] };
  }

  const routing = updateRouting((current) => {
    const nextAgents = Array.isArray(current.agents) ? current.agents.slice() : [];
    for (const task of incoming) {
      const createdAt = new Date().toISOString();
      const idx = nextAgents.findIndex((agent) => agent.id === task.agent_id);
      const currentAgent = idx >= 0 ? nextAgents[idx] : buildAgentShell(task.agent_id);
      const existingTasks = Array.isArray(currentAgent.tasks) ? currentAgent.tasks.slice() : [];
      existingTasks.push({
        id: task.id,
        title: task.title,
        description: task.details || '',
        status: 'working',
        created_at: createdAt,
        elapsed_seconds: 0
      });
      const updatedAgent = {
        ...currentAgent,
        status: 'working',
        current_task: task.title,
        task_details: task.details || task.title,
        last_task_id: task.id,
        started_at: createdAt,
        elapsed_seconds: 0,
        tasks: existingTasks
      };
      if (idx >= 0) {
        nextAgents[idx] = updatedAgent;
      } else {
        nextAgents.push(updatedAgent);
      }
    }

    return {
      ...current,
      task_summary: `Assigned ${incoming.length} task${incoming.length > 1 ? 's' : ''}.`,
      agents: nextAgents
    };
  });

  const assigned = [];
  for (const task of incoming) {
    runAgentTaskExecution({
      agent_id: task.agent_id,
      task_id: task.id,
      title: task.title,
      prompt: task.details || task.title
    });
    assigned.push({
      agent_id: task.agent_id,
      task: task.title,
      ok: true,
      status: 'working',
      reason: null
    });
  }

  return { ok: true, assigned };
}

function broadcastRoutingUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('routing:update', readRoutingFile());
}

function broadcastTaskResult(update) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('task:result', update);
}

function setupRoutingWatcher() {
  if (routingWatcherStarted) return;
  routingWatcherStarted = true;
  fs.watchFile(routingFile, { interval: 350 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    broadcastRoutingUpdate();
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
  setupRoutingWatcher();
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
  const codex = getCodexCapabilities();
  return {
    ok: true,
    app: app.getName(),
    version: app.getVersion(),
    timestamp: new Date().toISOString(),
    watchingStateFile: stateFile,
    hotReloadEnabled: isDev,
    hasOpenAIKey: Boolean(getOpenAIKey()),
    codex
  };
});

ipcMain.handle('codex:get-capabilities', async () => {
  return getCodexCapabilities(true);
});

ipcMain.handle('codex:list-projects', async () => {
  const projects = listCodexProjects();
  return { ok: true, projects, count: projects.length };
});

ipcMain.handle('codex:list-threads', async () => {
  const threads = listCodexThreads();
  return { ok: true, threads, count: threads.length };
});

ipcMain.handle('codex:create-thread', async (_event, payload) => {
  const title = typeof payload?.title === 'string' ? payload.title : '';
  const created = await createCodexThread(title);
  if (!created?.ok || !created?.thread?.id) {
    return {
      ok: false,
      error: created?.error || 'create_thread_failed',
      details: created?.details || created?.stderr || null
    };
  }
  const thread = created.thread;

  const autoStart = payload?.auto_start !== false;
  const taskTitleRaw = typeof payload?.initial_task === 'string' && payload.initial_task.trim()
    ? payload.initial_task.trim()
    : typeof title === 'string' && title.trim()
      ? title.trim()
      : '';
  const agentId = typeof payload?.agent_id === 'string' && payload.agent_id.trim()
    ? payload.agent_id.trim()
    : 'generalist_1';
  const description = typeof payload?.description === 'string' ? payload.description.trim() : '';

  let task = null;
  if (autoStart && taskTitleRaw) {
    task = await createAgentTask({
      agent_id: agentId,
      title: taskTitleRaw,
      description,
      thread_id: thread.id
    });
  }

  return { ok: true, thread, task, auto_started: Boolean(task?.ok) };
});

ipcMain.handle('codex:get-thread-logs', async (_event, payload) => {
  const threadId = typeof payload?.thread_id === 'string' ? payload.thread_id.trim() : '';
  if (!threadId) {
    return { ok: false, error: 'thread_id_required' };
  }
  const result = readThreadLogTail(threadId, {
    limit: payload?.limit,
    max_chars: payload?.max_chars
  });
  appendRealtimeLog('get_thread_logs completed', {
    thread_id: threadId,
    ok: result?.ok === true,
    path: result?.path || null
  });
  return result;
});

ipcMain.handle('codex:list-skills', async () => {
  const skills = listCodexSkills();
  return { ok: true, skills, count: skills.length };
});

ipcMain.handle('codex:list-automations', async () => {
  const automations = listCodexAutomations();
  return { ok: true, automations, count: automations.length };
});

ipcMain.handle('app:open-codex-binary', async () => {
  const opened = openCodexDesktopApp();
  if (opened.ok) {
    appendRealtimeLog('open codex app', opened);
    return opened;
  }

  const binaryPath = resolveCodexBinaryPath();
  if (binaryPath) {
    shell.showItemInFolder(binaryPath);
    appendRealtimeLog('open codex app fallback to binary location', { path: binaryPath });
    return { ok: true, fallback: 'show_binary_in_folder', path: binaryPath };
  }
  appendRealtimeLog('open codex app failed', opened);
  return { ok: false, error: 'codex_app_not_found' };
});

ipcMain.handle('app:open-codex-app', async () => {
  const opened = openCodexDesktopApp();
  if (opened.ok) {
    appendRealtimeLog('open codex app', opened);
    return opened;
  }
  appendRealtimeLog('open codex app failed', opened);
  return opened;
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

ipcMain.handle('routing:get', async () => {
  return readRoutingFile();
});

ipcMain.handle('routing:assign-tasks', async (_event, payload) => {
  return assignAgentTasks(payload || {});
});

ipcMain.handle('routing:create-task', async (_event, payload) => {
  return createAgentTask(payload || {});
});

ipcMain.handle('routing:delete-tasks', async (_event, payload) => {
  return deleteAgentTasks(payload || {});
});

ipcMain.handle('realtime:log', async (_event, payload) => {
  appendRealtimeLog(payload?.message || 'renderer-log', payload?.meta);
  return { ok: true };
});

ipcMain.handle('realtime:log-read', async () => {
  try {
    const text = fs.readFileSync(realtimeLogFile, 'utf8');
    return { ok: true, path: realtimeLogFile, text };
  } catch (error) {
    return { ok: false, path: realtimeLogFile, error: String(error) };
  }
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
        : 'You are a concise, warm, tool-using coordinator assistant. Use tools for task operations, never invent state, and ask one brief clarification when intent is ambiguous.'
  };

  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAIKey}`
    },
    body: (() => {
      const form = new FormData();
      form.set('sdp', offerSdp);
      form.set('session', JSON.stringify(sessionConfig));
      return form;
    })()
  });

  const answerSdp = await response.text();
  if (!response.ok) {
    throw new Error(`Realtime call failed (${response.status}): ${answerSdp.slice(0, 300)}`);
  }

  return { answerSdp };
});
