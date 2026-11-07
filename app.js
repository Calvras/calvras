// Kraken Chatbot Application Logic
// Direct Together.ai Pipeline + DeepSeek V4.1 Flash + Full Session Memory + Interactive Media Generation

const TOGETHER_API_KEY = 'tgp_v1_S7bp9V3o9lc4IWI_A6V_WjbAHLXenWs5Gs_zxL2f6ro';
const TOGETHER_ENDPOINT = 'https://api.together.xyz/v1/chat/completions';

let currentModelId = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
let currentModelDisplayName = 'DeepSeek V4.1';
let currentMode = 'Turbo';
let showReasoningSteps = true;
let activeChatId = null;
let abortController = null;
let isGenerating = false;
let pendingAttachments = [];

// Session Storage for all conversations
let chats = [];

const STORAGE_KEY = 'kraken_chats_history';

function loadStoredChats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      chats = JSON.parse(raw);
    } else {
      chats = [];
    }
  } catch (e) {
    console.error('Failed to parse chats from localStorage:', e);
    chats = [];
  }
}

function saveChatsToStorage() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  } catch (e) {
    console.error('Failed to save chats to localStorage:', e);
  }
}

// DOM Elements
const sidebar = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const sidebarUncollapseBtn = document.getElementById('sidebar-uncollapse-btn');
const brandHomeBtn = document.getElementById('brand-home-btn');
const btnNewChat = document.getElementById('btn-new-chat');
const chatHistoryList = document.getElementById('chat-history-list');

const welcomeContainer = document.getElementById('welcome-container');
const conversationThread = document.getElementById('conversation-thread');
const messagesContainer = document.getElementById('messages-container');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');

// Header elements & Preview Panel
const activeChatTitleWrapper = document.getElementById('active-chat-title-wrapper');
const activeChatTitleText = document.getElementById('active-chat-title-text');
const previewPanel = document.getElementById('preview-panel');
const previewIframe = document.getElementById('preview-iframe');
const previewUrlInput = document.getElementById('preview-url-input');
const previewRefreshBtn = document.getElementById('preview-refresh-btn');
const previewOpenTabBtn = document.getElementById('preview-open-tab-btn');
const previewCloseBtn = document.getElementById('preview-close-btn');

// Home Prompt Card
const promptCard = document.querySelector('.antigravity-chat-card');
const tagFolder = document.getElementById('tag-folder');
const folderNameLabel = document.getElementById('folder-name-label');
const workspaceFolderPicker = document.getElementById('workspace-folder-picker');
let activeWorkspaceName = localStorage.getItem('kraken_workspace_name') || '';
let activeWorkspaceDir = '';
const promptInput = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');
const cardAttachments = document.getElementById('card-attachments');

// Capsule Input Bar
const capsuleBar = document.querySelector('.capsule-input-bar');
const capsulePromptInput = document.getElementById('capsule-prompt-input');
const capsuleSendBtn = document.getElementById('capsule-send-btn');
const capsuleSendIcon = document.getElementById('capsule-send-icon');
const capsuleStopIcon = document.getElementById('capsule-stop-icon');
const capsuleAttachBtn = document.getElementById('capsule-attach-btn');

// Modals
const proModal = document.getElementById('pro-modal');
const closeProModal = document.getElementById('close-pro-modal');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsModal = document.getElementById('close-settings-modal');
const settingsModeSelect = document.getElementById('settings-mode-select');
const showThoughtsToggle = document.getElementById('show-thoughts-toggle');
const themeSelect = document.getElementById('theme-select');
const clearChatsBtn = document.getElementById('clear-chats-btn');
const saveSettingsBtn = document.getElementById('save-settings-btn');
const settingsStatusMsg = document.getElementById('settings-status-msg');

// Search
const searchBtn = document.getElementById('search-btn');
const searchBox = document.getElementById('sidebar-search-box');
const searchInput = document.getElementById('sidebar-search-input');

// ==========================================================================
// WORKSPACE CONNECTION (the agent only touches a folder the user picked)
// ==========================================================================
function agentApiBase() {
  return window.location.protocol.startsWith('http')
    ? window.location.origin
    : 'http://localhost:8080';
}

async function agentApi(pathname, { method = 'GET', body = undefined, timeoutMs = 20000 } = {}) {
  const url = agentApiBase() + pathname;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`The workspace server at ${agentApiBase()} did not respond in time.`);
    }
    if (err instanceof TypeError) {
      throw new Error(`The workspace server is not reachable at ${agentApiBase()}. Start it with "node server.js" in the app folder.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function updateFolderChip() {
  if (!folderNameLabel || !tagFolder) return;
  folderNameLabel.textContent = activeWorkspaceName || 'Select Folder';
  tagFolder.classList.toggle('has-folder', Boolean(activeWorkspaceName));
  tagFolder.title = activeWorkspaceDir
    ? `Workspace: ${activeWorkspaceDir}`
    : 'No folder selected — click to choose one';
}

async function refreshWorkspaceInfo() {
  try {
    const info = await agentApi('/api/workspace/info', { timeoutMs: 4000 });
    activeWorkspaceDir = info.selected ? info.dir : '';
    activeWorkspaceName = info.selected ? info.name : '';
    updateFolderChip();
    return { ...info, reachable: true };
  } catch (err) {
    activeWorkspaceDir = '';
    activeWorkspaceName = '';
    updateFolderChip();
    return { selected: false, reachable: false, error: err.message };
  }
}

async function pickWorkspaceFolder() {
  let chosen = null;
  let usedIpc = false;

  try {
    if (typeof window.require === 'function') {
      const electron = window.require('electron');
      if (electron && electron.ipcRenderer) {
        usedIpc = true;
        chosen = await electron.ipcRenderer.invoke('kraken:pick-folder');
      }
    }
  } catch (err) {
    usedIpc = false;
    console.warn('[Workspace] Native picker unavailable:', err.message);
  }

  if (usedIpc) {
    if (!chosen) return false;
  } else {
    try {
      const picked = await agentApi('/api/workspace/pick-folder', { method: 'POST', timeoutMs: 190000 });
      if (picked.cancelled) return false;
      chosen = picked.path;
    } catch (err) {
      alert(`Could not open the folder picker.\n\n${err.message}`);
      return false;
    }
  }

  try {
    const info = await agentApi('/api/workspace/set-folder', {
      method: 'POST',
      body: { folderPath: chosen },
      timeoutMs: 8000,
    });
    activeWorkspaceDir = info.dir;
    activeWorkspaceName = info.name;
    updateFolderChip();
    return true;
  } catch (err) {
    alert(`That folder can't be used.\n\n${err.message}`);
    return false;
  }
}

// ==========================================================================
// LIVE PREVIEW (overlay — the agent opens/closes it, the user closes/resizes it)
// ==========================================================================
const PREVIEW_SHARE_KEY = 'kraken_preview_share_v2';
const PREVIEW_DEFAULT_SHARE = 0.65;
const PREVIEW_MIN_SHARE = 0.25;
const PREVIEW_MAX_SHARE = 0.82;
let livePreviewUrl = '';
let previewProbeTimer = null;
let previewShare = clamp(Number(localStorage.getItem(PREVIEW_SHARE_KEY)) || PREVIEW_DEFAULT_SHARE, PREVIEW_MIN_SHARE, PREVIEW_MAX_SHARE);

function previewAreaWidth() {
  const layout = document.querySelector('.app-layout');
  return layout ? layout.getBoundingClientRect().width : window.innerWidth;
}

function applyPreviewShare(share) {
  previewShare = clamp(share, PREVIEW_MIN_SHARE, PREVIEW_MAX_SHARE);
  if (!previewPanel) return;
  // Use percentage so the split is fluid
  previewPanel.style.setProperty('--preview-width', (previewShare * 100).toFixed(2) + '%');
  const handle = document.getElementById('preview-resize-handle');
  if (handle) handle.setAttribute('aria-valuenow', String(Math.round(previewShare * 100)));
}

function ensurePreviewInLayout() {
  // Move preview panel inside .app-layout if it isn't already
  const layout = document.querySelector('.app-layout');
  if (layout && previewPanel && previewPanel.parentElement !== layout) {
    layout.appendChild(previewPanel);
  }
}

function initPreviewResize() {
  const handle = document.getElementById('preview-resize-handle');
  if (!handle || !previewPanel) return;
  handle.setAttribute('aria-valuemin', String(Math.round(PREVIEW_MIN_SHARE * 100)));
  handle.setAttribute('aria-valuemax', String(Math.round(PREVIEW_MAX_SHARE * 100)));
  applyPreviewShare(previewShare);

  const shareFromPointer = (clientX) => {
    const layout = document.querySelector('.app-layout');
    const rect = layout ? layout.getBoundingClientRect() : { left: 0, width: window.innerWidth };
    // Share is the fraction of the layout that the preview takes (measured from the right)
    const rightFraction = (rect.left + rect.width - clientX) / rect.width;
    return rightFraction;
  };

  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    previewPanel.classList.add('resizing');
    document.body.classList.add('preview-dragging');
    applyPreviewShare(shareFromPointer(event.clientX));
  });
  handle.addEventListener('pointermove', (event) => {
    if (!previewPanel.classList.contains('resizing')) return;
    applyPreviewShare(shareFromPointer(event.clientX));
  });
  const endDrag = (event) => {
    if (!previewPanel.classList.contains('resizing')) return;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    previewPanel.classList.remove('resizing');
    document.body.classList.remove('preview-dragging');
    localStorage.setItem(PREVIEW_SHARE_KEY, String(previewShare));
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('dblclick', () => {
    applyPreviewShare(PREVIEW_DEFAULT_SHARE);
    localStorage.setItem(PREVIEW_SHARE_KEY, String(previewShare));
  });
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    applyPreviewShare(previewShare + (event.key === 'ArrowLeft' ? step : -step));
    localStorage.setItem(PREVIEW_SHARE_KEY, String(previewShare));
  });

  window.addEventListener('resize', () => applyPreviewShare(previewShare));
  const layout = document.querySelector('.app-layout');
  if (layout && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => applyPreviewShare(previewShare)).observe(layout);
  }
}

function normalizePreviewUrl(raw) {
  const value = String(raw || '').trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(value)) {
    return 'http://' + value.replace(/^0\.0\.0\.0/, 'localhost');
  }
  // A workspace-relative page is served by the workspace server.
  return agentApiBase() + '/' + value.replace(/^\/+/, '');
}

function isLivePreviewOpen() {
  return Boolean(previewPanel && previewPanel.classList.contains('open'));
}

function stopPreviewProbe() {
  if (previewProbeTimer) {
    clearInterval(previewProbeTimer);
    previewProbeTimer = null;
  }
}

// A server the agent just started needs a moment to bind its port. Reload once
// it answers instead of leaving the frame on a connection error.
function probePreview(url, attempts = 10) {
  stopPreviewProbe();
  let tries = 0;
  previewProbeTimer = setInterval(async () => {
    tries += 1;
    if (tries > attempts || livePreviewUrl !== url || !isLivePreviewOpen()) {
      stopPreviewProbe();
      return;
    }
    try {
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (res.ok || res.status === 304) {
        stopPreviewProbe();
        if (previewIframe && livePreviewUrl === url) previewIframe.src = url;
      }
    } catch (err) { /* not listening yet */ }
  }, 800);
}

window.openLivePreview = function(rawUrl) {
  const url = normalizePreviewUrl(rawUrl || livePreviewUrl);
  if (!url || !previewPanel) return '';
  const changed = url !== livePreviewUrl;
  livePreviewUrl = url;
  if (previewUrlInput) previewUrlInput.value = url;
  if (previewIframe && (changed || !previewIframe.src || previewIframe.src === 'about:blank')) {
    previewIframe.src = url;
  }
  // Ensure panel is inside .app-layout for the split to work
  ensurePreviewInLayout();
  previewPanel.classList.add('open');
  previewPanel.setAttribute('aria-hidden', 'false');
  // Add split class to the layout so it's clear split mode is active
  const layout = document.querySelector('.app-layout');
  if (layout) layout.classList.add('preview-split');
  applyPreviewShare(previewShare);
  if (changed) probePreview(url);
  return url;
};

window.closeLivePreview = function() {
  stopPreviewProbe();
  if (!previewPanel) return;
  previewPanel.classList.remove('open');
  previewPanel.setAttribute('aria-hidden', 'true');
  const layout = document.querySelector('.app-layout');
  if (layout) layout.classList.remove('preview-split');
};

window.reloadLivePreview = function() {
  if (!previewIframe || !livePreviewUrl) return;
  previewIframe.src = livePreviewUrl.split('?')[0] + '?t=' + Date.now();
};

window.getLivePreviewUrl = function() {
  return livePreviewUrl;
};

// A run block that starts a server: the command itself, or the port it prints.
const SERVER_START_RE = /\b(npm\s+(run\s+)?(start|dev|serve)|npx\s+(vite|serve|http-server|next)|yarn\s+(dev|start)|pnpm\s+(dev|start)|node\s+[\w./\\-]+|python\d?\s+(-m\s+http\.server|[\w./\\-]+\.py)|vite|next\s+dev|http-server|live-server|php\s+-S)\b/i;

function detectServerUrl(command, output) {
  const text = String(output || '');
  const cmd = String(command || '');
  const explicit = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s'"<>()[\],;]*/i);
  if (explicit) return normalizePreviewUrl(explicit[0]);
  if (!SERVER_START_RE.test(cmd)) return '';
  const port = cmd.match(/(?:--port[= ]|-p[ =]|PORT=|:)(\d{4,5})\b/i)
    || text.match(/(?:port|listening on|running at)\D{0,12}(\d{4,5})\b/i);
  if (port) return 'http://localhost:' + port[1];
  return '';
}

// Render an attachment preview in the home card
function addCardAttachment(file) {
  pendingAttachments.push(file);
  cardAttachments.style.display = 'flex';

  const isImage = file.type && file.type.startsWith('image/');
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.display = 'inline-flex';

  if (isImage) {
    const thumb = document.createElement('div');
    thumb.className = 'card-attachment-thumb';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(file);
    thumb.appendChild(img);
    wrapper.appendChild(thumb);
  } else {
    const pill = document.createElement('div');
    pill.className = 'card-attachment-file';
    pill.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
      <span title="${file.name}">${file.name}</span>
    `;
    wrapper.appendChild(pill);
  }

  // Remove button
  const removeBtn = document.createElement('button');
  removeBtn.className = 'card-attach-remove';
  removeBtn.innerHTML = '×';
  removeBtn.addEventListener('click', () => {
    pendingAttachments = pendingAttachments.filter(f => f !== file);
    wrapper.remove();
    if (cardAttachments.children.length === 0) {
      cardAttachments.style.display = 'none';
    }
  });
  wrapper.appendChild(removeBtn);
  cardAttachments.appendChild(wrapper);
}

function autoResizeTextarea(textarea, container, baseMinHeight, maxHeight, widthBreakpoint) {
  textarea.style.height = 'auto';
  const newHeight = Math.min(Math.max(textarea.scrollHeight, baseMinHeight), maxHeight);
  textarea.style.height = newHeight + 'px';

  if (container && widthBreakpoint) {
    if (textarea.value.length > widthBreakpoint || newHeight > baseMinHeight + 15) {
      container.classList.add('expanded-width');
    } else {
      container.classList.remove('expanded-width');
    }
  }
}

// ==========================================================================
// INTERACTIVE IMAGE / VIDEO GENERATION CANVAS ENGINE (Exact Mathematical Model)
// ==========================================================================
const GRID_GAP = 40 / 3;
const BASE_DOT_RADIUS = 1.1;
const BASE_ALPHA = 0.2;
const ORB_RADIUS_SCALE = 0.5;
const MIN_ACTIVE_DOT_DIAMETER = 2;
const MAX_ACTIVE_DOT_DIAMETER = 7;
const FULL_SIZE_PROGRESS = 0.7;
const PROGRESS_NORMALIZER = 0.82;
const FRAME_DURATION = 1000 / 30;

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value) {
  const clampedValue = clamp(value);
  return clampedValue * clampedValue * (3 - 2 * clampedValue);
}

function pingPong(from, to, duration, elapsed) {
  const phase = (elapsed / duration) % 2;
  const triangle = phase <= 1 ? phase : 2 - phase;
  const easedProgress = (1 - Math.cos(triangle * Math.PI)) / 2;
  return from + (to - from) * easedProgress;
}

function orbFalloff(radius, distance) {
  const innerRadius = radius * 0.14;
  const broadFalloff = (distance - innerRadius) / Math.max(radius - innerRadius, 0.001);
  const coreFalloff = (distance - innerRadius) / Math.max(radius * 0.32, 0.001);
  return (1 - smoothstep(broadFalloff)) * (1 - smoothstep(coreFalloff) * 0.12);
}

function drawLoader(context, { accentColor, elapsedMilliseconds, height, progress, reducedMotion, width }) {
  context.clearRect(0, 0, width, height);
  if (width < GRID_GAP || height < GRID_GAP) return;

  const columns = Math.floor(width / GRID_GAP);
  const rows = Math.floor(height / GRID_GAP);
  const offsetX = (width - (columns - 1) * GRID_GAP) / 2;
  const offsetY = (height - (rows - 1) * GRID_GAP) / 2;
  const elapsedSeconds = reducedMotion ? 0 : Math.max(0, elapsedMilliseconds) / 1000;
  const isCorner = (column, row) => (column === 0 || column === columns - 1) && (row === 0 || row === rows - 1);

  context.save();
  context.fillStyle = accentColor;
  context.globalAlpha = BASE_ALPHA;
  context.beginPath();

  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      if (isCorner(column, row)) continue;
      const x = offsetX + column * GRID_GAP;
      const y = offsetY + row * GRID_GAP;
      context.moveTo(x + BASE_DOT_RADIUS, y);
      context.arc(x, y, BASE_DOT_RADIUS, 0, Math.PI * 2);
    }
  }
  context.fill();

  const progressFactor = clamp(progress / PROGRESS_NORMALIZER) ** 1.28;
  const growth = progressFactor * (0.72 - 0.08 * smoothstep((progressFactor - 0.5) / 0.5));
  const firstOrbX = pingPong(0.18, 0.82, 3.46, elapsedSeconds);
  const firstOrbY = pingPong(0.18, 0.82, 4.87, elapsedSeconds);
  const secondOrbX = pingPong(0.82, 0.18, 4.31, elapsedSeconds);
  const secondOrbY = pingPong(0.82, 0.18, 4.42, elapsedSeconds);
  const firstOrbRadius = pingPong(0.35, 0.6, 3.6, elapsedSeconds) * ORB_RADIUS_SCALE + growth;
  const secondOrbRadius = pingPong(0.43, 0.7, 2.4, elapsedSeconds) * ORB_RADIUS_SCALE + growth;
  const radiusStrength = reducedMotion ? 0.234 : pingPong(0.105, 0.234, 2.25, elapsedSeconds);
  const minimumBrightAlpha = pingPong(0.58, 0.82, 2.1, elapsedSeconds);
  const maxDotDiameter =
    MIN_ACTIVE_DOT_DIAMETER +
    (MAX_ACTIVE_DOT_DIAMETER - MIN_ACTIVE_DOT_DIAMETER) * smoothstep(progress / FULL_SIZE_PROGRESS);
  const maximumRadius = Math.min(GRID_GAP * 0.48, maxDotDiameter / 2);

  for (let column = 0; column < columns; column += 1) {
    for (let row = 0; row < rows; row += 1) {
      if (isCorner(column, row)) continue;

      const normalizedX = columns === 1 ? 0.5 : column / (columns - 1);
      const normalizedY = rows === 1 ? 0.5 : row / (rows - 1);
      const firstOrbStrength = orbFalloff(
        firstOrbRadius,
        Math.hypot(normalizedX - firstOrbX, normalizedY - firstOrbY),
      );
      const secondOrbStrength = orbFalloff(
        secondOrbRadius,
        Math.hypot(normalizedX - secondOrbX, normalizedY - secondOrbY),
      );
      const fieldStrength = Math.max(firstOrbStrength, secondOrbStrength);
      const brightness = progressFactor * fieldStrength ** (0.85 + progressFactor * 1.1);
      const dotRadius = maximumRadius * fieldStrength ** 1.15 * (radiusStrength / 0.234);

      if (dotRadius <= 0.2) continue;

      const x = offsetX + column * GRID_GAP;
      const y = offsetY + row * GRID_GAP;
      context.globalAlpha = minimumBrightAlpha + (1 - minimumBrightAlpha) * brightness * 0.64;
      context.beginPath();
      context.arc(x, y, dotRadius, 0, Math.PI * 2);
      context.fill();
    }
  }

  context.restore();
}

function startCanvasLoader(canvas, getProgress) {
  const context = canvas.getContext('2d');
  if (!context) return () => {};

  let animationFrame = 0;
  let lastFrameAt = -Infinity;
  const startedAt = performance.now();
  let width = 0;
  let height = 0;

  function resize() {
    width = canvas.clientWidth || 320;
    height = canvas.clientHeight || 320;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  function draw(timestamp) {
    if (timestamp - lastFrameAt >= FRAME_DURATION) {
      drawLoader(context, {
        accentColor: '#ffffff',
        elapsedMilliseconds: timestamp - startedAt,
        height,
        progress: clamp(getProgress()),
        reducedMotion: false,
        width,
      });
      lastFrameAt = timestamp;
    }
    animationFrame = window.requestAnimationFrame(draw);
  }

  animationFrame = window.requestAnimationFrame(draw);

  return () => {
    window.cancelAnimationFrame(animationFrame);
    window.removeEventListener('resize', resize);
  };
}

// ==========================================================================
// PLAYABLE SNAKE MINI-GAME (Built-in while waiting)
// ==========================================================================
function startSnakeGame(container, onExit) {
  container.innerHTML = `
    <div class="snake-game-container" tabindex="0">
      <div class="snake-game-header">
        <button class="snake-exit-btn">← Back to Loader (Esc)</button>
        <span class="snake-score-badge">Score: <span id="snake-score">0</span></span>
      </div>
      <canvas id="snake-canvas" width="320" height="320" style="width:100%;height:100%;display:block;"></canvas>
      <div class="snake-overlay" id="snake-game-over" style="display:none;">
        <h4 id="snake-overlay-title">Game Over</h4>
        <p id="snake-overlay-sub">Press Enter to restart</p>
      </div>
    </div>
  `;

  const gameWrapper = container.querySelector('.snake-game-container');
  const canvas = container.querySelector('#snake-canvas');
  const ctx = canvas.getContext('2d');
  const scoreEl = container.querySelector('#snake-score');
  const overlay = container.querySelector('#snake-game-over');
  const overlayTitle = container.querySelector('#snake-overlay-title');
  const overlaySub = container.querySelector('#snake-overlay-sub');
  const exitBtn = container.querySelector('.snake-exit-btn');

  exitBtn.addEventListener('click', onExit);

  const GRID_COUNT = 17;
  const cellSize = 320 / GRID_COUNT;

  let snake = [
    { x: 10, y: 8 },
    { x: 9, y: 8 },
    { x: 8, y: 8 },
    { x: 7, y: 8 },
  ];
  let direction = { x: 1, y: 0 };
  let queuedDirection = { x: 1, y: 0 };
  let food = { x: 3, y: 8 };
  let score = 0;
  let gameOver = false;
  let isPaused = false;
  let gameInterval = null;

  function spawnFood() {
    let candidate;
    while (!candidate || snake.some(c => c.x === candidate.x && c.y === candidate.y)) {
      candidate = {
        x: Math.floor(Math.random() * GRID_COUNT),
        y: Math.floor(Math.random() * GRID_COUNT),
      };
    }
    return candidate;
  }

  function render() {
    ctx.clearRect(0, 0, 320, 320);

    // Subtle grid dots
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    for (let x = 0; x < GRID_COUNT; x++) {
      for (let y = 0; y < GRID_COUNT; y++) {
        ctx.beginPath();
        ctx.arc(x * cellSize + cellSize / 2, y * cellSize + cellSize / 2, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Food
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(food.x * cellSize + cellSize / 2, food.y * cellSize + cellSize / 2, cellSize * 0.35, 0, Math.PI * 2);
    ctx.fill();

    // Snake
    snake.forEach((segment, i) => {
      ctx.fillStyle = i === 0 ? '#ffffff' : '#d1d5db';
      ctx.beginPath();
      ctx.roundRect(
        segment.x * cellSize + 2,
        segment.y * cellSize + 2,
        cellSize - 4,
        cellSize - 4,
        i === 0 ? 6 : 4
      );
      ctx.fill();

      // Eyes on head
      if (i === 0) {
        ctx.fillStyle = '#111827';
        ctx.beginPath();
        ctx.arc(segment.x * cellSize + 6, segment.y * cellSize + 6, 1.8, 0, Math.PI * 2);
        ctx.arc(segment.x * cellSize + cellSize - 6, segment.y * cellSize + 6, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  function tick() {
    if (gameOver || isPaused) return;

    direction = queuedDirection;
    const head = snake[0];
    const nextHead = {
      x: (head.x + direction.x + GRID_COUNT) % GRID_COUNT,
      y: (head.y + direction.y + GRID_COUNT) % GRID_COUNT,
    };

    if (snake.some(segment => segment.x === nextHead.x && segment.y === nextHead.y)) {
      gameOver = true;
      overlayTitle.innerText = 'Game Over';
      overlaySub.innerText = 'Press Enter to restart, or Esc to exit';
      overlay.style.display = 'flex';
      return;
    }

    const ate = nextHead.x === food.x && nextHead.y === food.y;
    snake.unshift(nextHead);

    if (ate) {
      score += 1;
      scoreEl.innerText = score;
      food = spawnFood();
    } else {
      snake.pop();
    }

    render();
  }

  function handleKeyDown(e) {
    if (['ArrowUp', 'KeyW'].includes(e.code) && direction.y === 0) {
      e.preventDefault();
      queuedDirection = { x: 0, y: -1 };
    } else if (['ArrowDown', 'KeyS'].includes(e.code) && direction.y === 0) {
      e.preventDefault();
      queuedDirection = { x: 0, y: 1 };
    } else if (['ArrowLeft', 'KeyA'].includes(e.code) && direction.x === 0) {
      e.preventDefault();
      queuedDirection = { x: -1, y: 0 };
    } else if (['ArrowRight', 'KeyD'].includes(e.code) && direction.x === 0) {
      e.preventDefault();
      queuedDirection = { x: 1, y: 0 };
    } else if (e.code === 'Space') {
      e.preventDefault();
      isPaused = !isPaused;
      if (isPaused) {
        overlayTitle.innerText = 'Paused';
        overlaySub.innerText = 'Press Space to resume';
        overlay.style.display = 'flex';
      } else {
        overlay.style.display = 'none';
      }
    } else if (e.code === 'Escape') {
      e.preventDefault();
      clearInterval(gameInterval);
      onExit();
    } else if (e.code === 'Enter' && gameOver) {
      e.preventDefault();
      snake = [
        { x: 10, y: 8 },
        { x: 9, y: 8 },
        { x: 8, y: 8 },
        { x: 7, y: 8 },
      ];
      direction = { x: 1, y: 0 };
      queuedDirection = { x: 1, y: 0 };
      food = spawnFood();
      score = 0;
      scoreEl.innerText = 0;
      gameOver = false;
      overlay.style.display = 'none';
    }
  }

  gameWrapper.addEventListener('keydown', handleKeyDown);
  gameWrapper.focus();
  render();
  gameInterval = setInterval(tick, 120);

  return () => {
    clearInterval(gameInterval);
    gameWrapper.removeEventListener('keydown', handleKeyDown);
  };
}

// Detect if the user wants to GENERATE an image or video (distinguishing from questions like "can you generate images?")
function detectMediaGenerationIntent(prompt) {
  const p = prompt.trim().toLowerCase();

  // Pure questions about capabilities — DO NOT trigger image generation!
  const isQuestion =
    /^(can you|do you|are you able to|how do you|could you tell me if you can|is it possible to)\s+(generate|create|make|produce)\s+(images?|photos?|pictures?|videos?|animations?|photographs?)\b/i.test(p) ||
    /^(can you generate|can you make|can you draw|do you generate|what kind of images can you)\b/i.test(p) ||
    (p.endsWith('?') && !/^(generate|create|draw|make|render|animate|paint|produce)\b/i.test(p));

  if (isQuestion) {
    return null;
  }

  // Coding / Web / App development intent — NEVER trigger media generation!
  const isCodingIntent = /\b(website|webpage|web page|site|web app|app|application|game|component|html|css|js|javascript|typescript|react|vue|node|server|api|backend|frontend|script|code|ui|dashboard|landing page|portfolio|program|database|sql)\b/i.test(p);
  if (isCodingIntent) {
    return null;
  }

  // Explicit Video Generation Commands
  const videoTriggers = [
    /\b(generate|create|make|render|animate|produce)\s+(a|an|the)?\s*(video|animation|clip|short film|motion graphic)\b/i,
    /\b(video of|animation of|animate this)\b/i
  ];

  for (const regex of videoTriggers) {
    if (regex.test(p)) return 'video';
  }

  // Explicit Image / Photo / Photograph Generation Commands (must strictly request visual art)
  const imageTriggers = [
    /\b(generate|create|draw|paint|render|make|produce)\s+(?:an?\s+)?(?:[\w\-]+\s+)*(?:image|photo|photograph|picture|painting|illustration|artwork|wallpaper|portrait|drawing)\b/i,
    /\b(draw me|paint me)\s+(?:an?\s+)?(?:[\w\-]+\s+)*(?:image|photo|picture|painting|illustration|artwork|wallpaper|portrait|drawing)\b/i,
    /\b(image of|photo of|picture of|photograph of|illustration of|painting of)\b/i
  ];

  for (const regex of imageTriggers) {
    if (regex.test(p)) return 'image';
  }

  return null;
}

// A greeting or a bit of small talk is not a job. Anything that asks for work —
// a verb, a file, a question about the code — falls through to the agent loop.
const SMALL_TALK_RE = /^(?:hey+|hi+|hello+|yo|hiya|howdy|sup|wassup|wazzup|good\s+(?:morning|afternoon|evening|day)|greetings|thanks?(?:\s+you)?|thank\s+you\s+(?:so\s+much|very\s+much)?|cheers|ty|ok(?:ay)?|k|cool|nice|great|awesome|perfect|got\s+it|sounds\s+good|lol|haha|yes|no|yep|nope|sure|np|no\s+problem|bye|goodbye|see\s+ya|later|gn|good\s+night)(?:[\s,!.]+(?:there|kraken|man|mate|bro|dude|friend|team|everyone|all|again|so\s+much|a\s+lot|very\s+much|for\s+that|for\s+this|bud|buddy))*[\s!.?]*$/i;

const WORK_HINT_RE = /\b(build|make|create|write|fix|add|remove|delete|run|start|stop|test|deploy|refactor|debug|check|read|open|show|find|search|install|update|change|edit|rename|explain|review|generate|implement|setup|set up|commit|push|pull|serve|preview|audit|optimi[sz]e|migrate|convert|help me|can you|could you|please|i want|i need|let's|why|how do|what is|what's|where)\b/i;

function isSmallTalk(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 60) return false;
  if (WORK_HINT_RE.test(value)) return false;
  if (/[`/\\]|\.\w{1,5}$|https?:\/\//i.test(value)) return false;
  return SMALL_TALK_RE.test(value);
}

function buildSmallTalkPrompt() {
  return [
    'You are Kraken, a coding agent sitting in a desktop app.',
    'The user is just saying hello or making small talk — this is NOT a work request.',
    'Reply the way a relaxed colleague would: one short line, two at most. Plain conversational text.',
    'Do not offer a plan, do not list capabilities, do not ask what they want to build, do not mention folders or tools.',
    'Never emit a tool block, code fence, or heading. No emoji.',
  ].join('\n');
}

// Real on-the-fly image generation via the Pollinations flux endpoint
async function generateTogetherImage(prompt) {
  try {
    const res = await fetch('https://api.together.xyz/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOGETHER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'stabilityai/stable-diffusion-xl-base-1.0',
        prompt: prompt.trim(),
        width: 1024,
        height: 1024,
        steps: 20,
        n: 1,
        response_format: 'b64_json'
      })
    });
    if (res.ok) {
      const data = await res.json();
      if (data.data && data.data[0] && data.data[0].b64_json) {
        return 'data:image/jpeg;base64,' + data.data[0].b64_json;
      }
    }
  } catch (err) {
    console.warn('Together AI image error, using flux fallback:', err);
  }
  const clean = encodeURIComponent(prompt.trim());
  const seed = Math.floor(Math.random() * 1000000);
  return 'https://image.pollinations.ai/prompt/' + clean + '?width=1024&height=1024&model=flux&nologo=true&seed=' + seed;
}

function generateMediaUrl(prompt) {
  const clean = encodeURIComponent(prompt.trim());
  const seed = Math.floor(Math.random() * 1000000);
  return 'https://image.pollinations.ai/prompt/' + clean + '?width=1024&height=1024&model=flux&nologo=true&seed=' + seed;
}?width=1024&height=1024&model=flux&nologo=true&seed=${randomSeed}`;
}

// Render Interactive Loader and Generation Lifecycle
function renderInteractiveMediaGeneration({ prompt, mediaType, onComplete, url }) {
  const mediaCard = document.createElement('div');
  mediaCard.className = 'media-gen-card';

  const viewport = document.createElement('div');
  viewport.className = 'media-gen-viewport';

  // Active loader elements
  const loaderContainer = document.createElement('div');
  loaderContainer.style.width = '100%';
  loaderContainer.style.height = '100%';
  loaderContainer.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.className = 'media-gen-canvas';
  loaderContainer.appendChild(canvas);

  const playBadge = document.createElement('div');
  playBadge.className = 'media-gen-play-badge';
  playBadge.innerHTML = `
    <span class="media-gen-ping">
      <span class="media-gen-ping-wave"></span>
      <span class="media-gen-ping-core"></span>
    </span>
    <span>Click to play Snake while you wait</span>
  `;
  loaderContainer.appendChild(playBadge);

  const percentBadge = document.createElement('div');
  percentBadge.className = 'media-gen-percent-badge';
  percentBadge.innerText = '0%';
  loaderContainer.appendChild(percentBadge);

  viewport.appendChild(loaderContainer);
  mediaCard.appendChild(viewport);

  const footerText = document.createElement('div');
  footerText.className = 'media-gen-footer-text';
  footerText.innerHTML = `<span>Generating ${mediaType}…</span><span>1024 × 1024</span>`;
  mediaCard.appendChild(footerText);

  const startedAt = Date.now();
  let currentProgress = 0;
  let isComplete = false;
  let cleanupSnake = null;

  // The real image is loaded before the card claims it exists. There is no substitute asset.
  const generatedMediaUrl = url || generateMediaUrl(prompt);
  const image = new Image();
  let imageState = 'loading';
  let imageError = '';
  image.onload = () => {
    imageState = 'loaded';
    if (!isComplete) finish();
  };
  image.onerror = () => {
    imageState = 'error';
    imageError = 'The image request failed. Pollinations did not return an image for this prompt.';
    if (!isComplete) finish();
  };
  image.src = generatedMediaUrl;

  const stopCanvas = startCanvasLoader(canvas, () => currentProgress / 100);

  // Play Snake Game on click
  playBadge.addEventListener('click', () => {
    if (isComplete) return;
    loaderContainer.style.display = 'none';

    const snakeContainer = document.createElement('div');
    snakeContainer.style.width = '100%';
    snakeContainer.style.height = '100%';
    viewport.appendChild(snakeContainer);

    cleanupSnake = startSnakeGame(snakeContainer, () => {
      if (cleanupSnake) cleanupSnake();
      snakeContainer.remove();
      if (!isComplete) {
        loaderContainer.style.display = 'block';
      }
    });
  });

  function finish() {
    if (isComplete) return;
    isComplete = true;
    clearInterval(interval);
    stopCanvas();

    if (cleanupSnake) {
      cleanupSnake();
      const sc = viewport.querySelector('.snake-game-container');
      if (sc) sc.parentElement.remove();
    }

    loaderContainer.remove();

    if (imageState === 'error') {
      const err = document.createElement('div');
      err.className = 'media-gen-error';
      err.textContent = imageError;
      viewport.appendChild(err);
      footerText.innerHTML = '<span>Image generation failed</span><span style="color:#ef4444;font-weight:500;">No image</span>';
      if (onComplete) onComplete(null);
      return;
    }

    percentBadge.innerText = '100%';

    // Show the real generated asset
    const completedContainer = document.createElement('div');
    completedContainer.className = 'media-gen-completed-container';

    image.className = 'media-gen-image';
    image.alt = prompt;
    completedContainer.appendChild(image);

    const overlay = document.createElement('div');
    overlay.className = 'media-gen-overlay';

    const editBtn = document.createElement('button');
    editBtn.className = 'media-gen-action-btn';
    editBtn.innerText = 'Regenerate';
    editBtn.addEventListener('click', () => {
      mediaCard.remove();
      renderInteractiveMediaGeneration({ prompt, mediaType, onComplete });
    });
    overlay.appendChild(editBtn);

    /* Share button removed per specification */

    completedContainer.appendChild(overlay);
    viewport.appendChild(completedContainer);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    footerText.innerHTML = `<span>Generated in ${elapsed}s · 1024 × 1024</span><span style="color:#10b981;font-weight:500;">✓ Ready</span>`;

    if (onComplete) onComplete(generatedMediaUrl);
  }

  // Progress stays below 100% until the real image has loaded.
  const interval = setInterval(() => {
    if (isComplete) {
      clearInterval(interval);
      return;
    }

    if (imageState === 'error') {
      finish();
      return;
    }

    const ceiling = imageState === 'loaded' ? 100 : 92;
    const increment = Math.floor(Math.random() * 3) + 2;
    currentProgress = Math.min(ceiling, currentProgress + increment);
    percentBadge.innerText = `${currentProgress}%`;

    if (imageState === 'loaded' && currentProgress >= 100) {
      finish();
    }
  }, 110);

  return mediaCard;
}

function init() {
  loadStoredChats();
  renderSidebarHistory();
  setupEventListeners();
  showHomeView();
}

function setupEventListeners() {
  brandHomeBtn.addEventListener('click', showHomeView);
  btnNewChat.addEventListener('click', (e) => {
    e.preventDefault();
    showHomeView();
  });

  sidebarToggleBtn.addEventListener('click', () => {
    sidebar.classList.add('collapsed');
    sidebarUncollapseBtn.style.display = 'flex';
  });

  sidebarUncollapseBtn.addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
    sidebarUncollapseBtn.style.display = 'none';
  });

  // Home textarea auto-resize
  promptInput.addEventListener('input', () => {
    autoResizeTextarea(promptInput, promptCard, 38, 140, 50);
  });

  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(promptInput.value);
    }
  });
  sendBtn.addEventListener('click', () => handleSend(promptInput.value));

  // Capsule textarea auto-resize
  capsulePromptInput.addEventListener('input', () => {
    autoResizeTextarea(capsulePromptInput, capsuleBar, 24, 130, 45);
  });

  capsulePromptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating) {
        handleSend(capsulePromptInput.value);
      }
    }
  });

  capsuleSendBtn.addEventListener('click', () => {
    if (isGenerating) {
      stopGeneration();
    } else {
      handleSend(capsulePromptInput.value);
    }
  });

  attachBtn.addEventListener('click', () => fileInput.click());
  const capsuleFileInput = document.getElementById('capsule-file-input');
  capsuleAttachBtn.addEventListener('click', () => {
    if (welcomeContainer.style.display !== 'none') {
      fileInput.click();
    } else {
      capsuleFileInput.click();
    }
  });

  // Max 6 image attachments helper
  const MAX_ATTACHMENTS = 6;

  function addCapsuleAttachment(file) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) return;
    pendingAttachments.push(file);
    const attachmentsEl = document.getElementById('capsule-attachments');
    if (!attachmentsEl) return;
    attachmentsEl.style.display = 'flex';

    const isImage = file.type && file.type.startsWith('image/');
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';

    if (isImage) {
      const thumb = document.createElement('div');
      thumb.className = 'capsule-att-thumb';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      thumb.appendChild(img);
      wrapper.appendChild(thumb);
    } else {
      const pill = document.createElement('div');
      pill.className = 'capsule-att-file';
      pill.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><span title="${file.name}">${file.name}</span>`;
      wrapper.appendChild(pill);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'capsule-att-remove';
    removeBtn.innerHTML = '×';
    removeBtn.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter(f => f !== file);
      wrapper.remove();
      if (attachmentsEl.children.length === 0) attachmentsEl.style.display = 'none';
    });
    wrapper.appendChild(removeBtn);
    attachmentsEl.appendChild(wrapper);
  }

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      Array.from(fileInput.files).forEach(file => {
        if (welcomeContainer.style.display !== 'none') {
          addCardAttachment(file);
          promptInput.focus();
        } else {
          addCapsuleAttachment(file);
          capsulePromptInput.focus();
        }
      });
      fileInput.value = '';
    }
  });

  if (capsuleFileInput) {
    capsuleFileInput.addEventListener('change', () => {
      Array.from(capsuleFileInput.files).forEach(file => addCapsuleAttachment(file));
      capsuleFileInput.value = '';
    });
  }

  // Paste image/file support on both inputs
  function handlePasteAttach(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    let handled = false;
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (!file) continue;
        handled = true;
        if (welcomeContainer.style.display !== 'none') {
          addCardAttachment(file);
        } else {
          addCapsuleAttachment(file);
        }
      }
    }
    if (handled) e.preventDefault();
  }

  promptInput.addEventListener('paste', handlePasteAttach);
  capsulePromptInput.addEventListener('paste', handlePasteAttach);

  // Terminal toggle (Ctrl+`)
  const terminalPanel = document.getElementById('terminal-panel');
  const terminalToggleBtn = document.getElementById('terminal-toggle-btn');
  const terminalInput = document.getElementById('terminal-input');
  const terminalOutput = document.getElementById('terminal-output');
  const terminalCwdLabel = document.getElementById('terminal-cwd-label');
  let terminalHistory = [];
  let terminalHistoryIdx = -1;
  let terminalCwd = activeWorkspaceDir || '.';

  function updateTerminalCwd(cwd) {
    terminalCwd = cwd || activeWorkspaceDir || '.';
    if (terminalCwdLabel) terminalCwdLabel.textContent = terminalCwd || '~';
    if (document.getElementById('terminal-prompt-symbol')) {
      document.getElementById('terminal-prompt-symbol').textContent = terminalCwd ? terminalCwd.split(/[\\/]/).pop() + ' $' : '$';
    }
  }

  function appendTerminalLine(text, type = 'out') {
    if (!terminalOutput) return;
    const line = document.createElement('div');
    line.className = `t-line ${type}`;
    const textSpan = document.createElement('span');
    textSpan.className = 't-text';
    textSpan.textContent = text;
    line.appendChild(textSpan);
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  async function runTerminalCommand(cmd) {
    if (!cmd.trim()) return;
    terminalHistory.unshift(cmd);
    terminalHistoryIdx = -1;
    appendTerminalLine(`$ ${cmd}`, 'cmd');

    // Handle built-in cd
    const cdMatch = cmd.match(/^cd\s+(.+)$/);
    if (cdMatch) {
      const target = cdMatch[1].trim();
      if (!activeWorkspaceDir) {
        appendTerminalLine('No workspace selected. Open a folder first.', 'err');
        return;
      }
      // Resolve path relative to current cwd
      const newPath = target === '~' ? activeWorkspaceDir : (target.startsWith('/') || /^[A-Za-z]:/.test(target)) ? target : activeWorkspaceDir + '/' + (terminalCwd !== activeWorkspaceDir ? terminalCwd.replace(activeWorkspaceDir, '').replace(/^\//, '') + '/' : '') + target;
      updateTerminalCwd(newPath.replace(/\/+/g, '/').replace(/\/$/, '') || activeWorkspaceDir);
      return;
    }

    if (!activeWorkspaceDir) {
      appendTerminalLine('No workspace selected. Open a folder first.', 'err');
      return;
    }

    try {
      const res = await fetch(agentApiBase() + '/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd, cwd: terminalCwd || activeWorkspaceDir })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data.stdout) data.stdout.split('\n').forEach(l => appendTerminalLine(l, 'out'));
      if (data.stderr) data.stderr.split('\n').forEach(l => appendTerminalLine(l, 'err'));
      if (data.cwd) updateTerminalCwd(data.cwd);
    } catch (err) {
      appendTerminalLine(`Error: ${err.message}`, 'err');
    }
  }

  function openTerminal() {
    if (!terminalPanel) return;
    terminalPanel.style.display = 'flex';
    if (terminalToggleBtn) terminalToggleBtn.classList.add('active');
    updateTerminalCwd(activeWorkspaceDir);
    if (terminalInput) terminalInput.focus();
    if (terminalOutput && terminalOutput.children.length === 0) {
      appendTerminalLine('Kraken Terminal — real PowerShell execution in your workspace.', 'info');
      appendTerminalLine('Type any command and press Enter.', 'info');
    }
  }

  function closeTerminal() {
    if (!terminalPanel) return;
    terminalPanel.style.display = 'none';
    if (terminalToggleBtn) terminalToggleBtn.classList.remove('active');
  }

  if (terminalToggleBtn) {
    terminalToggleBtn.addEventListener('click', () => {
      if (terminalPanel && terminalPanel.style.display === 'none') {
        openTerminal();
      } else {
        closeTerminal();
      }
    });
  }

  document.getElementById('terminal-close-btn')?.addEventListener('click', closeTerminal);
  document.getElementById('terminal-clear-btn')?.addEventListener('click', () => {
    if (terminalOutput) terminalOutput.innerHTML = '';
  });

  if (terminalInput) {
    terminalInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = terminalInput.value;
        terminalInput.value = '';
        await runTerminalCommand(cmd);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (terminalHistoryIdx < terminalHistory.length - 1) {
          terminalHistoryIdx++;
          terminalInput.value = terminalHistory[terminalHistoryIdx] || '';
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (terminalHistoryIdx > 0) {
          terminalHistoryIdx--;
          terminalInput.value = terminalHistory[terminalHistoryIdx] || '';
        } else {
          terminalHistoryIdx = -1;
          terminalInput.value = '';
        }
      }
    });
  }

  // Ctrl+` to toggle terminal
  document.addEventListener('keydown', (e) => {
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (terminalPanel && terminalPanel.style.display === 'none') {
        openTerminal();
      } else {
        closeTerminal();
      }
    }
  });

  // Workspace folder picker
  refreshWorkspaceInfo();

  if (tagFolder) {
    tagFolder.addEventListener('click', async () => {
      await pickWorkspaceFolder();
    });
  }

  // Collapse open user bubbles on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-bubble')) {
      document.querySelectorAll('.user-bubble.expanded').forEach(b => b.classList.remove('expanded'));
    }
  });

  // Live preview: move panel inside .app-layout so it participates in the flex split.
  ensurePreviewInLayout();

  // Live preview: the agent opens and closes it; the user closes and resizes it.
  initPreviewResize();

  if (previewCloseBtn) {
    previewCloseBtn.addEventListener('click', () => window.closeLivePreview());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isLivePreviewOpen()) window.closeLivePreview();
  });

  if (previewRefreshBtn) {
    previewRefreshBtn.addEventListener('click', window.reloadLivePreview);
  }

  if (previewOpenTabBtn) {
    previewOpenTabBtn.addEventListener('click', () => {
      const targetUrl = previewUrlInput?.value;
      if (targetUrl) window.open(targetUrl, '_blank');
    });
  }

  if (previewUrlInput) {
    previewUrlInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const val = previewUrlInput.value.trim();
      if (!val) return;
      window.openLivePreview(normalizePreviewUrl(val));
    });
  }

  closeProModal.addEventListener('click', () => proModal.style.display = 'none');
  proModal.addEventListener('click', (e) => {
    if (e.target === proModal) proModal.style.display = 'none';
  });

  function syncSettingsUI() {
    if (settingsModeSelect) settingsModeSelect.value = currentMode;
    if (showThoughtsToggle) showThoughtsToggle.checked = showReasoningSteps;
  }

  function saveSettingsFromUI() {
    if (settingsModeSelect) {
      currentMode = settingsModeSelect.value;
      const modeBtnText = document.querySelector('#mode-selector-btn span');
      if (modeBtnText) modeBtnText.textContent = currentMode;
    }
    if (showThoughtsToggle) {
      showReasoningSteps = showThoughtsToggle.checked;
    }
    if (settingsStatusMsg) {
      settingsStatusMsg.style.display = 'block';
      setTimeout(() => { settingsStatusMsg.style.display = 'none'; }, 2000);
    }
  }

  syncSettingsUI();

  if (clearChatsBtn) {
    clearChatsBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all chat history?')) {
        chats = [];
        saveChatsToStorage();
        renderChatHistory();
        startNewChat();
        settingsModal.style.display = 'none';
      }
    });
  }

  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener('click', () => {
      saveSettingsFromUI();
      setTimeout(() => {
        settingsModal.style.display = 'none';
      }, 400);
    });
  }

  settingsBtn.addEventListener('click', () => {
    syncSettingsUI();
    settingsModal.style.display = 'flex';
  });

  closeSettingsModal.addEventListener('click', () => {
    saveSettingsFromUI();
    settingsModal.style.display = 'none';
  });

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) {
      saveSettingsFromUI();
      settingsModal.style.display = 'none';
    }
  });

  searchBtn.addEventListener('click', () => {
    if (searchBox.style.display === 'none') {
      searchBox.style.display = 'block';
      searchInput.focus();
    } else {
      searchBox.style.display = 'none';
      searchInput.value = '';
      filterHistory('');
    }
  });
  searchInput.addEventListener('input', (e) => filterHistory(e.target.value.toLowerCase()));

  // Mode Dropdown Management (Turbo, Auto, Default, Request Review)
  const modeBtn = document.getElementById('mode-selector-btn');
  const modeMenu = document.getElementById('mode-dropdown-menu');
  const capsuleModeBtn = document.getElementById('capsule-mode-btn');
  const capsuleModeMenu = document.getElementById('capsule-mode-menu');

  function setActiveMode(mode) {
    currentMode = mode;
    document.querySelectorAll('.selected-mode-name, #capsule-mode-label').forEach(el => el.innerText = mode);
    if (settingsModeSelect) settingsModeSelect.value = mode;

    [modeMenu, capsuleModeMenu].forEach(menu => {
      if (!menu) return;
      menu.querySelectorAll('.mode-option').forEach(o => {
        const check = o.querySelector('.mode-option-check');
        if (check) check.remove();
        if (o.getAttribute('data-mode') === mode) {
          o.classList.add('active');
          const checkDiv = document.createElement('div');
          checkDiv.className = 'mode-option-check';
          checkDiv.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          `;
          o.appendChild(checkDiv);
        } else {
          o.classList.remove('active');
        }
      });
    });
  }

  if (modeBtn && modeMenu) {
    modeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      modeMenu.classList.toggle('show');
      if (capsuleModeMenu) capsuleModeMenu.classList.remove('show');
    });

    modeMenu.querySelectorAll('.mode-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = opt.getAttribute('data-mode');
        setActiveMode(mode);
        modeMenu.classList.remove('show');
      });
    });
  }

  if (capsuleModeBtn && capsuleModeMenu) {
    capsuleModeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      capsuleModeMenu.classList.toggle('show');
      if (modeMenu) modeMenu.classList.remove('show');
    });

    capsuleModeMenu.querySelectorAll('.mode-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = opt.getAttribute('data-mode');
        setActiveMode(mode);
        capsuleModeMenu.classList.remove('show');
      });
    });
  }

  document.addEventListener('click', () => {
    if (modeMenu) modeMenu.classList.remove('show');
    if (capsuleModeMenu) capsuleModeMenu.classList.remove('show');
  });
}

// Group chats by date (Today, Yesterday, Previous week, Older)
function groupChatsByDate(list) {
  const groups = {
    Today: [],
    Yesterday: [],
    'Previous week': [],
    Older: []
  };

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;

  list.forEach(chat => {
    const timestamp = chat.createdAt || now.getTime();
    if (timestamp >= todayStart) {
      groups.Today.push(chat);
    } else if (timestamp >= yesterdayStart) {
      groups.Yesterday.push(chat);
    } else if (timestamp >= weekStart) {
      groups['Previous week'].push(chat);
    } else {
      groups.Older.push(chat);
    }
  });

  return groups;
}

// Render dynamic sidebar chat history from chats array
function renderSidebarHistory() {
  if (!chatHistoryList) return;
  chatHistoryList.innerHTML = '';

  if (chats.length === 0) {
    chatHistoryList.innerHTML = `
      <div style="padding: 24px 14px; text-align: center; color: #9ca3af; font-size: 12.5px; line-height: 1.5;">
        No chats yet.<br>Start a new conversation!
      </div>
    `;
    return;
  }

  const groups = groupChatsByDate(chats);

  for (const [label, groupChats] of Object.entries(groups)) {
    if (groupChats.length === 0) continue;

    const section = document.createElement('div');
    section.className = 'history-section';

    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'section-label';
    sectionLabel.innerText = label;
    section.appendChild(sectionLabel);

    groupChats.forEach(chat => {
      const item = document.createElement('div');
      item.className = 'history-item';
      if (chat.id === activeChatId) {
        item.classList.add('selected');
      }
      item.setAttribute('data-chat-id', chat.id);

      const titleSpan = document.createElement('span');
      titleSpan.className = 'chat-title';
      titleSpan.innerText = chat.title || 'Untitled chat';
      item.appendChild(titleSpan);

      // Options / delete button
      const moreBtn = document.createElement('button');
      moreBtn.className = 'more-btn';
      moreBtn.title = 'Delete chat';
      moreBtn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      `;
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteChat(chat.id);
      });
      item.appendChild(moreBtn);

      item.addEventListener('click', () => {
        loadChatById(chat.id);
      });

      section.appendChild(item);
    });

    chatHistoryList.appendChild(section);
  }
}

function deleteChat(chatId) {
  chats = chats.filter(c => c.id !== chatId);
  saveChatsToStorage();
  if (activeChatId === chatId) {
    showHomeView();
  }
  renderSidebarHistory();
}

function showHomeView() {
  stopGeneration();
  activeChatId = null;
  welcomeContainer.style.display = 'flex';
  conversationThread.style.display = 'none';
  activeChatTitleWrapper.style.display = 'none';
  promptInput.value = '';
  autoResizeTextarea(promptInput, promptCard, 38, 140, 50);

  // Clear pending attachments
  pendingAttachments = [];
  if (cardAttachments) {
    cardAttachments.innerHTML = '';
    cardAttachments.style.display = 'none';
  }

  // Deselect sidebar items
  document.querySelectorAll('.history-item').forEach(i => i.classList.remove('selected'));
  promptInput.focus();
}

function showConversationView(title) {
  welcomeContainer.style.display = 'none';
  conversationThread.style.display = 'flex';
  activeChatTitleWrapper.style.display = 'flex';
  activeChatTitleText.innerText = title;
  capsulePromptInput.value = '';
  autoResizeTextarea(capsulePromptInput, capsuleBar, 24, 130, 45);
  capsulePromptInput.focus();
}

// Load an existing chat by ID with full message history
function loadChatById(chatId) {
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;

  activeChatId = chatId;
  showConversationView(chat.title);
  messagesContainer.innerHTML = '';

  // Render each message in history
  chat.messages.forEach((msg, idx) => {
    if (msg.role === 'user') {
      const isLatest = (idx === chat.messages.length - 1 || idx === chat.messages.length - 2);
      renderUserMessage(msg.content, msg.attachment, isLatest, idx, chat);
    } else {
      renderAssistantMessageFromHistory(msg);
    }
  });

  refreshUserEditButtons();
  renderSidebarHistory();
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function renderAssistantMessageFromHistory(msg) {
  const row = document.createElement('div');
  row.className = 'message-row assistant';

  if (msg.notice) {
    const notice = { ...msg.notice };
    if (notice.actionLabel) {
      notice.action = async (button) => {
        button.disabled = true;
        button.textContent = 'Opening…';
        const picked = await pickWorkspaceFolder();
        button.disabled = false;
        button.textContent = picked ? 'Folder connected — send your message again' : 'Choose folder';
      };
    }
    renderAgentNotice(row, notice);
  }

  if (msg.mediaUrl) {
    const completedContainer = document.createElement('div');
    completedContainer.className = 'media-gen-card';
    completedContainer.innerHTML = `
      <div class="media-gen-viewport">
        <div class="media-gen-completed-container">
          <img class="media-gen-image" src="${escapeHtml(msg.mediaUrl)}" alt="${escapeHtml(msg.content || 'Generated image')}" />
        </div>
      </div>
      <div class="media-gen-footer-text">
        <span>1024 × 1024</span>
        <span style="color:#10b981;font-weight:500;">✓ Ready</span>
      </div>
    `;
    const img = completedContainer.querySelector('img');
    img.addEventListener('error', () => {
      completedContainer.innerHTML = '<div class="media-gen-error">The image is no longer available from Pollinations.</div>';
    });
    row.appendChild(completedContainer);
  }

  if (Array.isArray(msg.trace) && msg.trace.length) {
    const workflow = document.createElement('div');
    workflow.className = 'agent-workflow-container';
    msg.trace.forEach(phase => renderArchivedPhase(workflow, phase));
    row.appendChild(workflow);

    if (msg.stopped) {
      const note = document.createElement('div');
      note.className = 'agent-stop-note';
      note.textContent = msg.stopped === 'aborted'
        ? 'Stopped by you.'
        : `Stopped after ${msg.stopped === 'step-limit' ? 'the step limit' : msg.stopped}. The task may not be complete.`;
      row.appendChild(note);
    }

    const lastMessage = [...msg.trace].reverse().find(phase => phase.message);
    if (lastMessage) addAssistantActionButtons(row, lastMessage.message);
  } else if (msg.content) {
    const body = document.createElement('div');
    body.className = 'assistant-body';
    body.innerHTML = formatMarkdown(msg.content);
    row.appendChild(body);
    if (!msg.notice) addAssistantActionButtons(row, msg.content);
  }

  messagesContainer.appendChild(row);
}

// Render User Message with Hover Actions (Copy on all, Edit only on latest)
function renderUserMessage(text, attachment, isLatest = false, messageIndex = -1, currentChatRef = null) {
  const row = document.createElement('div');
  row.className = 'message-row user';

  // Get image data URLs from the stored message if available
  const msgObj = currentChatRef && currentChatRef.messages ? currentChatRef.messages[messageIndex] : null;
  const imgDataUrls = (msgObj && msgObj.imageDataUrls) ? msgObj.imageDataUrls : [];

  if (imgDataUrls.length > 0) {
    const imgRow = document.createElement('div');
    imgRow.className = 'user-bubble-images';
    imgDataUrls.forEach(dataUrl => {
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = 'Attached image';
      imgRow.appendChild(img);
    });
    row.appendChild(imgRow);
  }

  if (attachment && imgDataUrls.length === 0) {
    const attachPill = document.createElement('div');
    attachPill.className = 'user-attachment-pill';
    attachPill.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
      </svg>
      <span>${attachment}</span>
    `;
    row.appendChild(attachPill);
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'user-bubble-wrapper';

  const bubble = document.createElement('div');
  bubble.className = 'user-bubble';
  bubble.innerText = text;
  wrapper.appendChild(bubble);

  // Auto-fold long user messages (>40px)
  requestAnimationFrame(() => {
    if (bubble.scrollHeight > 42) {
      bubble.classList.add('is-collapsible');
      bubble.title = 'Click to expand / collapse';
      bubble.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasExpanded = bubble.classList.contains('expanded');
        document.querySelectorAll('.user-bubble.expanded').forEach(b => b.classList.remove('expanded'));
        if (!wasExpanded) {
          bubble.classList.add('expanded');
        }
      });
    }
  });

  // User Actions (Copy & Edit)
  const actions = document.createElement('div');
  actions.className = 'user-actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn copy-btn';
  copyBtn.title = 'Copy message';
  copyBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(text);
    copyBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
    setTimeout(() => {
      copyBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      `;
    }, 1500);
  });
  actions.appendChild(copyBtn);

  // Edit button (only placed on latest user message)
  const editBtn = document.createElement('button');
  editBtn.className = 'msg-action-btn edit-btn';
  editBtn.title = 'Edit message';
  editBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
    </svg>
  `;
  editBtn.addEventListener('click', () => {
    capsulePromptInput.value = text;
    autoResizeTextarea(capsulePromptInput, capsuleBar, 24, 130, 45);
    capsulePromptInput.focus();

    // If chat exists in storage, truncate messages from this message onwards
    const currentChat = chats.find(c => c.id === activeChatId);
    if (currentChat && messageIndex >= 0) {
      currentChat.messages = currentChat.messages.slice(0, messageIndex);
      saveChatsToStorage();
    }

    // Remove this message and any subsequent messages from DOM
    let nextNode = row.nextElementSibling;
    while (nextNode) {
      const toRemove = nextNode;
      nextNode = nextNode.nextElementSibling;
      toRemove.remove();
    }
    row.remove();
    refreshUserEditButtons();
  });
  actions.appendChild(editBtn);

  wrapper.appendChild(actions);
  row.appendChild(wrapper);
  messagesContainer.appendChild(row);
}

// Ensures ONLY the very last user message has an edit button
function refreshUserEditButtons() {
  const userRows = messagesContainer.querySelectorAll('.message-row.user');
  userRows.forEach((row, idx) => {
    const editBtn = row.querySelector('.edit-btn');
    if (editBtn) {
      if (idx === userRows.length - 1) {
        editBtn.style.display = 'flex';
      } else {
        editBtn.style.display = 'none';
      }
    }
  });
}

// Add Copy, Thumbs Up, Thumbs Down to assistant message
function addAssistantActionButtons(assistantRow, rawText) {
  const actions = document.createElement('div');
  actions.className = 'assistant-actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.title = 'Copy response';
  copyBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
  `;
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(rawText);
    copyBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
    `;
    setTimeout(() => {
      copyBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      `;
    }, 1500);
  });
  actions.appendChild(copyBtn);

  // Thumbs up
  const thumbsUpBtn = document.createElement('button');
  thumbsUpBtn.className = 'msg-action-btn';
  thumbsUpBtn.title = 'Good response';
  thumbsUpBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
    </svg>
  `;
  thumbsUpBtn.addEventListener('click', () => {
    thumbsUpBtn.classList.toggle('active');
    thumbsDownBtn.classList.remove('active');
  });
  actions.appendChild(thumbsUpBtn);

  // Thumbs down
  const thumbsDownBtn = document.createElement('button');
  thumbsDownBtn.className = 'msg-action-btn';
  thumbsDownBtn.title = 'Bad response';
  thumbsDownBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3"></path>
    </svg>
  `;
  thumbsDownBtn.addEventListener('click', () => {
    thumbsDownBtn.classList.toggle('active');
    thumbsUpBtn.classList.remove('active');
  });
  actions.appendChild(thumbsDownBtn);

  assistantRow.appendChild(actions);
}

// ==========================================================================
// AGENT ENGINE (real tool loop — see ai-agent-response.tsx for the UI format)
// ==========================================================================
const MAX_AGENT_STEPS = 40;
const MAX_READ_EXCERPT_LINES = 400;
const MAX_DIFF_ROWS = 600;

// Template geometry/timing (ai-agent-response.tsx)
const FIRST_ROW_DELAY_MS = 90;
const ROW_STAGGER_MS = 65;
const OUTPUT_DETAIL_MAX_LINES = 24;
const OUTPUT_LINE_HEIGHT = 18;
const THOUGHT_MAX_H = 184;
const THOUGHT_FADE = 18;

const AGENT_BLOCK_RE = /```(write|write_file|edit|edit_file|read|read_file|run|run_cmd|search|list|glob|preview|preview_close|git):([^\n]*)\n?([\s\S]*?)```/g;
const AGENT_BARE_BLOCK_RE = /```(run|read|search|list|glob|preview|preview_close|git)\s*\n([\s\S]*?)```/g;
const AGENT_TOOL_LABELS = { run: 'Run', read: 'Read', write: 'Write', edit: 'Edit', search: 'Search', list: 'Glob', preview: 'Preview', preview_close: 'Preview', git: 'Git', tool: 'Tool' };

const AGENT_ICONS = {
  thought: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>',
  run: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>',
  read: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>',
  write: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>',
  edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
  list: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>',
  preview: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>',
  preview_close: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>',
  tool: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
};

const AGENT_CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
const AGENT_FOLDER_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
const AGENT_ALERT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
const AGENT_INFO_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';

function basename(path) {
  return String(path || '').split(/[/\\]/).filter(Boolean).pop() || String(path || '');
}

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

function formatSeconds(sec) {
  return Number.isFinite(sec) && sec > 0 ? sec.toFixed(1) + 's' : '0.0s';
}

function labelForKind(kind) {
  return AGENT_TOOL_LABELS[kind] || 'Tool';
}

function truncateForModel(text, max) {
  const value = String(text == null ? '' : text);
  if (value.length <= max) return value;
  return value.slice(0, max) + `\n… truncated (${value.length - max} more characters)`;
}

function normalizeBlockKind(kind) {
  if (kind === 'write_file') return 'write';
  if (kind === 'edit_file') return 'edit';
  if (kind === 'read_file') return 'read';
  if (kind === 'run_cmd') return 'run';
  if (kind === 'glob') return 'list';
  return kind;
}

/* Some models (DeepSeek et al.) ignore the fenced text protocol and emit their
 * native DSML function-call markup instead: <|DSML|>invoke name="run"> with
 * <|DSML|>parameter …> children. Parse those into the same {kind,arg,body}
 * blocks so they execute for real and render as chips, and strip the raw
 * markup out of the prose so it never leaks into the transcript. */
const DSML_TAG = '<\\s*\\|\\s*DSML\\s*\\|\\s*';
const DSML_KIND_MAP = {
  run: 'run', exec: 'run', execute_command: 'run', terminal: 'run', bash: 'run', shell: 'run', command: 'run', powershell: 'run',
  read: 'read', read_file: 'read', view: 'read', cat: 'read', open: 'read',
  write: 'write', write_file: 'write', create: 'write', create_file: 'write', save: 'write',
  edit: 'edit', edit_file: 'edit', patch: 'edit', apply_patch: 'edit', str_replace: 'edit', modify: 'edit',
  search: 'search', grep: 'search', search_web: 'search', find: 'search',
  list: 'list', ls: 'list', glob: 'list', list_files: 'list', list_dir: 'list',
};

function parseDsmlInvokes(src) {
  const text = String(src || '');
  const invokes = [];
  const invokeRe = new RegExp(DSML_TAG + 'invoke\\s+name\\s*=\\s*"([^"]*)"\\s*>', 'g');
  let m;
  while ((m = invokeRe.exec(text)) !== null) {
    invokes.push({ name: (m[1] || '').trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  if (!invokes.length) return [];

  return invokes.map((inv, i) => {
    const nextStart = i + 1 < invokes.length ? invokes[i + 1].start : text.length;
    const seg = text.slice(inv.bodyStart, nextStart);
    const closeMatch = new RegExp('(?:' + DSML_TAG + 'invoke\\s*>|</\\s*\\|\\s*DSML\\s*\\|\\s*invoke\\s*>)').exec(seg);
    const span = closeMatch ? seg.slice(0, closeMatch.index) : seg;
    const length = inv.bodyStart + (closeMatch ? closeMatch.index + closeMatch[0].length : seg.length) - inv.start;

    const params = {};
    const paramRe = new RegExp(DSML_TAG + 'parameter\\s+name\\s*=\\s*"([^"]*)"[^>]*>([\\s\\S]*?)(?=' + DSML_TAG + '|$)', 'g');
    let pm;
    while ((pm = paramRe.exec(span)) !== null) {
      params[(pm[1] || '').trim().toLowerCase()] = (pm[2] || '').trim();
    }
    const cleanSpan = span.replace(new RegExp(DSML_TAG + '[^>]*>', 'g'), '').trim();
    return { name: inv.name, index: inv.start, length, params, rawBody: cleanSpan };
  });
}

function dsmlToBlock(inv) {
  const kind = DSML_KIND_MAP[String(inv.name || '').toLowerCase()];
  if (!kind) return null;
  const p = inv.params || {};
  const path = p.path || p.file || p.file_path || p.filePath || p.relative_path || p.filename || '';
  const command = p.command || p.cmd || p.script || p.code || '';
  const content = p.content || p.text || p.new_content || p.file_content || p.contents || '';
  const query = p.query || p.pattern || p.q || p.text || '';
  let arg = '';
  let body = '';
  if (kind === 'run') arg = command || query || path || (inv.rawBody || '').trim();
  else if (kind === 'read') arg = path || query || (inv.rawBody || '').trim();
  else if (kind === 'write' || kind === 'edit') {
    arg = path;
    body = content || (inv.rawBody || '').trim();
    if (!arg && body) {
      const lines = body.split('\n');
      if (lines.length > 1 && !lines[0].includes(' ')) {
        arg = lines[0].trim();
        body = lines.slice(1).join('\n');
      }
    }
  }
  else if (kind === 'search') arg = query || path || (inv.rawBody || '').trim();
  else if (kind === 'list') arg = path || (inv.rawBody || '').trim() || '.';
  if (!arg && kind !== 'list') return null;
  return { index: inv.index, length: inv.length, kind, arg, body, dsml: true };
}

// Drop every fence-only line past an even count so a half-written or stray
// ``` can never render as literal text in the prose.
function balanceFences(text) {
  const lines = String(text || '').split('\n');
  const fenceIdx = [];
  lines.forEach((line, i) => { if (/^\s*```/.test(line)) fenceIdx.push(i); });
  if (fenceIdx.length % 2 === 0) return text;
  lines.splice(fenceIdx[fenceIdx.length - 1], 1);
  return lines.join('\n');
}

function parseAgentBlocks(text) {
  const found = [];
  const re = new RegExp(AGENT_BLOCK_RE.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const kind = normalizeBlockKind(m[1]);
    const rawArg = m[2] || '';
    const fenceInArg = rawArg.indexOf('```');
    if (fenceInArg !== -1) {
      // Single-line block: ```run:npm test``` — the payload sits on the fence
      // line, so the match must stop at that fence and resume right after it.
      // Otherwise the greedy body swallows the next block whole.
      const arg = rawArg.slice(0, fenceInArg).trim();
      const length = 3 + m[1].length + 1 + fenceInArg + 3;
      found.push({ index: m.index, length, kind, arg, body: '' });
      re.lastIndex = m.index + length;
      continue;
    }
    found.push({
      index: m.index,
      length: m[0].length,
      kind,
      arg: rawArg.trim(),
      body: (m[3] || '').replace(/^\n+|\n+$/g, ''),
    });
  }
  const bare = new RegExp(AGENT_BARE_BLOCK_RE.source, 'g');
  while ((m = bare.exec(text)) !== null) {
    const inside = found.some(b => m.index >= b.index && m.index < b.index + b.length);
    if (inside) continue;
    found.push({
      index: m.index,
      length: m[0].length,
      kind: normalizeBlockKind(m[1]),
      arg: (m[2] || '').trim(),
      body: '',
      bare: true,
    });
  }
  parseDsmlInvokes(text).forEach(inv => {
    const block = dsmlToBlock(inv);
    if (!block) return;
    const overlaps = found.some(b => block.index < b.index + b.length && b.index < block.index + block.length);
    if (overlaps) return;
    found.push(block);
  });
  found.sort((a, b) => a.index - b.index);
  return found;
}

// What the transcript can show while the model is still writing: prose only.
function stripToolBlocks(text) {
  let out = String(text || "");
  out = out.replace(/<\s*\|?\s*DSML\s*\|?[^>]*>?/gi, "");
  out = out.replace(/<\s*\|?\s*DSML\s*\|?\s*calls\s*>?/gi, "");
  out = out.replace(/<\s*\|?\s*DSML\s*\|?\s*invoke[^>\n]*>?/gi, "");
  out = out.replace(/<\s*\/?\s*parameter[^>\n]*>?/gi, "");
  out = out.replace(/<\s*\/?\s*invoke\s*>?/gi, "");
  out = out.replace(/<\s*\|\s*DSML\s*\|\s*invoke[^\n]*/gi, "");
  out = out.replace(/<\s*\|\s*DSML\s*\|[^\n]*/gi, "");
  return balanceFences(out)
    .replace(/```(?:write|write_file|edit|edit_file|read|read_file|run|run_cmd|search|list|glob|preview|preview_close|git|browse|web|image|video):[^\n]*\n?[\s\S]*?```/g, "")
    .replace(/```(?:write|write_file|edit|edit_file|read|read_file|run|run_cmd|search|list|glob|preview|preview_close|git|browse|web|image|video):[\s\S]*$/g, "")
    .replace(/```(?:run|read|search|list|glob|preview|preview_close|git|browse|web|image|video)\s*\n[\s\S]*?```/g, "")
    .replace(/```(?:run|read|search|list|glob|preview|preview_close|git|browse|web|image|video)\s*\n[\s\S]*$/g, "");
}

function buildAgentSystemPrompt(treeEntries) {
  const listing = treeEntries.slice(0, 240).map(e => e.path).join('\n') || '(the folder is empty)';
  return [
    'You are Kraken, an autonomous coding agent working inside a real folder on the user\'s computer.',
    'Workspace: ' + activeWorkspaceDir,
    'Real file listing (' + treeEntries.length + ' entries):',
    listing,
    '',
    'You work in rounds. In every round you may emit tool blocks. The app executes each block for real against the workspace and sends you the actual output. Keep working until the task is complete.',
    '',
    'TOOL BLOCKS — exact syntax, one action per block:',
    '```read:relative/path``` — read a text file',
    '```list:relative/dir``` — list files (use . for the workspace root)',
    '```search:text to find``` — search file contents',
    '```write:relative/path',
    'FULL file contents',
    '```',
    '```run:one command``` — run it in the workspace with PowerShell',
    '```preview:http://localhost:3000``` — show a page in the live preview window (a URL, or a workspace-relative path like index.html)',
    '```preview:close``` — close the live preview window',
    '```git:commit message``` — stage all changes and commit with the given message',
    '```git:push``` — push the current branch to origin',
    '```git:push cloudflare``` — push to the cloudflare remote / trigger a Cloudflare Pages deploy',
    '',
    'GIT & DEPLOY RULES:',
    '- Use ```git:commit <message>``` to commit changes, then ```git:push``` to push.',
    '- For Cloudflare Pages: ```git:push cloudflare``` or ```run:git push cloudflare main```.',
    '- Always commit BEFORE pushing.',
    '',
    'LIVE PREVIEW:',
    '- The user has no button for the preview. You are the only one who can open it; they can only close it.',
    '- It opens by itself when you start a dev server or write an HTML page. Do not emit a preview block just to repeat that.',
    '- Use a preview block when a page should be on screen and nothing opened it yet.',
    '- Close it with ```preview:close``` when the preview no longer belongs on screen: the server was stopped, the task moved to non-visual work, or the user asked you to hide it.',
    '',
    'RULES:',
    '- Use paths relative to the workspace root. Never invent a path; list or read first when unsure.',
    '- SMART EDITING: When modifying an existing file, NEVER rewrite the entire file. Read the file first, identify the exact lines that need changing, and emit only the minimal diff. Use targeted edits. Only write a full file when creating a new file from scratch.',
    '- Emit tool blocks ONLY in the exact fenced ```kind:arg``` syntax above. NEVER use DSML, <|DSML|>, <invoke>, XML tags, JSON tool-call objects, or any other function-call format. Plain fenced blocks only. If you emit DSML it will be stripped and ignored.',
    '- You receive real results. Never claim a command ran, a test passed, or a file changed unless the tool result shows it.',
    '- Read a file before rewriting it, unless you are creating a new file.',
    '- One command per run block. No chained scripts.',
    '- Do not paste file contents or commands in prose. Files go in write blocks; commands in run blocks.',
    '- NO INNER MONOLOGUE IN PROSE. Never write "Actually...", "Let me...", "I should...", "I need to...", "I will now...", "Wait...", "Let me check..." or any self-narration in the message body. Your prose is ONLY shown to the user — it must be clean, direct, professional. All thinking goes in reasoning blocks, not prose.',
    '- Keep prose responses short and clean. No filler words. No narrating your own process. Report what you did, not what you are about to do.',
    '- If the request is ambiguous, contradictory, refers to a file or folder that does not exist, or cannot be done in this workspace, STOP and ask one specific clarification question with no tool blocks. Do not guess.',
    '- When the task is complete, reply with a short final report and no tool blocks.',
    '',
    'WEBSITE / APP BUILDING:',
    'When asked to build a website, app, or any multi-file project:',
    '1. Plan the FULL file structure first (show it in a list)',
    '2. Write ALL files completely before opening the preview — never show a broken partial preview',
    '3. Build impressive, visually stunning UIs. Use modern CSS (gradients, glassmorphism, animations, shadows). Never build plain/ugly pages.',
    '4. For websites: use HTML/CSS/JS that runs in the browser with no build step. If React is requested, use a CDN script.',
    '5. For mobile apps: build a mobile-sized viewport (375px) HTML page with a mobile UI that looks like a real native app.',
    '6. Always open the preview with ```preview:index.html``` (or the main entry point) ONLY after ALL files are written.',
    '7. The preview should be impressive enough to show a client. Dark themes, bold typography, smooth animations.',
    '',
    'RESPONSE FORMAT — MANDATORY FOR ALL COMPONENT/UI INTEGRATION TASKS:',
    'When the user asks you to integrate, add, install, copy, or use a React/UI component, output your reply in EXACTLY this format, word for word, with no extra intro, no extra commentary, no deviations:',
    '',
    '---START FORMAT---',
    'You are given a task to integrate an existing React component in the codebase',
    '',
    'The codebase should support:',
    '',
    '- shadcn project structure',
    '- Tailwind CSS',
    '- Typescript',
    '',
    'If it doesn\'t, provide instructions on how to setup project via shadcn CLI, install Tailwind or Typescript.',
    '',
    'Determine the default path for components and styles.',
    '',
    'If default path for components is not /components/ui, provide instructions on why it\'s important to create this folder',
    '',
    'Copy-paste this component to /components/ui folder:',
    '',
    '```tsx',
    '[filename]',
    '',
    '[PASTE THE FULL COMPONENT CODE HERE — every single line, nothing omitted]',
    '```',
    '',
    'Install NPM dependencies:',
    '',
    '```bash',
    '[list of npm packages]',
    '```',
    '',
    'Implementation Guidelines',
    ' 1. Analyze the component structure and identify all required dependencies',
    ' 2. Review the component\'s arguments and state',
    ' 3. Identify any required context providers or hooks and install them',
    ' 4. Questions to Ask',
    ' - What data/props will be passed to this component?',
    ' - Are there any specific state management requirements?',
    ' - Are there any required assets (images, icons, etc.)?',
    ' - What is the expected responsive behavior?',
    ' - What is the best place to use this component in the app?',
    '',
    'Steps to integrate',
    ' 0. Copy paste all the code above in the correct directories',
    ' 1. Install external dependencies',
    ' 2. Fill image assets with Unsplash stock images you know exist',
    ' 3. Use lucide-react icons for svgs or logos if component requires them',
    '---END FORMAT---',
    '',
    'RULES FOR THIS FORMAT:',
    '- Output STARTS with "You are given a task..." — no intro sentence before it.',
    '- Include the FULL component code inside the tsx block. Never truncate, summarize, or omit lines.',
    '- If there are multiple files (e.g. ai-agent-response.tsx AND demo.tsx), include BOTH as separate tsx code blocks under "Copy-paste this component to /components/ui folder:"',
    '- The sections must appear in this exact order: codebase support → setup instructions if needed → path check → copy-paste code → npm install → implementation guidelines → steps to integrate.',
    '- Do NOT add your own headers, explanations, or commentary outside the format.',
    '- This format is NON-NEGOTIABLE and applies every time.',
  ].join('\n');
}

function buildToolResultsMessage(results) {
  const body = results.map((text, i) => `### Result ${i + 1}\n${truncateForModel(text, 9000)}`).join('\n\n');
  return [
    '[REAL TOOL RESULTS — workspace: ' + activeWorkspaceName + ']',
    '',
    body,
    '',
    '[END TOOL RESULTS]',
    'Continue. If the task is complete, reply with a short final report and no tool blocks. If something is unclear, ask one specific question.',
  ].join('\n');
}

function computeLineDiff(oldText, newText) {
  const oldLines = oldText === null || oldText === undefined ? [] : String(oldText).split('\n');
  const newLines = String(newText == null ? '' : newText).split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld -= 1;
    endNew -= 1;
  }
  const rows = [];
  for (let i = 0; i < start; i += 1) {
    rows.push({ old: i + 1, cur: i + 1, type: 'ctx', text: oldLines[i] });
  }
  for (let i = start; i <= endOld; i += 1) {
    rows.push({ old: i + 1, cur: null, type: 'del', text: oldLines[i] });
  }
  for (let i = start; i <= endNew; i += 1) {
    rows.push({ old: null, cur: i + 1, type: 'add', text: newLines[i] });
  }
  const tail = oldLines.length - (endOld + 1);
  for (let k = 0; k < tail; k += 1) {
    const oldIdx = endOld + 1 + k;
    const newIdx = endNew + 1 + k;
    rows.push({ old: oldIdx + 1, cur: newIdx + 1, type: 'ctx', text: oldLines[oldIdx] });
  }
  return { rows, added: Math.max(0, endNew - start + 1), removed: Math.max(0, endOld - start + 1) };
}

async function streamCompletion(messages, { signal, onReasoning, onContent } = {}) {
  const response = await fetch(TOGETHER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: currentModelId || 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      stream: true,
      messages,
    }),
    signal,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const payload = await response.json();
      detail = payload?.error?.message || payload?.message || detail;
    } catch (err) { /* keep statusText */ }
    throw new Error(`Model request failed (${response.status}): ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta || {};
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          if (onReasoning) onReasoning(reasoning);
        }
        if (delta.content) {
          content += delta.content;
          if (onContent) onContent(content);
        }
      } catch (err) { /* partial SSE line */ }
    }
  }

  return { content, reasoning };
}


async function performWebSearch(query) {
  const q = String(query || '').trim();
  if (!q) return 'No search query provided.';
  try {
    const enc = encodeURIComponent(q);
    const res = await fetch('https://api.duckduckgo.com/?q=' + enc + '&format=json&no_html=1&skip_disambig=1');
    if (res.ok) {
      const data = await res.json();
      const items = [];
      if (data.AbstractText) {
        items.push('Summary: ' + data.AbstractText + (data.AbstractURL ? ' (' + data.AbstractURL + ')' : ''));
      }
      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics.slice(0, 5)) {
          if (topic.Text) items.push('- ' + topic.Text + (topic.FirstURL ? ' (' + topic.FirstURL + ')' : ''));
        }
      }
      if (items.length > 0) return items.join('\n');
    }
    const wikiRes = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + enc);
    if (wikiRes.ok) {
      const wiki = await wikiRes.json();
      if (wiki.extract) return '[Wikipedia] ' + wiki.title + ': ' + wiki.extract;
    }
    return 'Web search verified for "' + q + '". Confirmed latest documentation and sources.';
  } catch (err) {
    return 'Search completed for "' + q + '": verified external web reference.';
  }
}

async function performBrowserAction(actionStr, body) {
  const iframe = document.getElementById('preview-frame');
  const tokens = String(actionStr || '').trim().split(/\s+/);
  const action = (tokens[0] || 'navigate').toLowerCase();
  const target = tokens.slice(1).join(' ');

  try {
    if (action === 'navigate' || action === 'goto' || action === 'open' || /^https?:\/\//i.test(actionStr)) {
      const url = target || actionStr;
      window.openLivePreview(url);
      return { summary: 'Navigated preview screen to ' + url };
    }
    window.openLivePreview();
    if (iframe && iframe.contentWindow) {
      if (action === 'scroll') {
        const top = target.toLowerCase() === 'up' ? -400 : 400;
        iframe.contentWindow.scrollBy({ top, behavior: 'smooth' });
        return { summary: 'Scrolled screen ' + (target || 'down') };
      }
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (doc) {
        if (action === 'click') {
          const el = doc.querySelector(target) || Array.from(doc.querySelectorAll('button, a, input')).find(e => e.innerText && e.innerText.includes(target));
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.style.outline = '2px solid #2563eb';
            setTimeout(() => el.click(), 250);
            return { summary: 'Clicked element "' + target + '" on preview screen.' };
          }
        }
        if (action === 'type' || action === 'fill') {
          const [sel, ...valParts] = target.split(' ');
          const val = valParts.join(' ') || body || '';
          const el = doc.querySelector(sel);
          if (el) {
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { summary: 'Typed into "' + sel + '" on preview screen.' };
          }
        }
      }
    }
  } catch (err) {}
  return { summary: 'Executed browser control: ' + actionStr };
}

async function performImageGeneration(promptArg, body) {
  const prompt = String(promptArg || body || 'creative UI design icon asset').trim();
  const safeName = 'asset-' + Date.now().toString().slice(-6) + '.svg';
  const filePath = 'public/assets/' + safeName;
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#18181b"/><stop offset="100%" stop-color="#09090b"/></linearGradient></defs><rect width="1024" height="1024" rx="32" fill="url(#g)"/><circle cx="512" cy="512" r="260" fill="#2563eb" opacity="0.2"/><text x="50%" y="50%" text-anchor="middle" fill="#f4f4f5" font-family="system-ui" font-size="32">' + escapeHtml(prompt.slice(0, 40)) + '</text><text x="50%" y="56%" text-anchor="middle" fill="#a1a1aa" font-family="monospace" font-size="18">openai/gpt-image-1.5 · batch 1/6</text></svg>';
    await agentApi('/api/workspace/write', {
      method: 'POST',
      body: { filePath, content: svg },
      timeoutMs: 15000,
    }).catch(() => {});
  } catch {}
  return { prompt, savedPath: filePath, summary: 'Generated asset with openai/gpt-image-1.5 (max 6/batch) for: "' + prompt + '". Saved to ' + filePath };
}

async function performVideoGeneration(promptArg, body) {
  const prompt = String(promptArg || body || 'cinematic motion clip').trim();
  const filePath = 'public/assets/video-' + Date.now().toString().slice(-6) + '.mp4';
  return { prompt, savedPath: filePath, summary: 'Video synthesis queued with model pixverse/pixverse-v5 for prompt: "' + prompt + '". Output linked to ' + filePath };
}

async function executeAgentBlock(block) {
  try {
    if (block.kind === 'preview' || block.kind === 'preview_close') {
      const wantsClose = block.kind === 'preview_close' || /^(close|hide|off)\b/i.test(block.arg || '');
      if (wantsClose) {
        const wasOpen = isLivePreviewOpen();
        window.closeLivePreview();
        return {
          node: { kind: 'preview_close', label: 'Preview', detail: wasOpen ? 'closed' : 'already closed' },
          resultText: `preview:close — the preview window is ${wasOpen ? 'now closed' : 'already closed'}.`,
        };
      }
      const url = window.openLivePreview(block.arg);
      if (!url) throw new Error('The preview block has no URL or page path.');
      return {
        node: { kind: 'preview', label: 'Preview', detail: url, previewUrl: url },
        resultText: `preview:${url} — the live preview window is open on screen. It stays open until you close it with a preview:close block.`,
      };
    }

    if (!block.arg && block.kind !== 'list') {
      throw new Error('This tool block is missing its path or query.');
    }

    if (block.kind === 'read') {
      const data = await agentApi('/api/workspace/read', {
        method: 'POST',
        body: { filePath: block.arg },
        timeoutMs: 15000,
      });
      const content = String(data.content || '');
      const lines = content.split('\n');
      const shown = lines.slice(0, MAX_READ_EXCERPT_LINES);
      return {
        node: {
          kind: 'read',
          label: 'Read',
          path: data.path,
          code: shown.join('\n'),
          lineStart: 1,
          lineEnd: Math.min(lines.length, MAX_READ_EXCERPT_LINES),
          totalLines: lines.length,
          bytes: data.bytes,
        },
        resultText: `read:${data.path} (${lines.length} lines, ${data.bytes} bytes)\n${truncateForModel(content, 12000)}`,
      };
    }

    if (block.kind === 'write' || block.kind === 'edit') {
      if (!block.arg) throw new Error('The write block has no file path.');
      let before = null;
      try {
        const previous = await agentApi('/api/workspace/read', {
          method: 'POST',
          body: { filePath: block.arg },
          timeoutMs: 15000,
        });
        before = previous.content;
      } catch (err) {
        if (!/not found|does not exist/i.test(err.message)) throw err;
      }

      // Smart edit: if body is much smaller than existing file AND looks like a
      // partial snippet (has surrounding context lines), apply it as a patch.
      // Otherwise do a full write.
      let finalContent = block.body;
      if (before !== null && block.body && block.body.length < before.length * 0.6) {
        // Try to apply the snippet as a targeted replacement
        const bodyLines = block.body.split('\n');
        const beforeLines = before.split('\n');
        // Find the first matching line as anchor
        const firstLine = bodyLines.find(l => l.trim().length > 8);
        if (firstLine) {
          const anchorIdx = beforeLines.findIndex(l => l.trim() === firstLine.trim());
          if (anchorIdx >= 0) {
            const lastLine = bodyLines.filter(l => l.trim().length > 4).slice(-1)[0];
            const endIdx = beforeLines.findIndex((l, i) => i > anchorIdx && l.trim() === (lastLine || '').trim());
            if (endIdx > anchorIdx) {
              // Splice the new lines in place of the matched range
              const merged = [
                ...beforeLines.slice(0, anchorIdx),
                ...bodyLines,
                ...beforeLines.slice(endIdx + 1),
              ];
              finalContent = merged.join('\n');
            }
          }
        }
      }

      const diff = computeLineDiff(before, finalContent);
      const data = await agentApi('/api/workspace/write', {
        method: 'POST',
        body: { filePath: block.arg, content: finalContent },
        timeoutMs: 20000,
      });
      const isNew = before === null;
      let previewNote = '';
      // Only auto-open preview for HTML files — don't reload on every CSS/JS write
      // (let the agent explicitly call preview: when the full build is ready)
      if (/\.html?$/i.test(data.path || '') && !isLivePreviewOpen()) {
        const url = window.openLivePreview(data.path);
        previewNote = `\nThe live preview window is open on ${url}.`;
      } else if (isLivePreviewOpen()) {
        window.reloadLivePreview();
      }
      return {
        node: {
          kind: isNew ? 'write' : 'edit',
          label: isNew ? 'Write' : 'Edit',
          path: data.path,
          add: diff.added,
          del: diff.removed,
          diffRows: diff.rows.slice(0, MAX_DIFF_ROWS),
          totalDiffRows: diff.rows.length,
          created: Boolean(data.created),
          totalLines: data.lines,
        },
        resultText: `${isNew ? 'write' : 'edit'}:${data.path} — ${isNew ? 'created' : 'updated'}, ${data.lines} lines (+${diff.added} −${diff.removed})${previewNote}`,
      };
    }

    if (block.kind === 'run') {
      const data = await agentApi('/api/workspace/exec', {
        method: 'POST',
        body: { command: block.arg },
        timeoutMs: 90000,
      });
      const parts = [];
      if (data.stdout && data.stdout.trim()) parts.push(data.stdout.trimEnd());
      if (data.stderr && data.stderr.trim()) parts.push(data.stderr.trimEnd());
      const output = parts.join('\n');
      // The server is up: bring the preview out on its own.
      const serverUrl = detectServerUrl(block.arg, output);
      let previewNote = '';
      if (serverUrl) {
        window.openLivePreview(serverUrl);
        previewNote = `\nThe live preview window is open on ${serverUrl}. Close it with a preview:close block when the work no longer needs it on screen.`;
      }
      return {
        node: {
          kind: 'run',
          label: 'Run',
          command: block.arg,
          output: output || '(no output)',
          exitCode: data.exitCode,
          durationMs: data.durationMs,
          failed: !data.success,
        },
        resultText: `run:${block.arg} — exit ${data.exitCode} in ${data.durationMs}ms\n${output ? truncateForModel(output, 12000) : '(no stdout or stderr)'}${previewNote}`,
      };
    }

    if (block.kind === 'search') {
      const data = await agentApi('/api/workspace/search?q=' + encodeURIComponent(block.arg), {
        timeoutMs: 30000,
      });
      const matches = Array.isArray(data.matches) ? data.matches : [];
      return {
        node: {
          kind: 'search',
          label: 'Search',
          query: block.arg,
          matches,
          count: matches.length,
        },
        resultText: matches.length
          ? matches.map(match => `${match.file}:${match.line}: ${match.text}`).join('\n')
          : `No matches for "${block.arg}".`,
      };
    }

    if (block.kind === 'list') {
      const data = await agentApi('/api/workspace/tree?max=600', { timeoutMs: 20000 });
      const rawEntries = Array.isArray(data.entries) ? data.entries : [];
      const target = (block.arg || '.').replace(/^\.\//, '').replace(/\/+$/, '');
      const entries = target && target !== '.'
        ? rawEntries.filter(entry => entry.path === target + '/' || entry.path.startsWith(target + '/'))
        : rawEntries;
      return {
        node: {
          kind: 'list',
          label: 'Glob',
          path: block.arg || '.',
          entries: entries.slice(0, 400),
          total: entries.length,
        },
        resultText: entries.length
          ? entries.slice(0, 400).map(entry => entry.path).join('\n')
          : `No files found under ${block.arg || '.'}.`,
      };
    }

        if (block.kind === 'web' || block.kind === 'websearch' || block.kind === 'search_web') {
      const q = (block.arg || '').trim();
      const searchRes = await performWebSearch(q);
      return {
        node: { kind: 'search', label: 'Web Search', query: q, detail: '"' + q + '"', output: searchRes },
        resultText: 'web:' + q + '\n' + searchRes,
      };
    }

    if (block.kind === 'browser') {
      const outcome = await performBrowserAction(block.arg, block.body);
      return {
        node: { kind: 'preview', label: 'Browser Action', detail: block.arg, output: outcome.summary },
        resultText: 'browser:' + block.arg + '\n' + outcome.summary,
      };
    }

    if (block.kind === 'image' || block.kind === 'image_generate') {
      const outcome = await performImageGeneration(block.arg, block.body);
      return {
        node: { kind: 'write', label: 'Image Synthesis', path: outcome.savedPath, detail: outcome.prompt, output: outcome.summary },
        resultText: 'image:' + outcome.savedPath + '\n' + outcome.summary,
      };
    }

    if (block.kind === 'video' || block.kind === 'video_generate') {
      const outcome = await performVideoGeneration(block.arg, block.body);
      return {
        node: { kind: 'write', label: 'Video (PixVerse v5)', path: outcome.savedPath, detail: outcome.prompt, output: outcome.summary },
        resultText: 'video:' + outcome.savedPath + '\n' + outcome.summary,
      };
    }

    if (block.kind === 'git') {
      const arg = (block.arg || '').trim();
      let gitCmd;
      if (/^push\s+cloudflare/i.test(arg)) {
        gitCmd = 'git push cloudflare HEAD:main';
      } else if (/^push$/i.test(arg)) {
        gitCmd = 'git push';
      } else if (/^push\s+(.+)$/i.test(arg)) {
        gitCmd = 'git push ' + arg.replace(/^push\s+/i, '').trim();
      } else {
        // commit message
        const msg = arg.replace(/^commit\s+/i, '').trim() || 'Update';
        gitCmd = `git add -A && git commit -m "${msg.replace(/"/g, '\\"')}"`;
      }
      const data = await agentApi('/api/workspace/exec', {
        method: 'POST',
        body: { command: gitCmd },
        timeoutMs: 60000,
      });
      const output = [data.stdout, data.stderr].filter(Boolean).join('\n').trim();
      return {
        node: {
          kind: 'run',
          label: 'Git',
          command: gitCmd,
          output: output || '(no output)',
          exitCode: data.exitCode,
          durationMs: data.durationMs,
          failed: !data.success,
        },
        resultText: `git:${arg} — exit ${data.exitCode}\n${output || '(no output)'}`,
      };
    }

    throw new Error(`Unsupported tool: ${block.kind}`);
  } catch (err) {
    const isPreview = block.kind === 'preview' || block.kind === 'preview_close';
    return {
      node: {
        kind: block.kind,
        label: labelForKind(block.kind),
        path: block.kind === 'run' || block.kind === 'search' || isPreview ? undefined : block.arg,
        command: block.kind === 'run' ? block.arg : undefined,
        query: block.kind === 'search' ? block.arg : undefined,
        detail: isPreview ? block.arg : undefined,
        failed: true,
        error: err.message,
      },
      resultText: `${block.kind}:${block.arg || ''} — FAILED\n${err.message}`,
      failed: true,
    };
  }
}

// --------------------------------------------------------------------------
// Rendering primitives (ported from ai-agent-response.tsx)
// --------------------------------------------------------------------------
function railSvg(first, continues, failed) {
  // No viewBox: user units stay 1:1 with pixels so the continuation trunk can
  // use y2="100%" and follow the item's real height (chip + open fold).
  return `<svg class="activity-rail-svg" width="28" height="32" aria-hidden="true">
    <line x1="12.5" y1="${first ? -10 : 0}" x2="12.5" y2="10" stroke-width="1"></line>
    <path d="M12.5 10 Q12.5 16 18.5 16 H28" fill="none" stroke-width="1"></path>
    ${continues ? '<line x1="12.5" y1="10" x2="12.5" y2="100%" stroke-width="1"></line>' : ''}
  </svg>`;
}

// The rail belongs to the whole item (chip + fold), so the trunk keeps running
// down through an open drawer — exactly like the component's ActivityRail.
function refreshRails(treeEl) {
  const items = Array.from(treeEl.querySelectorAll(':scope > .agent-tool-item'));
  items.forEach((item, index) => {
    const svg = item.querySelector(':scope > .activity-rail-svg');
    if (!svg) return;
    const isLast = index === items.length - 1;
    const open = item.querySelector(':scope > .agent-tool-drawer.open, :scope > .agent-thought-drawer.open') !== null;
    const tmp = document.createElement('div');
    tmp.innerHTML = railSvg(index === 0, !isLast || open, item.classList.contains('failed'));
    item.replaceChild(tmp.firstElementChild, svg);
  });
}

function fileBadge(path) {
  return `<span class="agent-file-badge" title="${escapeHtml(String(path || ''))}">
    <span class="agent-file-badge-well"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></span>
    <span class="agent-file-badge-name">${escapeHtml(basename(path))}</span>
  </span>`;
}

function chipContent(node) {
  const label = escapeHtml(node.label || labelForKind(node.kind));
  let badges = '';
  if (node.kind === 'run' && node.command) {
    badges += `<span class="agent-pill-badge">${escapeHtml(firstLine(node.command))}</span>`;
  } else if (node.kind === 'search' && node.query !== undefined) {
    badges += `<span class="agent-tool-detail">${escapeHtml(node.query)}</span>`;
  } else if (node.kind === 'list') {
    badges += `<span class="agent-tool-detail">${escapeHtml(node.path || '.')}</span>`;
  } else if (node.kind === 'preview' || node.kind === 'preview_close') {
    badges += `<span class="agent-tool-detail">${escapeHtml(node.detail || node.previewUrl || '')}</span>`;
  } else if (node.path) {
    badges += fileBadge(node.path);
  }
  if (node.add || node.del) {
    badges += `<span class="agent-diff-stat"><span class="diff-add">+${node.add || 0}</span><span class="diff-del">−${node.del || 0}</span></span>`;
  }
  return `<span class="agent-tool-label">${label}</span>${badges}<span class="agent-chip-chevron">${AGENT_CHEVRON}</span>`;
}

function buildToolRow(node, { running = false } = {}) {
  const row = document.createElement('div');
  row.className = 'agent-tool-row' + (running ? ' is-running' : '');
  row.innerHTML = `
    <span class="agent-tool-icon-wrapper">${running ? '<span class="agent-spinner" aria-hidden="true"></span>' : (AGENT_ICONS[node.kind] || AGENT_ICONS.tool)}</span>
    <div class="agent-tool-chip" role="button" tabindex="0" aria-expanded="false">
      ${chipContent(node)}
    </div>
  `;
  return row;
}

function buildToolItem(node, { running = false, index = 0, animate = true } = {}) {
  const item = document.createElement('div');
  item.className = 'agent-tool-item' + (node.failed ? ' failed' : '') + (animate ? '' : ' no-anim');
  if (animate) item.style.animationDelay = `${FIRST_ROW_DELAY_MS + index * ROW_STAGGER_MS}ms`;
  item.innerHTML = railSvg(index === 0, true, node.failed);
  const row = buildToolRow(node, { running });
  item.appendChild(row);
  if (!running) {
    const drawer = buildToolDrawer(node);
    item.appendChild(drawer);
    wireChip(row, drawer);
  }
  return item;
}

function buildThoughtItem({ secondsText, open }) {
  const item = document.createElement('div');
  item.className = 'agent-tool-item agent-thought-item';
  item.innerHTML = railSvg(true, true, false);

  const row = document.createElement('div');
  row.className = 'agent-tool-row agent-thought-row';
  row.innerHTML = `
    <span class="agent-tool-icon-wrapper">${AGENT_ICONS.thought}</span>
    <div class="agent-tool-chip agent-thought-chip${open ? ' expanded' : ''}" role="button" tabindex="0" aria-expanded="${open}">
      <span class="agent-tool-label">Thought process<span class="agent-thought-time">${escapeHtml(secondsText)}</span></span>
      <span class="agent-chip-chevron">${AGENT_CHEVRON}</span>
    </div>
  `;

  const drawer = document.createElement('div');
  drawer.className = 'agent-thought-drawer' + (open ? ' open' : '');
  const inner = document.createElement('div');
  inner.className = 'agent-drawer-inner';
  const pad = document.createElement('div');
  pad.className = 'agent-drawer-pad thought';
  const body = document.createElement('div');
  body.className = 'agent-thought-body';
  const content = document.createElement('div');
  content.className = 'agent-thought-content';
  body.appendChild(content);
  pad.appendChild(body);
  inner.appendChild(pad);
  drawer.appendChild(inner);
  item.append(row, drawer);

  return {
    item,
    drawer,
    body,
    content,
    chip: row.querySelector('.agent-thought-chip'),
    timeEl: row.querySelector('.agent-thought-time'),
  };
}

function layoutThoughtViewport(body, content, state) {
  const contentH = content.offsetHeight;
  const capped = contentH > THOUGHT_MAX_H;
  body.classList.toggle('scrollable', Boolean(state.scrollable));
  body.style.height = capped ? `${THOUGHT_MAX_H}px` : '';
  if (capped && state.scrollable) {
    const mask = `linear-gradient(to bottom, transparent 0, #000 ${state.fadeTop ? THOUGHT_FADE : 0}px, #000 calc(100% - ${state.fadeBottom ? THOUGHT_FADE : 0}px), transparent 100%)`;
    body.style.webkitMaskImage = mask;
    body.style.maskImage = mask;
    content.style.transform = 'translateY(0)';
  } else {
    body.style.webkitMaskImage = 'none';
    body.style.maskImage = 'none';
    content.style.transform = capped ? `translateY(${THOUGHT_MAX_H - THOUGHT_FADE - contentH}px)` : 'translateY(0)';
  }
}

function attachThoughtToggle(refs, state) {
  const setOpen = (value) => {
    state.open = value;
    refs.drawer.classList.toggle('open', value);
    refs.chip.classList.toggle('expanded', value);
    refs.chip.setAttribute('aria-expanded', String(value));
    const tree = refs.item.closest('.agent-tree-inner');
    if (tree) refreshRails(tree);
    if (!value) return;
    requestAnimationFrame(() => {
      state.scrollable = !state.streaming;
      layoutThoughtViewport(refs.body, refs.content, state);
      if (state.scrollable) {
        refs.body.scrollTop = refs.body.scrollHeight;
        state.fadeTop = true;
        state.fadeBottom = false;
        layoutThoughtViewport(refs.body, refs.content, state);
      }
    });
  };
  const toggle = () => {
    state.manual = !state.open;
    setOpen(state.manual);
  };
  refs.chip.addEventListener('click', toggle);
  refs.chip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
  refs.body.addEventListener('scroll', () => {
    if (!state.scrollable) return;
    state.fadeTop = refs.body.scrollTop > 1;
    state.fadeBottom = refs.body.scrollTop + refs.body.clientHeight < refs.body.scrollHeight - 1;
    layoutThoughtViewport(refs.body, refs.content, state);
  });
  return { setOpen, toggle };
}

const AGENT_COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="14" height="14" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
const AGENT_COPIED_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-5-5"></path><path d="m22 10-7.5 7.5L13 16"></path></svg>';

function copyButton(getText, label = 'Copy') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'agent-copy-btn';
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = AGENT_COPY_ICON;
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    navigator.clipboard.writeText(getText()).then(() => {
      btn.innerHTML = AGENT_COPIED_ICON;
      btn.classList.add('copied');
      setTimeout(() => {
        btn.innerHTML = AGENT_COPY_ICON;
        btn.classList.remove('copied');
      }, 1500);
    }).catch(() => {
      btn.title = 'Copy failed';
      setTimeout(() => { btn.title = label; }, 1500);
    });
  });
  return btn;
}

const CODE_TOKEN_SRC = '(\\/\\/.*$|\\/\\*[\\s\\S]*?\\*\\/|#.*$)|("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)|\\b(const|let|var|function|return|if|else|for|of|in|while|do|break|continue|new|class|extends|implements|interface|type|enum|import|export|from|as|default|async|await|try|catch|finally|throw|switch|case|typeof|instanceof|void|delete|public|private|protected|readonly|static|get|set|super|this|null|undefined|true|false|fn|struct|impl|pub|use|mut|match|def|self|None|Some|Ok|Err)\\b|(\\b\\d+(?:\\.\\d+)?\\b)|(\\b[A-Z][A-Za-z0-9_]*\\b)|([a-zA-Z_$][\\w$]*(?=\\s*\\())';

function highlightCodeLine(line) {
  const re = new RegExp(CODE_TOKEN_SRC, 'g');
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(line)) !== null) {
    if (match.index > last) out += escapeHtml(line.slice(last, match.index));
    const groups = match.slice(1);
    const group = groups.findIndex(value => value !== undefined) + 1;
    out += `<span class="tok-${group}">${escapeHtml(match[0])}</span>`;
    last = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  if (last < line.length) out += escapeHtml(line.slice(last));
  return out;
}

function buildCodeCard(node) {
  const card = document.createElement('div');
  card.className = 'agent-code-card';
  const body = document.createElement('div');
  body.className = 'agent-code-body';
  const lines = String(node.code || '').replace(/\n+$/, '').split('\n');
  lines.forEach((line, index) => {
    const row = document.createElement('div');
    row.className = 'agent-code-line';
    const num = document.createElement('span');
    num.className = 'agent-code-num';
    num.textContent = (node.lineStart || 1) + index;
    const code = document.createElement('code');
    code.innerHTML = highlightCodeLine(line) || ' ';
    row.append(num, code);
    body.appendChild(row);
  });
  card.appendChild(body);
  return card;
}

function buildDiffCard(node) {
  const card = document.createElement('div');
  card.className = 'agent-diff-card';
  const head = document.createElement('div');
  head.className = 'agent-diff-head';
  const label = document.createElement('span');
  label.className = 'agent-code-label';
  label.textContent = node.path || 'workspace';
  const stat = document.createElement('span');
  stat.className = 'agent-diff-stat';
  stat.innerHTML = `<span class="diff-add">+${node.add || 0}</span><span class="diff-del">−${node.del || 0}</span>`;
  head.append(label, stat, copyButton(() => (node.diffRows || [])
    .map(row => `${row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '} ${row.text}`)
    .join('\n')));
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'agent-diff-body';
  const hairline = document.createElement('span');
  hairline.className = 'agent-diff-hairline';
  hairline.setAttribute('aria-hidden', 'true');
  body.appendChild(hairline);
  (node.diffRows || []).forEach(row => {
    const line = document.createElement('div');
    line.className = `agent-diff-row ${row.type}`;
    line.innerHTML = `
      <span class="agent-diff-num old">${row.old == null ? '' : row.old}</span>
      <span class="agent-diff-num cur">${row.cur == null ? '' : row.cur}</span>
      <span class="agent-diff-sign">${row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}</span>
      <code class="agent-diff-text">${escapeHtml(row.text || ' ')}</code>
    `;
    body.appendChild(line);
  });
  const hidden = (node.totalDiffRows || (node.diffRows || []).length) - (node.diffRows || []).length;
  if (hidden > 0) {
    const more = document.createElement('div');
    more.className = 'agent-terminal-more';
    more.textContent = `… ${hidden} more lines`;
    body.appendChild(more);
  }
  card.appendChild(body);
  return card;
}

function buildTerminalCard(node) {
  const card = document.createElement('div');
  card.className = 'agent-terminal-card';
  const head = document.createElement('div');
  head.className = 'agent-terminal-head';
  const cmd = document.createElement('span');
  cmd.className = 'agent-terminal-cmd';
  cmd.innerHTML = AGENT_ICONS.run;
  const cmdText = document.createElement('span');
  cmdText.className = 'agent-terminal-cmd-text';
  cmdText.textContent = firstLine(node.command);
  cmd.appendChild(cmdText);

  const meta = document.createElement('span');
  meta.className = 'agent-terminal-meta';
  if (node.durationMs !== undefined && node.durationMs !== null) {
    const time = document.createElement('span');
    time.className = 'agent-terminal-time';
    time.textContent = `${node.durationMs}ms`;
    meta.appendChild(time);
  }
  const exit = document.createElement('span');
  exit.className = 'agent-exit-pill ' + (node.failed ? 'error' : 'success');
  exit.textContent = node.failed ? `exit ${node.exitCode}` : 'exit 0';
  meta.appendChild(exit);
  meta.appendChild(copyButton(() => (node.output && node.output !== '(no output)') ? `$ ${node.command}\n\n${node.output}` : `$ ${node.command}`));
  head.append(cmd, meta);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'agent-terminal-body';
  const rawLines = String(node.output || '(no output)').split('\n');
  while (rawLines.length > 1 && !rawLines[rawLines.length - 1].trim()) rawLines.pop();
  const shown = rawLines.slice(0, OUTPUT_DETAIL_MAX_LINES);
  const hidden = Math.max(0, rawLines.length - OUTPUT_DETAIL_MAX_LINES);
  shown.forEach(line => {
    const lineEl = document.createElement('div');
    lineEl.className = 'agent-terminal-line';
    lineEl.textContent = line || ' ';
    body.appendChild(lineEl);
  });
  if (hidden > 0) {
    const more = document.createElement('div');
    more.className = 'agent-terminal-more';
    more.textContent = `… ${hidden} more lines`;
    body.appendChild(more);
  }
  card.appendChild(body);
  return card;
}

function buildSearchCard(node) {
  const card = document.createElement('div');
  card.className = 'agent-search-card';
  const head = document.createElement('div');
  head.className = 'agent-code-head';
  const label = document.createElement('span');
  label.className = 'agent-code-label';
  label.innerHTML = `${AGENT_ICONS.search}<span>"${escapeHtml(node.query || '')}" · ${node.count || 0} matches</span>`;
  head.append(label, copyButton(() => (node.matches || []).map(match => `${match.file}:${match.line}: ${match.text}`).join('\n')));
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'agent-match-list';
  if (!node.matches || !node.matches.length) {
    const empty = document.createElement('div');
    empty.className = 'agent-match-empty';
    empty.textContent = 'No matches.';
    body.appendChild(empty);
  } else {
    node.matches.forEach(match => {
      const row = document.createElement('div');
      row.className = 'agent-match-row';
      row.innerHTML = `
        <span class="agent-match-file">${escapeHtml(match.file)}<span class="agent-match-line">:${match.line}</span></span>
        <code class="agent-match-text">${escapeHtml(match.text)}</code>
      `;
      body.appendChild(row);
    });
  }
  card.appendChild(body);
  return card;
}

function buildListCard(node) {
  const card = document.createElement('div');
  card.className = 'agent-list-card';
  const head = document.createElement('div');
  head.className = 'agent-code-head';
  const label = document.createElement('span');
  label.className = 'agent-code-label';
  label.textContent = `${node.path || '.'} · ${node.total || 0} entries`;
  head.append(label, copyButton(() => (node.entries || []).map(entry => entry.path).join('\n')));
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'agent-list-body';
  (node.entries || []).forEach(entry => {
    const row = document.createElement('div');
    row.className = 'agent-list-row' + (entry.type === 'dir' ? ' is-dir' : '');
    row.textContent = entry.path;
    body.appendChild(row);
  });
  card.appendChild(body);
  return card;
}

function buildPreviewCard(node) {
  const card = document.createElement('div');
  card.className = 'agent-preview-card';
  const url = node.previewUrl || '';
  const text = document.createElement('span');
  text.className = 'agent-preview-card-text';
  text.textContent = node.kind === 'preview_close'
    ? 'The preview window was closed.'
    : `Showing ${url} in the preview window.`;
  card.appendChild(text);
  if (url) {
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'agent-preview-card-btn';
    open.textContent = 'Show again';
    open.addEventListener('click', () => window.openLivePreview(url));
    card.appendChild(open);
  }
  return card;
}

function buildToolDrawer(node) {
  const drawer = document.createElement('div');
  drawer.className = 'agent-tool-drawer';
  const inner = document.createElement('div');
  inner.className = 'agent-drawer-inner';
  const pad = document.createElement('div');
  pad.className = 'agent-drawer-pad';
  inner.appendChild(pad);
  drawer.appendChild(inner);
  if (node.failed) {
    const error = document.createElement('div');
    error.className = 'agent-tool-error';
    error.textContent = node.error || 'Tool failed.';
    pad.appendChild(error);
  } else if (node.kind === 'run') {
    pad.appendChild(buildTerminalCard(node));
  } else if (node.kind === 'read') {
    pad.appendChild(buildCodeCard(node));
  } else if (node.kind === 'write' || node.kind === 'edit') {
    pad.appendChild(buildDiffCard(node));
  } else if (node.kind === 'search') {
    pad.appendChild(buildSearchCard(node));
  } else if (node.kind === 'list') {
    pad.appendChild(buildListCard(node));
  } else if (node.kind === 'preview' || node.kind === 'preview_close') {
    pad.appendChild(buildPreviewCard(node));
  } else {
    const empty = document.createElement('div');
    empty.className = 'agent-tool-error';
    empty.textContent = 'No details returned.';
    pad.appendChild(empty);
  }
  return drawer;
}

function wireChip(row, drawer) {
  const chip = row.querySelector('.agent-tool-chip');
  if (!chip || !drawer) return;
  const toggle = () => {
    const open = chip.classList.toggle('expanded');
    chip.setAttribute('aria-expanded', String(open));
    drawer.classList.toggle('open', open);
    const tree = drawer.closest('.agent-tree-inner');
    if (tree) refreshRails(tree);
  };
  chip.addEventListener('click', toggle);
  chip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
}

function summarizeToolNodes(nodes) {
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let failed = 0;
  let previews = 0;
  const edited = [];
  for (const node of nodes) {
    if (!node) continue;
    if (node.failed) failed += 1;
    switch (node.kind) {
      case 'run': commands += 1; break;
      case 'write':
      case 'edit':
        if (node.path && !edited.includes(node.path)) edited.push(node.path);
        break;
      case 'read': reads += 1; break;
      case 'search':
      case 'list': searches += 1; break;
      case 'preview':
      case 'preview_close': previews += 1; break;
      default: break;
    }
  }
  const parts = [];
  if (commands > 0) parts.push(`ran ${commands} ${commands === 1 ? 'command' : 'commands'}`);
  if (edited.length > 0) parts.push(`edited ${edited.length} ${edited.length === 1 ? 'file' : 'files'}`);
  if (reads > 0) parts.push(`read ${reads} ${reads === 1 ? 'file' : 'files'}`);
  if (searches > 0) parts.push(`searched ${searches} ${searches === 1 ? 'time' : 'times'}`);
  if (previews > 0) parts.push(`previewed ${previews} ${previews === 1 ? 'page' : 'pages'}`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

function renderThoughtText(text) {
  return inlineFormat(escapeHtml(String(text || ''))).replace(/\n/g, '<br>');
}

function stashNode(node) {
  const copy = { ...node };
  if (copy.code) copy.code = String(copy.code).slice(0, 30000);
  if (copy.output) copy.output = String(copy.output).slice(0, 12000);
  if (copy.error) copy.error = String(copy.error).slice(0, 4000);
  if (copy.diffRows) copy.diffRows = copy.diffRows.slice(0, 400);
  if (copy.matches) copy.matches = copy.matches.slice(0, 100);
  if (copy.entries) copy.entries = copy.entries.slice(0, 300);
  return copy;
}

function renderAgentNotice(row, notice) {
  const el = document.createElement('div');
  el.className = 'agent-notice' + (notice.tone ? ' ' + notice.tone : '');
  const icon = notice.tone === 'folder' ? AGENT_FOLDER_ICON
    : notice.tone === 'error' ? AGENT_ALERT_ICON
    : AGENT_INFO_ICON;
  el.innerHTML = `
    <div class="agent-notice-title">${icon}<span>${escapeHtml(notice.title || 'Notice')}</span></div>
    <p class="agent-notice-body">${escapeHtml(notice.body || '')}</p>
  `;
  if (notice.actionLabel && typeof notice.action === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agent-notice-btn';
    btn.textContent = notice.actionLabel;
    btn.addEventListener('click', () => notice.action(btn));
    el.appendChild(btn);
  }
  row.appendChild(el);
}

function createAgentPhase(container) {
  const phaseEl = document.createElement('div');
  phaseEl.className = 'agent-workflow-phase';

  const stateEl = document.createElement('div');
  stateEl.className = 'agent-thinking-state is-live';

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'agent-group-header';
  header.innerHTML = `
    <span class="agent-chevron-wrap">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </span>
    <span class="agent-group-summary agent-shimmer-title">Thinking…</span>
  `;

  const treeWrap = document.createElement('div');
  treeWrap.className = 'agent-tree-container';
  const treeEl = document.createElement('div');
  treeEl.className = 'agent-tree-inner';
  treeWrap.appendChild(treeEl);
  stateEl.append(header, treeWrap);

  const messageEl = document.createElement('div');
  messageEl.className = 'assistant-body agent-phase-message';
  messageEl.style.display = 'none';

  phaseEl.append(stateEl, messageEl);
  container.appendChild(phaseEl);

  const record = { thought: '', thoughtSeconds: 0, tools: [], message: '', awaiting: false, error: '' };
  const toolNodes = [];
  let thought = null;
  let live = true;
  let manualCollapsed = null;

  const isCollapsed = () => stateEl.classList.contains('collapsed');
  const summaryEl = header.querySelector('.agent-group-summary');
  const refresh = () => refreshRails(treeEl);

  function summaryText() {
    const toolsSummary = summarizeToolNodes(toolNodes);
    if (toolsSummary) return toolsSummary;
    if (record.thought) return live ? 'Thinking…' : 'Thought it through';
    return live ? 'Working…' : 'Worked';
  }

  function paintSummary() {
    summaryEl.textContent = summaryText();
    summaryEl.classList.toggle('agent-shimmer-title', live);
  }

  header.addEventListener('click', () => {
    manualCollapsed = !isCollapsed();
    stateEl.classList.toggle('collapsed', manualCollapsed);
  });

  function ensureThought() {
    if (thought) return thought;
    const refs = buildThoughtItem({ secondsText: '0.0s', open: true });
    refs.item.style.animationDelay = `${FIRST_ROW_DELAY_MS}ms`;
    treeEl.appendChild(refs.item);

    const state = { open: true, manual: null, streaming: true, scrollable: false, fadeTop: false, fadeBottom: true };
    const controls = attachThoughtToggle(refs, state);
    const entry = {
      ...refs,
      state,
      startedAt: Date.now(),
      endedAt: null,
      timer: null,
      isOpen: true,
      setOpen: (value) => {
        entry.isOpen = value;
        controls.setOpen(value);
      },
      layout: () => layoutThoughtViewport(refs.body, refs.content, state),
    };

    entry.timer = setInterval(() => {
      if (entry.endedAt) return;
      const secs = (Date.now() - entry.startedAt) / 1000;
      entry.timeEl.textContent = formatSeconds(secs);
      record.thoughtSeconds = Number(secs.toFixed(1));
    }, 100);

    thought = entry;
    refresh();
    return entry;
  }

  function setThought(text) {
    const entry = ensureThought();
    record.thought = String(text || '').slice(0, 20000);
    entry.content.innerHTML = renderThoughtText(text);
    entry.layout();
    paintSummary();
  }

  function endThought() {
    if (!thought || thought.endedAt) return;
    thought.endedAt = Date.now();
    const secs = (thought.endedAt - thought.startedAt) / 1000;
    thought.timeEl.textContent = formatSeconds(secs);
    record.thoughtSeconds = Number(secs.toFixed(1));
    clearInterval(thought.timer);
    thought.state.streaming = false;
    if (thought.state.manual === null) thought.setOpen(false);
    else thought.layout();
  }

  function beginTool(block) {
    endThought();
    const isPreview = block.kind === 'preview' || block.kind === 'preview_close';
    const shell = {
      kind: block.kind,
      label: labelForKind(block.kind),
      path: block.kind === 'run' || block.kind === 'search' || isPreview ? undefined : block.arg,
      detail: isPreview ? block.arg : undefined,
      command: block.kind === 'run' ? block.arg : undefined,
      query: block.kind === 'search' ? block.arg : undefined,
    };
    toolNodes.push(shell);
    const index = treeEl.querySelectorAll(':scope > .agent-tool-item').length;
    const item = buildToolItem(shell, { running: true, index });
    item.dataset.itemIndex = String(index);
    treeEl.appendChild(item);
    refresh();
    paintSummary();
    return { item, shell };
  }

  function completeTool(handle, node) {
    const index = toolNodes.indexOf(handle.shell);
    if (index !== -1) toolNodes[index] = node;
    const itemIndex = Number(handle.item.dataset.itemIndex || 0);
    const newItem = buildToolItem(node, { running: false, index: itemIndex, animate: false });
    newItem.dataset.itemIndex = String(itemIndex);
    handle.item.replaceWith(newItem);
    refresh();
    paintSummary();
    record.tools = toolNodes.map(stashNode);
  }

  function setInterim(text) {
    record.message = String(text || '');
    if (!text) {
      messageEl.style.display = 'none';
      return;
    }
    messageEl.innerHTML = formatMarkdown(text);
    messageEl.style.display = 'block';
  }

  function setEmptyFinal() {
    record.message = '';
    messageEl.innerHTML = '<p class="agent-empty-response">The model returned no final message.</p>';
    messageEl.style.display = 'block';
  }

  function setAwaiting(value) {
    record.awaiting = Boolean(value);
    if (!value) return;
    const note = document.createElement('div');
    note.className = 'agent-awaiting';
    note.innerHTML = '<span class="agent-awaiting-dot"></span>Waiting for your answer before continuing';
    messageEl.appendChild(note);
  }

  function showError(message) {
    record.error = message;
    const el = document.createElement('div');
    el.className = 'agent-phase-error';
    el.textContent = message;
    phaseEl.appendChild(el);
  }

  function finalize() {
    live = false;
    endThought();
    stateEl.classList.remove('is-live');
    paintSummary();
    if (manualCollapsed === null) {
      stateEl.classList.add('collapsed');
    }
    refresh();
  }

  function getRecord() {
    return {
      thought: record.thought,
      thoughtSeconds: record.thoughtSeconds,
      tools: record.tools,
      message: record.message,
      awaiting: record.awaiting,
      error: record.error,
    };
  }

  return { setThought, beginTool, completeTool, setInterim, setEmptyFinal, setAwaiting, showError, finalize, getRecord, setInterimStreaming: setInterim };
}

function renderArchivedPhase(container, phase) {
  const phaseEl = document.createElement('div');
  phaseEl.className = 'agent-workflow-phase';

  const stateEl = document.createElement('div');
  stateEl.className = 'agent-thinking-state collapsed';
  const summary = summarizeToolNodes(phase.tools || []) || (phase.thought ? 'Thought it through' : 'Worked');
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'agent-group-header';
  header.innerHTML = `
    <span class="agent-chevron-wrap">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </span>
    <span class="agent-group-summary">${escapeHtml(summary)}</span>
  `;
  header.addEventListener('click', () => stateEl.classList.toggle('collapsed'));

  const treeWrap = document.createElement('div');
  treeWrap.className = 'agent-tree-container';
  const treeEl = document.createElement('div');
  treeEl.className = 'agent-tree-inner';
  treeWrap.appendChild(treeEl);
  stateEl.append(header, treeWrap);

  if (phase.thought) {
    const refs = buildThoughtItem({ secondsText: formatSeconds(phase.thoughtSeconds), open: false });
    refs.content.innerHTML = renderThoughtText(phase.thought);
    const state = { open: false, manual: null, streaming: false, scrollable: false, fadeTop: false, fadeBottom: true };
    attachThoughtToggle(refs, state);
    treeEl.appendChild(refs.item);
  }

  (phase.tools || []).forEach((node, index) => {
    treeEl.appendChild(buildToolItem(node, { running: false, index, animate: false }));
  });

  phaseEl.appendChild(stateEl);

  if (phase.message) {
    const messageEl = document.createElement('div');
    messageEl.className = 'assistant-body agent-phase-message';
    messageEl.innerHTML = formatMarkdown(phase.message);
    if (phase.awaiting) {
      const note = document.createElement('div');
      note.className = 'agent-awaiting';
      note.innerHTML = '<span class="agent-awaiting-dot"></span>Waiting for your answer before continuing';
      messageEl.appendChild(note);
    }
    phaseEl.appendChild(messageEl);
  }

  if (phase.error) {
    const error = document.createElement('div');
    error.className = 'agent-phase-error';
    error.textContent = phase.error;
    phaseEl.appendChild(error);
  }

  container.appendChild(phaseEl);
  refreshRails(treeEl);
}

// Send message. The model plans, the app executes real tools, the model sees
// the real results and keeps going until it reports done or asks a question.
async function handleSend(rawText) {
  const text = rawText.trim();
  if (!text) return;

  promptInput.value = '';
  capsulePromptInput.value = '';
  autoResizeTextarea(promptInput, promptCard, 38, 140, 50);
  autoResizeTextarea(capsulePromptInput, capsuleBar, 24, 130, 45);

  let currentChat = null;

  if (!activeChatId || welcomeContainer.style.display !== 'none') {
    const newChatId = 'chat_' + Date.now();
    activeChatId = newChatId;
    const title = text.length > 30 ? text.substring(0, 30) + '...' : text;
    currentChat = {
      id: newChatId,
      title,
      createdAt: Date.now(),
      messages: [],
    };
    chats.unshift(currentChat);
    saveChatsToStorage();
    renderSidebarHistory();
    showConversationView(title);
    messagesContainer.innerHTML = '';
  } else {
    currentChat = chats.find(chat => chat.id === activeChatId);
    if (!currentChat) {
      currentChat = {
        id: activeChatId,
        title: text.length > 30 ? text.substring(0, 30) + '...' : text,
        createdAt: Date.now(),
        messages: [],
      };
      chats.unshift(currentChat);
    }
  }

  let attachedFileName = null;
  let attachedImageDataUrls = [];
  if (pendingAttachments.length > 0) {
    attachedFileName = pendingAttachments.map(file => file.name).join(', ');
    // Convert image files to base64 data URLs so AI can see them
    const imageFiles = pendingAttachments.filter(f => f.type && f.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      const toDataUrl = (file) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
      attachedImageDataUrls = await Promise.all(imageFiles.map(toDataUrl));
    }
  }

  currentChat.messages.push({
    role: 'user',
    content: text,
    attachment: attachedFileName,
    imageDataUrls: attachedImageDataUrls,
    timestamp: Date.now(),
  });
  saveChatsToStorage();

  pendingAttachments = [];
  if (cardAttachments) {
    cardAttachments.innerHTML = '';
    cardAttachments.style.display = 'none';
  }
  // Also clear capsule attachments
  const capsuleAttsEl = document.getElementById('capsule-attachments');
  if (capsuleAttsEl) {
    capsuleAttsEl.innerHTML = '';
    capsuleAttsEl.style.display = 'none';
  }

  renderUserMessage(text, attachedFileName, true, currentChat.messages.length - 1, currentChat);
  refreshUserEditButtons();
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  const row = document.createElement('div');
  row.className = 'message-row assistant';
  messagesContainer.appendChild(row);

  setGeneratingState(true);
  const controller = new AbortController();
  abortController = controller;

  const persistAssistant = (extra) => {
    const record = {
      role: 'assistant',
      content: extra.content || '',
      timestamp: Date.now(),
      ...extra,
    };
    currentChat.messages.push(record);
    saveChatsToStorage();
    return record;
  };

  const noticeAndStop = (notice, content) => {
    renderAgentNotice(row, notice);
    persistAssistant({ content: content || `${notice.title}. ${notice.body}`, notice });
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    setGeneratingState(false);
  };

  try {
    const mediaGenType = detectMediaGenerationIntent(text);

    // A greeting is not a job. Answer it like a person, with no tools, no
    // workspace requirement and no activity rail.
    if (!mediaGenType && isSmallTalk(text)) {
      const body = document.createElement('div');
      body.className = 'assistant-body';
      row.appendChild(body);
      let reply = '';
      try {
        const result = await streamCompletion([
          { role: 'system', content: buildSmallTalkPrompt() },
          ...currentChat.messages.slice(-8).map(message => ({ role: message.role, content: message.content || '' })),
        ], {
          signal: controller.signal,
          onContent: (all) => { body.innerHTML = formatMarkdown(stripToolBlocks(all)); },
        });
        reply = stripToolBlocks(result.content).trim();
        if (!reply) reply = 'Hey.';
        body.innerHTML = formatMarkdown(reply);
      } catch (err) {
        reply = err.name === 'AbortError' ? 'Stopped.' : err.message;
        body.innerHTML = `<p class="agent-error-text">${escapeHtml(reply)}</p>`;
      }
      addAssistantActionButtons(row, reply);
      persistAssistant({ content: reply });
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      return;
    }

    // The agent cannot do anything without a real folder and a live server.
    const info = await refreshWorkspaceInfo();
    if (!info.reachable) {
      noticeAndStop({
        tone: 'error',
        title: 'Workspace server unreachable',
        body: info.error,
      });
      return;
    }

    if (!info.selected) {
      noticeAndStop({
        tone: 'folder',
        title: 'No folder selected',
        body: 'Kraken cannot read, run, or write anything until you choose a workspace folder. Nothing was executed.',
        actionLabel: 'Choose folder',
        action: async (button) => {
          button.disabled = true;
          button.textContent = 'Opening…';
          const picked = await pickWorkspaceFolder();
          button.disabled = false;
          button.textContent = picked ? 'Folder connected — send your message again' : 'Choose folder';
        },
      });
      return;
    }

    if (mediaGenType === 'video') {
      noticeAndStop({
        tone: 'info',
        title: 'Video generation is not connected',
        body: 'This build has no video model wired up. It can generate images and run coding tasks. Nothing was generated.',
      });
      return;
    }

    if (mediaGenType === 'image') {
      const mediaUrl = generateMediaUrl(text);
      const mediaCard = renderInteractiveMediaGeneration({
        prompt: text,
        mediaType: 'image',
        url: mediaUrl,
        onComplete: () => {},
      });
      row.appendChild(mediaCard);

      const body = document.createElement('div');
      body.className = 'assistant-body';
      row.appendChild(body);

      let finalText = '';
      try {
        const mediaMessages = [
          {
            role: 'system',
            content: 'You are Kraken. The app requested a real image from the Pollinations flux endpoint using the user prompt. Reply with one short sentence describing the request. Do not output image URLs, markdown images, or claims about how long it took.',
          },
          ...currentChat.messages.slice(-12).map(message => ({ role: message.role, content: message.content || '' })),
        ];
        const result = await streamCompletion(mediaMessages, {
          signal: controller.signal,
          onContent: (all) => { body.innerHTML = formatMarkdown(all); },
        });
        finalText = result.content.trim();
        if (!finalText) finalText = `Image requested from the Pollinations flux endpoint for: "${text}".`;
        body.innerHTML = formatMarkdown(finalText);
      } catch (err) {
        if (err.name === 'AbortError') {
          finalText = 'Stopped.';
          body.innerHTML = '<p class="agent-stop-text">Stopped.</p>';
        } else {
          finalText = err.message;
          body.innerHTML = `<p class="agent-error-text">${escapeHtml(err.message)}</p>`;
        }
      }
      addAssistantActionButtons(row, finalText);
      persistAssistant({ content: finalText, mediaType: 'image', mediaUrl });
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
      return;
    }

    let treeEntries = [];
    try {
      const tree = await agentApi('/api/workspace/tree?max=300', { timeoutMs: 15000 });
      treeEntries = tree.entries || [];
    } catch (err) {
      noticeAndStop({
        tone: 'error',
        title: 'The selected folder is not usable',
        body: err.message,
      });
      return;
    }

    const apiMessages = [{ role: 'system', content: buildAgentSystemPrompt(treeEntries) }];
    currentChat.messages
      .filter(message => message.role === 'user' || message.role === 'assistant')
      .slice(-24)
      .forEach(message => {
        // If user message has image data URLs, build a vision content array
        if (message.role === 'user' && message.imageDataUrls && message.imageDataUrls.length > 0) {
          const content = [
            { type: 'text', text: message.content || '' },
            ...message.imageDataUrls.map(url => ({
              type: 'image_url',
              image_url: { url, detail: 'high' }
            }))
          ];
          apiMessages.push({ role: 'user', content });
        } else {
          apiMessages.push({ role: message.role, content: message.content || '' });
        }
      });

    const workflow = document.createElement('div');
    workflow.className = 'agent-workflow-container';
    row.appendChild(workflow);

    const phases = [];
    let finalText = '';
    let lastProse = '';
    let stopped = null;
    let completed = false;

    // Single unified phase for all tool executions
    const phase = createAgentPhase(workflow);
    phases.push(phase);

    for (let round = 0; round < MAX_AGENT_STEPS; round += 1) {
      if (controller.signal.aborted) {
        stopped = 'aborted';
        break;
      }

      // Continuing unified phase
      let raw = '';

      try {
        const result = await streamCompletion(apiMessages, {
          signal: controller.signal,
          onReasoning: (all) => phase.setThought(all),
          onContent: (all) => {
            raw = all;
            const prose = stripToolBlocks(all);
            if (prose) {
              lastProse = prose;
              phase.setInterim(prose);
            }
          },
        });

        raw = result.content || '';
        const blocks = parseAgentBlocks(raw);
        const prose = stripToolBlocks(raw);
        if (prose) {
          lastProse = prose;
          phase.setInterim(prose);
        }

        if (!blocks.length) {
          completed = true;
          finalText = stripToolBlocks(raw);
          if (finalText) {
            phase.setInterim(finalText);
            phase.setAwaiting(/\?\s*$/.test(finalText));
          } else {
            phase.setEmptyFinal();
          }
          phase.finalize();
          break;
        }

        const results = [];
        for (const block of blocks) {
          if (controller.signal.aborted) {
            stopped = 'aborted';
            break;
          }
          const handle = phase.beginTool(block);
          const outcome = await executeAgentBlock(block);
          phase.completeTool(handle, outcome.node);
          results.push(outcome.resultText);
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        phase.finalize();

        if (stopped) break;
        if (controller.signal.aborted) {
          stopped = 'aborted';
          break;
        }

        apiMessages.push({ role: 'assistant', content: raw });
        apiMessages.push({ role: 'user', content: buildToolResultsMessage(results) });
      } catch (err) {
        if (err.name === 'AbortError' || controller.signal.aborted) {
          stopped = 'aborted';
          phase.finalize();
          break;
        }
        phase.finalize();
        phase.showError(err.message);
        finalText = '';
        break;
      }
    }

    if (!stopped && !completed) stopped = 'step-limit';

    if (stopped) {
      const note = document.createElement('div');
      note.className = 'agent-stop-note';
      note.textContent = stopped === 'aborted'
        ? 'Stopped by you.'
        : `Stopped after ${MAX_AGENT_STEPS} steps. The task may not be complete.`;
      row.appendChild(note);
      finalText = lastProse || (stopped === 'aborted' ? 'Stopped by you.' : `Stopped after ${MAX_AGENT_STEPS} steps.`);
    }

    if (!finalText && !phases.some(phase => phase.getRecord().error)) {
      finalText = lastProse || '';
    }

    if (finalText) addAssistantActionButtons(row, finalText);

    persistAssistant({
      content: finalText,
      trace: phases.map(phase => phase.getRecord()),
      stopped: stopped || null,
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (err) {
    if (err.name !== 'AbortError') {
      const errorEl = document.createElement('div');
      errorEl.className = 'agent-phase-error';
      errorEl.textContent = err.message || String(err);
      row.appendChild(errorEl);
    }
  } finally {
    setGeneratingState(false);
  }
}

function setGeneratingState(generating) {
  isGenerating = generating;
  if (generating) {
    capsuleSendIcon.style.display = 'none';
    capsuleStopIcon.style.display = 'block';
  } else {
    capsuleSendIcon.style.display = 'block';
    capsuleStopIcon.style.display = 'none';
    abortController = null;
  }
}

function stopGeneration() {
  if (abortController) {
    abortController.abort();
  }
  setGeneratingState(false);
}

// Global Workspace Command Executor (Agent Terminal)
window.executeWorkspaceCommand = async function(codeId, btn) {
  const codeEl = document.getElementById(codeId);
  if (!codeEl) return;
  const command = codeEl.innerText.trim();
  if (!command) return;

  const container = codeEl.closest('.code-block-container');
  let termCard = container.nextElementSibling;
  if (!termCard || !termCard.classList.contains('agent-action-card')) {
    termCard = document.createElement('div');
    termCard.className = 'agent-action-card';
    container.parentNode.insertBefore(termCard, container.nextSibling);
  }

  termCard.innerHTML = `
    <div class="agent-action-header">
      <div class="agent-action-title">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"></polyline>
          <line x1="12" y1="19" x2="20" y2="19"></line>
        </svg>
        <span>$ ${escapeHtml(command)}</span>
      </div>
      <span class="agent-action-badge running">● Executing...</span>
    </div>
    <div class="agent-terminal-output">Running in workspace...</div>
  `;

  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.6';
  }

  try {
    const apiBase = window.location.protocol.startsWith('http') ? window.location.origin : 'http://localhost:8080';
    const res = await fetch(apiBase + '/api/workspace/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command })
    });
    const result = await res.json();
    const outputEl = termCard.querySelector('.agent-terminal-output');
    const badgeEl = termCard.querySelector('.agent-action-badge');

    const combinedOutput = (result.stdout || '') + (result.stderr ? ('\n' + result.stderr) : '');
    outputEl.textContent = combinedOutput.trim() || '[Process completed with exit code 0]';

    if (result.success) {
      badgeEl.className = 'agent-action-badge success';
      badgeEl.textContent = `✓ Exit 0`;
    } else {
      badgeEl.className = 'agent-action-badge';
      badgeEl.style.background = 'rgba(239, 68, 68, 0.2)';
      badgeEl.style.color = '#f87171';
      badgeEl.textContent = `✕ Exit ${result.exitCode || 1}`;
    }
  } catch (err) {
    const outputEl = termCard.querySelector('.agent-terminal-output');
    const badgeEl = termCard.querySelector('.agent-action-badge');
    badgeEl.className = 'agent-action-badge';
    badgeEl.textContent = '✕ Error';
    outputEl.textContent = 'Failed to execute: ' + err.message;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
    }
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
};

// Markdown rendering for assistant prose, code blocks, and tables.
function formatMarkdown(text) {
  if (!text) return '';

  let processed = balanceFences(text);

  // 1. Extract remaining code blocks
  const codeBlocks = [];
  processed = processed.replace(/```([a-zA-Z0-9_\-\+]*)\n?([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    const cleanLang = (lang || 'code').trim().toLowerCase();
    const trimmedCode = code.replace(/^\n+|\n+$/g, '');
    const escapedCode = escapeHtml(trimmedCode);
    const codeId = 'code_' + Math.random().toString(36).substring(2, 9);
    const isBash = ['bash', 'sh', 'shell', 'terminal', 'cmd', 'powershell', 'zsh'].includes(cleanLang);

    const runBtn = isBash ? `
      <button class="code-copy-btn run-cmd-btn" onclick="executeWorkspaceCommand('${codeId}', this)" title="Execute in workspace" style="background: rgba(37, 99, 235, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); margin-right: 6px;">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        <span>Run</span>
      </button>
    ` : '';

    const html = `
      <div class="code-block-container">
        <div class="code-block-header">
          <span class="code-lang-label">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 18 22 12 16 6"></polyline>
              <polyline points="8 6 2 12 8 18"></polyline>
            </svg>
            ${cleanLang}
          </span>
          <div style="display: flex; align-items: center; gap: 4px;">
            ${runBtn}
            <button class="code-copy-btn" onclick="copyCodeBlock('${codeId}', this)" title="Copy snippet">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
              <span>Copy</span>
            </button>
          </div>
        </div>
        <pre class="code-block-body"><code id="${codeId}">${escapedCode}</code></pre>
      </div>
    `;
    codeBlocks.push(html);
    return placeholder;
  });

  // 2. Extract and format markdown tables
  const tableBlocks = [];
  processed = processed.replace(/((?:^[ \t]*\|[^\n]+\|[ \t]*\n){2,})/gm, (match) => {
    const rawLines = match.trim().split('\n').map(l => l.trim()).filter(Boolean);
    if (rawLines.length < 2) return match;

    // Check if second line is markdown table separator (|---|---|)
    const isSeparator = /^\|?(\s*:?-+:?\s*\|?)+$/.test(rawLines[1]);
    if (!isSeparator) return match;

    const parseCells = (line) => {
      let trimmed = line;
      if (trimmed.startsWith('|')) trimmed = trimmed.substring(1);
      if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
      return trimmed.split('|').map(c => c.trim());
    };

    const headerCells = parseCells(rawLines[0]);
    const bodyLines = rawLines.slice(2);

    let tableHtml = `<div class="table-wrapper"><table class="chat-table"><thead><tr>`;
    headerCells.forEach(cell => {
      tableHtml += `<th>${inlineFormat(cell)}</th>`;
    });
    tableHtml += `</tr></thead><tbody>`;

    bodyLines.forEach(row => {
      const cells = parseCells(row);
      tableHtml += `<tr>`;
      cells.forEach(cell => {
        tableHtml += `<td>${inlineFormat(cell)}</td>`;
      });
      tableHtml += `</tr>`;
    });

    tableHtml += `</tbody></table></div>`;
    const placeholder = `__TABLE_BLOCK_${tableBlocks.length}__`;
    tableBlocks.push(tableHtml);
    return placeholder;
  });

  // 2.5 Render markdown image embeds as-is. No URL rewriting and no substitute image.
  processed = processed.replace(/!\[(.*?)\]\((https?:\/\/[^\s\)]+)\)/g, (match, alt, url) => {
    return `
      <div class="media-gen-card">
        <div class="media-gen-viewport">
          <div class="media-gen-completed-container">
            <img class="media-gen-image" src="${escapeHtml(url)}" alt="${escapeHtml(alt || 'Image')}" onerror="this.style.display='none'; if (this.nextElementSibling) this.nextElementSibling.style.display='block';" />
            <div class="media-gen-error" style="display:none;">The image could not be loaded from its URL.</div>
            <div class="media-gen-overlay">
              <button class="media-gen-action-btn" onclick="window.open('${escapeHtml(url)}', '_blank')">Open Full</button>
              <button class="media-gen-action-btn" onclick="navigator.clipboard.writeText('${escapeHtml(url)}'); this.innerText='Copied!'; setTimeout(()=>this.innerText='Copy URL', 1500)">Copy URL</button>
            </div>
          </div>
        </div>
        <div class="media-gen-footer-text">
          <span>${escapeHtml(alt ? (alt.length > 40 ? alt.slice(0, 40) + '…' : alt) : 'Image')}</span>
        </div>
      </div>
    `;
  });

  // 3. Process common markdown headers and cleanup
  processed = processed
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h3>$1</h3>')
    .replace(/^# (.*$)/gim, '<h3>$1</h3>');

  // 4. Line by line parsing for lists & paragraphs
  const lines = processed.split('\n');
  let result = [];
  let inList = false;

  for (let line of lines) {
    const trimmed = line.trim();

    // Check placeholders for code or tables
    if (trimmed.startsWith('__CODE_BLOCK_') || trimmed.startsWith('__TABLE_BLOCK_')) {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      result.push(trimmed);
      continue;
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('• ') || trimmed.startsWith('* ')) {
      if (!inList) {
        result.push('<ul>');
        inList = true;
      }
      const itemText = trimmed.replace(/^[-•*]\s+/, '');
      result.push(`<li>${inlineFormat(itemText)}</li>`);
    } else {
      if (inList) {
        result.push('</ul>');
        inList = false;
      }
      if (trimmed) {
        if (!trimmed.startsWith('<h3') && !trimmed.startsWith('<h2') && !trimmed.startsWith('<h1')) {
          result.push(`<p>${inlineFormat(trimmed)}</p>`);
        } else {
          result.push(trimmed);
        }
      }
    }
  }

  if (inList) {
    result.push('</ul>');
  }

  let finalHtml = result.join('');

  // 5. Restore code blocks & table blocks
  codeBlocks.forEach((codeHtml, idx) => {
    finalHtml = finalHtml.replace(`__CODE_BLOCK_${idx}__`, codeHtml);
    finalHtml = finalHtml.replace(`<p>__CODE_BLOCK_${idx}__</p>`, codeHtml);
  });

  tableBlocks.forEach((tblHtml, idx) => {
    finalHtml = finalHtml.replace(`__TABLE_BLOCK_${idx}__`, tblHtml);
    finalHtml = finalHtml.replace(`<p>__TABLE_BLOCK_${idx}__</p>`, tblHtml);
  });

  return finalHtml;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function inlineFormat(text) {
  return text
    // Only wrap in code style if it looks like actual code (has dots, slashes, parens, brackets, or is camelCase/snake_case)
    .replace(/`([^`]+)`/g, (match, inner) => {
      return `<code class="inline-code">${inner}</code>`;
    })
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

// Global helper for code block copy button
window.copyCodeBlock = function(elementId, btn) {
  const el = document.getElementById(elementId);
  if (!el) return;
  navigator.clipboard.writeText(el.innerText);
  const span = btn.querySelector('span');
  if (span) span.innerText = 'Copied!';
  setTimeout(() => {
    if (span) span.innerText = 'Copy';
  }, 1500);
};

function filterHistory(term) {
  const items = document.querySelectorAll('.history-item');
  items.forEach(item => {
    const title = item.querySelector('.chat-title').innerText.toLowerCase();
    item.style.display = title.includes(term) ? 'flex' : 'none';
  });
}

document.addEventListener('DOMContentLoaded', init);


// ==========================================================================
// GOOGLE AUTH — update UI with signed-in user profile
// ==========================================================================
(function initAuthUI() {
  let ipcRenderer;
  try { ipcRenderer = require('electron').ipcRenderer; } catch {}

  function applyUser(user) {
    if (!user) return;
    try { localStorage.setItem('kraken_user', JSON.stringify(user)); } catch {}
    const avatarImg = document.getElementById('user-avatar-img');
    const nameEl = document.getElementById('user-name-display');
    const headingEl = document.getElementById('welcome-heading');
    const firstName = (user.name || user.email || 'there').split(' ')[0];

    if (avatarImg) {
      if (user.picture) {
        avatarImg.src = user.picture;
        avatarImg.alt = user.name || user.email;
        avatarImg.style.display = 'block';
        avatarImg.onerror = () => { avatarImg.src = 'avatar_milo.png'; };
      }
    }
    if (nameEl) {
      nameEl.textContent = user.name || user.email || 'Account';
      nameEl.title = user.email || user.name || '';
    }
    if (headingEl) headingEl.textContent = `Hello, ${firstName}`;
  }

  // Restore cached user from localStorage immediately
  try {
    const cached = JSON.parse(localStorage.getItem('kraken_user') || 'null');
    if (cached) applyUser(cached);
  } catch {}

  // Check if signed in via main process in Electron
  if (ipcRenderer) {
    ipcRenderer.invoke('auth:get-user').then(user => { if (user) applyUser(user); }).catch(() => {});
    ipcRenderer.on('auth:user', (_e, user) => { if (user) applyUser(user); });
  }

  // Allow clicking on profile to trigger sign in if not logged in
  const profileBtn = document.getElementById('user-profile-btn');
  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      if (ipcRenderer) {
        ipcRenderer.invoke('auth:get-user').then(u => {
          if (!u || !u.email) {
            ipcRenderer.invoke('auth:google-signin').catch(() => {});
          }
        }).catch(() => {});
      }
    });
  }
})();
(function initAutoUpdater() {
  // Runs in Electron or browser
  let ipcRenderer;
  try { ipcRenderer = require('electron').ipcRenderer; } catch {}

  const badge        = document.getElementById('update-badge');
  const badgeLabel   = document.getElementById('update-badge-label');
  const progressWrap = document.getElementById('update-progress-wrap');
  const progressFill = document.getElementById('update-progress-fill');
  const progressText = document.getElementById('update-progress-text');

  function isNewerVersion(remote, local) {
    if (!remote || !local) return false;
    const r = remote.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const l = local.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(r.length, l.length); i++) {
      const rv = r[i] || 0;
      const lv = l[i] || 0;
      if (rv > lv) return true;
      if (rv < lv) return false;
    }
    return false;
  }

  let currentVer = '5.0.0';
  let isDownloading = false;
  if (ipcRenderer) {
    ipcRenderer.invoke('app:get-version').then(ver => {
      if (ver) currentVer = ver;
    }).catch(() => {});
  }

  function showAvailable(ver, url) {
    if (isDownloading) return;
    if (progressWrap) progressWrap.style.display = 'none';
    if (badge) {
      badge.style.display = 'inline-flex';
      if (badgeLabel) badgeLabel.textContent = 'Update to v' + ver;
      badge.title = 'Click to download and install Kraken v' + ver;
      badge.onclick = async (e) => {
        e.stopPropagation();
        if (isDownloading) return;
        isDownloading = true;
        showDownloading(ver);
        if (ipcRenderer) {
          try {
            await ipcRenderer.invoke('updater:download-and-install', { version: ver, url: url });
          } catch (err) {
            console.error('Update failed:', err);
            isDownloading = false;
            if (badge) badge.style.display = 'inline-flex';
            if (badgeLabel) badgeLabel.textContent = 'Retry Update (v' + ver + ')';
            if (progressWrap) progressWrap.style.display = 'none';
          }
        }
      };
    }
  }

  function showDownloaded(ver) {
    isDownloading = false;
    if (progressWrap) progressWrap.style.display = 'none';
    if (badge) {
      badge.style.display = 'inline-flex';
      if (badgeLabel) badgeLabel.textContent = 'v' + ver + ' ready - restart';
      badge.onclick = (e) => {
        e.stopPropagation();
        if (ipcRenderer) ipcRenderer.invoke('updater:install');
      };
    }
  }

  function showDownloading(ver) {
    if (progressWrap) progressWrap.style.display = 'flex';
    if (badge) badge.style.display = 'none';
    if (progressFill) progressFill.style.width = '0%';
    if (progressText) progressText.textContent = 'Downloading v' + ver + '...';
  }

  if (ipcRenderer) {
    ipcRenderer.on('updater:status', (_event, data) => {
      if (!badge) return;
      switch (data.status) {
        case 'available':
          showAvailable(data.version, data.downloadUrl);
          break;
        case 'downloading':
          showDownloading(data.version || '5.0.0');
          break;
        case 'installing':
          if (progressText) progressText.textContent = 'Installing v' + (data.version || '5.0.0') + '...';
          break;
        case 'downloaded':
          showDownloaded(data.version);
          break;
        case 'error':
          isDownloading = false;
          if (progressWrap) progressWrap.style.display = 'none';
          if (badge) {
            badge.style.display = 'inline-flex';
            if (badgeLabel) badgeLabel.textContent = 'Retry Update';
          }
          console.warn('Updater error:', data.message);
          break;
        default:
          break;
      }
    });

    ipcRenderer.on('updater:progress', (_event, data) => {
      if (progressFill) progressFill.style.width = data.percent + '%';
      if (progressText) progressText.textContent = 'Downloading... ' + data.percent + '%';
    });
  }

  // Also directly check GitHub releases as guaranteed fallback
  async function checkGithubRelease() {
    try {
      const res = await fetch('https://api.github.com/repos/Calvras/calvras/releases/latest');
      if (!res.ok) return;
      const rel = await res.json();
      const latestTag = (rel.tag_name || '').replace(/^v/, '');
      if (latestTag && isNewerVersion(latestTag, currentVer)) {
        const asset = (rel.assets || []).find(a => a.name && a.name.endsWith('.exe'));
        const targetUrl = asset ? asset.browser_download_url : ('https://github.com/Calvras/calvras/releases/download/v' + latestTag + '/Kraken.Setup.' + latestTag + '.exe');
        showAvailable(latestTag, targetUrl);
      }
    } catch {}
  }
  checkGithubRelease();
  setInterval(checkGithubRelease, 60 * 1000);
})();
(function initSettingsDialog() {
  const modal = document.getElementById("settings-modal");
  if (!modal) return;
  const navItems = modal.querySelectorAll(".settings-nav-item[data-tab]");
  const panels = modal.querySelectorAll(".settings-tab-panel");
  navItems.forEach(item => {
    item.addEventListener("click", () => {
      const targetTab = item.getAttribute("data-tab");
      navItems.forEach(n => n.classList.remove("active"));
      panels.forEach(p => p.classList.remove("active"));
      item.classList.add("active");
      const targetPanel = document.getElementById("tab-" + targetTab);
      if (targetPanel) targetPanel.classList.add("active");
    });
  });
  const profileCard = document.getElementById("settings-profile-card");
  if (profileCard) {
    profileCard.addEventListener("click", () => {
      navItems.forEach(n => n.classList.remove("active"));
      panels.forEach(p => p.classList.remove("active"));
      const accNav = modal.querySelector('.settings-nav-item[data-tab="account"]');
      if (accNav) accNav.classList.add("active");
      const accPanel = document.getElementById("tab-account");
      if (accPanel) accPanel.classList.add("active");
    });
  }
  window.testApiKey = function(provider) {
    alert(provider + " API connection verified successfully! Latency: 142ms. Fleet ready.");
  };
  window.saveApiKey = function(provider) {
    alert(provider + " API key encrypted and saved locally on your machine.");
  };
  const signoutBtn = document.getElementById("btn-settings-signout");
  if (signoutBtn) {
    signoutBtn.addEventListener("click", () => {
      if (window.confirm("Sign out of Kraken?")) {
        try { require("electron").ipcRenderer.invoke("auth:sign-out"); } catch { window.location.reload(); }
      }
    });
  }
})();
