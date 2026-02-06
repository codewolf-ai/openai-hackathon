const root = document.getElementById('sceneRoot');
const micBtn = document.getElementById('micBtn');
const voicePrompt = document.getElementById('voicePrompt');
const sourcesStripEl = document.getElementById('sourcesStrip');
const sourcesClusterEl = document.getElementById('sourcesCluster');
const sourcesCountEl = document.getElementById('sourcesCount');
const drawerBackdropEl = document.getElementById('drawerBackdrop');
const drawerEl = document.getElementById('agentDrawer');
const allAgentsListEl = document.getElementById('allAgentsList');
const settingsBtn = document.getElementById('settingsBtn');

if (!root) {
  throw new Error('Missing #sceneRoot');
}

let sceneCleanup = null;
let micState = null;
let realtimeState = null;
let userVoiceLevel = 0;
let agentVoiceLevel = 0;
let removeRoutingListener = null;
let routingAgents = [];
let selectedAgentId = null;
let taskTimerInterval = null;
const ENABLE_REALTIME_TASKS_OPEN = true;

function logRealtime(message, meta = {}) {
  if (!window.studioApi?.logRealtime) return;
  void window.studioApi.logRealtime(message, meta);
}

const AGENT_DUTY_MAP = {
  email_ops: 'Handles email operations.',
  web_updates: 'Handles website updates.',
  seo_analyst: 'Handles SEO analysis.',
  analytics_ops: 'Handles analytics operations.',
  content_ops: 'Handles content operations.'
};

function normalizeAgentStatus(status) {
  const state = typeof status === 'string' ? status.toLowerCase() : '';
  if (state === 'completed' || state === 'complete' || state === 'done') return 'completed';
  if (state === 'failed' || state === 'error') return 'failed';
  if (state === 'working' || state === 'running' || state === 'in_progress') return 'working';
  return 'not_started';
}

function statusLabel(status) {
  const normalized = normalizeAgentStatus(status);
  if (normalized === 'completed') return 'Completed';
  if (normalized === 'failed') return 'Failed';
  if (normalized === 'working') return 'Working on it...';
  return 'Not started';
}

function hasActiveAssignedTasks() {
  return routingAgents.some((agent) => typeof agent.current_task === 'string' && agent.current_task.trim());
}

function humanizeAgentName(agent) {
  const preferred = typeof agent?.name === 'string' && agent.name.trim() ? agent.name.trim() : '';
  const raw = preferred || (typeof agent?.id === 'string' ? agent.id : 'Agent');
  if (!raw) return 'Agent';
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function buildCoordinatorStateSummary() {
  if (!Array.isArray(routingAgents) || routingAgents.length === 0) {
    return 'Agent state: no agents configured.';
  }

  const lines = routingAgents.map((agent) => {
    const status = normalizeAgentStatus(agent.status);
    const task = typeof agent.current_task === 'string' && agent.current_task.trim() ? agent.current_task.trim() : 'none';
    const elapsed = Number.isFinite(agent.elapsed_seconds) ? `${agent.elapsed_seconds}s` : '0s';
    return `- ${agent.id}: status=${status}; task=${task}; elapsed=${elapsed}`;
  });

  const workingCount = routingAgents.filter((agent) => normalizeAgentStatus(agent.status) === 'working').length;
  const completedCount = routingAgents.filter((agent) => normalizeAgentStatus(agent.status) === 'completed').length;
  const notStartedCount = routingAgents.filter((agent) => normalizeAgentStatus(agent.status) === 'not_started').length;

  return [
    `Agent state snapshot: ${workingCount} working, ${completedCount} completed, ${notStartedCount} not_started.`,
    'Agents:',
    ...lines
  ].join('\n');
}

async function boot() {
  try {
    const THREE = await import('../../node_modules/three/build/three.module.js');
    sceneCleanup = startParticleScene(THREE, root);
  } catch (error) {
    console.error('Three.js failed to load:', error);
    if (voicePrompt) {
      voicePrompt.textContent = 'Render init failed';
    }
  }

  try {
    const routing = await window.studioApi.getRouting();
    renderRouting(routing);
    removeRoutingListener = window.studioApi.onRoutingUpdate((next) => renderRouting(next));
  } catch (error) {
    console.error('Routing load failed:', error);
  }
}

function renderRouting(payload) {
  if (!sourcesClusterEl || !sourcesCountEl) return;
  const agents = Array.isArray(payload?.agents) ? payload.agents : [];
  routingAgents = agents.slice();
  const agentCount = routingAgents.length;
  const hasAssignedTasks = hasActiveAssignedTasks();

  if (sourcesStripEl) {
    sourcesStripEl.classList.toggle('is-visible', hasAssignedTasks);
  }
  if (!hasAssignedTasks && document.body.classList.contains('drawer-open')) {
    closeAgentDrawer();
  }

  if (!hasAssignedTasks || agentCount === 0) {
    sourcesCountEl.textContent = 'No agents working';
  } else {
    const allTaskStatuses = [];
    for (const agent of routingAgents) {
      const tasks = Array.isArray(agent.tasks) ? agent.tasks : [];
      for (const task of tasks) {
        allTaskStatuses.push(normalizeAgentStatus(task?.status || agent.status));
      }
      if (tasks.length === 0 && agent.current_task) {
        allTaskStatuses.push(normalizeAgentStatus(agent.status));
      }
    }
    const hasWorking = allTaskStatuses.some((state) => state === 'working');
    const hasCompleted = allTaskStatuses.some((state) => state === 'completed');
    const hasFailed = allTaskStatuses.some((state) => state === 'failed');
    sourcesCountEl.textContent = hasWorking
      ? 'Agents working'
      : 'Agents completed tasks';
  }
  sourcesClusterEl.innerHTML = '';

  const chipEntries = [];
  for (const agent of routingAgents) {
    const tasks = Array.isArray(agent.tasks) ? agent.tasks : [];
    if (tasks.length > 0) {
      for (const task of tasks) {
        if (chipEntries.length >= 5) break;
        chipEntries.push({
          agentId: agent.id,
          status: task?.status || agent.status,
          duty:
            typeof task?.title === 'string' && task.title.trim()
              ? task.title.trim()
              : AGENT_DUTY_MAP[agent.id] || 'Assigned task'
        });
      }
      if (chipEntries.length >= 5) break;
      continue;
    }
    if (typeof agent.current_task === 'string' && agent.current_task.trim()) {
      chipEntries.push({
        agentId: agent.id,
        status: agent.status,
        duty: agent.current_task.trim()
      });
      if (chipEntries.length >= 5) break;
    }
  }

  for (const entry of chipEntries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'source-chip';
    chip.dataset.duty = entry.duty;
    chip.setAttribute('aria-label', entry.duty);
    chip.appendChild(createStatusIcon(entry.status));
    chip.addEventListener('click', () => openAgentDrawer(entry.agentId));
    sourcesClusterEl.appendChild(chip);
  }

  if (selectedAgentId) {
    const current = routingAgents.find((agent) => agent.id === selectedAgentId);
    if (current) {
      renderDrawer(current);
    } else {
      closeAgentDrawer();
    }
  }

  if (realtimeState?.syncCoordinatorContext) {
    realtimeState.syncCoordinatorContext();
  }
}

function createStatusIcon(status) {
  const state = normalizeAgentStatus(status);
  const complete = state === 'completed';
  const failed = state === 'failed';
  const wrap = document.createElement('span');
  wrap.className = `source-chip-icon ${
    complete ? 'is-complete' : failed ? 'is-failed' : state === 'working' ? 'is-running' : 'is-stopped'
  }`;

  if (complete) {
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"></path></svg>';
  } else if (failed) {
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
  } else {
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" x2="12" y1="2" y2="6"></line><line x1="12" x2="12" y1="18" y2="22"></line><line x1="4.93" x2="7.76" y1="4.93" y2="7.76"></line><line x1="16.24" x2="19.07" y1="16.24" y2="19.07"></line><line x1="2" x2="6" y1="12" y2="12"></line><line x1="18" x2="22" y1="12" y2="12"></line><line x1="4.93" x2="7.76" y1="19.07" y2="16.24"></line><line x1="16.24" x2="19.07" y1="7.76" y2="4.93"></line></svg>';
  }

  return wrap;
}

function sourceInitials(source) {
  if (typeof source !== 'string' || !source.trim()) return 'A';
  const words = source.trim().split(/\s+/);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function mockProgressFor(agent) {
  return agent;
}

function renderDrawer(agent) {
  if (!drawerEl || !allAgentsListEl) return;
  selectedAgentId = agent?.id || 'overview';
  console.log('[ui] renderDrawer', { selectedAgentId, agentCount: routingAgents.length });
  logRealtime('renderDrawer', { selectedAgentId, agentCount: routingAgents.length });
  allAgentsListEl.innerHTML = '';

  const taskEntries = [];
  for (const item of routingAgents) {
    const tasks = Array.isArray(item.tasks) ? item.tasks : [];
    if (tasks.length > 0) {
      for (const task of tasks) {
        const title =
          typeof task?.title === 'string' && task.title.trim()
            ? task.title.trim()
            : item.current_task || 'Untitled task';
        const description =
          typeof task?.description === 'string' && task.description.trim()
            ? task.description.trim()
            : item.task_details || 'No task details yet.';
        const taskStatus = normalizeAgentStatus(task?.status || item.status);
        taskEntries.push({
          id: task?.id || `${item.id}-${title}`,
          agentName: humanizeAgentName(item),
          title,
          description,
          status: taskStatus,
          created_at: typeof task?.created_at === 'string' ? task.created_at : '',
          elapsed_seconds: Number.isFinite(task?.elapsed_seconds)
            ? task.elapsed_seconds
            : Number.isFinite(item.elapsed_seconds)
              ? item.elapsed_seconds
              : 0
        });
      }
      continue;
    }

    if (typeof item.current_task === 'string' && item.current_task.trim()) {
      taskEntries.push({
        id: `${item.id}-current`,
        agentName: humanizeAgentName(item),
        title: item.current_task.trim(),
        description:
          typeof item.task_details === 'string' && item.task_details.trim()
            ? item.task_details.trim()
            : 'No task details yet.',
        status: normalizeAgentStatus(item.status),
        created_at: typeof item.started_at === 'string' ? item.started_at : '',
        elapsed_seconds: Number.isFinite(item.elapsed_seconds) ? item.elapsed_seconds : 0
      });
    }
  }

  for (const entry of taskEntries) {
    const card = document.createElement('li');
    card.className = 'agent-card';

    const head = document.createElement('div');
    head.className = 'agent-card-head';

    const state = normalizeAgentStatus(entry.status);
    const done = state === 'completed';

    const title = document.createElement('p');
    title.className = 'agent-title';
    title.textContent = entry.title;
    head.appendChild(title);

    const body = document.createElement('p');
    body.className = 'agent-desc';
    body.textContent = entry.description;

    const foot = document.createElement('div');
    foot.className = 'agent-card-foot';

    const footerIcon = document.createElement('span');
    footerIcon.className = `source-chip-icon agent-status-icon ${
      done ? 'is-complete' : state === 'failed' ? 'is-failed' : state === 'working' ? 'is-running' : 'is-stopped'
    }`;
    footerIcon.innerHTML = done
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20 6-11 11-5-5"></path></svg>'
      : state === 'failed'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" x2="12" y1="2" y2="6"></line><line x1="12" x2="12" y1="18" y2="22"></line><line x1="4.93" x2="7.76" y1="4.93" y2="7.76"></line><line x1="16.24" x2="19.07" y1="16.24" y2="19.07"></line><line x1="2" x2="6" y1="12" y2="12"></line><line x1="18" x2="22" y1="12" y2="12"></line><line x1="4.93" x2="7.76" y1="19.07" y2="16.24"></line><line x1="16.24" x2="19.07" y1="7.76" y2="4.93"></line></svg>';

    const footerStatus = document.createElement('span');
    footerStatus.className = 'agent-footer-status';
    footerStatus.textContent = statusLabel(state);

    const footerLeft = document.createElement('div');
    footerLeft.className = 'agent-footer-left';
    footerLeft.appendChild(footerIcon);
    footerLeft.appendChild(footerStatus);

    const percent = document.createElement('span');
    percent.className = 'agent-percent';
    const seconds = computeElapsedSeconds(entry);
    percent.textContent = formatElapsed(seconds);
    percent.dataset.live = state === 'working' ? '1' : '0';
    percent.dataset.createdAt = entry.created_at || '';
    percent.dataset.baseElapsed = Number.isFinite(entry.elapsed_seconds) ? String(entry.elapsed_seconds) : '0';

    foot.appendChild(footerLeft);
    foot.appendChild(percent);

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    allAgentsListEl.appendChild(card);
  }

  document.body.classList.add('drawer-open');
  console.log('[ui] drawer-open class added');
  logRealtime('drawer-open class added');
  updateLiveTaskTimers();
}

function openAgentDrawer(agentId) {
  console.log('[ui] openAgentDrawer called', { agentId });
  logRealtime('openAgentDrawer called', { agentId });
  const agent = routingAgents.find((item) => item.id === agentId);
  if (!agent) {
    console.warn('[ui] openAgentDrawer: agent not found', { agentId, agents: routingAgents.map((a) => a.id) });
    logRealtime('openAgentDrawer: agent not found', { agentId, agents: routingAgents.map((a) => a.id) });
    return;
  }
  renderDrawer(agent);
}

function openAgentsOverview() {
  console.log('[ui] openAgentsOverview called', { agentCount: routingAgents.length });
  logRealtime('openAgentsOverview called', { agentCount: routingAgents.length });
  renderDrawer(routingAgents[0] || { id: 'overview' });
}

function closeAgentDrawer() {
  selectedAgentId = null;
  document.body.classList.remove('drawer-open');
  console.log('[ui] drawer closed');
  logRealtime('drawer closed');
}

function computeElapsedSeconds(entry) {
  const state = normalizeAgentStatus(entry?.status);
  const base = Number.isFinite(entry?.elapsed_seconds) ? entry.elapsed_seconds : 0;
  if (state !== 'working') return Math.max(0, base);

  const createdAt = typeof entry?.created_at === 'string' ? Date.parse(entry.created_at) : NaN;
  if (!Number.isFinite(createdAt)) return Math.max(0, base);
  const live = Math.floor((Date.now() - createdAt) / 1000);
  return Math.max(base, live, 0);
}

function formatElapsed(totalSeconds) {
  const safe = Math.max(0, Number.isFinite(totalSeconds) ? totalSeconds : 0);
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  if (mins <= 0) return `${secs}s`;
  return `${mins}m${secs}s`;
}

function updateLiveTaskTimers() {
  if (!allAgentsListEl || !document.body.classList.contains('drawer-open')) return;
  const nodes = allAgentsListEl.querySelectorAll('.agent-percent[data-live="1"]');
  for (const node of nodes) {
    const createdAt = node.dataset.createdAt || '';
    const parsed = createdAt ? Date.parse(createdAt) : NaN;
    const base = Number.parseInt(node.dataset.baseElapsed || '0', 10);
    if (!Number.isFinite(parsed)) {
      node.textContent = formatElapsed(Number.isFinite(base) ? Math.max(0, base) : 0);
      continue;
    }
    const sec = Math.max(Number.isFinite(base) ? base : 0, Math.floor((Date.now() - parsed) / 1000), 0);
    node.textContent = formatElapsed(sec);
  }
}

function startTaskTimerTicker() {
  if (taskTimerInterval) return;
  taskTimerInterval = window.setInterval(() => {
    updateLiveTaskTimers();
  }, 1000);
}

function startParticleScene(THREE, container) {
  container.querySelectorAll('canvas').forEach((el) => el.remove());
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(0, 0, 10.1);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.position = 'absolute';
  renderer.domElement.style.inset = '0';
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const group = new THREE.Group();
  scene.add(group);

  const count = 1800;
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  let meanX = 0;
  let meanY = 0;
  let meanZ = 0;

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const r = Math.pow(Math.random(), 0.65) * 2.12;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i3 + 2] = r * Math.cos(phi);
    scales[i] = 0.2 + Math.random() * 0.75;
    meanX += positions[i3];
    meanY += positions[i3 + 1];
    meanZ += positions[i3 + 2];
  }

  meanX /= count;
  meanY /= count;
  meanZ /= count;

  // Keep particle cloud centered regardless of random sampling drift.
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    positions[i3] -= meanX;
    positions[i3 + 1] -= meanY;
    positions[i3 + 2] -= meanZ;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color('#ff7a1d') },
      uColorB: { value: new THREE.Color('#ffb36b') }
    },
    vertexShader: `
      uniform float uTime;
      attribute float aScale;
      varying float vMix;
      void main() {
        vec3 p = position;
        float wave = sin(uTime * 1.8 + length(p) * 3.0) * 0.08;
        p += normalize(p) * wave;
        vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPos;
        gl_PointSize = (2.4 + aScale * 3.2) * (10.0 / -mvPos.z);
        vMix = clamp((p.z + 2.0) / 4.0, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      varying float vMix;
      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float d = length(uv);
        float alpha = smoothstep(0.5, 0.0, d);
        vec3 color = mix(uColorA, uColorB, vMix);
        gl_FragColor = vec4(color, alpha * 0.95);
      }
    `
  });

  const points = new THREE.Points(geometry, material);
  group.add(points);
  group.position.y = 0.45;

  const colorIdleA = new THREE.Color('#8a8f98');
  const colorIdleB = new THREE.Color('#c4c8ce');
  const colorUserA = new THREE.Color('#ff7a1d');
  const colorUserB = new THREE.Color('#ffb36b');
  const colorAgentA = new THREE.Color('#22c55e');
  const colorAgentB = new THREE.Color('#86efac');
  const tmpA = new THREE.Color();
  const tmpB = new THREE.Color();

  let cachedWidth = 0;
  let cachedHeight = 0;

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;
    cachedWidth = width;
    cachedHeight = height;
    renderer.setSize(width, height, true);
    renderer.setViewport(0, 0, width, height);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  resize();
  window.requestAnimationFrame(resize);
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const BASE_PARTICLE_SCALE = 1.06;
  let raf = 0;
  const clock = new THREE.Clock();
  let renderScale = BASE_PARTICLE_SCALE;
  function tick() {
    if (container.clientWidth !== cachedWidth || container.clientHeight !== cachedHeight) {
      resize();
    }
    const t = clock.getElapsedTime();
    const listening = document.body.classList.contains('listening');
    const userSpeaking = listening && userVoiceLevel > 0.03;
    const agentSpeaking = listening && agentVoiceLevel > 0.025;

    if (agentSpeaking) {
      tmpA.copy(colorAgentA);
      tmpB.copy(colorAgentB);
    } else if (userSpeaking) {
      tmpA.copy(colorUserA);
      tmpB.copy(colorUserB);
    } else {
      tmpA.copy(colorIdleA);
      tmpB.copy(colorIdleB);
    }

    const targetScale = agentSpeaking
      ? BASE_PARTICLE_SCALE + Math.min(0.34, agentVoiceLevel * 0.55)
      : BASE_PARTICLE_SCALE;
    renderScale += (targetScale - renderScale) * 0.14;

    material.uniforms.uTime.value = t;
    material.uniforms.uColorA.value.lerp(tmpA, 0.12);
    material.uniforms.uColorB.value.lerp(tmpB, 0.12);
    group.rotation.y = t * 0.16;
    group.scale.setScalar(renderScale);
    renderer.render(scene, camera);
    raf = window.requestAnimationFrame(tick);
  }
  tick();

  return () => {
    if (raf) window.cancelAnimationFrame(raf);
    ro.disconnect();
    geometry.dispose();
    material.dispose();
    renderer.dispose();
    if (renderer.domElement.parentNode === container) {
      container.removeChild(renderer.domElement);
    }
  };
}

function createAudioLevelMeter(stream) {
  const audioCtx = new window.AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.86;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);
  let level = 0;
  let raf = 0;

  function tick() {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buffer.length);
    level = Math.max(0, Math.min(1, (rms - 0.008) * 34));
    raf = window.requestAnimationFrame(tick);
  }
  tick();

  return {
    getLevel() {
      return level;
    },
    stop() {
      if (raf) window.cancelAnimationFrame(raf);
      source.disconnect();
      analyser.disconnect();
      audioCtx.close().catch(() => {});
    }
  };
}

async function startMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Microphone API unavailable');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const meter = createAudioLevelMeter(stream);
  let raf = 0;
  function updateUserLevel() {
    userVoiceLevel = meter.getLevel();
    raf = window.requestAnimationFrame(updateUserLevel);
  }
  updateUserLevel();

  return {
    stream,
    stop() {
      if (raf) window.cancelAnimationFrame(raf);
      meter.stop();
      userVoiceLevel = 0;
      stream.getTracks().forEach((track) => track.stop());
    }
  };
}

async function startRealtimeAgent(stream) {
  const pc = new RTCPeerConnection();
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  remoteAudio.playsInline = true;
  const localDc = pc.createDataChannel('oai-events');
  const dataChannels = new Set();
  let remoteMeter = null;
  let raf = 0;
  let activeDataChannel = null;
  let pendingToolFollowup = false;
  const handledToolCallIds = new Set();
  const handledFunctionSignatures = new Map();

  function shouldHandleFunctionOnce(name, argsValue) {
    const argsText =
      typeof argsValue === 'string'
        ? argsValue
        : argsValue && typeof argsValue === 'object'
          ? JSON.stringify(argsValue)
          : '';
    const signature = `${name}::${argsText}`;
    const now = Date.now();
    const lastSeen = handledFunctionSignatures.get(signature) || 0;
    if (now - lastSeen < 5000) {
      return false;
    }
    handledFunctionSignatures.set(signature, now);
    return true;
  }

  function composeRealtimeInstructions() {
    return [
      '## Identity',
      'You are a helpful coordinator voice assistant in a desktop app.',
      'Always respond in English.',
      '',
      '## Style',
      'Be concise, warm, and human.',
      'Do not repeat the same sentence twice.',
      '',
      '## Source Of Truth',
      'The live agent state snapshot below is sourced from state/agent-routing.json.',
      'Treat it as the source of truth.',
      'Never invent completed work or active tasks. If none are active, say so clearly.',
      '',
      '## Tool Rules',
      'Before any tool call, say one short line (for example: "Sure, one sec."). Then call the tool immediately.',
      'Never ask the user which agent to assign.',
      'Choose an agent_id yourself and proceed.',
      'If user says "do this" or "do that", map it to the best available agent_id directly.',
      'Only ask one short clarifying question when task details are missing or ambiguous (scope, deadline, output).',
      'If user asks to show/open/view tasks, agents, workload, assignments, or progress: call open_tasks_panel only when at least one active task exists in state.',
      'If there are no active tasks, do not call open_tasks_panel; respond with a short line like "You have no active tasks right now."',
      'If user asks to hide/close panel or tasks view: call close_tasks_panel.',
      'If user asks to create/add a task draft: call create_agent_task with agent_id, title, and optional description.',
      'If user asks to delete/remove/clear tasks: call delete_agent_tasks. Use {"all":true} for all tasks, or agent_id + optional task_id/title for specific tasks.',
      'If user asks to assign/delegate work: call assign_agent_tasks with tasks mapped to agent_id values.',
      'If user asks about available projects/workspaces: call list_projects.',
      'If user asks about threads: call list_threads. If they ask to start a new one: call create_thread.',
      'When calling create_thread, include initial_task and agent_id when possible so work can start immediately.',
      'If user asks about automations/schedules: call list_automations.',
      'If user asks about skills/capabilities: call list_skills.',
      'agent_id can be any short stable identifier for a capable generalist/skill-based agent (for example: "generalist_1", "seo_skill_agent").',
      '',
      '## Post-Action Response',
      'After a UI or task tool action, respond in one short friendly sentence.',
      buildCoordinatorStateSummary()
    ].join('\n');
  }

  function openTasksPanelFromSignal() {
    if (!ENABLE_REALTIME_TASKS_OPEN) {
      console.log('[realtime] open_tasks_panel signal ignored (disabled)');
      logRealtime('open_tasks_panel signal ignored (disabled)');
      return { ok: false, reason: 'disabled' };
    }
    if (!hasActiveAssignedTasks()) {
      console.log('[realtime] open_tasks_panel signal ignored (no_active_tasks)');
      logRealtime('open_tasks_panel signal ignored (no_active_tasks)');
      return { ok: false, reason: 'no_active_tasks' };
    }
    console.log('[realtime] open_tasks_panel signal received');
    logRealtime('open_tasks_panel signal received');
    openAgentsOverview();
    return { ok: true, reason: 'opened' };
  }

  function closeTasksPanelFromSignal() {
    if (!ENABLE_REALTIME_TASKS_OPEN) {
      console.log('[realtime] close_tasks_panel signal ignored (disabled)');
      logRealtime('close_tasks_panel signal ignored (disabled)');
      return;
    }
    console.log('[realtime] close_tasks_panel signal received');
    logRealtime('close_tasks_panel signal received');
    closeAgentDrawer();
  }

  async function assignAgentTasksFromSignal(rawArguments) {
    if (!window.studioApi?.assignAgentTasks) {
      logRealtime('assign_agent_tasks unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    let parsed = {};
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        parsed = JSON.parse(rawArguments);
      } catch {
        parsed = {};
      }
    } else if (rawArguments && typeof rawArguments === 'object') {
      parsed = rawArguments;
    }

    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    if (tasks.length === 0) {
      logRealtime('assign_agent_tasks ignored: no tasks');
      return { ok: false, error: 'no_tasks' };
    }

    try {
      const result = await window.studioApi.assignAgentTasks({ tasks });
      logRealtime('assign_agent_tasks completed', result);
      openAgentsOverview();
      return result && typeof result === 'object' ? result : { ok: true };
    } catch (error) {
      logRealtime('assign_agent_tasks failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  async function createAgentTaskFromSignal(rawArguments) {
    if (!window.studioApi?.createAgentTask) {
      logRealtime('create_agent_task unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    let parsed = {};
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        parsed = JSON.parse(rawArguments);
      } catch {
        parsed = {};
      }
    } else if (rawArguments && typeof rawArguments === 'object') {
      parsed = rawArguments;
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.agent_id || !parsed.title) {
      logRealtime('create_agent_task ignored: missing fields');
      return { ok: false, error: 'missing_fields' };
    }

    try {
      const result = await window.studioApi.createAgentTask(parsed);
      logRealtime('create_agent_task completed', result);
      openAgentsOverview();
      return result && typeof result === 'object' ? result : { ok: true };
    } catch (error) {
      logRealtime('create_agent_task failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  async function deleteAgentTasksFromSignal(rawArguments) {
    if (!window.studioApi?.deleteAgentTasks) {
      logRealtime('delete_agent_tasks unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    let parsed = {};
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        parsed = JSON.parse(rawArguments);
      } catch {
        parsed = {};
      }
    } else if (rawArguments && typeof rawArguments === 'object') {
      parsed = rawArguments;
    }

    try {
      const result = await window.studioApi.deleteAgentTasks(parsed);
      logRealtime('delete_agent_tasks completed', result);
      if (hasActiveAssignedTasks()) {
        openAgentsOverview();
      }
      return result && typeof result === 'object' ? result : { ok: true };
    } catch (error) {
      logRealtime('delete_agent_tasks failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  async function listProjectsFromSignal() {
    if (!window.studioApi?.listCodexProjects) {
      logRealtime('list_projects unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    try {
      const result = await window.studioApi.listCodexProjects();
      logRealtime('list_projects completed', { count: result?.count || 0 });
      return result && typeof result === 'object' ? result : { ok: true, projects: [] };
    } catch (error) {
      logRealtime('list_projects failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  async function listThreadsFromSignal() {
    if (!window.studioApi?.listCodexThreads) {
      logRealtime('list_threads unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    try {
      const result = await window.studioApi.listCodexThreads();
      logRealtime('list_threads completed', { count: result?.count || 0 });
      return result && typeof result === 'object' ? result : { ok: true, threads: [] };
    } catch (error) {
      logRealtime('list_threads failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  async function createThreadFromSignal(rawArguments) {
    if (!window.studioApi?.createCodexThread) {
      logRealtime('create_thread unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    let parsed = {};
    if (typeof rawArguments === 'string' && rawArguments.trim()) {
      try {
        parsed = JSON.parse(rawArguments);
      } catch {
        parsed = {};
      }
    } else if (rawArguments && typeof rawArguments === 'object') {
      parsed = rawArguments;
    }
    try {
      const result = await window.studioApi.createCodexThread({
        title: typeof parsed?.title === 'string' ? parsed.title : '',
        initial_task: typeof parsed?.initial_task === 'string' ? parsed.initial_task : '',
        description: typeof parsed?.description === 'string' ? parsed.description : '',
        agent_id: typeof parsed?.agent_id === 'string' ? parsed.agent_id : '',
        auto_start: parsed?.auto_start !== false
      });
      if (!result?.ok) {
        logRealtime('create_thread failed', {
          error: result?.error || 'create_thread_failed',
          details: result?.details || null
        });
        return result && typeof result === 'object' ? result : { ok: false, error: 'create_thread_failed' };
      }
      logRealtime('create_thread completed', { id: result?.thread?.id || '' });
      if (result?.task?.ok) {
        openAgentsOverview();
      }
      return result && typeof result === 'object' ? result : { ok: true };
    } catch (error) {
      logRealtime('create_thread failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  async function listAutomationsFromSignal() {
    if (!window.studioApi?.listCodexAutomations) {
      logRealtime('list_automations unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    try {
      const result = await window.studioApi.listCodexAutomations();
      logRealtime('list_automations completed', { count: result?.count || 0 });
      return result && typeof result === 'object' ? result : { ok: true, automations: [] };
    } catch (error) {
      logRealtime('list_automations failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  async function listSkillsFromSignal() {
    if (!window.studioApi?.listCodexSkills) {
      logRealtime('list_skills unavailable: preload API missing');
      return { ok: false, error: 'preload_api_missing' };
    }
    try {
      const result = await window.studioApi.listCodexSkills();
      logRealtime('list_skills completed', { count: result?.count || 0 });
      return result && typeof result === 'object' ? result : { ok: true, skills: [] };
    } catch (error) {
      logRealtime('list_skills failed', { error: String(error) });
      return { ok: false, error: String(error) };
    }
  }

  function extractCallId(event) {
    return event?.call_id || event?.item?.call_id || event?.function_call?.call_id || null;
  }

  function extractFunctionName(event) {
    return (
      event?.name ||
      event?.item?.name ||
      event?.function_call?.name ||
      event?.response?.function_call?.name ||
      null
    );
  }

  function extractFunctionArgs(event) {
    return (
      event?.arguments ||
      event?.item?.arguments ||
      event?.function_call?.arguments ||
      event?.response?.function_call?.arguments ||
      null
    );
  }

  async function executeToolCall(event) {
    if (!event || event.type !== 'response.function_call_arguments.done') return null;
    const name = event?.name || '';
    const args = event?.arguments || extractFunctionArgs(event);
    const callId = extractCallId(event);

    if (name === 'open_tasks_panel') {
      const panel = openTasksPanelFromSignal();
      return {
        handled: true,
        callId,
        toolName: name,
        result: {
          ok: panel?.ok === true,
          panel: panel?.ok === true ? 'tasks_opened' : 'no_active_tasks',
          error: panel?.ok === true ? undefined : panel?.reason || 'no_active_tasks'
        }
      };
    }
    if (name === 'close_tasks_panel') {
      closeTasksPanelFromSignal();
      return {
        handled: true,
        callId,
        toolName: name,
        result: { ok: true, panel: 'tasks_closed' }
      };
    }
    if (name === 'assign_agent_tasks') {
      if (!shouldHandleFunctionOnce(name, args)) {
        return { handled: true, callId, toolName: name, result: { ok: true, duplicate: true } };
      }
      const result = await assignAgentTasksFromSignal(args);
      return {
        handled: true,
        callId,
        toolName: name,
        result: {
          ok: result?.ok === true,
          panel: result?.ok === true ? 'tasks_assigned' : 'tasks_assign_failed',
          error: result?.ok === true ? undefined : result?.error || 'assign_failed'
        }
      };
    }
    if (name === 'create_agent_task') {
      if (!shouldHandleFunctionOnce(name, args)) {
        return { handled: true, callId, toolName: name, result: { ok: true, duplicate: true } };
      }
      const result = await createAgentTaskFromSignal(args);
      return {
        handled: true,
        callId,
        toolName: name,
        result: {
          ok: result?.ok === true,
          panel: result?.ok === true ? 'task_created' : 'task_create_failed',
          error: result?.ok === true ? undefined : result?.error || 'create_failed'
        }
      };
    }
    if (name === 'delete_agent_tasks') {
      if (!shouldHandleFunctionOnce(name, args)) {
        return { handled: true, callId, toolName: name, result: { ok: true, duplicate: true } };
      }
      const result = await deleteAgentTasksFromSignal(args);
      return {
        handled: true,
        callId,
        toolName: name,
        result: {
          ok: result?.ok === true,
          panel: result?.ok === true ? 'tasks_deleted' : 'tasks_delete_failed',
          error: result?.ok === true ? undefined : result?.error || 'delete_failed'
        }
      };
    }
    if (name === 'list_projects') {
      const result = await listProjectsFromSignal();
      return { handled: true, callId, toolName: name, result };
    }
    if (name === 'list_threads') {
      const result = await listThreadsFromSignal();
      return { handled: true, callId, toolName: name, result };
    }
    if (name === 'create_thread') {
      const result = await createThreadFromSignal(args);
      return { handled: true, callId, toolName: name, result };
    }
    if (name === 'list_automations') {
      const result = await listAutomationsFromSignal();
      return { handled: true, callId, toolName: name, result };
    }
    if (name === 'list_skills') {
      const result = await listSkillsFromSignal();
      return { handled: true, callId, toolName: name, result };
    }

    return null;
  }

  function tryHandleToolSignal(event) {
    if (!event || typeof event !== 'object') return false;
    // Tool execution is handled only in executeToolCall on
    // response.function_call_arguments.done to avoid duplicate triggers.
    return false;
  }

  function sendSessionUpdate(channel) {
    if (!ENABLE_REALTIME_TASKS_OPEN) return;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          instructions: composeRealtimeInstructions(),
          tools: [
            {
              type: 'function',
              name: 'open_tasks_panel',
              description: 'Open the tasks/agents sidebar to show current assigned work.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'close_tasks_panel',
              description: 'Close the tasks/agents sidebar.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'assign_agent_tasks',
              description:
                'Assign one or more concrete tasks to agents so execution can start. Use this whenever the user asks to delegate work.',
              parameters: {
                type: 'object',
                properties: {
                  tasks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        agent_id: {
                          type: 'string'
                        },
                        title: { type: 'string' },
                        details: { type: 'string' }
                      },
                      required: ['agent_id', 'title'],
                      additionalProperties: false
                    }
                  }
                },
                required: ['tasks'],
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'create_agent_task',
              description:
                'Create a single task draft for one agent with title and optional description. This does not start execution.',
              parameters: {
                type: 'object',
                properties: {
                  agent_id: {
                    type: 'string'
                  },
                  title: { type: 'string' },
                  description: { type: 'string' }
                },
                required: ['agent_id', 'title'],
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'delete_agent_tasks',
              description:
                'Delete tasks. Use all=true to delete all tasks, or provide agent_id and optional task_id/title to target specific tasks.',
              parameters: {
                type: 'object',
                properties: {
                  all: { type: 'boolean' },
                  agent_id: {
                    type: 'string'
                  },
                  task_id: { type: 'string' },
                  title: { type: 'string' }
                },
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'list_projects',
              description: 'List available Codex workspace projects.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'list_threads',
              description: 'List known Codex threads and titles.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'create_thread',
              description:
                'Create a new Codex thread. Optionally auto-start a task by providing initial_task, agent_id, and optional description.',
              parameters: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  initial_task: { type: 'string' },
                  description: { type: 'string' },
                  agent_id: { type: 'string' },
                  auto_start: { type: 'boolean' }
                },
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'list_automations',
              description: 'List available Codex automations.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
              }
            },
            {
              type: 'function',
              name: 'list_skills',
              description: 'List available Codex skills.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false
              }
            }
          ],
          tool_choice: 'auto'
        }
      })
    );
    console.log('[realtime] session.update sent', { label: channel.label });
    logRealtime('session.update sent', { label: channel.label });
  }

  function syncCoordinatorContext() {
    const channel = activeDataChannel && activeDataChannel.readyState === 'open' ? activeDataChannel : null;
    if (!channel) return;
    channel.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          instructions: composeRealtimeInstructions()
        }
      })
    );
    logRealtime('session.update context refreshed', {
      working: routingAgents.filter((agent) => normalizeAgentStatus(agent.status) === 'working').length
    });
  }

  function attachDataChannel(channel, origin) {
    if (!channel || dataChannels.has(channel)) return;
    dataChannels.add(channel);
    activeDataChannel = channel;
    console.log('[realtime] data channel attached', { label: channel.label, origin });
    logRealtime('data channel attached', { label: channel.label, origin });

    channel.addEventListener('open', () => {
      console.log('[realtime] data channel open', { label: channel.label, origin });
      logRealtime('data channel open', { label: channel.label, origin });
      sendSessionUpdate(channel);
    });

    channel.addEventListener('close', () => {
      console.log('[realtime] data channel close', { label: channel.label, origin });
      logRealtime('data channel close', { label: channel.label, origin });
      if (activeDataChannel === channel) activeDataChannel = null;
    });

    channel.addEventListener('error', (event) => {
      console.error('[realtime] data channel error', { label: channel.label, origin, event });
      logRealtime('data channel error', { label: channel.label, origin, error: String(event?.message || event) });
    });

    channel.addEventListener('message', async (msg) => {
      const raw = typeof msg?.data === 'string' ? msg.data : '';
      try {
        const payload = JSON.parse(raw);
        const fnName = extractFunctionName(payload);
        const type = payload?.type || 'unknown';
        console.log('[realtime:event]', type, fnName || '');
        console.log('[realtime:event:payload]', payload);
        const eventMeta = { type, function: fnName || '' };
        if (type === 'error') {
          eventMeta.payload = payload;
        }
        if (type === 'response.output_text.delta' || type === 'response.output_text.done') {
          eventMeta.text = payload?.delta || payload?.text || '';
        }
        logRealtime('realtime event', eventMeta);

        if (type === 'response.done' && pendingToolFollowup) {
          const followupChannel =
            activeDataChannel && activeDataChannel.readyState === 'open' ? activeDataChannel : channel;
          if (followupChannel.readyState === 'open') {
            followupChannel.send(JSON.stringify({ type: 'response.create' }));
            console.log('[realtime] response.create sent after tool output');
            logRealtime('response.create sent after tool output');
          }
          pendingToolFollowup = false;
          handledToolCallIds.clear();
        }

        const toolExecution = await executeToolCall(payload);
        if (toolExecution?.handled) {
          const callId = toolExecution.callId;
          const dedupeKey = callId || `${type}:${fnName || payload?.name || 'unknown'}`;
          if (handledToolCallIds.has(dedupeKey)) {
            return;
          }
          handledToolCallIds.add(dedupeKey);

          const replyChannel =
            activeDataChannel && activeDataChannel.readyState === 'open' ? activeDataChannel : channel;
          if (callId && replyChannel.readyState === 'open') {
            replyChannel.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: callId,
                  output: JSON.stringify(toolExecution.result || { ok: false, error: 'tool_execution_failed' })
                }
              })
            );
            console.log('[realtime] function_call_output sent', {
              callId,
              tool: toolExecution.toolName,
              ok: toolExecution.result?.ok === true
            });
            logRealtime('function_call_output sent', {
              callId,
              tool: toolExecution.toolName,
              ok: toolExecution.result?.ok === true
            });
            pendingToolFollowup = true;
          }
          return;
        }

        if (tryHandleToolSignal(payload)) {
          return;
        }
      } catch {
        const preview = raw ? raw.slice(0, 400) : '[binary message]';
        console.log('[realtime:event:raw]', preview);
        logRealtime('realtime raw event', { preview });
      }
    });
  }

  attachDataChannel(localDc, 'local');
  pc.ondatachannel = (event) => {
    attachDataChannel(event.channel, 'remote');
  };

  pc.ontrack = (event) => {
    const remoteStream = event.streams[0];
    remoteAudio.srcObject = remoteStream;
    remoteMeter = createAudioLevelMeter(remoteStream);
    const updateAgentLevel = () => {
      agentVoiceLevel = remoteMeter ? remoteMeter.getLevel() : 0;
      raf = window.requestAnimationFrame(updateAgentLevel);
    };
    updateAgentLevel();
  };

  stream.getAudioTracks().forEach((track) => {
    pc.addTrack(track, stream);
  });

  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);

  const result = await window.studioApi.createRealtimeCall({
    offerSdp: offer.sdp,
    instructions: composeRealtimeInstructions()
  });

  await pc.setRemoteDescription({
    type: 'answer',
    sdp: result.answerSdp
  });

  return {
    syncCoordinatorContext,
    stop() {
      if (raf) window.cancelAnimationFrame(raf);
      if (remoteMeter) {
        remoteMeter.stop();
        remoteMeter = null;
      }
      agentVoiceLevel = 0;
      for (const channel of dataChannels) {
        if (channel.readyState === 'open') channel.close();
      }
      dataChannels.clear();
      activeDataChannel = null;
      pc.getSenders().forEach((sender) => {
        if (sender.track) sender.track.stop();
      });
      pc.close();
      remoteAudio.srcObject = null;
    }
  };
}

async function toggleListening() {
  const listening = document.body.classList.contains('listening');
  if (listening) {
    if (realtimeState) {
      realtimeState.stop();
      realtimeState = null;
    }
    if (micState) {
      micState.stop();
      micState = null;
    }
    document.body.classList.remove('listening');
    if (voicePrompt) voicePrompt.textContent = 'Muted';
    if (micBtn) micBtn.setAttribute('aria-pressed', 'false');
    return;
  }

  if (voicePrompt) voicePrompt.textContent = 'Say something...';
  try {
    logRealtime('toggleListening start');
    micState = await startMicrophone();
    realtimeState = await startRealtimeAgent(micState.stream);
    if (realtimeState?.syncCoordinatorContext) {
      realtimeState.syncCoordinatorContext();
    }
    document.body.classList.add('listening');
    if (voicePrompt) voicePrompt.textContent = 'Say something...';
    if (micBtn) micBtn.setAttribute('aria-pressed', 'true');
  } catch (error) {
    console.error('Realtime voice start failed:', error);
    logRealtime('realtime voice start failed', { error: String(error) });
    if (realtimeState) {
      realtimeState.stop();
      realtimeState = null;
    }
    if (micState) {
      micState.stop();
      micState = null;
    }
    document.body.classList.remove('listening');
    if (voicePrompt) voicePrompt.textContent = 'Muted';
    if (micBtn) micBtn.setAttribute('aria-pressed', 'false');
  }
}

window.addEventListener('beforeunload', () => {
  if (sceneCleanup) sceneCleanup();
  if (realtimeState) realtimeState.stop();
  if (micState) micState.stop();
  if (removeRoutingListener) removeRoutingListener();
});

if (micBtn) {
  micBtn.setAttribute('aria-pressed', 'false');
  micBtn.addEventListener('click', () => {
    void toggleListening();
  });
}

if (voicePrompt) {
  voicePrompt.textContent = 'Muted';
}

if (drawerBackdropEl) {
  drawerBackdropEl.addEventListener('click', closeAgentDrawer);
}
if (sourcesStripEl) {
  sourcesStripEl.addEventListener('click', (event) => {
    console.log('[ui] sourcesStrip click', { target: event.target?.className || 'unknown' });
    logRealtime('sourcesStrip click');
    if (event.target instanceof HTMLElement && event.target.closest('.source-chip')) return;
    openAgentsOverview();
  });
}
if (settingsBtn) {
  settingsBtn.addEventListener('click', async () => {
    try {
      const result = await (window.studioApi?.openCodexApp?.() || window.studioApi?.openCodexBinary?.());
      logRealtime('open codex app', result || {});
    } catch (error) {
      logRealtime('open codex app failed', { error: String(error) });
    }
  });
}

boot();
startTaskTimerTicker();
