'use strict';

const API_BASE = '/api';

/**
 * EarnKampus Frontend — app.js
 *
 * Authentication model:
 * - The session cookie (set by the server) is the source of truth.
 * - On load, we call /api/auth/me to verify the session is valid.
 * - localStorage is used ONLY as a UI display hint (name/avatar for instant render).
 *   It is NEVER trusted for authorization decisions; the server always checks the cookie.
 * - On 401 from the server the local hint is cleared and the user is treated as guest.
 */

let currentState = {
  currentTab: 'need',
  categoryFilter: 'All Categories',
  searchQuery: '',
  currentUser: {
    id: null,
    name: 'Guest',
    college: null,
    avatar: '',
    isLoggedIn: false,
  },
  posts: [],
  usersList: [],
  messages: [],
  activeChatUser: null,     // { id, name }
  stats: {
    openTasks: 0,
    completedTasks: 0,
    totalEarned: 0,
    activeVolunteers: 0,
  },
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  // Apply localStorage UI hint immediately for fast render, then verify with server
  applyUIHint();
  setupEventListeners();
  await verifySession(); // server-side check — overwrites or clears local hint
  await loadStats();
  await fetchPosts();
  if (currentState.currentUser.isLoggedIn) {
    await fetchMessages();
    await fetchNotifications();
    startNotificationPolling();
  }
}

/**
 * Apply the localStorage UI hint for immediate display.
 * This is ONLY for UI (name, avatar) — never for authorization.
 */
function applyUIHint() {
  try {
    const hint = localStorage.getItem('earncampus_ui_hint');
    if (hint) {
      const parsed = JSON.parse(hint);
      if (parsed && parsed.name && parsed.id) {
        currentState.currentUser = {
          id: parsed.id,
          name: parsed.name,
          email: parsed.email || '',
          college: parsed.college || null,
          avatar: parsed.avatar || '',
          isLoggedIn: true, // tentative — will be confirmed by verifySession()
        };
      }
    }
  } catch (e) {
    console.warn('UI hint parse error:', e);
  }
  updateUserUI();
}

/**
 * Verify session with the server via /api/auth/me.
 * This is the authoritative authentication check.
 */
async function verifySession() {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'same-origin' });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.user) {
        currentState.currentUser = {
          ...data.user,
          isLoggedIn: true,
        };
        // Keep localStorage hint in sync with server data
        localStorage.setItem('earncampus_ui_hint', JSON.stringify({ id: data.user.id, name: data.user.name, college: data.user.college })); // no email stored in the browser
        updateUserUI();
        return;
      }
    }
    // Session invalid or expired — clear local state
    clearUserSession();
  } catch (e) {
    // Network error — keep tentative local state but mark uncertain
    console.warn('Session verification failed (network):', e.message);
  }
}

function clearUserSession() {
  localStorage.removeItem('earncampus_ui_hint');
  currentState.currentUser = {
    id: null,
    name: 'Guest',
    college: null,
    avatar: '',
    isLoggedIn: false,
  };
  updateUserUI();
}

function updateUserUI() {
  const avatarEl = document.getElementById('currentAvatar');
  const nameEl = document.getElementById('userNameDisplay');
  const loginBtn = document.getElementById('navLoginBtn');
  const signupBtn = document.getElementById('navSignupBtn');
  const logoutBtn = document.getElementById('navLogoutBtn');
  const messagesBtn = document.getElementById('navMessagesBtn');
  const notifBtn = document.getElementById('navNotifBtn');

  const pill = document.getElementById('userPill');
  const shownName = currentState.currentUser.name || 'Guest';
  if (nameEl) nameEl.textContent = shownName;
  if (pill) {
    pill.dataset.initial = shownName.charAt(0).toUpperCase();
    pill.style.display = currentState.currentUser.isLoggedIn ? 'inline-flex' : 'none';
  }

  if (currentState.currentUser.isLoggedIn) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (signupBtn) signupBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    if (messagesBtn) messagesBtn.style.display = 'inline-flex';
    if (notifBtn) notifBtn.style.display = 'inline-grid';
  } else {
    if (loginBtn) loginBtn.style.display = 'inline-flex';
    if (signupBtn) signupBtn.style.display = 'inline-flex';
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (messagesBtn) messagesBtn.style.display = 'none';
    if (notifBtn) notifBtn.style.display = 'none';
  }
}

function setupEventListeners() {
  const tabNeed = document.getElementById('tabNeed');
  const tabOffer = document.getElementById('tabOffer');
  if (tabNeed && tabOffer) {
    tabNeed.addEventListener('click', () => switchTab('need'));
    tabOffer.addEventListener('click', () => switchTab('offer'));
    const tabMineBtn = document.getElementById('tabMine');
    if (tabMineBtn) tabMineBtn.addEventListener('click', () => switchTab('mine'));
  }

  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  let searchTimeout = null;
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      // Trim to 100 chars client-side to prevent huge requests; server also enforces this
      currentState.searchQuery = e.target.value.slice(0, 100);
      if (clearSearchBtn) {
        clearSearchBtn.hidden = currentState.searchQuery.length === 0;
      }
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => { fetchPosts(); }, 250);
    });
  }

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      currentState.searchQuery = '';
      clearSearchBtn.hidden = true;
      fetchPosts();
    });
  }

  const categoryFilter = document.getElementById('categoryFilter');
  if (categoryFilter) {
    categoryFilter.addEventListener('change', (e) => {
      currentState.categoryFilter = e.target.value;
      fetchPosts();
    });
  }

  const openComposerBtn = document.getElementById('openComposerBtn');
  const closeComposerBtn = document.getElementById('closeComposerBtn');
  const cancelComposerBtn = document.getElementById('cancelComposerBtn');
  const composerModal = document.getElementById('composerModal');

  if (openComposerBtn) {
    openComposerBtn.addEventListener('click', () => { openComposerModal(); });
  }
  if (closeComposerBtn) closeComposerBtn.addEventListener('click', closeComposerModal);
  if (cancelComposerBtn) cancelComposerBtn.addEventListener('click', closeComposerModal);
  if (composerModal) {
    composerModal.addEventListener('click', (e) => {
      if (e.target === composerModal) closeComposerModal();
    });
  }

  const closeAuthReqBtn = document.getElementById('closeAuthReqBtn');
  const authRequiredModal = document.getElementById('authRequiredModal');
  if (closeAuthReqBtn) closeAuthReqBtn.addEventListener('click', closeAuthRequiredModal);
  if (authRequiredModal) {
    authRequiredModal.addEventListener('click', (e) => {
      if (e.target === authRequiredModal) closeAuthRequiredModal();
    });
  }

  const navMessagesBtn = document.getElementById('navMessagesBtn');
  const closeMessagesBtn = document.getElementById('closeMessagesBtn');
  const messagesModal = document.getElementById('messagesModal');
  const sendMessageForm = document.getElementById('sendMessageForm');

  if (navMessagesBtn) {
    navMessagesBtn.addEventListener('click', () => openMessagesModal());
  }
  if (closeMessagesBtn) closeMessagesBtn.addEventListener('click', closeMessagesModal);
  if (messagesModal) {
    messagesModal.addEventListener('click', (e) => {
      if (e.target === messagesModal) closeMessagesModal();
    });
  }
  if (sendMessageForm) {
    sendMessageForm.addEventListener('submit', handleSendMessage);
  }

  const userPill = document.getElementById('userPill');
  if (userPill) {
    userPill.addEventListener('click', (e) => {
      if (!currentState.currentUser.isLoggedIn) {
        e.preventDefault();
        window.location.href = 'auth.html?tab=login';
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (composerModal && !composerModal.hidden) closeComposerModal();
      if (authRequiredModal && !authRequiredModal.hidden) closeAuthRequiredModal();
      if (messagesModal && !messagesModal.hidden) closeMessagesModal();
    }
  });

  const postForm = document.getElementById('postForm');
  if (postForm) {
    postForm.addEventListener('submit', handleCreatePost);
  }

  const navLogoutBtn = document.getElementById('navLogoutBtn');
  if (navLogoutBtn) {
    navLogoutBtn.addEventListener('click', handleLogout);
  }
}

function showAuthRequiredModal(message) {
  const modal = document.getElementById('authRequiredModal');
  const textEl = document.getElementById('authReqText');
  if (textEl) textEl.textContent = message || 'You must be logged in to post tasks or offer help on EarnKampus.';
  if (modal) modal.hidden = false;
}

function closeAuthRequiredModal() {
  const modal = document.getElementById('authRequiredModal');
  if (modal) modal.hidden = true;
}

let editingPostId = null; // set while the composer is editing an existing post
let editingPostType = null;

/** "per customer" for services, "per volunteer" for multi-volunteer help requests. */
function priceNote(p) {
  if (p.type === 'offer') return 'per customer';
  return (p.slotsNeeded || 1) > 1 ? 'per volunteer' : '';
}

/** Make the create / edit form use the right words for the post type. */
function applyPostTypeUI(type) {
  const offer = type === 'offer';
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('priceLabel', el => { el.textContent = offer ? 'Price per customer (\u20b9)' : 'Reward each (\u20b9)'; });
  set('slotsLabel', el => { el.textContent = offer ? 'Customers you can serve' : 'Volunteers needed'; });
  set('postTitleInput', el => { el.placeholder = offer ? 'e.g. Printing and spiral binding at the hostel' : 'e.g. Print and collect 20 pages'; });
  set('postDetailsInput', el => { el.placeholder = offer ? 'What you offer, and where and when you are available' : 'Where, when, and anything the volunteer should know'; });
  set('postPayHelp', el => {
    el.textContent = offer
      ? 'Customers pay you directly. They mark the payment as sent and you confirm when it arrives. EarnKampus does not handle payments yet.'
      : 'The reward is paid per volunteer. You pay each volunteer directly. EarnKampus does not handle payments yet.';
  });
}

(function watchPostType() {
  document.getElementsByName('postType').forEach(r => r.addEventListener('change', () => applyPostTypeUI(r.value)));
})();

function openComposerModal() {
  if (!currentState.currentUser.isLoggedIn) {
    showAuthRequiredModal('You must be logged in to create a new task post.');
    return;
  }
  resetComposerMode();
  const modal = document.getElementById('composerModal');
  if (modal) modal.hidden = false;
}

function closeComposerModal() {
  const modal = document.getElementById('composerModal');
  const form = document.getElementById('postForm');
  if (modal) modal.hidden = true;
  if (form) form.reset();
  resetComposerMode();
}

/** Put the composer back into "create a new post" mode. */
function resetComposerMode() {
  editingPostId = null;
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('modalTitle', el => { el.textContent = 'Create task post'; });
  set('postSubmitBtn', el => { el.textContent = 'Publish post'; });
  set('postTypeField', el => { el.hidden = false; });
  set('postCategorySelect', el => { el.disabled = false; });
  set('postPriceInput', el => { el.disabled = false; });
  set('postSlotsInput', el => { el.min = '1'; });
  set('postModeNote', el => { el.hidden = true; el.textContent = ''; });
  editingPostType = null;
  applyPostTypeUI('need');
}

/** Open the composer pre-filled with an existing post. */
function openEditModal(p) {
  if (!currentState.currentUser.isLoggedIn) return;
  const assigned = (p.assignees || []).length;
  const locked = assigned > 0; // price/category are fixed once volunteers have agreed to them

  editingPostId = p.id;
  editingPostType = p.type;
  applyPostTypeUI(p.type);
  document.getElementById('modalTitle').textContent = 'Edit post';
  document.getElementById('postSubmitBtn').textContent = 'Save changes';
  document.getElementById('postTypeField').hidden = true;
  document.getElementById('postTitleInput').value = p.title || '';
  document.getElementById('postDetailsInput').value = p.details || '';
  document.getElementById('postCategorySelect').value = p.category || 'Other';
  document.getElementById('postPriceInput').value = p.price;
  document.getElementById('postSlotsInput').value = p.slotsNeeded || 1;
  document.getElementById('postSlotsInput').min = String(Math.max(1, assigned));
  document.getElementById('postCategorySelect').disabled = locked;
  document.getElementById('postPriceInput').disabled = locked;

  const note = document.getElementById('postModeNote');
  if (locked) {
    note.textContent = 'Volunteers are already assigned, so the reward and category are locked. You can still update the title and details, or increase the number of volunteers.';
  } else if ((p.interestedUsers || []).length) {
    note.textContent = 'If you change the reward, current offers are cleared so volunteers can offer again at the new amount.';
  } else {
    note.textContent = '';
  }
  note.hidden = !note.textContent;

  document.getElementById('composerModal').hidden = false;
}

async function submitPostEdit() {
  const body = {
    title: document.getElementById('postTitleInput').value,
    details: document.getElementById('postDetailsInput').value,
    slotsNeeded: document.getElementById('postSlotsInput').value,
  };
  const catEl = document.getElementById('postCategorySelect');
  const priceEl = document.getElementById('postPriceInput');
  if (!catEl.disabled) body.category = catEl.value;
  if (!priceEl.disabled) body.price = priceEl.value;
  if (!body.title.trim()) { showToast('Title is required.', 'error'); return; }

  try {
    const res = await fetch(`${API_BASE}/posts/${encodeURIComponent(editingPostId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.status === 401) { clearUserSession(); showAuthRequiredModal('Your session expired. Please log in again.'); return; }
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'Post updated.', 'success');
      closeComposerModal();
      await fetchPosts();
    } else {
      showToast(data.error || 'Could not update the post.', 'error');
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  }
}

// ── Messaging ──────────────────────────────────────────────────────────────────

async function fetchMessages() {
  if (!currentState.currentUser.isLoggedIn) return;
  try {
    const res = await fetch(`${API_BASE}/messages`, { credentials: 'same-origin' });
    if (res.status === 401) { clearUserSession(); return; }
    const data = await res.json();
    if (data.success) {
      currentState.messages = data.messages;
      // If the conversation is open on screen, anything new in it counts as read
      const chatModal = document.getElementById('messagesModal');
      if (currentState.activeChatUser && chatModal && !chatModal.hidden) {
        markThreadRead(currentState.activeChatUser.id);
      }
      updateUnreadBadge();
    }
  } catch (e) {
    console.error('Error fetching messages:', e);
  }
}

/** Mark messages from one person as read: update the badge now, tell the server in the background. */
function markThreadRead(userId) {
  const now = new Date().toISOString();
  let changed = false;
  currentState.messages.forEach(m => {
    if (m.senderId === userId && m.receiverId === currentState.currentUser.id && !m.readAt) {
      m.readAt = now;
      changed = true;
    }
  });
  updateUnreadBadge();
  if (!changed) return;
  fetch(`${API_BASE}/messages/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ withUserId: userId }),
  }).catch(() => { /* badge is already correct locally; next load will retry */ });
}

function updateUnreadBadge() {
  const unreadBadge = document.getElementById('unreadBadge');
  if (!unreadBadge) return;
  const count = currentState.messages.filter(m => m.receiverId === currentState.currentUser.id && !m.readAt).length;
  if (count > 0) {
    unreadBadge.textContent = count;
    unreadBadge.style.display = 'inline';
  } else {
    unreadBadge.style.display = 'none';
  }
}

const extraContacts = new Map(); // people you opened a chat with before any message exists (post "Message" buttons)
const isPhoneChat = () => window.matchMedia('(max-width: 760px)').matches;

function openMessagesModal(targetUser = null, prefillContext = '') {
  if (!currentState.currentUser.isLoggedIn) {
    showAuthRequiredModal('Please log in to send direct messages to campus members.');
    return;
  }
  if (targetUser && targetUser.id === currentState.currentUser.id) return;

  const modal = document.getElementById('messagesModal');
  if (modal) modal.hidden = false;

  if (targetUser) {
    // Keep this person in the conversation list even before the first message, and forget any earlier chat
    extraContacts.set(targetUser.id, { id: targetUser.id, name: targetUser.name, avatar: '', addedAt: Date.now() });
    currentState.activeChatUser = null;
  }

  fetchMessages().then(() => {
    renderContactsList(targetUser ? targetUser.id : null);
    if (targetUser) {
      selectContact(extraContacts.get(targetUser.id));
      if (prefillContext) {
        const input = document.getElementById('chatInputText');
        if (input) input.value = `Hi ${targetUser.name}, about "${prefillContext}": `; // value, not innerHTML
      }
    } else if (isPhoneChat()) {
      showChatList(); // on a phone, start from the list of conversations
    } else {
      const contacts = getContactsList();
      if (contacts.length > 0) selectContact(contacts[0]);
    }
  });
}

/** Phone layout: go back from a conversation to the list. */
function showChatList() {
  currentState.activeChatUser = null;
  const container = document.querySelector('.chat-container');
  if (container) container.classList.remove('has-thread');
  const form = document.getElementById('sendMessageForm');
  if (form) form.hidden = true;
  const header = document.getElementById('chatActiveUser');
  if (header) header.textContent = 'Select a student to message';
  renderContactsList();
  renderChatThread();
}

function closeMessagesModal() {
  const modal = document.getElementById('messagesModal');
  if (modal) modal.hidden = true;
  const container = document.querySelector('.chat-container');
  if (container) container.classList.remove('has-thread');
  currentState.activeChatUser = null;
}

function getContactsList() {
  const me = currentState.currentUser.id;
  const map = new Map();
  const touch = (id, name, time) => {
    if (!id || id === me) return;
    const cur = map.get(id) || { id, name, avatar: '', last: 0 };
    if (time > cur.last) cur.last = time;
    if (!cur.name && name) cur.name = name;
    map.set(id, cur);
  };

  currentState.messages.forEach(m => {
    const mine = m.senderId === me;
    touch(mine ? m.receiverId : m.senderId, mine ? m.receiverName : m.senderName, new Date(m.timestamp).getTime() || 0);
  });
  extraContacts.forEach(c => touch(c.id, c.name, c.addedAt));            // chats opened from a post
  currentState.posts.forEach(p => { if (p.authorId) touch(p.authorId, p.author, 0); }); // people you can message from the feed

  return Array.from(map.values()).sort((x, y) => y.last - x.last);       // most recent conversation first
}

function renderContactsList(selectedUserId = null) {
  const contactsList = document.getElementById('contactsList');
  if (!contactsList) return;

  const me = currentState.currentUser.id;
  const info = new Map(); // per person: last message and number of unread messages
  currentState.messages.forEach(m => {
    const mine = m.senderId === me;
    const other = mine ? m.receiverId : m.senderId;
    const rec = info.get(other) || { text: '', time: -1, unread: 0 };
    const t = new Date(m.timestamp).getTime() || 0;
    if (t >= rec.time) { rec.time = t; rec.text = (mine ? 'You: ' : '') + m.text; }
    if (!mine && !m.readAt) rec.unread += 1;
    info.set(other, rec);
  });

  const activeId = currentState.activeChatUser ? currentState.activeChatUser.id : selectedUserId;
  contactsList.textContent = '';

  getContactsList().forEach(c => {
    const div = document.createElement('div');
    div.className = `contact-item ${c.id === activeId ? 'active' : ''}`;
    div.addEventListener('click', () => selectContact(c));

    const infoDiv = document.createElement('div');
    infoDiv.className = 'contact-info';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'contact-name';
    nameSpan.textContent = c.name; // textContent, not innerHTML (V8)
    const sub = document.createElement('span');
    sub.className = 'contact-sub';
    const rec = info.get(c.id);
    sub.textContent = rec ? rec.text : 'No messages yet';
    infoDiv.appendChild(nameSpan);
    infoDiv.appendChild(sub);
    div.appendChild(infoDiv);

    if (rec && rec.unread > 0) {
      const pill = document.createElement('span');
      pill.className = 'unread-pill';
      pill.textContent = String(rec.unread);
      div.appendChild(pill);
    }
    contactsList.appendChild(div);
  });
}

function selectContact(user) {
  currentState.activeChatUser = user;
  markThreadRead(user.id);
  renderContactsList(user.id);

  const activeUserHeader = document.getElementById('chatActiveUser');
  if (activeUserHeader) {
    activeUserHeader.textContent = user.name; // textContent (V8)
  }

  const sendMessageForm = document.getElementById('sendMessageForm');
  if (sendMessageForm) sendMessageForm.hidden = false;

  const container = document.querySelector('.chat-container');
  if (container) container.classList.add('has-thread'); // phone layout: show the conversation, hide the list

  renderChatThread();
}

(function setupChatBack() {
  const back = document.getElementById('chatBackBtn');
  if (back) back.addEventListener('click', showChatList);
})();

function renderChatThread() {
  const body = document.getElementById('chatMessagesBody');
  if (!body) return;

  if (!currentState.activeChatUser) {
    body.textContent = '';
    const state = document.createElement('div');
    state.className = 'empty-chat-state';
    const txt = document.createElement('p');
    txt.style.fontSize = '13px';
    txt.style.color = 'var(--muted)';
    txt.textContent = 'Select a student from the left sidebar to view messages.';
    state.appendChild(txt);
    body.appendChild(state);
    return;
  }

  const threadMsgs = currentState.messages.filter(m =>
    (m.senderId === currentState.currentUser.id && m.receiverId === currentState.activeChatUser.id) ||
    (m.senderId === currentState.activeChatUser.id && m.receiverId === currentState.currentUser.id)
  );

  body.textContent = '';

  if (threadMsgs.length === 0) {
    const state = document.createElement('div');
    state.className = 'empty-chat-state';
    const txt = document.createElement('p');
    txt.style.fontSize = '13px';
    txt.style.color = 'var(--muted)';
    txt.textContent = `No messages yet with ${currentState.activeChatUser.name}. Send a message to start!`;
    state.appendChild(txt);
    body.appendChild(state);
    return;
  }

  threadMsgs.forEach(m => {
    const isSent = m.senderId === currentState.currentUser.id;
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isSent ? 'sent' : 'received'}`;

    const timeStr = m.timestamp
      ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    const textSpan = document.createElement('span');
    textSpan.textContent = m.text; // textContent — prevents stored XSS (V8)

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = timeStr;

    bubble.appendChild(textSpan);
    bubble.appendChild(timeSpan);
    body.appendChild(bubble);
  });

  body.scrollTop = body.scrollHeight;
}

async function handleSendMessage(e) {
  e.preventDefault();
  const input = document.getElementById('chatInputText');
  if (!input || !currentState.activeChatUser) return;

  const text = input.value.trim().slice(0, 2000); // client-side length limit
  if (!text) return;

  try {
    const res = await fetch(`${API_BASE}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        receiverId: currentState.activeChatUser.id, // use ID, not name
        text: text,
      }),
    });

    if (res.status === 401) { clearUserSession(); return; }

    const data = await res.json();
    if (data.success) {
      input.value = '';
      if (data.message) {
        currentState.messages.push(data.message);
      }
      renderChatThread();
      updateUnreadBadge();
    } else {
      showToast(data.error || 'Error sending message', 'error');
    }
  } catch (err) {
    showToast('Failed to send message.', 'error');
  }
}

async function handleLogout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch (e) {
    // Best effort
  }
  clearUserSession();
  currentState.messages = [];
  showToast('Logged out successfully.', 'info');
  fetchPosts();
}

async function loadStats() {
  try {
    const res = await fetch(`${API_BASE}/stats`);
    const data = await res.json();
    if (data.success) {
      currentState.stats = data.stats;
      const statOpen = document.getElementById('statOpen');
      const statActiveVol = document.getElementById('statActiveVol');
      const statCompleted = document.getElementById('statCompleted');
      const statEarnings = document.getElementById('statEarnings');

      if (statOpen) statOpen.textContent = data.stats.openTasks;
      if (statActiveVol) statActiveVol.textContent = data.stats.activeVolunteers;
      if (statCompleted) statCompleted.textContent = data.stats.completedTasks;
      if (statEarnings) statEarnings.textContent = `₹${data.stats.totalEarned}`;
    }
  } catch (err) {
    console.error('Stats loading error:', err);
  }
}

async function fetchPosts() {
  const postsGrid = document.getElementById('postsGrid');
  if (postsGrid) {
    postsGrid.textContent = ''; // clear safely
    const spinner = document.createElement('div');
    spinner.className = 'loading-spinner';
    spinner.innerHTML = '<div class="spinner"></div><span>Fetching campus feed...</span>';
    postsGrid.appendChild(spinner);
  }

  try {
    // "My Tasks" tab: everything I posted or worked on, including finished tasks
    if (currentState.currentTab === 'mine') {
      const mp = new URLSearchParams({
        category: currentState.categoryFilter,
        search: currentState.searchQuery.slice(0, 100),
      });
      const mres = await fetch(`${API_BASE}/my-tasks?${mp.toString()}`, { credentials: 'same-origin' });
      if (mres.status === 401) { clearUserSession(); return; }
      const mdata = await mres.json();
      if (mdata.success) {
        currentState.posts = mdata.posts;
        renderPosts();
      } else {
        showToast(mdata.error || 'Could not load your tasks.', 'error');
      }
      return;
    }

    const userCollege = currentState.currentUser.isLoggedIn
      ? (currentState.currentUser.college || '')
      : '';

    const params = new URLSearchParams({
      type: currentState.currentTab,
      category: currentState.categoryFilter,
      search: currentState.searchQuery.slice(0, 100), // enforce limit before sending
      college: userCollege,
    });

    const res = await fetch(`${API_BASE}/posts?${params.toString()}`);
    if (!res.ok) {
      if (postsGrid) postsGrid.innerHTML = '<div class="loading-spinner"><span>Failed to load posts.</span></div>';
      return;
    }
    const data = await res.json();

    if (data.success) {
      currentState.posts = data.posts;
      renderPosts();
    }
  } catch (err) {
    if (postsGrid) postsGrid.innerHTML = '<div class="loading-spinner"><span>Failed to connect to backend.</span></div>';
    showToast('Backend network error.', 'error');
  }
}

function switchTab(tab) {
  if (tab === 'mine' && !currentState.currentUser.isLoggedIn) {
    showAuthRequiredModal('Log in to see your tasks and history.');
    return;
  }
  currentState.currentTab = tab;

  const tabs = { need: 'tabNeed', offer: 'tabOffer', mine: 'tabMine' };
  Object.keys(tabs).forEach(key => {
    const el = document.getElementById(tabs[key]);
    if (el) el.classList.toggle('active', key === tab);
  });

  const headings = { need: 'Help wanted', offer: 'Services offered', mine: 'My tasks, including finished ones' };
  const feedHeading = document.getElementById('feedHeading');
  if (feedHeading) feedHeading.textContent = headings[tab] || headings.need;

  return fetchPosts();
}

function renderPosts() {
  const postsGrid = document.getElementById('postsGrid');
  const countBadge = document.getElementById('feedCountBadge');
  if (!postsGrid) return;

  closeFloatingMenus();
  document.querySelectorAll('body > .menu-list').forEach(el => el.remove()); // none may be left floating from the old cards
  postsGrid.textContent = '';
  if (countBadge) {
    const n = currentState.posts.length;
    const u = currentState.currentUser;
    const scope = (currentState.currentTab !== 'mine' && u.isLoggedIn && u.college) ? ` \u00b7 ${u.college}` : '';
    countBadge.textContent = `${n} ${n === 1 ? 'task' : 'tasks'}${scope}`;
  }

  if (currentState.posts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-spinner';
    const mineTab = currentState.currentTab === 'mine';
    const t1 = document.createElement('span');
    t1.style.cssText = 'font-weight:700;color:var(--ink)';
    const guest = !currentState.currentUser.isLoggedIn;
    t1.textContent = mineTab ? 'No tasks yet' : (guest ? 'Log in to see tasks' : 'No posts found');
    const t2 = document.createElement('span');
    t2.style.fontSize = '13px';
    t2.textContent = mineTab
      ? 'Tasks you post or help with will appear here, including finished ones.'
      : (guest ? 'EarnKampus shows tasks from your own college. Log in with your college email to see them.' : 'Be the first to create a post in this category!');
    empty.appendChild(t1);
    empty.appendChild(t2);
    postsGrid.appendChild(empty);
    return;
  }

  currentState.posts.forEach(p => {
    const card = buildPostCard(p);
    postsGrid.appendChild(card);
  });
  requestAnimationFrame(() => refreshClampToggles(postsGrid));
}

/** Show "Read more..." only on descriptions that are actually cut off. */
function refreshClampToggles(root) {
  (root || document).querySelectorAll('.card-details.is-clamped').forEach(el => {
    const btn = el.nextElementSibling;
    if (!btn || !btn.classList.contains('read-more')) return;
    btn.hidden = !(el.scrollHeight > el.clientHeight + 1);
  });
}

let clampResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(clampResizeTimer);
  clampResizeTimer = setTimeout(() => refreshClampToggles(document), 150);
});

/** Opens the full post in a window; the page behind it is blurred. */
function openPostDetail(p) {
  const modal = document.getElementById('postDetailModal');
  const body = document.getElementById('postDetailBody');
  const titleEl = document.getElementById('postDetailTitle');
  if (!modal || !body || !titleEl) return;

  titleEl.textContent = p.title || 'Task details'; // textContent (V8)
  body.textContent = '';

  const top = document.createElement('div');
  top.className = 'detail-top';
  const tags = document.createElement('div');
  tags.className = 'card-tags';
  const addTag = (text, cls) => {
    const t = document.createElement('span');
    t.className = cls;
    t.textContent = text;
    tags.appendChild(t);
  };
  addTag(p.category || 'Other', 'tag-badge');
  addTag((p.status || '').replace('_', ' '), `status-badge status-${p.status}`);
  if ((p.slotsNeeded || 1) > 1) addTag(`${(p.assignees || []).length}/${p.slotsNeeded} filled`, 'tag-badge');
  if (p.editedAt) addTag('Edited', 'tag-badge');

  const price = document.createElement('div');
  price.className = 'price-pill';
  price.textContent = `\u20b9${p.price}`;
  const detailNote = priceNote(p);
  if (detailNote) {
    const note = document.createElement('span');
    note.className = 'price-note';
    note.textContent = detailNote;
    price.appendChild(note);
  }
  top.appendChild(tags);
  top.appendChild(price);

  const text = document.createElement('p');
  text.className = 'detail-text';
  text.textContent = p.details || 'No description provided.'; // textContent (V8)

  const posted = document.createElement('p');
  posted.className = 'card-date';
  posted.textContent = 'Posted ' + new Date(p.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

  const authorRow = document.createElement('div');
  authorRow.className = 'card-author';
  const authorLink = document.createElement('a');
  authorLink.href = `profile.html?id=${encodeURIComponent(p.authorId)}`;
  authorLink.className = 'author-info';
  const avatar = document.createElement('div');
  avatar.className = 'author-avatar';
  avatar.textContent = (p.author || '?').charAt(0).toUpperCase();
  const meta = document.createElement('div');
  meta.className = 'author-meta';
  const name = document.createElement('span');
  name.className = 'author-name';
  name.textContent = p.author || 'Unknown';
  const sub = document.createElement('span');
  sub.className = 'author-sub';
  sub.textContent = `${p.college || 'Campus'} \u00b7 ${ratingLabel(p.authorRatingAvg, p.authorRatingCount)}`;
  meta.appendChild(name);
  meta.appendChild(sub);
  authorLink.appendChild(avatar);
  authorLink.appendChild(meta);
  authorRow.appendChild(authorLink);

  body.appendChild(top);
  body.appendChild(text);
  body.appendChild(posted);
  body.appendChild(authorRow);
  modal.hidden = false;
}

(function setupPostDetailModal() {
  const modal = document.getElementById('postDetailModal');
  if (!modal) return;
  const close = () => { modal.hidden = true; };
  ['closePostDetailBtn', 'postDetailCloseBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', close);
  });
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) close(); });
})();

/** "just now", "5 min ago", "3 hr ago", "2 days ago", then a plain date. */
function formatPostedDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function buildPostCard(p) {
  // Compare by server-derived authorId, not display name (V3)
  const isAuthor = p.authorId === currentState.currentUser.id;
  const hasOffered = p.interestedUsers && p.interestedUsers.some(u => u.userId === currentState.currentUser.id);
  const isAssignedToMe = (p.assignees || []).some(a => a.userId === currentState.currentUser.id);

  const card = document.createElement('div');
  card.className = 'post-card';
  card.dataset.postId = p.id;

  // Header: category + status on the left, reward on the right (DOM, never innerHTML: V8)
  const cardTop = document.createElement('div');
  cardTop.className = 'card-top';

  const cardTags = document.createElement('div');
  cardTags.className = 'card-tags';

  const categoryBadge = document.createElement('span');
  categoryBadge.className = 'tag-badge';
  categoryBadge.textContent = p.category || 'Other';

  const statusBadge = document.createElement('span');
  statusBadge.className = `status-badge status-${p.status}`;
  statusBadge.textContent = (p.status || '').replace('_', ' ');

  cardTags.appendChild(categoryBadge);
  cardTags.appendChild(statusBadge);
  if (p.editedAt) {
    const editedBadge = document.createElement('span');
    editedBadge.className = 'tag-badge';
    editedBadge.textContent = 'Edited';
    cardTags.appendChild(editedBadge);
  }

  if ((p.slotsNeeded || 1) > 1) {
    const filledBadge = document.createElement('span');
    filledBadge.className = 'tag-badge';
    filledBadge.textContent = `${(p.assignees || []).length}/${p.slotsNeeded} filled`;
    cardTags.appendChild(filledBadge);
  }

  const pricePill = document.createElement('div');
  pricePill.className = 'price-pill';
  pricePill.textContent = `₹${p.price}`;
  const noteText = priceNote(p);
  if (noteText) {
    const note = document.createElement('span');
    note.className = 'price-note';
    note.textContent = noteText;
    pricePill.appendChild(note);
  }

  cardTop.appendChild(cardTags);
  cardTop.appendChild(pricePill);

  // Body: what the task is
  const cardBody = document.createElement('div');
  cardBody.className = 'card-body';

  const cardTitle = document.createElement('h3');
  cardTitle.className = 'card-title';
  cardTitle.textContent = p.title || ''; // textContent (V8)
  cardBody.appendChild(cardTitle);

  if (p.details) {
    // Long descriptions are cut to 3 lines; the full text opens in its own window
    const cardDetails = document.createElement('p');
    cardDetails.className = 'card-details is-clamped';
    cardDetails.textContent = p.details; // textContent (V8)

    const readMore = document.createElement('button');
    readMore.type = 'button';
    readMore.className = 'read-more';
    readMore.textContent = 'Read more...';
    readMore.hidden = true; // revealed by refreshClampToggles() only when the text is cut off
    readMore.addEventListener('click', () => openPostDetail(p));
    cardDetails.addEventListener('click', () => { if (!readMore.hidden) openPostDetail(p); });

    cardBody.appendChild(cardDetails);
    cardBody.appendChild(readMore);
  }

  const postedText = formatPostedDate(p.createdAt);
  if (postedText) {
    const posted = document.createElement('time');
    posted.className = 'card-date';
    posted.dateTime = p.createdAt;
    posted.title = new Date(p.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    posted.textContent = `Posted ${postedText}`;
    cardBody.appendChild(posted);
  }

  // Who posted it: name, college and lifetime rating
  const authorRow = document.createElement('div');
  authorRow.className = 'card-author';

  const authorLink = document.createElement('a');
  authorLink.href = `profile.html?id=${encodeURIComponent(p.authorId)}`;
  authorLink.className = 'author-info';
  authorLink.title = `View ${p.author}'s profile`;

  const authorAvatar = document.createElement('div');
  authorAvatar.className = 'author-avatar';
  authorAvatar.textContent = (p.author || '?').charAt(0).toUpperCase();

  const authorMeta = document.createElement('div');
  authorMeta.className = 'author-meta';

  const authorName = document.createElement('span');
  authorName.className = 'author-name';
  authorName.textContent = (p.author || 'Unknown') + (isAuthor ? ' (you)' : ''); // textContent (V8)

  const authorSub = document.createElement('span');
  authorSub.className = 'author-sub';
  authorSub.textContent = `${p.college || 'Campus'} \u00b7 ${ratingLabel(p.authorRatingAvg, p.authorRatingCount)}`;

  authorMeta.appendChild(authorName);
  authorMeta.appendChild(authorSub);
  authorLink.appendChild(authorAvatar);
  authorLink.appendChild(authorMeta);
  authorRow.appendChild(authorLink);

  const rowActions = document.createElement('div');
  rowActions.className = 'card-author-actions';
  if (isAuthor) {
    if (p.status !== 'completed') {
      rowActions.appendChild(mkBtn('Edit', 'btn btn-outline btn-sm', '', () => openEditModal(p)));
    }
    if (p.status === 'open' && !(p.assignees || []).length) {
      rowActions.appendChild(buildMenu([{ label: 'Delete post', danger: true, onClick: () => deletePost(p.id) }]));
    }
  } else if (currentState.currentUser.isLoggedIn) {
    rowActions.appendChild(mkBtn('Report', 'btn btn-outline btn-sm btn-quiet-danger', '', () => openReportModal(p.authorId, p.author, p.id)));
  }
  if (rowActions.children.length) authorRow.appendChild(rowActions);

  card.appendChild(cardTop);
  card.appendChild(cardBody);
  card.appendChild(authorRow);
  card.appendChild(buildPostActions(p, isAuthor, hasOffered, isAssignedToMe));
  return card;
}

/** "4.5 (12 ratings)" or "No ratings yet" */
function ratingLabel(avg, count) {
  if (!count) return 'No ratings yet';
  return `\u2605 ${Number(avg).toFixed(1)} (${count} ${count === 1 ? 'rating' : 'ratings'})`;
}

function mkBtn(text, cls, css, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.style.cssText = css;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function mkBadge(text) {
  const s = document.createElement('span');
  s.className = 'tag-badge';
  s.textContent = text;
  return s;
}

const panelState = new Map(); // which dropdowns the user opened, kept across re-renders

/** Small coloured status label. tone: ok | warn | info */
function buildChip(text, tone) {
  const chip = document.createElement('span');
  chip.className = `chip chip-${tone}`;
  chip.textContent = text;
  return chip;
}

/** Native dropdown section. Content scrolls inside it, so the card never grows with the list. */
function buildCollapsible(stateKey, label, hint, children, defaultOpen) {
  const details = document.createElement('details');
  details.className = 'collapsible';
  details.open = panelState.has(stateKey) ? panelState.get(stateKey) : defaultOpen;

  const summary = document.createElement('summary');
  const title = document.createElement('span');
  title.className = 'collapsible-title';
  title.textContent = label;
  summary.appendChild(title);
  if (hint) {
    const meta = document.createElement('span');
    meta.className = 'collapsible-meta';
    meta.textContent = hint;
    summary.appendChild(meta);
  }
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'collapsible-body';
  children.forEach(c => body.appendChild(c));
  details.appendChild(body);

  details.addEventListener('toggle', () => panelState.set(stateKey, details.open));
  return details;
}

/** "More" dropdown for secondary actions. items: [{ label, onClick, danger }] */
function buildMenu(items) {
  const menu = document.createElement('details');
  menu.className = 'menu';

  const toggle = document.createElement('summary');
  toggle.className = 'btn btn-outline btn-sm menu-toggle';
  toggle.textContent = 'More';
  toggle.setAttribute('aria-label', 'More actions');
  menu.appendChild(toggle);

  const list = document.createElement('div');
  list.className = 'menu-list';
  items.forEach(item => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (item.danger ? ' menu-danger' : '');
    b.textContent = item.label;
    b.addEventListener('click', () => { menu.open = false; item.onClick(); });
    list.appendChild(b);
  });
  menu.appendChild(list);

  // The list is moved to <body> while open. Inside a scrolling panel (like the volunteers list) it would
  // otherwise be cut off at the panel's edge, which is why the first row's menu was half hidden.
  menu.addEventListener('toggle', () => {
    if (menu.open) floatMenu(menu, list); else dockMenu(menu, list);
  });
  return menu;
}

function floatMenu(menu, list) {
  const rect = menu.getBoundingClientRect();
  list.style.cssText = 'position:fixed;top:0;left:0;right:auto;bottom:auto;z-index:300;visibility:hidden;';
  document.body.appendChild(list);
  const w = list.offsetWidth;
  const h = list.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUp = spaceBelow < h + 12 && rect.top > spaceBelow; // open upward only when there is no room below
  const top = openUp ? rect.top - h - 6 : rect.bottom + 6;
  const left = Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8);
  list.style.top = `${Math.max(8, top)}px`;
  list.style.left = `${left}px`;
  list.style.visibility = 'visible';
}

function dockMenu(menu, list) {
  list.style.cssText = '';
  menu.appendChild(list);
}

function closeFloatingMenus() {
  document.querySelectorAll('details.menu[open]').forEach(m => { m.open = false; });
}
window.addEventListener('scroll', closeFloatingMenus, true); // capture: also catches scrolling inside a panel
window.addEventListener('resize', closeFloatingMenus);

// Close any open "More" menu when clicking elsewhere
document.addEventListener('click', e => {
  if (e.target.closest && e.target.closest('.menu-list')) return; // item handlers close their own menu
  document.querySelectorAll('details.menu[open]').forEach(m => { if (!m.contains(e.target)) m.open = false; });
});

/** One label that says where this volunteer is in the task. */
function volunteerStatus(a) {
  if (a.status !== 'completed') return { text: 'In progress', tone: 'warn' };
  if (a.paymentStatus === 'confirmed') return { text: 'Done, paid', tone: 'ok' };
  if (a.paymentStatus === 'paid') return { text: 'Paid, awaiting confirmation', tone: 'info' };
  return { text: 'Done, unpaid', tone: 'warn' };
}

/**
 * One volunteer = one compact row: who, one status label, one main button, and a "More" menu.
 * isAuthor: the poster managing a volunteer. Otherwise it is the volunteer's own row.
 */
function buildAssigneeRow(p, a, isAuthor) {
  if (p.type === 'offer') return buildServiceRow(p, a, isAuthor);
  const row = document.createElement('div');
  row.className = 'vol-row';

  const top = document.createElement('div');
  top.className = 'vol-top';

  const who = document.createElement('div');
  who.className = 'vol-who';
  if (isAuthor) {
    const nameLink = document.createElement('a');
    nameLink.href = `profile.html?id=${encodeURIComponent(a.userId)}`;
    nameLink.className = 'vol-name';
    nameLink.textContent = a.name; // textContent (V8)
    const rating = document.createElement('span');
    rating.className = 'vol-rating';
    rating.textContent = ratingLabel(a.ratingAvg, a.ratingCount);
    who.appendChild(nameLink);
    who.appendChild(rating);
  } else {
    const you = document.createElement('span');
    you.className = 'vol-name';
    you.textContent = 'You are assigned';
    who.appendChild(you);
  }
  const status = volunteerStatus(a);
  top.appendChild(who);
  top.appendChild(buildChip(status.text, status.tone));
  row.appendChild(top);

  // Decide the single most useful next step; everything else goes under "More"
  const other = isAuthor ? { id: a.userId, name: a.name } : { id: p.authorId, name: p.author };
  const message = () => openMessagesModal({ id: other.id, name: other.name }, p.title);
  const rate = () => openRatingModal(p.id, other.name, isAuthor ? a.userId : undefined);
  let primary = null;
  const menu = [];

  if (isAuthor) {
    if (a.status === 'assigned') {
      primary = mkBtn('Mark done', 'btn btn-black', '', () => markCompleted(p.id, a.userId));
      menu.push({ label: 'Reassign', onClick: () => changeAssignment(p.id, 'reassign', a.userId, a.name) });
    } else if (a.paymentStatus === 'unpaid') {
      primary = mkBtn(`Mark \u20b9${p.price} paid`, 'btn btn-black', '', () => markPaid(p.id, a.userId, a.name, p.price));
      menu.push({ label: `Rate ${a.name}`, onClick: rate });
    } else {
      primary = mkBtn(`Rate ${a.name}`, 'btn btn-black', '', rate);
    }
    menu.push({ label: 'Message', onClick: message });
    menu.push({ label: `Report ${a.name}`, danger: true, onClick: () => openReportModal(a.userId, a.name, p.id) });
  } else {
    if (a.status === 'assigned') {
      menu.push({ label: 'Withdraw from task', onClick: () => changeAssignment(p.id, 'withdraw') });
    } else if (a.paymentStatus === 'paid') {
      primary = mkBtn('Confirm payment received', 'btn btn-black', '', () => confirmPayment(p.id));
      menu.push({ label: `Rate ${p.author}`, onClick: rate });
    } else {
      primary = mkBtn(`Rate ${p.author}`, 'btn btn-black', '', rate);
    }
  }
  if (!primary) primary = mkBtn(`Message ${other.name}`, 'btn btn-outline', '', message);
  else if (!isAuthor) menu.push({ label: 'Message poster', onClick: message });

  const actions = document.createElement('div');
  actions.className = 'vol-actions';
  actions.appendChild(primary);
  if (menu.length) actions.appendChild(buildMenu(menu));
  row.appendChild(actions);
  return row;
}

/** A pending offer: who, rating, and two buttons. */
function buildOfferRow(p, u, isLatest) {
  const row = document.createElement('div');
  row.className = 'offer-row';

  const info = document.createElement('div');
  info.className = 'offer-info';
  const nameLink = document.createElement('a');
  nameLink.href = `profile.html?id=${encodeURIComponent(u.userId)}`;
  nameLink.className = 'vol-name';
  nameLink.textContent = u.name; // textContent (V8)
  const rating = document.createElement('span');
  rating.className = 'vol-rating';
  rating.textContent = ratingLabel(u.ratingAvg, u.ratingCount);
  info.appendChild(nameLink);
  if (isLatest) info.appendChild(buildChip('Latest', 'info'));
  info.appendChild(rating);

  const actions = document.createElement('div');
  actions.className = 'offer-actions';
  actions.appendChild(mkBtn('Message', 'btn btn-outline btn-sm', '', () => openMessagesModal({ id: u.userId, name: u.name }, p.title)));
  // Pass userId to server, not display name (V2)
  actions.appendChild(mkBtn('Accept', 'btn btn-black btn-sm', '', () => assignUser(p.id, u.userId)));

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

function buildPostActions(p, isAuthor, hasOffered, isAssignedToMe) {
  const me = currentState.currentUser.id;
  const assignees = p.assignees || [];
  const slots = p.slotsNeeded || 1;
  const openSlots = slots - assignees.length;
  const isOffer = p.type === 'offer';
  const who = isOffer ? 'customer' : 'volunteer';

  const box = document.createElement('div');
  box.className = 'card-footer';

  // ── The poster ──
  if (isAuthor) {
    if (assignees.length) {
      const doneCount = assignees.filter(a => a.status === 'completed').length;
      const hint = `${assignees.length} of ${slots} ${isOffer ? 'booked' : 'assigned'}` + (doneCount ? `, ${doneCount} done` : '');
      box.appendChild(buildCollapsible(`${p.id}:team`, isOffer ? 'Customers' : 'Volunteers', hint,
        assignees.map(a => buildAssigneeRow(p, a, true)), assignees.length <= 2));
    }

    if (p.status === 'open' && assignees.length > 0 && openSlots > 0) {
      box.appendChild(mkBtn(`Start with ${assignees.length} ${who}${assignees.length > 1 ? 's' : ''} now`,
        'btn btn-outline btn-sm', '', () => startWithCurrent(p.id)));
    }

    // Offers: the newest stays on top; older ones tuck into a dropdown
    const offers = (p.interestedUsers || []).filter(u => !assignees.some(a => a.userId === u.userId));
    if (p.status === 'open' && offers.length > 0) {
      const block = document.createElement('div');
      block.className = 'offers-block';

      const head = document.createElement('div');
      head.className = 'offers-head';
      const headTitle = document.createElement('span');
      headTitle.textContent = isOffer ? 'Service requests' : 'Volunteer offers';
      const headHint = document.createElement('span');
      headHint.className = 'collapsible-meta';
      headHint.textContent = `${openSlots} spot${openSlots === 1 ? '' : 's'} left`;
      head.appendChild(headTitle);
      head.appendChild(headHint);
      block.appendChild(head);

      block.appendChild(buildOfferRow(p, offers[offers.length - 1], true));
      const earlier = offers.slice(0, -1).reverse();
      if (earlier.length) {
        block.appendChild(buildCollapsible(`${p.id}:earlier`, `Earlier offers (${earlier.length})`, '',
          earlier.map(u => buildOfferRow(p, u, false)), false));
      }
      box.appendChild(block);
    } else if (p.status === 'open') {
      const wait = document.createElement('p');
      wait.className = 'status-note';
      wait.textContent = assignees.length
        ? `Waiting for ${openSlots} more ${who}${openSlots === 1 ? '' : 's'}.`
        : (isOffer ? 'Waiting for customers to request your service.' : 'Waiting for volunteers to respond.');
      box.appendChild(wait);
    }
    return box;
  }

  // ── Everyone else ──
  if (isAssignedToMe) {
    assignees.filter(a => a.userId === me).forEach(a => box.appendChild(buildAssigneeRow(p, a, false)));
  } else if (p.status === 'open') {
    const row = document.createElement('div');
    row.className = 'footer-row';
    if (hasOffered) {
      const sent = mkBtn(p.type === 'offer' ? 'Request sent' : 'Offer sent', 'btn btn-outline', 'flex:1;', () => {});
      sent.disabled = true;
      row.appendChild(sent);
    } else {
      row.appendChild(mkBtn(p.type === 'need' ? 'Offer help' : 'Request service', 'btn btn-black', 'flex:1;', () => submitOffer(p.id)));
    }
    row.appendChild(mkBtn('Message', 'btn btn-outline', '', () => openMessagesModal({ id: p.authorId, name: p.author }, p.title)));
    box.appendChild(row);
  } else {
    const note = document.createElement('p');
    note.className = 'status-note';
    note.textContent = p.status === 'completed' ? 'This task is completed.' : 'This task is in progress.';
    box.appendChild(note);
  }
  return box;
}

// ── Service posts ("I offer a service"): customers pay, the provider confirms ──
// Delivery is confirmed by the customer; payment is recorded by the customer and confirmed by the provider.

function serviceStatus(a) {
  if (a.status === 'completed' && a.paymentStatus === 'confirmed') return { text: 'Completed, paid', tone: 'ok' };
  if (a.status === 'completed') return { text: a.paymentStatus === 'paid' ? 'Completed, payment to confirm' : 'Completed, unpaid', tone: 'info' };
  if (a.status === 'delivered') {
    return a.paymentStatus === 'paid'
      ? { text: 'Paid, awaiting confirmation', tone: 'info' }
      : { text: 'Delivered, awaiting payment', tone: 'warn' };
  }
  return { text: 'Booked', tone: 'warn' };
}

/**
 * One customer on a service post. The order is:
 *   provider: Mark delivered  ->  customer: Mark payment as sent  ->  provider: Confirm payment received
 */
function buildServiceRow(p, a, isAuthor) {
  const row = document.createElement('div');
  row.className = 'vol-row';

  const top = document.createElement('div');
  top.className = 'vol-top';
  const who = document.createElement('div');
  who.className = 'vol-who';
  if (isAuthor) {
    const nameLink = document.createElement('a');
    nameLink.href = `profile.html?id=${encodeURIComponent(a.userId)}`;
    nameLink.className = 'vol-name';
    nameLink.textContent = a.name; // textContent (V8)
    const rating = document.createElement('span');
    rating.className = 'vol-rating';
    rating.textContent = ratingLabel(a.ratingAvg, a.ratingCount);
    who.appendChild(nameLink);
    who.appendChild(rating);
  } else {
    const you = document.createElement('span');
    you.className = 'vol-name';
    you.textContent = 'Your booking';
    who.appendChild(you);
  }
  const status = serviceStatus(a);
  top.appendChild(who);
  top.appendChild(buildChip(status.text, status.tone));
  row.appendChild(top);

  const other = isAuthor ? { id: a.userId, name: a.name } : { id: p.authorId, name: p.author };
  const message = () => openMessagesModal({ id: other.id, name: other.name }, p.title);
  const rate = () => openRatingModal(p.id, other.name, isAuthor ? a.userId : undefined);
  const finished = a.status === 'completed';
  let primary = null;
  const menu = [];

  if (isAuthor) {
    if (a.paymentStatus === 'paid') {
      // Step 3: the customer says they paid, the provider checks and confirms
      primary = mkBtn('Confirm payment received', 'btn btn-black', '', () => paymentReceived(p.id, a.userId, true));
      menu.push({ label: 'I did not receive this payment', danger: true, onClick: () => paymentReceived(p.id, a.userId, false) });
    } else if (a.status === 'assigned') {
      // Step 1: deliver the service
      primary = mkBtn('Mark delivered', 'btn btn-black', '', () => deliverService(p.id, a.userId, a.name));
      menu.push({ label: 'Cancel booking', onClick: () => changeAssignment(p.id, 'reassign', a.userId, a.name) });
    } else if (finished && a.paymentStatus === 'confirmed') {
      primary = mkBtn(`Rate ${a.name}`, 'btn btn-black', '', rate);
    }
    if (finished && a.paymentStatus !== 'confirmed') menu.push({ label: `Rate ${a.name}`, onClick: rate });
    menu.push({ label: `Report ${a.name}`, danger: true, onClick: () => openReportModal(a.userId, a.name, p.id) });
  } else {
    if ((a.status === 'delivered' || finished) && a.paymentStatus === 'unpaid') {
      // Step 2: after delivery, the customer marks the payment as sent
      primary = mkBtn('Mark payment as sent', 'btn btn-black', '', () => markServicePaid(p));
    } else if (finished && a.paymentStatus === 'confirmed') {
      primary = mkBtn(`Rate ${p.author}`, 'btn btn-black', '', rate);
    } else if (a.status === 'assigned') {
      menu.push({ label: 'Cancel booking', onClick: () => changeAssignment(p.id, 'withdraw') });
    }
    if (finished && primary && a.paymentStatus === 'unpaid') menu.push({ label: `Rate ${p.author}`, onClick: rate });
  }
  if (!primary) primary = mkBtn(`Message ${other.name}`, 'btn btn-outline', '', message);
  else menu.push({ label: 'Message', onClick: message });

  const actions = document.createElement('div');
  actions.className = 'vol-actions';
  actions.appendChild(primary);
  if (menu.length) actions.appendChild(buildMenu(menu));
  row.appendChild(actions);
  return row;
}

function deliverService(postId, customerUserId, name) {
  if (!confirm(`Mark the service as delivered to ${name}? They will be asked to confirm it.`)) return;
  return postAction({ id: postId, action: 'deliver' }, { customerUserId });
}

function paymentReceived(postId, customerUserId, received) {
  const msg = received
    ? 'Confirm that the payment has reached you?'
    : 'Tell the customer you did NOT receive this payment? It goes back to unpaid.';
  if (!confirm(msg)) return;
  return postAction({ id: postId, action: 'payment-received' }, { customerUserId, received });
}

function markServicePaid(p) {
  if (!confirm(`Confirm that you received the service and have paid ${p.author} \u20b9${p.price}? Only continue if both are true.`)) return;
  return postAction({ id: p.id, action: 'payment-sent' }, {});
}

// ── Trust features: ratings & reports ──────────────────────────────────────────

/** Small reusable modal built with DOM methods only (no innerHTML). */
function openTrustModal({ title, intro, withScore, categories, placeholder, submitLabel, onSubmit }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal-box';
  box.style.maxWidth = '400px';

  const head = document.createElement('div');
  head.className = 'modal-header';
  const h3 = document.createElement('h3');
  h3.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn';
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  head.appendChild(h3);
  head.appendChild(closeBtn);
  box.appendChild(head);

  const introEl = document.createElement('p');
  introEl.style.cssText = 'font-size:13.5px;color:var(--muted);';
  introEl.textContent = intro;
  box.appendChild(introEl);

  let catSelect = null;
  if (categories) {
    catSelect = document.createElement('select');
    catSelect.style.cssText = 'width:100%;';
    categories.forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      catSelect.appendChild(opt);
    });
    box.appendChild(catSelect);
  }

  let scoreSelect = null;
  if (withScore) {
    scoreSelect = document.createElement('select');
    scoreSelect.style.cssText = 'width:100%;';
    [[5, '5 - Excellent'], [4, '4 - Good'], [3, '3 - Okay'], [2, '2 - Poor'], [1, '1 - Bad']].forEach(([v, label]) => {
      const opt = document.createElement('option');
      opt.value = String(v);
      opt.textContent = label;
      scoreSelect.appendChild(opt);
    });
    box.appendChild(scoreSelect);
  }

  const textarea = document.createElement('textarea');
  textarea.rows = 3;
  textarea.maxLength = 500;
  textarea.placeholder = placeholder;
  textarea.style.cssText = 'width:100%;resize:vertical;';
  box.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-outline';
  cancelBtn.textContent = 'Cancel';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'btn btn-black';
  submitBtn.textContent = submitLabel;
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  box.appendChild(actions);

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    const ok = await onSubmit({
      score: scoreSelect ? Number(scoreSelect.value) : null,
      category: catSelect ? catSelect.value : null,
      text: textarea.value.trim(),
    });
    if (ok) close(); else submitBtn.disabled = false;
  });
}

function openRatingModal(postId, personName, rateeId) {
  openTrustModal({
    title: `Rate ${personName}`,
    intro: 'Your honest rating helps other students decide who to trust.',
    withScore: true,
    placeholder: 'Optional comment (max 500 characters)',
    submitLabel: 'Submit Rating',
    onSubmit: ({ score, text }) => submitRating(postId, score, text, rateeId),
  });
}

const REPORT_CATEGORIES = [
  ['scam', 'Scam / unfair money demand'],
  ['no_show', 'No-show / did not complete the task'],
  ['harassment', 'Harassment or rude behaviour'],
  ['fake_post', 'Fake or misleading post'],
  ['inappropriate', 'Inappropriate content'],
  ['off_platform', 'Asked me to pay outside EarnKampus or pay extra'],
  ['other', 'Other (please explain)'],
];

function openReportModal(targetUserId, personName, postId) {
  openTrustModal({
    title: `Report ${personName}`,
    intro: 'Choose what went wrong. Reports are reviewed by the EarnKampus team.',
    withScore: false,
    categories: REPORT_CATEGORIES,
    placeholder: 'Add details (required if you chose "Other")',
    submitLabel: 'Submit Report',
    onSubmit: ({ category, text }) => {
      if (category === 'other' && !text) { showToast('Please explain the problem.', 'error'); return false; }
      return submitReport(targetUserId, postId, category, text);
    },
  });
}

async function submitRating(postId, score, comment, rateeId) {
  try {
    const res = await fetch(`${API_BASE}/posts/${encodeURIComponent(postId)}/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ score, comment, rateeId }),
    });
    if (res.status === 401) { clearUserSession(); return false; }
    const data = await res.json();
    if (data.success) {
      showToast('Thanks for rating!', 'success');
      fetchPosts(); // refresh so the new average shows on cards right away
      return true;
    }
    showToast(data.error || 'Could not submit rating.', 'error');
    return false;
  } catch (err) {
    showToast('Error submitting rating.', 'error');
    return false;
  }
}

async function submitReport(targetUserId, postId, category, reason) {
  try {
    const res = await fetch(`${API_BASE}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ targetUserId, postId, category, reason }),
    });
    if (res.status === 401) { clearUserSession(); return false; }
    const data = await res.json();
    if (data.success) { showToast('Report submitted. Thank you.', 'success'); return true; }
    showToast(data.error || 'Could not submit report.', 'error');
    return false;
  } catch (err) {
    showToast('Error submitting report.', 'error');
    return false;
  }
}

// ── API action handlers ────────────────────────────────────────────────────────

async function handleCreatePost(e) {
  e.preventDefault();

  if (!currentState.currentUser.isLoggedIn) {
    showAuthRequiredModal('You must be logged in to create a task post.');
    return;
  }
  if (editingPostId) { return submitPostEdit(); }

  const typeRadios = document.getElementsByName('postType');
  let selectedType = 'need';
  typeRadios.forEach(r => { if (r.checked) selectedType = r.value; });

  const title = document.getElementById('postTitleInput').value;
  const category = document.getElementById('postCategorySelect').value;
  const price = document.getElementById('postPriceInput').value;
  const slotsEl = document.getElementById('postSlotsInput');
  const slotsNeeded = slotsEl ? slotsEl.value : 1;
  const details = document.getElementById('postDetailsInput').value;

  // Client-side trim; server enforces limits too
  if (!title || title.trim() === '') { showToast('Title is required.', 'error'); return; }


  try {
    const res = await fetch(`${API_BASE}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      // Do NOT send author/authorId — server derives from session (V3)
      body: JSON.stringify({ type: selectedType, title, category, price, details, slotsNeeded }),
    });

    if (res.status === 401) {
      clearUserSession();
      showAuthRequiredModal('Your session expired. Please log in again.');
      return;
    }

    const data = await res.json();
    if (data.success) {
      showToast('Post created successfully!', 'success');
      closeComposerModal();
      await loadStats();
      await fetchPosts();
    } else {
      showToast(data.error || 'Error creating post.', 'error');
    }
  } catch (err) {
    showToast('Failed to create post due to network error.', 'error');
  }
}

async function submitOffer(postId) {
  if (!currentState.currentUser.isLoggedIn) {
    showAuthRequiredModal('You must be logged in to offer help or request services on tasks.');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/posts/${postId}/offer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      // No userName in body — server uses session (V2)
      body: JSON.stringify({}),
    });

    if (res.status === 401) { clearUserSession(); return; }

    const data = await res.json();
    if (data.success) {
      showToast('Offer submitted to poster!', 'success');
      await loadStats();
      await fetchPosts();
    } else {
      showToast(data.error || 'Could not submit offer.', 'error');
    }
  } catch (err) {
    showToast('Error submitting offer.', 'error');
  }
}

async function assignUser(postId, volunteerUserId) {
  try {
    const res = await fetch(`${API_BASE}/posts/${postId}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      // Send userId as the selector — server verifies ownership (V2)
      body: JSON.stringify({ volunteerUserId }),
    });

    if (res.status === 401) { clearUserSession(); return; }

    const data = await res.json();
    if (data.success) {
      showToast('Task assigned!', 'success');
      await loadStats();
      await fetchPosts();
    } else {
      showToast(data.error || 'Could not assign volunteer.', 'error');
    }
  } catch (err) {
    showToast('Error assigning task.', 'error');
  }
}

async function postAction(path, body, okMessage) {
  try {
    const res = await fetch(`${API_BASE}/posts/${encodeURIComponent(path.id)}/${path.action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) { clearUserSession(); return; }
    const data = await res.json();
    if (data.success) {
      await loadStats();
      if (data.post && data.post.status === 'completed' && currentState.currentTab !== 'mine') {
        // Finished tasks leave the public feed, so take the user to where they can still rate / pay
        showToast('Task finished! It moved to My Tasks, where you can rate and confirm payment.', 'success');
        switchTab('mine');
      } else {
        showToast(okMessage || data.message || 'Done.', 'success');
        await fetchPosts();
      }
    } else {
      showToast(data.error || 'Something went wrong.', 'error');
    }
  } catch (err) {
    showToast('Network error. Please try again.', 'error');
  }
}

function markCompleted(postId, volunteerUserId) {
  return postAction({ id: postId, action: 'complete' }, { volunteerUserId });
}

function changeAssignment(postId, action, volunteerUserId, volunteerName) {
  const msg = action === 'reassign'
    ? `Remove ${volunteerName || 'this volunteer'} and reopen their slot so you can choose someone else?`
    : 'Withdraw from this task? Your slot will reopen for others.';
  if (!confirm(msg)) return;
  return postAction({ id: postId, action }, { volunteerUserId });
}

function markPaid(postId, volunteerUserId, name, price) {
  if (!confirm(`Only continue if you have really paid ${name} ₹${price} Mark as paid?`)) return;
  return postAction({ id: postId, action: 'pay' }, { volunteerUserId });
}

function confirmPayment(postId) {
  if (!confirm('Confirm that you received your payment?')) return;
  return postAction({ id: postId, action: 'confirm-payment' }, {});
}

function startWithCurrent(postId) {
  if (!confirm('Start now with the volunteers you already accepted? The remaining spots will be closed.')) return;
  return postAction({ id: postId, action: 'start' }, {});
}

async function deletePost(postId) {
  if (!confirm('Are you sure you want to delete this post?')) return;

  try {
    const res = await fetch(`${API_BASE}/posts/${postId}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });

    if (res.status === 401) { clearUserSession(); return; }
    if (res.status === 403) { showToast('You are not authorized to delete this post.', 'error'); return; }

    const data = await res.json();
    if (data.success) {
      showToast('Post deleted.', 'success');
      await loadStats();
      await fetchPosts();
    } else {
      showToast(data.error || 'Could not delete post.', 'error');
    }
  } catch (err) {
    showToast('Error deleting post.', 'error');
  }
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const msgSpan = document.createElement('span');
  msgSpan.textContent = message; // textContent — no XSS (V8)

  toast.appendChild(msgSpan);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}


// ── Notifications ───────────────────────────────────────────────────────────

const notifState = { items: [], unread: 0, pollTimer: null, loadedOnce: false };

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (notifState.unread > 0) {
    badge.textContent = notifState.unread > 9 ? '9+' : String(notifState.unread);
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

async function fetchNotifications() {
  if (!currentState.currentUser.isLoggedIn) return;
  try {
    const res = await fetch(`${API_BASE}/notifications`, { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success) return;

    const grew = data.unread > notifState.unread;
    notifState.items = data.notifications;
    notifState.unread = data.unread;
    updateNotifBadge();

    if (grew && notifState.loadedOnce) {
      const newest = data.notifications.find(n => !n.read);
      if (newest) showToast(newest.title, 'info');
    }
    notifState.loadedOnce = true;

    const modal = document.getElementById('notifModal');
    if (modal && !modal.hidden) renderNotifications();
  } catch (err) { /* offline: the next check will try again */ }
}

function startNotificationPolling() {
  if (notifState.pollTimer) return;
  notifState.pollTimer = setInterval(() => { if (!document.hidden) fetchNotifications(); }, 45000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fetchNotifications(); });
}

function renderNotifications() {
  const list = document.getElementById('notifList');
  if (!list) return;
  list.textContent = '';

  if (!notifState.items.length) {
    const empty = document.createElement('p');
    empty.className = 'notif-empty';
    empty.textContent = 'Nothing yet. Updates about your tasks, orders and payments will appear here.';
    list.appendChild(empty);
    return;
  }

  notifState.items.forEach(n => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'notif-item' + (n.read ? '' : ' unread');

    const dot = document.createElement('span');
    dot.className = 'notif-dot';
    const text = document.createElement('div');
    text.className = 'notif-text';
    const title = document.createElement('span');
    title.className = 'notif-title';
    title.textContent = n.title; // textContent (V8)
    const body = document.createElement('span');
    body.className = 'notif-body';
    body.textContent = n.body || '';
    const time = document.createElement('span');
    time.className = 'notif-time';
    time.textContent = formatPostedDate(n.createdAt);
    text.appendChild(title);
    if (n.body) text.appendChild(body);
    text.appendChild(time);

    item.appendChild(dot);
    item.appendChild(text);
    item.addEventListener('click', () => openNotificationTarget(n));
    list.appendChild(item);
  });
}

function openNotifications() {
  const modal = document.getElementById('notifModal');
  if (!modal) return;
  renderNotifications();
  modal.hidden = false;
  if (notifState.unread > 0) {
    notifState.unread = 0; // they are being read now
    updateNotifBadge();
    fetch(`${API_BASE}/notifications/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({}),
    }).catch(() => {});
  }
}

function closeNotifications() {
  const modal = document.getElementById('notifModal');
  if (modal) modal.hidden = true;
}

/** Take the user to the post a notification is about (finished tasks only live in My tasks). */
async function openNotificationTarget(n) {
  closeNotifications();
  if (!n.postId) return;
  if (currentState.currentTab !== 'mine') await switchTab('mine'); else await fetchPosts();
  const card = Array.from(document.querySelectorAll('.post-card')).find(c => c.dataset.postId === n.postId);
  if (!card) { showToast('That post is no longer available.', 'error'); return; }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('post-flash');
  setTimeout(() => card.classList.remove('post-flash'), 2400);
}

(function setupNotificationUI() {
  const btn = document.getElementById('navNotifBtn');
  if (btn) btn.addEventListener('click', openNotifications);
  const modal = document.getElementById('notifModal');
  if (!modal) return;
  const closeBtn = document.getElementById('closeNotifBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeNotifications);
  modal.addEventListener('click', e => { if (e.target === modal) closeNotifications(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeNotifications(); });
})();

// If assets/logo.png is missing, hide the image instead of showing a broken icon
document.querySelectorAll('.brand-logo').forEach(img => {
  const hide = () => { img.style.display = 'none'; };
  img.addEventListener('error', hide);
  if (img.complete && img.naturalWidth === 0) hide();
});