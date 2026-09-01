// ── Cloud Cost Analyzer — Login page interactions ──────────────────────────

// Eye toggle for password field
(function () {
  const toggle = document.getElementById('pwToggle');
  const input  = document.getElementById('password');
  if (!toggle || !input) return;

  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    const eye = toggle.querySelector('.icon-eye');
    const eyeOff = toggle.querySelector('.icon-eye-off');
    if (eye) eye.style.display = show ? 'none' : 'block';
    if (eyeOff) eyeOff.style.display = show ? 'block' : 'none';
  });
})();

// Submit button ripple & loading state
(function () {
  const form = document.getElementById('login-form');
  const btn  = document.getElementById('submitBtn');
  if (!btn) return;

  // Dynamic interactive click ripple
  btn.addEventListener('click', (e) => {
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    const size = Math.max(rect.width, rect.height);
    ripple.style.width  = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${e.clientX - rect.left - size / 2}px`;
    ripple.style.top  = `${e.clientY - rect.top - size / 2}px`;
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  });

  if (form) {
    form.addEventListener('submit', () => {
      if (btn.classList.contains('is-loading')) return;
      btn.classList.add('is-loading');
      btn.disabled = true;
    });
  }
})();

