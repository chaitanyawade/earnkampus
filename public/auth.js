'use strict';
// Moved out of auth.html: the server CSP blocks inline <script> blocks.
    // ── State ──────────────────────────────────────────────────────────────────

    // ── Tab Switcher ───────────────────────────────────────────────────────────
    function switchTab(tab) {
      const signupForm = document.getElementById('signupForm');
      const loginForm = document.getElementById('loginForm');
      const tabSignupBtn = document.getElementById('tabSignupBtn');
      const tabLoginBtn = document.getElementById('tabLoginBtn');
      const authFooter = document.getElementById('authFooter');
      const authAlert = document.getElementById('authAlert');

      // Verify all elements exist
      if (!signupForm || !loginForm || !tabSignupBtn || !tabLoginBtn || !authFooter || !authAlert) {
        console.warn('Auth form elements not found in DOM', {
          signupForm: !!signupForm,
          loginForm: !!loginForm,
          tabSignupBtn: !!tabSignupBtn,
          tabLoginBtn: !!tabLoginBtn,
          authFooter: !!authFooter,
          authAlert: !!authAlert
        });
        return;
      }

      // Clear alert safely (textContent prevents XSS)
      authAlert.className = 'alert-box';
      authAlert.textContent = '';

      if (tab === 'login') {
        // Show login form, hide signup
        signupForm.hidden = true;
        signupForm.style.display = 'none';
        const otpF1 = document.getElementById('otpForm');
        if (otpF1) { otpF1.hidden = true; otpF1.style.display = 'none'; }
        hideRecoveryForms();
        loginForm.hidden = false;
        loginForm.style.display = 'flex';
        
        // Update tab buttons
        tabSignupBtn.classList.remove('active');
        tabLoginBtn.classList.add('active');
        
        // Update footer
        authFooter.innerHTML = '';
        authFooter.textContent = "Don't have an account? ";
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = 'Sign Up here';
        link.addEventListener('click', (e) => { e.preventDefault(); switchTab('signup'); });
        authFooter.appendChild(link);
        document.title = 'EarnKampus - Log In';
      } else {
        // Show signup form, hide login
        signupForm.hidden = false;
        signupForm.style.display = 'flex';
        const otpF2 = document.getElementById('otpForm');
        if (otpF2) { otpF2.hidden = true; otpF2.style.display = 'none'; }
        hideRecoveryForms();
        loginForm.hidden = true;
        loginForm.style.display = 'none';
        
        // Update tab buttons
        tabSignupBtn.classList.add('active');
        tabLoginBtn.classList.remove('active');
        
        // Update footer
        authFooter.innerHTML = '';
        authFooter.textContent = 'Already have an account? ';
        const link = document.createElement('a');
        link.href = '#';
        link.textContent = 'Log In here';
        link.addEventListener('click', (e) => { e.preventDefault(); switchTab('login'); });
        authFooter.appendChild(link);
        document.title = 'EarnKampus - Sign Up';
      }
    }

    document.getElementById('tabSignupBtn').addEventListener('click', () => switchTab('signup'));
    document.getElementById('tabLoginBtn').addEventListener('click', () => switchTab('login'));

    // ── Password Visibility ────────────────────────────────────────────────────
    function togglePasswordVisibility(inputId, btn) {
      const input = document.getElementById(inputId);
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    }

    document.getElementById('toggleSignupPwd').addEventListener('click', function () {
      togglePasswordVisibility('signupPassword', this);
    });
    document.getElementById('toggleLoginPwd').addEventListener('click', function () {
      togglePasswordVisibility('loginPassword', this);
    });

    // ── Show alert safely (never innerHTML with user data) ─────────────────────
    function showAlert(message, type) {
      const authAlert = document.getElementById('authAlert');
      authAlert.className = `alert-box alert-${type} show`;
      authAlert.textContent = message; // textContent — not innerHTML (V8)
    }

    // ── Toast ──────────────────────────────────────────────────────────────────
    function showToast(message) {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast';
      const icon = document.createElement('span');
      icon.textContent = '';
      const text = document.createElement('span');
      text.textContent = message; // textContent — not innerHTML (V8)
      toast.appendChild(icon);
      toast.appendChild(text);
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 3500);
    }

    // ── URL tab detection ──────────────────────────────────────────────────────
    // Detect tab from URL immediately (not waiting for DOMContentLoaded)
    function initializeTab() {
      const urlParams = new URLSearchParams(window.location.search);
      const tabParam = urlParams.get('tab') || urlParams.get('mode');
      const initialTab = tabParam === 'login' ? 'login' : 'signup';
      switchTab(initialTab);
    }
    
    // Call on DOMContentLoaded AND immediately if DOM is already ready
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', initializeTab);
    } else {
      initializeTab();
    }

    // ── Signup, step 1: request an emailed verification code ──────────────────
    let pendingEmail = '';
    let resendTimer = null;

    function startResendCooldown(seconds) {
      const btn = document.getElementById('otpResendBtn');
      let left = seconds;
      clearInterval(resendTimer);
      btn.disabled = true;
      btn.textContent = `Resend code (${left}s)`;
      resendTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(resendTimer);
          btn.disabled = false;
          btn.textContent = 'Resend code';
        } else {
          btn.textContent = `Resend code (${left}s)`;
        }
      }, 1000);
    }

    function showOtpStep(email, resendAfter) {
      pendingEmail = email;
      const signupF = document.getElementById('signupForm');
      const otpF = document.getElementById('otpForm');
      signupF.hidden = true; signupF.style.display = 'none';
      otpF.hidden = false; otpF.style.display = 'flex';
      document.getElementById('otpEmailText').textContent = email; // textContent, never innerHTML
      const codeInput = document.getElementById('otpCode');
      codeInput.value = '';
      codeInput.focus();
      startResendCooldown(resendAfter || 60);
    }

    function showSignupStep() {
      clearInterval(resendTimer);
      const signupF = document.getElementById('signupForm');
      const otpF = document.getElementById('otpForm');
      otpF.hidden = true; otpF.style.display = 'none';
      signupF.hidden = false; signupF.style.display = 'flex';
    }

    function devHint(data) {
      // Present only when the server runs without email configured (local development)
      return data.devCode ? ` (Dev mode code: ${data.devCode})` : '';
    }

    document.getElementById('signupForm').addEventListener('submit', async function (e) {
      e.preventDefault();

      const name = document.getElementById('signupName').value.trim();
      const email = document.getElementById('signupEmail').value.trim();
      const password = document.getElementById('signupPassword').value;

      if (!name) { showAlert('Please enter your full name.', 'error'); return; }
      if (!email) { showAlert('Please enter your college email.', 'error'); return; }
      if (password.length < 8) { showAlert('Password must be at least 8 characters.', 'error'); return; }

      const submitBtn = document.getElementById('signupSubmitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending code...';

      try {
        const res = await fetch('/api/auth/signup/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ name, email, password }),
        });
        const data = await res.json();

        if (data.success) {
          showAlert(data.message + devHint(data), 'success');
          showOtpStep(email.toLowerCase(), data.resendAfter);
        } else {
          showAlert(data.error || 'Could not start signup. Please try again.', 'error');
        }
      } catch (err) {
        showAlert('Network error. Please check your connection.', 'error');
      }
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Verification Code';
    });

    // ── Signup, step 2: verify the code, then the account is created ──────────
    document.getElementById('otpForm').addEventListener('submit', async function (e) {
      e.preventDefault();

      const code = document.getElementById('otpCode').value.trim();
      if (!/^\d{6}$/.test(code)) { showAlert('Enter the 6-digit code from your email.', 'error'); return; }

      const btn = document.getElementById('otpSubmitBtn');
      btn.disabled = true;
      btn.textContent = 'Verifying...';

      try {
        const res = await fetch('/api/auth/signup/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email: pendingEmail, code }),
        });
        const data = await res.json();

        if (data.success) {
          // UI-only hint (the session cookie is what actually authenticates)
          localStorage.setItem('earncampus_ui_hint', JSON.stringify({
            id: data.user.id,
            name: data.user.name,
            email: data.user.email,
            college: data.user.college,
            avatar: data.user.avatar,
          }));
          showAlert(`Welcome, ${data.user.name}! Your email is verified. Redirecting...`, 'success');
          setTimeout(() => { window.location.href = 'index.html'; }, 1500);
          return;
        }
        showAlert(data.error || 'Verification failed. Please try again.', 'error');
      } catch (err) {
        showAlert('Network error. Please check your connection.', 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Verify & Create Account';
    });

    document.getElementById('otpResendBtn').addEventListener('click', async function () {
      try {
        const res = await fetch('/api/auth/signup/resend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email: pendingEmail }),
        });
        const data = await res.json();
        if (data.success) {
          showAlert(data.message + devHint(data), 'success');
          startResendCooldown(data.resendAfter || 60);
        } else {
          showAlert(data.error || 'Could not resend the code.', 'error');
        }
      } catch (err) {
        showAlert('Network error. Please check your connection.', 'error');
      }
    });

    document.getElementById('otpBackBtn').addEventListener('click', showSignupStep);

    // ── Forgot password ────────────────────────────────────────────────────────
    let resetEmail = '';
    let resetTimer = null;

    function hideRecoveryForms() {
      ['forgotForm', 'resetForm'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.hidden = true; el.style.display = 'none'; }
      });
    }

    function showLoginRecoveryForm(id) {
      ['loginForm', 'forgotForm', 'resetForm'].forEach(f => {
        const el = document.getElementById(f);
        el.hidden = f !== id;
        el.style.display = f === id ? 'flex' : 'none';
      });
    }

    function startResetCooldown(seconds) {
      const btn = document.getElementById('resetResendBtn');
      let left = seconds;
      clearInterval(resetTimer);
      btn.disabled = true;
      btn.textContent = `Resend code (${left}s)`;
      resetTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(resetTimer);
          btn.disabled = false;
          btn.textContent = 'Resend code';
        } else {
          btn.textContent = `Resend code (${left}s)`;
        }
      }, 1000);
    }

    async function requestResetCode(email) {
      const res = await fetch('/api/auth/forgot/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email }),
      });
      return res.json();
    }

    document.getElementById('forgotLink').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value.trim();
      document.getElementById('authAlert').className = 'alert-box';
      showLoginRecoveryForm('forgotForm');
    });
    document.getElementById('forgotBackBtn').addEventListener('click', () => showLoginRecoveryForm('loginForm'));
    document.getElementById('resetBackBtn').addEventListener('click', () => { clearInterval(resetTimer); showLoginRecoveryForm('loginForm'); });

    document.getElementById('forgotForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      const email = document.getElementById('forgotEmail').value.trim();
      if (!email) { showAlert('Please enter your email.', 'error'); return; }

      const btn = document.getElementById('forgotSubmitBtn');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const data = await requestResetCode(email);
        if (data.success) {
          resetEmail = email.toLowerCase();
          document.getElementById('resetEmailText').textContent = resetEmail; // textContent, never innerHTML
          document.getElementById('resetCode').value = '';
          document.getElementById('resetPassword').value = '';
          document.getElementById('resetPassword2').value = '';
          showAlert(data.message + devHint(data), 'success');
          showLoginRecoveryForm('resetForm');
          startResetCooldown(data.resendAfter || 60);
          document.getElementById('resetCode').focus();
        } else {
          showAlert(data.error || 'Could not send the code. Please try again.', 'error');
        }
      } catch (err) {
        showAlert('Network error. Please check your connection.', 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Send Reset Code';
    });

    document.getElementById('resetResendBtn').addEventListener('click', async function () {
      try {
        const data = await requestResetCode(resetEmail);
        if (data.success) {
          showAlert('A new code was sent if the account exists.' + devHint(data), 'success');
          startResetCooldown(data.resendAfter || 60);
        } else {
          showAlert(data.error || 'Could not resend the code.', 'error');
        }
      } catch (err) {
        showAlert('Network error. Please check your connection.', 'error');
      }
    });

    document.getElementById('resetForm').addEventListener('submit', async function (e) {
      e.preventDefault();
      const code = document.getElementById('resetCode').value.trim();
      const pw = document.getElementById('resetPassword').value;
      const pw2 = document.getElementById('resetPassword2').value;

      if (!/^\d{6}$/.test(code)) { showAlert('Enter the 6-digit code from your email.', 'error'); return; }
      if (pw.length < 8) { showAlert('Password must be at least 8 characters.', 'error'); return; }
      if (pw !== pw2) { showAlert('The two passwords do not match.', 'error'); return; }

      const btn = document.getElementById('resetSubmitBtn');
      btn.disabled = true;
      btn.textContent = 'Updating...';
      try {
        const res = await fetch('/api/auth/forgot/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email: resetEmail, code, newPassword: pw }),
        });
        const data = await res.json();
        if (data.success) {
          clearInterval(resetTimer);
          document.getElementById('loginEmail').value = resetEmail;
          document.getElementById('loginPassword').value = '';
          showLoginRecoveryForm('loginForm');
          showAlert(data.message, 'success');
        } else {
          showAlert(data.error || 'Could not reset the password.', 'error');
        }
      } catch (err) {
        showAlert('Network error. Please check your connection.', 'error');
      }
      btn.disabled = false;
      btn.textContent = 'Reset Password';
    });

    // ── Login form ─────────────────────────────────────────────────────────────
    document.getElementById('loginForm').addEventListener('submit', async function (e) {
      e.preventDefault();

      const email = document.getElementById('loginEmail').value.trim();
      const password = document.getElementById('loginPassword').value;

      if (!email || !password) {
        showAlert('Email and password are required.', 'error');
        return;
      }

      const submitBtn = document.getElementById('loginSubmitBtn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Logging In...';

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ email, password }),
        });

        const data = await res.json();

        if (data.success) {
          // Store minimal UI hint in localStorage (NOT used for auth — cookie is auth)
          localStorage.setItem('earncampus_ui_hint', JSON.stringify({
            id: data.user.id,
            name: data.user.name,
            email: data.user.email,
            college: data.user.college,
            avatar: data.user.avatar,
          }));

          showAlert(`Welcome back, ${data.user.name}! Redirecting...`, 'success');
          setTimeout(() => { window.location.href = 'index.html'; }, 1200);
        } else {
          showAlert(data.error || 'Invalid email or password.', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Log In';
        }
      } catch (err) {
        showAlert('Network error. Please check your connection.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Log In';
      }
    });