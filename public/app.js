'use strict';

const API_BASE = '/api';

/**
 * EarnCampus Frontend — app.js
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
    avatar: '👤',
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
          avatar: parsed.avatar || '🎓',
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
        localStorage.setItem('earncampus_ui_hint', JSON.stringify(data.user));
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
    avatar: '👤',
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

  if (avatarEl) avatarEl.textContent = currentState.currentUser.avatar || '👤';
  if (nameEl) nameEl.textContent = currentState.currentUser.name || 'Guest';

  if (currentState.currentUser.isLoggedIn) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (signupBtn) signupBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    if (messagesBtn) messagesBtn.style.display = 'inline-flex';
  } else {
    if (loginBtn) loginBtn.style.display = 'inline-flex';
    if (signupBtn) signupBtn.style.display = 'inline-flex';
    if (logoutBtn) logoutBtn.style.display = 'none';
    if (messagesBtn) messagesBtn.style.display = 'none';
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
        window.location.href = 'login.html';
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
  if (textEl) textEl.textContent = message || 'You must be logged in to post tasks or offer help on EarnCampus.';
  if (modal) modal.hidden = false;
}

function closeAuthRequiredModal() {
  const modal = document.getElementById('authRequiredModal');
  if (modal) modal.hidden = true;
}

function openComposerModal() {
  if (!currentState.currentUser.isLoggedIn) {
    showAuthRequiredModal('You must be logged in to create a new task post.');
    return;
  }
  const modal = document.getElementById('composerModal');
  if (modal) modal.hidden = false;
}

function closeComposerModal() {
  const modal = document.getElementById('composerModal');
  const form = document.getElementById('postForm');
  if (modal) modal.hidden = true;
  if (form) form.reset();
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

function openMessagesModal(targetUser = null, prefillContext = '') {
  if (!currentState.currentUser.isLoggedIn) {
    showAuthRequiredModal('Please log in to send direct messages to campus members.');
    return;
  }

  const modal = document.getElementById('messagesModal');
  if (modal) modal.hidden = false;

  fetchMessages().then(() => {
    renderContactsList(targetUser ? targetUser.id : null);
    if (targetUser) {
      selectContact(targetUser);
      if (prefillContext) {
        const input = document.getElementById('chatInputText');
        if (input) {
          // Use textContent assignment, not innerHTML
          input.value = `Hi ${targetUser.name}, regarding your post "${prefillContext}": `;
        }
      }
    } else {
      const contacts = getContactsList();
      if (contacts.length > 0) selectContact(contacts[0]);
    }
  });
}

function closeMessagesModal() {
  const modal = document.getElementById('messagesModal');
  if (modal) modal.hidden = true;
}

function getContactsList() {
  // Build contact list from actual messages only (no hardcoded default users)
  const map = new Map();

  currentState.messages.forEach(m => {
    const otherId = m.senderId === currentState.currentUser.id ? m.receiverId : m.senderId;
    const otherName = m.senderId === currentState.currentUser.id ? m.receiverName : m.senderName;
    if (otherId && otherId !== currentState.currentUser.id && !map.has(otherId)) {
      map.set(otherId, { id: otherId, name: otherName, avatar: '👤' });
    }
  });

  // Also include users from current posts (for "Message" button on post cards)
  currentState.posts.forEach(p => {
    if (p.authorId && p.authorId !== currentState.currentUser.id && !map.has(p.authorId)) {
      map.set(p.authorId, { id: p.authorId, name: p.author, avatar: '👤' });
    }
  });

  return Array.from(map.values());
}

function renderContactsList(selectedUserId = null) {
  const contactsList = document.getElementById('contactsList');
  if (!contactsList) return;

  const contacts = getContactsList();
  contactsList.innerHTML = '';

  contacts.forEach(c => {
    const div = document.createElement('div');
    const isActive = c.id === (currentState.activeChatUser ? currentState.activeChatUser.id : selectedUserId);
    div.className = `contact-item ${isActive ? 'active' : ''}`;
    div.addEventListener('click', () => selectContact(c));

    const avatarSpan = document.createElement('span');
    avatarSpan.className = 'contact-avatar';
    avatarSpan.textContent = c.avatar || '👤';

    const infoDiv = document.createElement('div');
    infoDiv.className = 'contact-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'contact-name';
    nameSpan.textContent = c.name; // textContent — not innerHTML (V8)

    infoDiv.appendChild(nameSpan);
    div.appendChild(avatarSpan);
    div.appendChild(infoDiv);
    contactsList.appendChild(div);
  });
}

function selectContact(user) {
  currentState.activeChatUser = user;
  markThreadRead(user.id);
  renderContactsList(user.id);

  const activeUserHeader = document.getElementById('chatActiveUser');
  if (activeUserHeader) {
    activeUserHeader.textContent = `Chatting with ${user.name}`; // textContent (V8)
  }

  const sendMessageForm = document.getElementById('sendMessageForm');
  if (sendMessageForm) sendMessageForm.hidden = false;

  renderChatThread();
}

function renderChatThread() {
  const body = document.getElementById('chatMessagesBody');
  if (!body) return;

  if (!currentState.activeChatUser) {
    body.textContent = '';
    const state = document.createElement('div');
    state.className = 'empty-chat-state';
    const icon = document.createElement('span');
    icon.style.fontSize = '32px';
    icon.textContent = '💬';
    const txt = document.createElement('p');
    txt.style.fontSize = '13px';
    txt.style.color = 'var(--muted)';
    txt.textContent = 'Select a student from the left sidebar to view messages.';
    state.appendChild(icon);
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
    const icon = document.createElement('span');
    icon.style.fontSize = '28px';
    icon.textContent = '👋';
    const txt = document.createElement('p');
    txt.style.fontSize = '13px';
    txt.style.color = 'var(--muted)';
    txt.textContent = `No messages yet with ${currentState.activeChatUser.name}. Send a message to start!`;
    state.appendChild(icon);
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

  fetchPosts();
}

function renderPosts() {
  const postsGrid = document.getElementById('postsGrid');
  const countBadge = document.getElementById('feedCountBadge');
  if (!postsGrid) return;

  postsGrid.textContent = '';
  if (countBadge) {
    countBadge.textContent = `${currentState.posts.length} ${currentState.posts.length === 1 ? 'task' : 'tasks'}`;
  }

  if (currentState.posts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'loading-spinner';
    const mineTab = currentState.currentTab === 'mine';
    const icon = document.createElement('span');
    icon.style.fontSize = '32px';
    icon.textContent = '📭';
    const t1 = document.createElement('span');
    t1.style.cssText = 'font-weight:700;color:var(--ink)';
    const guest = !currentState.currentUser.isLoggedIn;
    t1.textContent = mineTab ? 'No tasks yet' : (guest ? 'Log in to see tasks' : 'No posts found');
    const t2 = document.createElement('span');
    t2.style.fontSize = '13px';
    t2.textContent = mineTab
      ? 'Tasks you post or help with will appear here, including finished ones.'
      : (guest ? 'EarnCampus shows tasks from your own college. Log in with your college email to see them.' : 'Be the first to create a post in this category!');
    empty.appendChild(icon);
    empty.appendChild(t1);
    empty.appendChild(t2);
    postsGrid.appendChild(empty);
    return;
  }

  currentState.posts.forEach(p => {
    const card = buildPostCard(p);
    postsGrid.appendChild(card);
  });
}

function buildPostCard(p) {
  // Compare by server-derived authorId, not display name (V3)
  const isAuthor = p.authorId === currentState.currentUser.id;
  const hasOffered = p.interestedUsers && p.interestedUsers.some(u => u.userId === currentState.currentUser.id);
  const isAssignedToMe = (p.assignees || []).some(a => a.userId === currentState.currentUser.id);

  const card = document.createElement('div');
  card.className = 'post-card';

  // Card top — use DOM, not innerHTML for user data (V8)
  const cardTop = document.createElement('div');
  cardTop.className = 'card-top';

  const authorLink = document.createElement('a');
  authorLink.href = `profile.html?id=${encodeURIComponent(p.authorId)}`;
  authorLink.className = 'author-info';
  authorLink.style.cssText = 'text-decoration:none;color:inherit;cursor:pointer;';
  authorLink.title = `View ${p.author}'s Profile`;

  const authorAvatar = document.createElement('div');
  authorAvatar.className = 'author-avatar';
  authorAvatar.textContent = '👤';

  const authorMeta = document.createElement('div');
  authorMeta.className = 'author-meta';

  const authorName = document.createElement('span');
  authorName.className = 'author-name';
  authorName.style.textDecoration = 'underline';
  authorName.textContent = p.author || 'Unknown'; // textContent — no XSS (V8)

  const authorCollege = document.createElement('span');
  authorCollege.className = 'author-college';
  authorCollege.textContent = `🎓 ${p.college || 'Campus'}`;

  const authorRating = document.createElement('span');
  authorRating.className = 'author-college';
  authorRating.style.fontWeight = '600';
  authorRating.textContent = ratingLabel(p.authorRatingAvg, p.authorRatingCount);

  authorMeta.appendChild(authorName);
  authorMeta.appendChild(authorCollege);
  authorMeta.appendChild(authorRating);
  authorLink.appendChild(authorAvatar);
  authorLink.appendChild(authorMeta);

  const pricePill = document.createElement('div');
  pricePill.className = 'price-pill';
  pricePill.textContent = (p.slotsNeeded || 1) > 1 ? `₹${p.price} each` : `₹${p.price}`;

  cardTop.appendChild(authorLink);
  cardTop.appendChild(pricePill);

  // Card body
  const cardBody = document.createElement('div');
  cardBody.className = 'card-body';

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

  // Poster's rating, shown as its own badge so it is easy to spot on every card
  const ratedBadge = document.createElement('span');
  ratedBadge.className = 'tag-badge';
  ratedBadge.style.cssText = 'font-weight:700;color:var(--accent);background:var(--accent-soft);box-shadow:none;';
  ratedBadge.title = 'Rating of the person who posted this task';
  ratedBadge.textContent = p.authorRatingCount
    ? `⭐ ${Number(p.authorRatingAvg).toFixed(1)} · ${p.authorRatingCount} rated`
    : '⭐ New (0 rated)';
  cardTags.appendChild(ratedBadge);

  const cardTitle = document.createElement('h3');
  cardTitle.className = 'card-title';
  cardTitle.textContent = p.title || ''; // textContent (V8)

  const cardDetails = document.createElement('p');
  cardDetails.className = 'card-details';
  cardDetails.textContent = p.details || ''; // textContent (V8)

  cardBody.appendChild(cardTags);
  cardBody.appendChild(cardTitle);
  cardBody.appendChild(cardDetails);

  card.appendChild(cardTop);
  card.appendChild(cardBody);

  // Action footer
  const actionContainer = buildPostActions(p, isAuthor, hasOffered, isAssignedToMe);
  card.appendChild(actionContainer);

  return card;
}

/** "⭐ 4.5 (12 ratings)" or "⭐ No ratings yet" */
function ratingLabel(avg, count) {
  if (!count) return '⭐ No ratings yet';
  return `⭐ ${Number(avg).toFixed(1)} (${count} ${count === 1 ? 'rating' : 'ratings'})`;
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

const PAYMENT_LABELS = {
  unpaid: '💰 Unpaid',
  paid: '💸 Paid, awaiting confirmation',
  confirmed: '✅ Payment confirmed',
};

/** One volunteer's row: status, payment, and the actions that apply to the viewer. */
function buildAssigneeRow(p, a, isAuthor) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-direction:column;gap:8px;border-radius:13px;padding:10px;background:var(--surface);box-shadow:var(--inset);';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;';
  const nameLink = document.createElement('a');
  nameLink.href = `profile.html?id=${encodeURIComponent(a.userId)}`;
  nameLink.style.cssText = 'font-weight:700;color:inherit;text-decoration:underline;';
  nameLink.textContent = a.name;
  head.appendChild(nameLink);
  head.appendChild(mkBadge(ratingLabel(a.ratingAvg, a.ratingCount)));
  head.appendChild(mkBadge(a.status === 'completed' ? '✅ Work done' : '⚡ In progress'));
  if (a.status === 'completed') head.appendChild(mkBadge(PAYMENT_LABELS[a.paymentStatus] || a.paymentStatus));
  row.appendChild(head);

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
  const small = 'font-size:11px;padding:4px 8px;';

  if (isAuthor) {
    btns.appendChild(mkBtn('💬 Chat', 'btn btn-outline', small, () => openMessagesModal({ id: a.userId, name: a.name }, p.title)));
    if (a.status === 'assigned') {
      btns.appendChild(mkBtn('✅ Mark done', 'btn btn-emerald', small, () => markCompleted(p.id, a.userId)));
      btns.appendChild(mkBtn('🔄 Reassign', 'btn btn-outline', small, () => changeAssignment(p.id, 'reassign', a.userId, a.name)));
    } else {
      if (a.paymentStatus === 'unpaid') {
        btns.appendChild(mkBtn(`💸 Mark ₹${p.price} paid`, 'btn btn-emerald', small, () => markPaid(p.id, a.userId, a.name, p.price)));
      }
      btns.appendChild(mkBtn('⭐ Rate', 'btn btn-black', small, () => openRatingModal(p.id, a.name, a.userId)));
    }
    btns.appendChild(mkBtn('🚩', 'btn btn-outline', small + 'color:var(--danger);', () => openReportModal(a.userId, a.name, p.id)));
  } else {
    // viewer is this volunteer
    btns.appendChild(mkBtn(`💬 Message ${p.author}`, 'btn btn-outline', small, () => openMessagesModal({ id: p.authorId, name: p.author }, p.title)));
    if (a.status === 'assigned') {
      btns.appendChild(mkBtn('↩ Withdraw', 'btn btn-outline', small, () => changeAssignment(p.id, 'withdraw')));
    } else {
      if (a.paymentStatus === 'paid') {
        btns.appendChild(mkBtn('✅ Confirm payment received', 'btn btn-emerald', small, () => confirmPayment(p.id)));
      }
      btns.appendChild(mkBtn(`⭐ Rate ${p.author}`, 'btn btn-black', small, () => openRatingModal(p.id, p.author)));
    }
  }
  row.appendChild(btns);
  return row;
}

function buildPostActions(p, isAuthor, hasOffered, isAssignedToMe) {
  const me = currentState.currentUser.id;
  const loggedIn = currentState.currentUser.isLoggedIn;
  const assignees = p.assignees || [];
  const slots = p.slotsNeeded || 1;
  const openSlots = slots - assignees.length;

  const box = document.createElement('div');
  box.className = 'card-footer';
  box.style.cssText = 'display:flex;flex-direction:column;gap:8px;';

  // Slot progress (only when it carries information)
  if (slots > 1 || assignees.length) {
    const prog = document.createElement('div');
    prog.style.cssText = 'font-size:12px;font-weight:700;';
    prog.textContent = `👥 ${assignees.length}/${slots} volunteers assigned`;
    box.appendChild(prog);
  }

  // Volunteers panel: the poster sees everyone; a volunteer sees only their own row
  const visible = isAuthor ? assignees : assignees.filter(a => a.userId === me);
  visible.forEach(a => box.appendChild(buildAssigneeRow(p, a, isAuthor)));

  if (isAuthor) {
    // Start early with whoever has been accepted
    if (p.status === 'open' && assignees.length > 0 && openSlots > 0) {
      box.appendChild(mkBtn(`▶ Start with ${assignees.length} volunteer${assignees.length > 1 ? 's' : ''} (don't wait for ${openSlots} more)`,
        'btn btn-outline', 'font-size:11px;padding:4px 8px;', () => startWithCurrent(p.id)));
    }

    // Offers waiting to be accepted
    const offers = (p.interestedUsers || []).filter(u => !assignees.some(a => a.userId === u.userId));
    if (p.status === 'open' && offers.length > 0) {
      const listDiv = document.createElement('div');
      listDiv.className = 'offers-list';
      const label = document.createElement('span');
      label.style.cssText = 'font-size:12px;font-weight:700;color:var(--muted);';
      label.textContent = `Volunteer offers (${openSlots} spot${openSlots === 1 ? '' : 's'} left)`;
      listDiv.appendChild(label);

      offers.forEach(u => {
        const offerRow = document.createElement('div');
        offerRow.className = 'offer-item';

        const offerLabel = document.createElement('span');
        const userLink = document.createElement('a');
        userLink.href = `profile.html?id=${encodeURIComponent(u.userId)}`;
        userLink.style.cssText = 'text-decoration:underline;color:inherit;font-weight:700;';
        userLink.textContent = u.name; // textContent (V8)
        offerLabel.textContent = '✋ ';
        offerLabel.appendChild(userLink);
        offerLabel.appendChild(document.createTextNode(` offered help · ${ratingLabel(u.ratingAvg, u.ratingCount)}`));

        const btnGroup = document.createElement('div');
        btnGroup.style.cssText = 'display:flex;gap:4px;';
        const msgBtn = mkBtn('💬', 'btn btn-outline', 'padding:3px 8px;font-size:11px;', () => openMessagesModal({ id: u.userId, name: u.name }, p.title));
        msgBtn.title = `Message ${u.name}`;
        // Pass userId to server, not display name (V2)
        const acceptBtn = mkBtn('Accept & Assign', 'btn btn-emerald', 'padding:4px 8px;font-size:11px;', () => assignUser(p.id, u.userId));
        btnGroup.appendChild(msgBtn);
        btnGroup.appendChild(acceptBtn);
        offerRow.appendChild(offerLabel);
        offerRow.appendChild(btnGroup);
        listDiv.appendChild(offerRow);
      });
      box.appendChild(listDiv);
    } else if (p.status === 'open') {
      const flexRow = document.createElement('div');
      flexRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
      const waitText = document.createElement('span');
      waitText.style.cssText = 'font-size:12.5px;color:var(--muted);';
      waitText.textContent = assignees.length ? `Waiting for ${openSlots} more volunteer${openSlots === 1 ? '' : 's'}...` : 'Waiting for responses...';
      flexRow.appendChild(waitText);
      if (!assignees.length) {
        flexRow.appendChild(mkBtn('Delete', 'btn btn-secondary', 'padding:6px 12px;font-size:12px;color:var(--danger);', () => deletePost(p.id)));
      }
      box.appendChild(flexRow);
    } else if (p.status === 'completed') {
      const done = document.createElement('div');
      done.className = 'assigned-box';
      done.textContent = '✅ All volunteers finished';
      box.appendChild(done);
    }
    return box;
  }

  // ── Not the poster ──
  if (isAssignedToMe) {
    // their own row is shown above; nothing else to add
  } else if (p.status === 'open') {
    if (hasOffered) {
      const flexRow = document.createElement('div');
      flexRow.style.cssText = 'display:flex;gap:8px;align-items:center;width:100%;';
      const offeredBtn = mkBtn('✅ You Offered Help', 'btn btn-secondary', 'flex:1;opacity:0.8;font-size:12px;', () => {});
      offeredBtn.disabled = true;
      flexRow.appendChild(offeredBtn);
      flexRow.appendChild(mkBtn('💬 Message', 'btn btn-outline', 'font-size:12px;', () => openMessagesModal({ id: p.authorId, name: p.author }, p.title)));
      box.appendChild(flexRow);
    } else {
      const flexRow = document.createElement('div');
      flexRow.style.cssText = 'display:flex;gap:8px;width:100%;';
      const offerBtn = mkBtn(`🤝 ${p.type === 'need' ? 'Offer Help' : 'Request Service'}`, 'btn btn-primary', 'flex:1;', () => submitOffer(p.id));
      const msgBtn = mkBtn('💬', 'btn btn-outline', '', () => openMessagesModal({ id: p.authorId, name: p.author }, p.title));
      msgBtn.title = `Message ${p.author}`;
      flexRow.appendChild(offerBtn);
      flexRow.appendChild(msgBtn);
      box.appendChild(flexRow);
    }
  } else {
    const info = document.createElement('div');
    info.className = 'assigned-box';
    info.textContent = p.status === 'completed' ? '✅ Completed' : '📌 Task in progress';
    box.appendChild(info);
  }

  // Report the poster
  if (loggedIn) {
    box.appendChild(mkBtn(`🚩 Report ${p.author}`, 'btn btn-outline',
      'width:100%;font-size:11px;padding:4px;color:var(--danger);', () => openReportModal(p.authorId, p.author, p.id)));
  }
  return box;
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
    [[5, '⭐⭐⭐⭐⭐  Excellent'], [4, '⭐⭐⭐⭐  Good'], [3, '⭐⭐⭐  Okay'], [2, '⭐⭐  Poor'], [1, '⭐  Bad']].forEach(([v, label]) => {
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
  ['scam', '💸 Scam / unfair money demand'],
  ['no_show', '🚫 No-show / did not complete the task'],
  ['harassment', '😡 Harassment or rude behaviour'],
  ['fake_post', '🎭 Fake or misleading post'],
  ['inappropriate', '⚠️ Inappropriate content'],
  ['other', '❓ Other (please explain)'],
];

function openReportModal(targetUserId, personName, postId) {
  openTrustModal({
    title: `Report ${personName}`,
    intro: 'Choose what went wrong. Reports are reviewed by the EarnCampus team.',
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
  if (!confirm(`Only continue if you have really paid ${name} ₹${price} (UPI/cash). Mark as paid?`)) return;
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

  const icon = document.createElement('span');
  // Properly differentiate between different toast types
  const iconMap = {
    error: '⚠️',
    success: '✅',
    info: 'ℹ️',
  };
  icon.textContent = iconMap[type] || 'ℹ️';

  const msgSpan = document.createElement('span');
  msgSpan.textContent = message; // textContent — no XSS (V8)

  toast.appendChild(icon);
  toast.appendChild(msgSpan);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}