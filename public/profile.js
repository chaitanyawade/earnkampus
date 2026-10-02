// Moved out of profile.html: the server CSP blocks inline <script> blocks.
    'use strict';

    let isOwnProfile = false;
    let currentUserData = null; // server-verified user (own profile only)
    let map = null;
    let mapMarker = null;

    document.addEventListener('DOMContentLoaded', () => {
      loadProfilePage();
    });

    async function loadProfilePage() {
      const urlParams = new URLSearchParams(window.location.search);
      const targetId = urlParams.get('id');
      const targetName = urlParams.get('user'); // legacy support

      // Determine if viewing own profile by checking session
      let sessionUser = null;
      try {
        const meRes = await fetch('/api/auth/me', { credentials: 'same-origin' });
        if (meRes.ok) {
          const meData = await meRes.json();
          if (meData.success) sessionUser = meData.user;
        }
      } catch (e) {}

      const logoutBtn = document.getElementById('logoutBtn');

      if (!targetId && !targetName) {
        // No target — viewing own profile
        if (!sessionUser) {
          // Not logged in — redirect
          window.location.href = 'login.html';
          return;
        }
        isOwnProfile = true;
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';
        await loadOwnProfile(sessionUser);
      } else {
        // Viewing another user's public profile
        const lookupId = targetId;
        const lookupName = targetName;

        if (sessionUser) {
          // Check if this IS actually our own profile being viewed by id
          if (targetId && targetId === sessionUser.id) {
            isOwnProfile = true;
            if (logoutBtn) logoutBtn.style.display = 'inline-flex';
            await loadOwnProfile(sessionUser);
            return;
          }
          if (logoutBtn) logoutBtn.style.display = 'inline-flex';
        }

        await loadPublicProfile(lookupId, lookupName);
      }
    }

    /** "Edit name" button + inline editor, shown only on your own profile. */
    function setupNameEdit(user) {
      const area = document.getElementById('profileActionArea');
      if (!area) return;
      area.textContent = '';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-outline';
      editBtn.textContent = '✏️ Edit name';
      area.appendChild(editBtn);

      editBtn.addEventListener('click', () => {
        const nameEl = document.getElementById('profileName');
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:4px 0;';

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 80;
        input.value = user.name;
        input.style.cssText = 'font-size:16px;font-weight:700;min-width:0;flex:1 1 180px;';

        const save = document.createElement('button');
        save.className = 'btn btn-black';
        save.textContent = 'Save';
        const cancel = document.createElement('button');
        cancel.className = 'btn btn-outline';
        cancel.textContent = 'Cancel';

        wrap.appendChild(input);
        wrap.appendChild(save);
        wrap.appendChild(cancel);
        nameEl.style.display = 'none';
        nameEl.parentNode.insertBefore(wrap, nameEl.nextSibling);
        editBtn.style.display = 'none';
        input.focus();

        const close = () => { wrap.remove(); nameEl.style.display = ''; editBtn.style.display = ''; };
        cancel.addEventListener('click', close);

        save.addEventListener('click', async () => {
          const newName = input.value.trim();
          if (newName.length < 2) { showToast('Name must be at least 2 characters.'); return; }
          save.disabled = true;
          try {
            const res = await fetch('/api/auth/profile', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ name: newName }),
            });
            const data = await res.json();
            if (data.success) {
              user.name = data.user.name;
              nameEl.textContent = data.user.name;
              try {
                const hint = JSON.parse(localStorage.getItem('earncampus_ui_hint') || 'null');
                if (hint) { hint.name = data.user.name; localStorage.setItem('earncampus_ui_hint', JSON.stringify(hint)); }
              } catch (e) { /* hint is optional */ }
              showToast('Name updated.');
              close();
              return;
            }
            showToast(data.error || 'Could not update name.');
          } catch (err) {
            showToast('Network error. Please try again.');
          }
          save.disabled = false;
        });
      });
    }

    async function loadOwnProfile(sessionUser) {
      // Fetch full private profile including location
      document.getElementById('headerSubtext').textContent = 'My Profile';

      // Render basic info from session, then add the public rating
      renderBasicProfile(sessionUser);
      try {
        const rres = await fetch('/api/users/profile?id=' + encodeURIComponent(sessionUser.id), { credentials: 'same-origin' });
        const rdata = await rres.json();
        if (rdata.success) {
          renderBasicProfile(Object.assign({}, sessionUser, { ratingAvg: rdata.profile.ratingAvg, ratingCount: rdata.profile.ratingCount }));
        }
      } catch (e) { /* rating is optional; ignore */ }

      currentUserData = sessionUser;
      setupNameEdit(sessionUser);
    }

    async function loadPublicProfile(targetId, targetName) {

      // Fetch public profile — server strips GPS coords (V16)
      let url = '/api/users/profile?';
      if (targetId) url += 'id=' + encodeURIComponent(targetId);
      else if (targetName) url += 'name=' + encodeURIComponent(targetName);
      else { showToast('Profile not found.'); return; }

      try {
        const res = await fetch(url);
        if (!res.ok) {
          document.getElementById('profileName').textContent = 'Profile Not Found';
          document.getElementById('profileSubtitle').textContent = 'This user may not have registered yet.';
          return;
        }
        const data = await res.json();
        if (data.success && data.profile) {
          const p = data.profile;

          // Set subtitle for viewing context
          const header = document.getElementById('headerSubtext');
          if (header) {
            header.textContent = 'Viewing Profile: ';
            const nameSpan = document.createElement('span');
            nameSpan.textContent = p.name || 'Campus Member'; // textContent (V8)
            header.appendChild(nameSpan);
          }

          renderBasicProfile(p);

          // Add message button
          const actionArea = document.getElementById('profileActionArea');
          if (actionArea) {
            const msgLink = document.createElement('a');
            msgLink.href = 'index.html';
            msgLink.className = 'btn btn-black';
            msgLink.style.fontSize = '13px';
            msgLink.textContent = `💬 Message ${p.name || 'User'}`; // textContent (V8)
            actionArea.appendChild(msgLink);
          }
        } else {
          document.getElementById('profileName').textContent = 'User Not Found';
        }
      } catch (e) {
        console.error('Public profile error:', e);
        document.getElementById('profileName').textContent = 'Error Loading Profile';
      }
    }

    function renderBasicProfile(data) {
      // All textContent — no innerHTML with user data (V8)
      const avatarEl = document.getElementById('profileAvatar');
      const nameEl = document.getElementById('profileName');
      const subtitleEl = document.getElementById('profileSubtitle');
      const collegeEl = document.getElementById('profileCollege');
      const ratingEl = document.getElementById('profileRating');

      if (avatarEl) avatarEl.textContent = data.avatar || '🎓';
      if (nameEl) nameEl.textContent = data.name || 'Campus Member';
      if (subtitleEl) subtitleEl.textContent = data.email || 'EarnCampus Member';
      if (collegeEl) collegeEl.textContent = data.college || '-';
      if (ratingEl) {
        const count = data.ratingCount || 0;
        ratingEl.textContent = count
          ? `⭐ ${Number(data.ratingAvg).toFixed(1)} (${count} ${count === 1 ? 'rating' : 'ratings'})`
          : '⭐ No ratings yet';
      }
    }

    document.getElementById('logoutBtn').addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (e) {}
      localStorage.removeItem('earncampus_ui_hint');
      window.location.href = 'index.html';
    });

    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast';
      const icon = document.createElement('span');
      icon.textContent = type === 'error' ? '⚠️' : '⚡';
      const msgSpan = document.createElement('span');
      msgSpan.textContent = message; // textContent — no XSS (V8)
      toast.appendChild(icon);
      toast.appendChild(document.createTextNode(' '));
      toast.appendChild(msgSpan);
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 3500);
    }

    function escapeHTML(str) {
      if (!str) return '';
      return str.replace(/[&<>'"]/g,
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
      );
    }