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
    toggle.querySelector('.icon-eye').style.display  = show ? 'none' : 'block';
    toggle.querySelector('.icon-eye-off').style.display = show ? 'block' : 'none';
  });
})();

// Submit spinner / disable to prevent double-submit
(function () {
  const form = document.getElementById('login-form');
  const btn  = document.getElementById('submitBtn');
  if (!form || !btn) return;

  form.addEventListener('submit', () => {
    if (btn.classList.contains('is-loading')) return;
    btn.classList.add('is-loading');
    btn.disabled = true;
  });
})();

// ── Live streaming "Cost Overview" chart ────────────────────────────────────
(function () {
  const svg = document.querySelector('.peek-svg');
  if (!svg) return;
  const line = document.getElementById('pkPathLine');
  const area = document.getElementById('pkPathArea');
  const dot  = document.getElementById('pkDot');
  const tip  = document.getElementById('pkTip');
  const valEl= document.getElementById('pkVal');

  const N = 11, X0 = 6, X1 = 314, YT = 16, YB = 78;     // viewBox 0 0 320 92
  const xs = Array.from({length: N}, (_, i) => X0 + i * (X1 - X0) / (N - 1));
  const yOf = v => YT + (1 - v) * (YB - YT);
  const clamp = x => Math.max(.18, Math.min(.96, x));
  const BASE = 42000, RANGE = 12000;                    // spend = BASE + lastVal*RANGE

  function smooth(p) {                                   // Catmull-Rom -> cubic bezier
    let d = 'M' + p[0].x + ',' + p[0].y;
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i-1]||p[i], p1 = p[i], p2 = p[i+1], p3 = p[i+2]||p2;
      d += ' C' + (p1.x+(p2.x-p0.x)/6) + ',' + (p1.y+(p2.y-p0.y)/6) + ' '
                + (p2.x-(p3.x-p1.x)/6) + ',' + (p2.y-(p3.y-p1.y)/6) + ' ' + p2.x + ',' + p2.y;
    }
    return d;
  }
  function render(vs) {
    const pts = vs.map((v, i) => ({ x: xs[i], y: yOf(v) }));
    const d = smooth(pts);
    line.setAttribute('d', d);
    area.setAttribute('d', d + ' L' + xs[N-1] + ',92 L' + xs[0] + ',92 Z');
    const last = pts[N-1];
    dot.setAttribute('cx', last.x); dot.setAttribute('cy', last.y);
    const total = Math.round(BASE + vs[N-1] * RANGE);
    valEl.textContent = '$' + total.toLocaleString('en-US');
    tip.textContent   = '$' + (total / 1000).toFixed(1) + 'k';
  }

  let vals = [.30,.38,.30,.5,.42,.62,.55,.7,.64,.82,.78];
  render(vals);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const seed = vals.slice();
  let target = seed.slice();
  vals = vals.map(() => .22);                            // intro: grow up from a flat line
  setTimeout(() => { target = seed.slice(); }, 300);

  (function loop() {                                     // continuous eased chase
    for (let i = 0; i < N; i++) vals[i] += (target[i] - vals[i]) * 0.045;
    render(vals);
    requestAnimationFrame(loop);
  })();
  setInterval(() => {                                    // stream a new point every 2.8s
    target = target.slice(1);
    target.push(clamp(target[target.length-1] + (Math.random() - 0.46) * 0.34));
  }, 2800);
})();
