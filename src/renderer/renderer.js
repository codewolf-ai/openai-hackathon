const root = document.getElementById('sceneRoot');
const micBtn = document.getElementById('micBtn');
const voicePrompt = document.getElementById('voicePrompt');

if (!root) {
  throw new Error('Missing #sceneRoot');
}

let sceneCleanup = null;
let micState = null;
let realtimeState = null;

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
}

function startParticleScene(THREE, container) {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  camera.position.set(0, 0, 10.8);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const group = new THREE.Group();
  scene.add(group);

  const count = 1800;
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    const r = Math.pow(Math.random(), 0.65) * 2.25;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i3 + 2] = r * Math.cos(phi);
    scales[i] = 0.2 + Math.random() * 0.75;
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

  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  let raf = 0;
  const clock = new THREE.Clock();
  function tick() {
    const t = clock.getElapsedTime();
    material.uniforms.uTime.value = t;
    group.rotation.y = t * 0.16;
    group.scale.setScalar(1);
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

  return {
    stream,
    stop() {
      stream.getTracks().forEach((track) => track.stop());
    }
  };
}

async function startRealtimeAgent(stream) {
  const pc = new RTCPeerConnection();
  const remoteAudio = new Audio();
  remoteAudio.autoplay = true;
  remoteAudio.playsInline = true;

  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
  };

  stream.getAudioTracks().forEach((track) => {
    pc.addTrack(track, stream);
  });

  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  await pc.setLocalDescription(offer);

  const result = await window.studioApi.createRealtimeCall({
    offerSdp: offer.sdp,
    instructions:
      'You are a helpful voice assistant in a desktop app. Be concise, natural, and actionable for non-technical users.'
  });

  await pc.setRemoteDescription({
    type: 'answer',
    sdp: result.answerSdp
  });

  return {
    stop() {
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
    micState = await startMicrophone();
    realtimeState = await startRealtimeAgent(micState.stream);
    document.body.classList.add('listening');
    if (voicePrompt) voicePrompt.textContent = 'Say something...';
    if (micBtn) micBtn.setAttribute('aria-pressed', 'true');
  } catch (error) {
    console.error('Realtime voice start failed:', error);
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

boot();
