// ---------- State ----------
const state = {
  apiKey: localStorage.getItem('or_api_key') || '',
  model: localStorage.getItem('or_model') || 'google/gemini-3.7-flash',
  theme: localStorage.getItem('theme') || 'dark',
  format: 'pdf'
};

applyTheme(state.theme);
updatePlanLabel();

// ---------- Auth (real backend — register/login/session are handled by the
// server, which hashes passwords and issues a signed token) ----------
const authScreen = document.getElementById('authScreen');
const appRoot = document.getElementById('appRoot');
const authTitle = document.getElementById('authTitle');
const authSub = document.getElementById('authSub');
const authName = document.getElementById('authName');
const authNameLabel = authName.previousElementSibling;
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authError = document.getElementById('authError');
const authSubmit = document.getElementById('authSubmit');
const authSwitchText = document.getElementById('authSwitchText');
const authSwitchBtn = document.getElementById('authSwitchBtn');

let authMode = 'register'; // or 'login'
let currentUser = null; // { id, name, email }

function getAuthToken() {
  return localStorage.getItem('auth_token');
}
function setAuthToken(token) {
  localStorage.setItem('auth_token', token);
}
function clearAuthToken() {
  localStorage.removeItem('auth_token');
}

// Attach the token to any API call automatically.
async function apiFetch(path, options = {}) {
  const token = getAuthToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showAuth() {
  authScreen.classList.remove('hidden');
  appRoot.classList.add('hidden');
}
function showApp() {
  authScreen.classList.add('hidden');
  appRoot.classList.remove('hidden');
}

function setAuthMode(mode) {
  authMode = mode;
  authError.classList.add('hidden');
  if (mode === 'register') {
    authTitle.textContent = 'Create your account';
    authSub.textContent = 'Sign up to start generating documents';
    authNameLabel.style.display = 'block';
    authName.style.display = 'block';
    authSubmit.textContent = 'Create account';
    authSwitchText.textContent = 'Already have an account?';
    authSwitchBtn.textContent = 'Log in';
  } else {
    authTitle.textContent = 'Welcome back';
    authSub.textContent = 'Log in to continue';
    authNameLabel.style.display = 'none';
    authName.style.display = 'none';
    authSubmit.textContent = 'Log in';
    authSwitchText.textContent = "Don't have an account?";
    authSwitchBtn.textContent = 'Sign up';
  }
}

authSwitchBtn.addEventListener('click', () => {
  setAuthMode(authMode === 'register' ? 'login' : 'register');
});

// Allow pressing Enter in any auth field to submit
[authName, authEmail, authPassword].forEach(input => {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      authSubmit.click();
    }
  });
});

authSubmit.addEventListener('click', async () => {
  const email = authEmail.value.trim().toLowerCase();
  const password = authPassword.value;
  const name = authName.value.trim();

  if (!email || !password) {
    authError.textContent = 'Please fill in email and password.';
    authError.classList.remove('hidden');
    return;
  }
  if (authMode === 'register' && !name) {
    authError.textContent = 'Please enter your name.';
    authError.classList.remove('hidden');
    return;
  }

  authSubmit.disabled = true;
  const originalLabel = authSubmit.textContent;
  authSubmit.textContent = authMode === 'register' ? 'Creating account…' : 'Logging in…';

  try {
    const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body = authMode === 'register' ? { name, email, password } : { email, password };
    const data = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body) });
    setAuthToken(data.token);
    onLoginSuccess(data.user);
  } catch (err) {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = originalLabel;
  }
});

function onLoginSuccess(user) {
  currentUser = user;
  document.getElementById('planLabel').textContent = state.apiKey ? `Model: ${state.model}` : 'No API key set';
  const userNameEl = document.querySelector('.user-name');
  if (userNameEl) userNameEl.textContent = user.name || 'Account';
  const avatarEl = document.querySelector('.avatar');
  if (avatarEl) avatarEl.textContent = (user.name || 'U').charAt(0).toUpperCase();
  showApp();
}

// On load: if a token is stored, verify it's still valid with the server
// (rather than trusting it blindly) before showing the app.
(async function checkExistingSession() {
  const token = getAuthToken();
  if (!token) {
    setAuthMode('register');
    showAuth();
    return;
  }
  try {
    const data = await apiFetch('/api/auth/me');
    onLoginSuccess(data.user);
  } catch {
    clearAuthToken();
    setAuthMode('login');
    showAuth();
  }
})();

// ---------- Logout (defined early so it's available once auth resolves) ----------
function performLogout() {
  clearAuthToken();
  authEmail.value = '';
  authPassword.value = '';
  authName.value = '';
  currentUser = null;
  setAuthMode('login');
  showAuth();
}

// ---------- Elements ----------
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('overlay');
const openSidebarBtn = document.getElementById('openSidebar');
const closeSidebarBtn = document.getElementById('closeSidebar');
const newChatBtn = document.getElementById('newChatBtn');

const settingsModal = document.getElementById('settingsModal');
const openSettingsBtn = document.getElementById('openSettings');
const closeSettingsBtn = document.getElementById('closeSettings');
const saveSettingsBtn = document.getElementById('saveSettings');
const apiKeyInput = document.getElementById('apiKeyInput');
const modelInput = document.getElementById('modelInput');

const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const messagesEl = document.getElementById('messages');
const greetingEl = document.getElementById('greeting');
const formatRow = document.getElementById('formatRow');

apiKeyInput.value = state.apiKey;
modelInput.value = state.model;
document.querySelectorAll('.theme-btn').forEach(btn => {
  if (btn.dataset.theme === state.theme) btn.classList.add('active');
  btn.addEventListener('click', () => {
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyTheme(btn.dataset.theme);
  });
});

// ---------- Logout ----------
const logoutBtn = document.getElementById('logoutBtn');
logoutBtn.addEventListener('click', () => {
  performLogout();
  closeSidebar();
});

// ---------- Sidebar toggle ----------
function openSidebar() {
  sidebar.classList.add('open');
  overlay.classList.add('show');
  openSidebarBtn.classList.add('hidden-btn');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  overlay.classList.remove('show');
  openSidebarBtn.classList.remove('hidden-btn');
}
openSidebarBtn.addEventListener('click', openSidebar);
closeSidebarBtn.addEventListener('click', closeSidebar);
overlay.addEventListener('click', () => { closeSidebar(); closeSettings(); });

newChatBtn.addEventListener('click', () => {
  startNewConversation();
  closeSidebar();
});

// ---------- Settings modal ----------
function openSettings() { settingsModal.classList.remove('hidden'); }
function closeSettings() { settingsModal.classList.add('hidden'); }
openSettingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', closeSettings);

saveSettingsBtn.addEventListener('click', () => {
  state.apiKey = apiKeyInput.value.trim();
  state.model = modelInput.value.trim() || 'openai/gpt-4o-mini';
  localStorage.setItem('or_api_key', state.apiKey);
  localStorage.setItem('or_model', state.model);
  updatePlanLabel();
  closeSettings();
});

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
}

function updatePlanLabel() {
  document.getElementById('planLabel').textContent = state.apiKey
    ? `Model: ${state.model}`
    : 'No API key set';
}

// ---------- Format selection ----------
formatRow.addEventListener('click', (e) => {
  const chip = e.target.closest('.format-chip');
  if (!chip) return;
  document.querySelectorAll('.format-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  state.format = chip.dataset.format;
});

// ---------- Quick-start templates ----------
document.getElementById('templateChips').addEventListener('click', (e) => {
  const chip = e.target.closest('.template-chip');
  if (!chip) return;
  promptInput.value = chip.dataset.template;
  promptInput.dispatchEvent(new Event('input')); // trigger auto-resize
  promptInput.focus();

  // Nudge the format chip toward what the template implies, when obvious.
  const impliedFormat = detectExplicitFormat(chip.dataset.template);
  if (impliedFormat) {
    document.querySelectorAll('.format-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.format === impliedFormat);
    });
    state.format = impliedFormat;
  }
});

// ---------- Chat sessions (each = one conversation, with its own messages) ----------
let sessions = JSON.parse(localStorage.getItem('chat_sessions') || '[]');
let currentSessionId = null;

function saveSessions() {
  // Cap how many sessions we keep so localStorage doesn't grow unbounded.
  sessions = sessions.slice(0, 40);
  localStorage.setItem('chat_sessions', JSON.stringify(sessions));
}

function renderHistory() {
  const list = document.getElementById('historyList');
  list.innerHTML = '';
  sessions.forEach(session => {
    const el = document.createElement('div');
    el.className = 'history-item' + (session.id === currentSessionId ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = session.title;
    el.appendChild(label);

    const delBtn = document.createElement('button');
    delBtn.className = 'history-delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete conversation';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(session.id);
    });
    el.appendChild(delBtn);

    el.addEventListener('click', () => loadSession(session.id));
    list.appendChild(el);
  });
}

function deleteSession(id) {
  sessions = sessions.filter(s => s.id !== id);
  saveSessions();
  if (currentSessionId === id) {
    startNewConversation();
  } else {
    renderHistory();
  }
}

function loadSession(id) {
  const session = sessions.find(s => s.id === id);
  if (!session) return;
  currentSessionId = id;
  conversation = session.messages.map(m => ({ role: m.role, content: m.content }));
  messagesEl.innerHTML = '';
  greetingEl.style.display = 'none';
  session.messages.forEach(m => {
    if (m.role === 'user') {
      let html = escapeHtml(m.content).replace(/\n/g, '<br>');
      if (m.attachmentNames && m.attachmentNames.length) {
        const names = m.attachmentNames.map(n => `📄 ${escapeHtml(n)}`).join(', ');
        html += `<div class="msg-attachments-note">Attached: ${names} <em>(not recoverable after reload — re-attach if needed)</em></div>`;
      }
      addMessage('user', html);
    } else {
      const el = addMessage('assistant', '');
      if (m.fileInfo) {
        el.innerHTML = `Here's your document.` + fileCardHtml(m.fileInfo.filename, m.fileInfo.format);
        // Note: the actual file blob isn't kept in storage (too large) —
        // regenerate on demand if they click Download after reloading a session.
        el.querySelector('.download-btn').addEventListener('click', () => {
          alert('This file was generated earlier in a previous session and is no longer cached. Ask me to generate it again to download it.');
        });
      } else {
        const textHtml = formatAssistantText(m.content);
        el.innerHTML = `<div class="msg-formatted">${textHtml}</div>` + copyBtnHtml();
        attachCopy(el, m.content);
      }
    }
  });
  renderHistory();
  closeSidebar();
  scrollToBottom();
}

function startNewConversation() {
  currentSessionId = null;
  conversation = [];
  messagesEl.innerHTML = '';
  greetingEl.style.display = '';
  renderHistory();
}

function upsertCurrentSession(userText) {
  let session = sessions.find(s => s.id === currentSessionId);
  if (!session) {
    session = {
      id: 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      title: userText.slice(0, 60),
      messages: [],
      updatedAt: Date.now()
    };
    sessions.unshift(session);
    currentSessionId = session.id;
  }
  return session;
}

renderHistory();
// ---------- Chat input ----------
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + 'px';
});
promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});
sendBtn.addEventListener('click', handleSend);

// Conversation memory: full back-and-forth sent with every request so the
// model has context instead of treating each message in isolation.
let conversation = [];

// ---------- File attachments ----------
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const attachmentRow = document.getElementById('attachmentRow');
let pendingAttachments = []; // { id, name, kind: 'image'|'text', dataUrl?, textContent? }
let lastFileContext = null; // { name, text } — cached full text of the most recent text attachment, kept OUT of the resent conversation history to save tokens

const TEXT_FILE_EXTENSIONS = ['.txt', '.csv', '.md', '.json', '.log'];
const MAX_TEXT_CHARS = 12000; // keep prompt sizes sane

attachBtn?.addEventListener('click', () => fileInput?.click());

fileInput?.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = ''; // allow re-selecting the same file later

  for (const file of files) {
    const isImage = file.type.startsWith('image/');
    const isText = TEXT_FILE_EXTENSIONS.some(ext => file.name.toLowerCase().endsWith(ext));

    if (!isImage && !isText) {
      alert(`"${file.name}" isn't a supported type yet. You can attach images, or text-based files (.txt, .csv, .md, .json, .log).`);
      continue;
    }

    const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

    if (isImage) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      pendingAttachments.push({ id, name: file.name, kind: 'image', dataUrl });
    } else {
      let text = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(file);
      });
      let truncated = false;
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
        truncated = true;
      }
      pendingAttachments.push({ id, name: file.name, kind: 'text', textContent: text, truncated });
    }
  }

  renderAttachmentRow();
});

function attachmentChipHtml(att) {
  const icon = att.kind === 'image'
    ? `<img src="${att.dataUrl}" alt="">`
    : `<span>📄</span>`;
  return `
    <div class="attachment-chip" data-id="${att.id}">
      ${icon}
      <span class="attachment-name">${escapeHtml(att.name)}</span>
      <button class="attachment-remove" data-remove="${att.id}" title="Remove">✕</button>
    </div>`;
}

function renderAttachmentRow() {
  if (!attachmentRow) return;
  const hasPending = pendingAttachments.length > 0;
  const showReuseChip = !hasPending && lastFileContext;

  if (!hasPending && !showReuseChip) {
    attachmentRow.classList.add('hidden');
    attachmentRow.innerHTML = '';
    return;
  }

  attachmentRow.classList.remove('hidden');

  if (hasPending) {
    attachmentRow.innerHTML = pendingAttachments.map(attachmentChipHtml).join('');
    attachmentRow.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter(a => a.id !== btn.dataset.remove);
        renderAttachmentRow();
      });
    });
  } else if (showReuseChip) {
    attachmentRow.innerHTML = `
      <button class="attachment-chip reuse-chip" id="reuseFileBtn" title="Re-attach without re-uploading — free, no re-reading from disk">
        📄 <span class="attachment-name">${escapeHtml(lastFileContext.name)}</span>
        <span class="reuse-label">↺ reuse</span>
      </button>`;
    document.getElementById('reuseFileBtn').addEventListener('click', () => {
      pendingAttachments.push({
        id: 'att_' + Date.now(),
        name: lastFileContext.name,
        kind: 'text',
        textContent: lastFileContext.text
      });
      renderAttachmentRow();
    });
  }
}


function scrollToBottom() {
  const chatArea = document.getElementById('chatArea');
  // Wait a frame so the browser has laid out the new/updated content
  // before we measure scrollHeight — fixes stale scroll position when
  // a placeholder message grows after being replaced with real content.
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

function addMessage(role, html, isError = false) {
  greetingEl.style.display = 'none';
  const el = document.createElement('div');
  el.className = `msg ${role}` + (isError ? ' error' : '');
  el.innerHTML = html;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function copyBtnHtml() {
  return `<button class="copy-btn" title="Copy">⧉</button>`;
}

function attachCopy(container, text) {
  const btn = container.querySelector('.copy-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⧉'; }, 1200);
    });
  });
}

async function handleSend() {
  const prompt = promptInput.value.trim();
  if (!prompt && pendingAttachments.length === 0) return;

  if (!state.apiKey) {
    openSettings();
    return;
  }

  // Capture the chip selection at the moment of sending, so it can't be
  // affected by anything that changes state.format later in this same flow.
  const selectedFormatAtSend = state.format;

  const attachmentsForThisMessage = pendingAttachments;
  pendingAttachments = [];
  renderAttachmentRow();

  const sessionTitleSource = prompt || (attachmentsForThisMessage[0]?.name || 'New conversation');
  const session = upsertCurrentSession(sessionTitleSource);

  // Build what actually gets shown in the chat bubble: the typed text plus
  // small preview chips for any attached files.
  const displayText = prompt || (attachmentsForThisMessage.length ? 'Attached file(s):' : '');
  const attachmentsHtml = attachmentsForThisMessage.length
    ? `<div class="msg-attachments">${attachmentsForThisMessage.map(attachmentChipHtml).join('')}</div>`
    : '';
  addMessage('user', escapeHtml(displayText).replace(/\n/g, '<br>') + attachmentsHtml);

  // Build what actually gets SENT to the model. Text-file contents get
  // appended as readable context; images become real vision content blocks
  // (only works if the selected model supports vision — otherwise the API
  // will return a clear error, which the existing error handling surfaces).
  const textAttachments = attachmentsForThisMessage.filter(a => a.kind === 'text');
  const imageAttachments = attachmentsForThisMessage.filter(a => a.kind === 'image');

  let combinedText = prompt;
  textAttachments.forEach(a => {
    combinedText += `\n\n--- Attached file: ${a.name}${a.truncated ? ' (truncated)' : ''} ---\n${a.textContent}\n--- end of ${a.name} ---`;
  });
  if (!combinedText.trim() && imageAttachments.length) {
    combinedText = 'Please look at the attached image(s).';
  }

  const userContent = imageAttachments.length
    ? [
        { type: 'text', text: combinedText },
        ...imageAttachments.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } }))
      ]
    : combinedText;

  const userMessageEntry = { role: 'user', content: userContent };
  conversation.push(userMessageEntry);
  // Store a lightweight version in the session — full image data URLs are
  // large, so only filenames are persisted (consistent with how generated
  // files already work: re-attach or regenerate rather than caching forever).
  session.messages.push({
    role: 'user',
    content: displayText,
    attachmentNames: attachmentsForThisMessage.map(a => a.name)
  });

  // Cache the raw text now (before this turn's entry gets compressed below),
  // so a later message can cheaply bring it back via the "reuse" chip
  // without re-reading the file or paying to resend it on every turn.
  if (textAttachments.length && imageAttachments.length === 0) {
    lastFileContext = {
      name: textAttachments.map(a => a.name).join(', '),
      text: textAttachments.map(a => `--- ${a.name} ---\n${a.textContent}`).join('\n\n')
    };
  }

  promptInput.value = '';
  promptInput.style.height = 'auto';

  const loadingEl = addMessage('assistant', 'Thinking…');
  sendBtn.disabled = true;

  const setStatus = (text) => {
    loadingEl.textContent = text;
    scrollToBottom();
  };

  try {
    let result;
    try {
      result = await callOpenRouter(state.format, setStatus);
    } catch (parseErr) {
      // A malformed-JSON failure (the most common real cause: raw LaTeX-style
      // backslashes in math content breaking JSON string escaping) is worth
      // one automatic corrective retry before surfacing an error — this is
      // exactly the failure mode that used to dead-end on "do it again".
      if (/valid JSON|unexpected response shape/i.test(parseErr.message)) {
        setStatus('That response was malformed — retrying…');
        conversation.push({
          role: 'user',
          content: 'Your last response was not valid JSON — likely due to unescaped backslashes from LaTeX-style math notation (e.g. \\frac, \\times). Respond again with ONLY strict, valid JSON in the exact format specified. For math, use the ^() and _() notation instead of LaTeX/backslashes.'
        });
        result = await callOpenRouter(state.format, setStatus);
        conversation.pop(); // remove the corrective nudge from stored history
      } else {
        throw parseErr;
      }
    }

    if (result.action === 'reply') {
      // Plain conversational response — no file generated.
      const textHtml = formatAssistantText(result.message);
      loadingEl.innerHTML = `<div class="msg-formatted">${textHtml}</div>` + copyBtnHtml();
      attachCopy(loadingEl, result.message);
      conversation.push({ role: 'assistant', content: result.message });
      session.messages.push({ role: 'assistant', content: result.message });
    } else {
      // action === 'generate' — determine format deterministically rather
      // than fully trusting the model: only let the CURRENT message's own
      // words override the button, never something mentioned earlier in
      // the conversation history.
      const formatMentionedNow = detectExplicitFormat(prompt);
      const chosenFormat = formatMentionedNow || selectedFormatAtSend;

      // Some models occasionally return a stub schema (just a title, no
      // real content). Rather than surface that as an error immediately,
      // give it one automatic corrective retry before giving up.
      try {
        validateSchemaHasContent(result.schema);
      } catch (emptyErr) {
        setStatus('That came back thin — writing more detail…');
        conversation.push({
          role: 'user',
          content: 'Your last response had an empty/placeholder document with no real content. Please write out the FULL requested content now, in the same JSON format.'
        });
        result = await callOpenRouter(state.format, setStatus);
        conversation.pop(); // remove the corrective nudge from stored history
        if (result.action !== 'generate') {
          throw new Error('The model could not produce the document content. Try rephrasing your request or switching models in Settings.');
        }
      }

      setStatus('Building the file…');
      const { blob, filename } = await buildDocument(result.schema, chosenFormat);

      const docId = 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      generatedDocs.set(docId, { schema: result.schema, format: chosenFormat, filename, blob });

      loadingEl.innerHTML = `Here's your document — double-tap any text or cell below to edit it.`
        + fileCardHtml(filename, chosenFormat, docId)
        + renderInlineDoc(docId);
      const assistantNote = `[Generated ${chosenFormat.toUpperCase()} document: ${filename}]`;
      conversation.push({ role: 'assistant', content: assistantNote });
      session.messages.push({ role: 'assistant', content: assistantNote, fileInfo: { filename, format: chosenFormat } });

      // Keep the format chips in sync with what was actually generated.
      if (chosenFormat !== state.format) {
        state.format = chosenFormat;
        document.querySelectorAll('.format-chip').forEach(c => {
          c.classList.toggle('active', c.dataset.format === chosenFormat);
        });
      }
    }

    session.updatedAt = Date.now();
    saveSessions();
    renderHistory();
    scrollToBottom();
  } catch (err) {
    console.error(err);
    loadingEl.classList.add('error');
    loadingEl.textContent = 'Something went wrong: ' + err.message;
    scrollToBottom();
  } finally {
    sendBtn.disabled = false;

    // Compress this turn's stored content now that the API call has already
    // used the full text — every future resend of conversation history will
    // use this cheap placeholder instead of paying for the file again.
    if (textAttachments.length && imageAttachments.length === 0) {
      userMessageEntry.content = (prompt || '(attached a file)')
        + `\n\n[Attached file(s): ${textAttachments.map(a => a.name).join(', ')} — full text omitted from context to save tokens. If needed again, ask the user to use the "reuse" option to re-attach it.]`;
      renderAttachmentRow(); // reveal the reuse chip now that lastFileContext is set
    }
  }
}

// In-memory store of generated documents, keyed by a short id. Holds the
// structured schema (so the inline editor can modify real content) and the
// current blob (kept in sync whenever an edit regenerates the file).
// Lost on page reload — consistent with how downloads already worked.
const generatedDocs = new Map();

function fileCardHtml(filename, format, docId) {
  const icons = { pdf: '📄', docx: '📝', xlsx: '📊' };
  return `
    <div class="file-card">
      <div class="file-icon">${icons[format]}</div>
      <div class="file-meta">
        <div class="file-name" data-filename-for="${docId || ''}">${filename}</div>
        <div class="file-type">${format.toUpperCase()} document</div>
      </div>
      <button class="download-btn" data-doc-id="${docId || ''}">Download</button>
    </div>`;
}

// Fallback for reloaded sessions where no cached blob/docId exists.
function attachDownload(container, blob, filename) {
  const btn = container.querySelector('.download-btn');
  btn.addEventListener('click', () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
}

// One delegated handler for every "fresh" download button (has a data-doc-id)
// covers all current and future file cards — pulls the CURRENT blob at click
// time, so it stays correct even after the user has edited the document.
messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.download-btn[data-doc-id]');
  if (!btn || !btn.dataset.docId) return;
  const doc = generatedDocs.get(btn.dataset.docId);
  if (!doc || !doc.blob) return;
  const url = URL.createObjectURL(doc.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = doc.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---------- Inline document editor ----------
// Renders the document's actual structured content directly in the chat
// message as an editable preview — double-click any text or table cell to
// edit it in place, no separate window. Edits regenerate the real file
// (debounced) and keep the Download button pointed at the latest blob.

function getAtPath(obj, path) {
  return path.reduce((o, key) => (o == null ? o : o[key]), obj);
}
function setAtPath(obj, path, value) {
  let target = obj;
  for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
  target[path[path.length - 1]] = value;
}

function editableField(path, rawText, className, multiline) {
  const pathAttr = JSON.stringify(path).replace(/"/g, '&quot;');
  const rendered = renderRichText(escapeHtml(rawText || ''));
  return `<${multiline ? 'div' : 'span'} class="${className} inline-editable" data-path="${pathAttr}" data-multiline="${!!multiline}">${rendered || '<span class="inline-empty">(empty — double-tap to add text)</span>'}</${multiline ? 'div' : 'span'}>`;
}

function renderInlineDoc(docId) {
  const doc = generatedDocs.get(docId);
  if (!doc) return '';
  const s = doc.schema;
  let html = `<div class="inline-doc" data-doc-id="${escapeHtml(docId)}">`;

  html += editableField(['title'], s.title || 'Document', 'inline-doc-title');

  html += `<div class="inline-doc-sections">`;
  (s.sections || []).forEach((sec, si) => {
    html += `<div class="inline-doc-section">`;
    html += editableField(['sections', si, 'heading'], sec.heading || '', 'inline-doc-heading');
    (sec.paragraphs || []).forEach((p, pi) => {
      html += editableField(['sections', si, 'paragraphs', pi], p, 'inline-doc-paragraph', true);
    });
    html += `<button class="inline-add-btn" data-add-paragraph="${si}">+ paragraph</button>`;
    html += `</div>`;
  });
  html += `</div>`;
  html += `<button class="inline-add-btn inline-add-section">+ Add section</button>`;

  if (s.table && s.table.headers) {
    html += `<div class="inline-table-wrap"><table class="inline-doc-table"><thead><tr>`;
    s.table.headers.forEach((h, hi) => {
      html += `<th>${editableField(['table', 'headers', hi], String(h), 'inline-doc-cell')}</th>`;
    });
    html += `</tr></thead><tbody>`;
    (s.table.rows || []).forEach((row, ri) => {
      html += `<tr>`;
      row.forEach((cell, ci) => {
        html += `<td>${editableField(['table', 'rows', ri, ci], String(cell), 'inline-doc-cell')}</td>`;
      });
      html += `</tr>`;
    });
    html += `</tbody></table></div>`;
    html += `<button class="inline-add-btn inline-add-row">+ Add row</button>`;
  }

  html += `<span class="inline-save-indicator" data-save-indicator></span>`;
  html += `</div>`;
  return html;
}

const regenerateTimers = new Map(); // docId -> timeout handle, for debouncing

function scheduleRegenerate(docId, indicatorEl) {
  if (indicatorEl) { indicatorEl.textContent = 'Editing…'; indicatorEl.className = 'inline-save-indicator pending'; }
  clearTimeout(regenerateTimers.get(docId));
  regenerateTimers.set(docId, setTimeout(() => regenerateInlineDoc(docId, indicatorEl), 600));
}

async function regenerateInlineDoc(docId, indicatorEl) {
  const doc = generatedDocs.get(docId);
  if (!doc) return;
  try {
    validateSchemaHasContent(doc.schema);
    const { blob, filename } = await buildDocument(doc.schema, doc.format);
    doc.blob = blob;
    doc.filename = filename;
    document.querySelectorAll(`[data-filename-for="${docId}"]`).forEach(el => { el.textContent = filename; });
    if (indicatorEl) {
      indicatorEl.textContent = '✓ Saved';
      indicatorEl.className = 'inline-save-indicator saved';
      setTimeout(() => { indicatorEl.textContent = ''; indicatorEl.className = 'inline-save-indicator'; }, 1500);
    }
  } catch (err) {
    if (indicatorEl) {
      indicatorEl.textContent = 'Could not save — ' + err.message;
      indicatorEl.className = 'inline-save-indicator error';
    }
  }
}

function commitInlineEdit(fieldEl) {
  const docEl = fieldEl.closest('.inline-doc');
  const docId = docEl.dataset.docId;
  const doc = generatedDocs.get(docId);
  if (!doc) return;

  const path = JSON.parse(fieldEl.dataset.path);
  const input = fieldEl.querySelector('.inline-edit-input');
  const value = input ? input.value : '';
  setAtPath(doc.schema, path, value);

  fieldEl.innerHTML = renderRichText(escapeHtml(value)) || '<span class="inline-empty">(empty — double-tap to add text)</span>';
  fieldEl.classList.remove('inline-editing');

  scheduleRegenerate(docId, docEl.querySelector('[data-save-indicator]'));
}

function startInlineEdit(fieldEl) {
  if (fieldEl.classList.contains('inline-editing')) return;
  const docEl = fieldEl.closest('.inline-doc');
  const docId = docEl.dataset.docId;
  const doc = generatedDocs.get(docId);
  if (!doc) return;

  const path = JSON.parse(fieldEl.dataset.path);
  const currentValue = getAtPath(doc.schema, path) || '';
  const multiline = fieldEl.dataset.multiline === 'true';

  fieldEl.classList.add('inline-editing');
  const tag = multiline ? 'textarea' : 'input';
  fieldEl.innerHTML = `<${tag} class="inline-edit-input">${multiline ? escapeHtml(currentValue) : ''}</${tag}>`;
  const input = fieldEl.querySelector('.inline-edit-input');
  if (!multiline) input.value = currentValue;
  input.focus();
  input.select();

  const commit = () => commitInlineEdit(fieldEl);
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !multiline) { e.preventDefault(); input.blur(); }
    if (e.key === 'Enter' && multiline && (e.ctrlKey || e.metaKey)) { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      fieldEl.innerHTML = renderRichText(escapeHtml(currentValue)) || '<span class="inline-empty">(empty — double-tap to add text)</span>';
      fieldEl.classList.remove('inline-editing');
    }
  });
}

// Delegated listeners cover every current and future inline-doc, generated
// at any point in the conversation, without attaching per-message handlers.
messagesEl.addEventListener('dblclick', (e) => {
  const field = e.target.closest('.inline-editable');
  if (field) startInlineEdit(field);
});

messagesEl.addEventListener('click', (e) => {
  const addParaBtn = e.target.closest('[data-add-paragraph]');
  if (addParaBtn) {
    const docEl = addParaBtn.closest('.inline-doc');
    const doc = generatedDocs.get(docEl.dataset.docId);
    const si = Number(addParaBtn.dataset.addParagraph);
    if (!doc.schema.sections[si].paragraphs) doc.schema.sections[si].paragraphs = [];
    doc.schema.sections[si].paragraphs.push('');
    rerenderInlineDoc(docEl);
    return;
  }
  const addSectionBtn = e.target.closest('.inline-add-section');
  if (addSectionBtn) {
    const docEl = addSectionBtn.closest('.inline-doc');
    const doc = generatedDocs.get(docEl.dataset.docId);
    if (!doc.schema.sections) doc.schema.sections = [];
    doc.schema.sections.push({ heading: '', paragraphs: [''] });
    rerenderInlineDoc(docEl);
    return;
  }
  const addRowBtn = e.target.closest('.inline-add-row');
  if (addRowBtn) {
    const docEl = addRowBtn.closest('.inline-doc');
    const doc = generatedDocs.get(docEl.dataset.docId);
    doc.schema.table.rows.push(doc.schema.table.headers.map(() => ''));
    rerenderInlineDoc(docEl);
    scheduleRegenerate(docEl.dataset.docId, docEl.querySelector('[data-save-indicator]'));
  }
});

function rerenderInlineDoc(docEl) {
  const docId = docEl.dataset.docId;
  docEl.outerHTML = renderInlineDoc(docId);
  scrollToBottom();
}

// Checks ONLY the given message text (not conversation history) for an
// explicit format mention, so an old message can't make a format "stick"
// across turns. Returns 'pdf' | 'docx' | 'xlsx' | null.
function detectExplicitFormat(text) {
  if (/\b(docx|word doc|word document|\.docx)\b/i.test(text)) return 'docx';
  if (/\b(xlsx|excel|spreadsheet|\.xlsx)\b/i.test(text)) return 'xlsx';
  if (/\b(pdf|\.pdf)\b/i.test(text)) return 'pdf';
  return null;
}

// Shared inline-formatting parser used by chat rendering, PDF, DOCX, and XLSX
// generation, so **bold**, *italic*, `code`, ^superscript, and _subscript
// syntax gets converted consistently everywhere instead of showing as raw
// asterisks/carets in some outputs and not others.
function parseInlineSegments(text) {
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\^\(([^)]+)\)|\^([A-Za-z0-9+\-=]+)|_\(([^)]+)\)|_([A-Za-z0-9+\-=]+)/g;
  const segments = [];
  let lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIndex) segments.push({ text: text.slice(lastIndex, m.index) });
    if (m[1] !== undefined) segments.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) segments.push({ text: m[2], italic: true });
    else if (m[3] !== undefined) segments.push({ text: m[3], code: true });
    else if (m[4] !== undefined) segments.push({ text: m[4], superscript: true });
    else if (m[5] !== undefined) segments.push({ text: m[5], superscript: true });
    else if (m[6] !== undefined) segments.push({ text: m[6], subscript: true });
    else if (m[7] !== undefined) segments.push({ text: m[7], subscript: true });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  if (segments.length === 0) segments.push({ text });
  return segments;
}

const SUPERSCRIPT_MAP = { '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ' };
const SUBSCRIPT_MAP = { '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','=':'₌','(':'₍',')':'₎','a':'ₐ','e':'ₑ','o':'ₒ','x':'ₓ' };

// PDF and XLSX can't do true superscript/subscript formatting, so approximate
// with unicode super/sub characters (covers digits and common math symbols,
// which is the vast majority of real formula use — exponents, H2O, CO2, etc).
function toUnicodeMapped(str, map) {
  return str.split('').map(ch => map[ch.toLowerCase()] || ch).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Lightweight markdown renderer for assistant chat replies — supports
// **bold**, `code`, bullet lists (- or *), numbered lists, and paragraphs.
// Escapes HTML first so this is safe against injection, then layers markdown
// syntax on top of the escaped text.
// Renders **bold**, *italic*, `code`, ^sup, _sub as real inline HTML.
// `text` should already be HTML-escaped (this only handles markdown-style
// syntax on top, never raw HTML). Shared by chat replies and the inline
// document editor so formatting looks identical everywhere.
function renderRichText(text) {
  return parseInlineSegments(text).map(seg => {
    const t = seg.text;
    if (seg.bold) return `<strong>${t}</strong>`;
    if (seg.italic) return `<em>${t}</em>`;
    if (seg.code) return `<code>${t}</code>`;
    if (seg.superscript) return `<sup>${t}</sup>`;
    if (seg.subscript) return `<sub>${t}</sub>`;
    return t;
  }).join('');
}

function formatAssistantText(raw) {
  const escaped = escapeHtml(raw);
  const lines = escaped.split('\n');

  let html = '';
  let listType = null; // 'ul' | 'ol' | null
  let paragraphBuffer = [];

  function flushParagraph() {
    if (paragraphBuffer.length) {
      html += `<p>${paragraphBuffer.join('<br>')}</p>`;
      paragraphBuffer = [];
    }
  }
  function closeList() {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  }
  const inline = renderRichText;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      flushParagraph();
      closeList();
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)/);
    const numberedMatch = line.match(/^\d+\.\s+(.*)/);
    const headingMatch = line.match(/^(#{1,3})\s+(.*)/);

    if (headingMatch) {
      flushParagraph();
      closeList();
      const level = Math.min(headingMatch[1].length + 2, 5); // h3..h5
      html += `<h${level}>${inline(headingMatch[2])}</h${level}>`;
    } else if (bulletMatch) {
      flushParagraph();
      if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
      html += `<li>${inline(bulletMatch[1])}</li>`;
    } else if (numberedMatch) {
      flushParagraph();
      if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
      html += `<li>${inline(numberedMatch[1])}</li>`;
    } else {
      closeList();
      paragraphBuffer.push(inline(line));
    }
  }
  flushParagraph();
  closeList();

  return html || inline(escaped);
}

// ---------- OpenRouter call ----------
// The model first decides whether it has enough info to generate a document,
// or whether it should just reply conversationally (ask questions, chat, etc).
async function callOpenRouter(defaultFormat, onStatus) {
  const systemPrompt = `You are a helpful assistant inside a document-generation app. The currently selected format button in the UI is ${defaultFormat.toUpperCase()}.

Format priority rule (important): use ${defaultFormat.toUpperCase()} unless the user's MOST RECENT message explicitly names a different format (e.g. says "docx", "word doc", "excel", "spreadsheet", "pdf"). Only the latest message counts for this — if a format was mentioned earlier in the conversation but the UI button has since changed and the latest message doesn't repeat a format, follow the current button (${defaultFormat.toUpperCase()}), not the older mention. Don't let an earlier turn's format "stick" across messages.

Decide whether you're just chatting/need more info, or are ready to generate, then respond with ONLY one strict JSON object, no markdown, no code fences, no commentary outside the JSON:

Case 1 — just chatting, or you need more details before generating (missing key info like names, amounts, dates, recipient, etc):
{ "action": "reply", "message": "your conversational response, e.g. a greeting or a clarifying question" }

Case 2 — you have enough information to actually produce the document now:
{
  "action": "generate",
  "format": "pdf" | "docx" | "xlsx",
  "schema": {
    "title": "string",
    "sections": [ { "heading": "string or empty", "paragraphs": ["string", "..."] } ],
    "table": { "headers": ["string", "..."], "rows": [["string", "..."]] }
  }
}

Rules:
- "format" follows the priority rule above: the latest message's explicit format if given, otherwise ${defaultFormat} (the UI default) — never an older message's format.
- Only use "generate" when the user has actually asked for a document and given enough concrete detail to make it useful (not just a greeting like "hello").
- When you use "generate", you MUST fully write out the real, complete content requested — every question, every paragraph, every row. Never return a schema with just a title and empty/placeholder sections — that produces a blank, useless document. If the request is large (e.g. "5 multiple choice questions" or "2 pages"), write all of it out in full inside "sections" or "table", not a summary or a promise to do it.
- For quiz/question content: put each question and its answer choices as its own paragraph (or a short section), and write real question text and real options — not placeholders like "Question 1 here."
- Formatting syntax you can use inside any paragraph/heading/cell text, and it will render properly (not as literal symbols): **bold**, *italic*, \`code\`, ^(text) or ^x for superscript/exponents, _(text) or _x for subscript. Use real unicode symbols directly where natural: √ ± × ÷ ° π ≤ ≥ ≈ ∞ etc.
- For math/science formulas: write them properly formatted, e.g. "E = mc^(2)", "H_(2)O", "x^(2) + y^(2) = r^(2)", "CO_(2)". Don't write formulas as flat unformatted text like "x^2" with a literal caret shown — use the ^(...) syntax so it renders as a real exponent.
- CRITICAL for JSON validity: never use LaTeX notation or raw backslashes (no \\frac, \\times, \\sqrt, \\(, \\), $$, etc.) anywhere in your output — a literal backslash breaks JSON string escaping and corrupts the entire response. Use plain characters and unicode symbols instead: write fractions as "1/2" or "0.5", write × or * for multiplication, write √ for square root, use ^() and _() for exponents/subscripts as described above.
- For XLSX specifically: when a table needs a computed total/average/etc, put an actual live formula in that cell as a string starting with "=", e.g. "=SUM(B2:B5)" or "=AVERAGE(C2:C10)", using standard Excel formula syntax and referencing the correct cell range based on the row/column position in the table you're building (headers occupy row 1 of the table). This produces a real working spreadsheet formula, not a frozen number.
- For tabular/financial documents (invoice, budget, price list) populate "table" and omit it in the reply case.
- For text documents (letter, report, resume) use "sections" with real headings and paragraphs.
- Keep "reply" messages short and natural, like a real chat message.
- Never output anything outside the single JSON object.`;

  // Efficiency: don't resend the entire conversation forever — that grows the
  // token cost (and cost $) with every message, most of which stops being
  // relevant. Keep a sliding window of the most recent turns, which is enough
  // for the model to track what it's currently working on with the user.
  const MAX_CONTEXT_MESSAGES = 16;
  const trimmedConversation = conversation.slice(-MAX_CONTEXT_MESSAGES);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimmedConversation
  ];

  const baseRequestBody = {
    model: state.model,
    messages,
    temperature: 0.3,
    max_tokens: 4000,
    response_format: { type: 'json_object' }
  };

  // Streams the completion, reporting live status via onStatus as recognizable
  // pieces of the JSON arrive (action type, then content sections appearing).
  // Returns the full raw text once the stream ends. Throws with a real error
  // message if OpenRouter reports a failure (checked before/after streaming,
  // since errors can arrive either as a non-2xx status or as an SSE error event).
  async function streamOnce(body) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${state.apiKey}`,
        'HTTP-Referer': location.href,
        'X-Title': 'DocGen AI'
      },
      body: JSON.stringify({ ...body, stream: true })
    });

    if (!res.ok || !res.body) {
      // Non-streaming failure (bad key, bad model id, etc). Try to read the
      // error body for a real message.
      let errMsg = `HTTP ${res.status}`;
      try {
        const errData = await res.json();
        errMsg = errData?.error?.message || errMsg;
      } catch { /* body wasn't JSON either; keep generic status message */ }
      return { error: errMsg };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let sawAction = null;
    let sawContentStart = false;
    let lastGenericUpdateAt = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep any partial line for next chunk

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        if (json.error) {
          return { error: json.error.message || 'Unknown streaming error' };
        }

        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;

          // Live status updates based on what's showing up so far.
          if (onStatus) {
            if (!sawAction && /"action"\s*:\s*"reply"/.test(fullText)) {
              sawAction = 'reply';
              onStatus('Replying…');
            } else if (!sawAction && /"action"\s*:\s*"generate"/.test(fullText)) {
              sawAction = 'generate';
              onStatus('Planning your document…');
            } else if (sawAction === 'generate' && !sawContentStart && /"(sections|table)"\s*:/.test(fullText)) {
              sawContentStart = true;
              onStatus('Writing the content…');
            } else if (sawContentStart && fullText.length - lastGenericUpdateAt > 40) {
              // Generic fallback: even without a new landmark, prove it's
              // actually moving by showing how much has been written.
              lastGenericUpdateAt = fullText.length;
              onStatus(`Writing the content… (${fullText.length} characters so far)`);
            } else if (!sawAction && fullText.length - lastGenericUpdateAt > 40) {
              lastGenericUpdateAt = fullText.length;
              onStatus('Thinking…');
            }
          }
        }
      }
    }

    return { fullText };
  }

  onStatus?.('Thinking…');
  let { fullText, error } = await streamOnce(baseRequestBody);

  // If the failure looks related to response_format support, retry once
  // without it — some models on OpenRouter don't accept that param.
  if (error && /response_format|json_object|json_schema/i.test(error) && baseRequestBody.response_format) {
    const retryBody = { ...baseRequestBody };
    delete retryBody.response_format;
    onStatus?.('Thinking…');
    ({ fullText, error } = await streamOnce(retryBody));
  }

  // If the underlying model/provider doesn't support streaming at all,
  // fall back to a plain non-streaming request as a last resort.
  if (error && /stream/i.test(error)) {
    onStatus?.('Thinking…');
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${state.apiKey}`,
          'HTTP-Referer': location.href,
          'X-Title': 'DocGen AI'
        },
        body: JSON.stringify(baseRequestBody)
      });
      const data = await res.json();
      if (data?.error) {
        error = data.error.message || error;
      } else {
        fullText = data.choices?.[0]?.message?.content || '';
        error = null;
      }
    } catch { /* keep the original streaming error */ }
  }

  if (error) {
    throw new Error(error);
  }

  if (!fullText) {
    throw new Error('The model returned an empty response. Try again, or check that your OpenRouter model ID is correct in Settings.');
  }

  try {
    return parseJsonLoose(fullText, defaultFormat);
  } catch (err) {
    console.error('Failed to parse model output as JSON. Raw content was:', fullText);
    throw new Error('The model\'s response wasn\'t valid JSON. Check the browser console for what it actually returned.');
  }
}

// Model output containing math notation sometimes includes raw backslashes
// (LaTeX habits like \frac, \times, \(...\)) which are invalid inside a JSON
// string unless escaped — this is the most common real-world cause of
// "invalid JSON" from math-heavy requests. Fix up stray backslashes before
// giving up, by escaping any backslash that isn't already part of a valid
// JSON escape sequence.
function sanitizeJsonText(text) {
  return text.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

function parseJsonLoose(raw, fallbackFormat) {
  let text = raw.trim();
  // strip code fences if the model added them anyway
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model did not return valid JSON.');
  text = text.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (firstErr) {
    try {
      parsed = JSON.parse(sanitizeJsonText(text));
    } catch {
      throw firstErr; // report the original error, sanitized attempt was just a best-effort fallback
    }
  }

  if (parsed.action !== 'reply' && parsed.action !== 'generate') {
    throw new Error('Model returned an unexpected response shape.');
  }
  if (parsed.action === 'generate') {
    if (!['pdf', 'docx', 'xlsx'].includes(parsed.format)) {
      parsed.format = fallbackFormat;
    }
  }
  return parsed;
}

// ---------- Document builders ----------
function validateSchemaHasContent(schema) {
  const sections = schema.sections || [];
  const hasParagraphText = sections.some(sec =>
    (sec.paragraphs || []).some(p => p && p.trim().length > 0)
  );
  const table = schema.table;
  const hasTableRows = table && Array.isArray(table.rows) && table.rows.length > 0;

  if (!hasParagraphText && !hasTableRows) {
    throw new Error('The model returned an empty document (no real content, just a title). This can happen with some models — try again, or switch to a stronger model in Settings.');
  }
}

async function buildDocument(schema, format) {
  validateSchemaHasContent(schema);
  const title = (schema.title || 'Document').trim();
  const safeName = title.replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '_').slice(0, 40) || 'document';

  if (format === 'pdf') return buildPdf(schema, `${safeName}.pdf`);
  if (format === 'docx') return buildDocx(schema, `${safeName}.docx`);
  if (format === 'xlsx') return buildXlsx(schema, `${safeName}.xlsx`);
  throw new Error('Unknown format');
}

function pdfInlineRuns(text) {
  return parseInlineSegments(text).map(seg => {
    let t = seg.text;
    if (seg.superscript) t = toUnicodeMapped(t, SUPERSCRIPT_MAP);
    if (seg.subscript) t = toUnicodeMapped(t, SUBSCRIPT_MAP);
    const run = { text: t };
    if (seg.bold) run.bold = true;
    if (seg.italic) run.italics = true;
    if (seg.code) run.font = 'Roboto'; // no monospace font bundled; keep default but visually distinct via italics fallback below
    return run;
  });
}

function buildPdf(schema, filename) {
  return new Promise((resolve, reject) => {
    try {
      const content = [{ text: pdfInlineRuns(schema.title || 'Document'), style: 'header' }];

      (schema.sections || []).forEach(sec => {
        if (sec.heading) content.push({ text: pdfInlineRuns(sec.heading), style: 'subheader' });
        (sec.paragraphs || []).forEach(p => content.push({ text: pdfInlineRuns(p), margin: [0, 0, 0, 8] }));
      });

      if (schema.table && schema.table.headers) {
        content.push({
          table: {
            headerRows: 1,
            widths: schema.table.headers.map(() => '*'),
            body: [
              schema.table.headers.map(h => ({ text: pdfInlineRuns(String(h)), bold: true })),
              ...(schema.table.rows || []).map(row => row.map(cell => ({ text: pdfInlineRuns(String(cell)) })))
            ]
          },
          margin: [0, 10, 0, 10]
        });
      }

      const docDefinition = {
        content,
        styles: {
          header: { fontSize: 20, bold: true, margin: [0, 0, 0, 12] },
          subheader: { fontSize: 14, bold: true, margin: [0, 10, 0, 6] }
        },
        defaultStyle: { fontSize: 11 }
      };

      pdfMake.createPdf(docDefinition).getBlob(blob => {
        resolve({ blob, filename });
      });
    } catch (e) { reject(e); }
  });
}

async function buildDocx(schema, filename) {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } = docx;

  function docxRuns(text, forceBold = false) {
    return parseInlineSegments(text).map(seg => {
      const opts = { text: seg.text };
      if (forceBold || seg.bold) opts.bold = true;
      if (seg.italic) opts.italics = true;
      if (seg.superscript) opts.superScript = true;
      if (seg.subscript) opts.subScript = true;
      return new TextRun(opts);
    });
  }

  const children = [
    new Paragraph({ children: docxRuns(schema.title || 'Document'), heading: HeadingLevel.TITLE })
  ];

  (schema.sections || []).forEach(sec => {
    if (sec.heading) {
      children.push(new Paragraph({ children: docxRuns(sec.heading), heading: HeadingLevel.HEADING_2 }));
    }
    (sec.paragraphs || []).forEach(p => {
      children.push(new Paragraph({ children: docxRuns(p) }));
    });
  });

  if (schema.table && schema.table.headers) {
    const headerRow = new TableRow({
      children: schema.table.headers.map(h => new TableCell({
        children: [new Paragraph({ children: docxRuns(String(h), true) })]
      }))
    });
    const rows = (schema.table.rows || []).map(row => new TableRow({
      children: row.map(cell => new TableCell({ children: [new Paragraph({ children: docxRuns(String(cell)) })] }))
    }));
    children.push(new Table({ rows: [headerRow, ...rows] }));
  }

  const doc = new Document({ sections: [{ children }] });
  const blob = await Packer.toBlob(doc);
  return { blob, filename };
}

// XLSX cells apply formatting at the whole-cell level, not per-word, so
// strip markdown syntax down to plain text (still converting sup/sub to
// unicode, since that works fine inside a plain string).
function plainizeForXlsx(text) {
  return parseInlineSegments(String(text)).map(seg => {
    if (seg.superscript) return toUnicodeMapped(seg.text, SUPERSCRIPT_MAP);
    if (seg.subscript) return toUnicodeMapped(seg.text, SUBSCRIPT_MAP);
    return seg.text;
  }).join('');
}

// A table cell whose text starts with "=" is treated as a real, live Excel
// formula (e.g. "=SUM(B2:B5)") instead of static text — so totals, averages,
// etc. actually compute in the spreadsheet rather than being frozen numbers.
function xlsxCellValue(raw) {
  const text = String(raw).trim();
  if (text.startsWith('=') && text.length > 1) {
    return { formula: text.slice(1) };
  }
  // Numeric-looking values become real numbers so Excel can sum/chart them.
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return Number(text);
  }
  return plainizeForXlsx(text);
}

async function buildXlsx(schema, filename) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(schema.title?.slice(0, 30) || 'Sheet1');

  let rowCursor = 1;
  sheet.getCell(`A${rowCursor}`).value = plainizeForXlsx(schema.title || 'Document');
  sheet.getCell(`A${rowCursor}`).font = { bold: true, size: 14 };
  rowCursor += 2;

  (schema.sections || []).forEach(sec => {
    if (sec.heading) {
      sheet.getCell(`A${rowCursor}`).value = plainizeForXlsx(sec.heading);
      sheet.getCell(`A${rowCursor}`).font = { bold: true };
      rowCursor++;
    }
    (sec.paragraphs || []).forEach(p => {
      sheet.getCell(`A${rowCursor}`).value = plainizeForXlsx(p);
      rowCursor++;
    });
    rowCursor++;
  });

  if (schema.table && schema.table.headers) {
    const headerRow = sheet.getRow(rowCursor);
    schema.table.headers.forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = plainizeForXlsx(h);
      cell.font = { bold: true };
    });
    rowCursor++;
    (schema.table.rows || []).forEach(row => {
      const r = sheet.getRow(rowCursor);
      row.forEach((val, i) => { r.getCell(i + 1).value = xlsxCellValue(val); });
      rowCursor++;
    });
    sheet.columns.forEach(col => { col.width = 20; });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  return { blob, filename };
}
