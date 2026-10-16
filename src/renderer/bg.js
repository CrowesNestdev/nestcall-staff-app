"use strict";
// Nest brand background: slow drifting white particles joined by faint lines, on black.
(function () {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.id = "bg-canvas"; canvas.setAttribute("aria-hidden", "true");
  document.body.prepend(canvas);
  const size = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
  size(); window.addEventListener("resize", size);
  const ps = Array.from({ length: 50 }, () => ({
    x: Math.random() * canvas.width, y: Math.random() * canvas.height, r: Math.random() * 2 + 1,
    vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3, o: Math.random() * 0.3 + 0.1,
  }));
  (function frame() {
    ctx.fillStyle = "rgba(0,0,0,0.05)"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ps.forEach((p, i) => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
      if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fillStyle = `rgba(255,255,255,${p.o})`; ctx.fill();
      for (let j = i + 1; j < ps.length; j++) {
        const q = ps[j], dx = p.x - q.x, dy = p.y - q.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 150) {
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = `rgba(255,255,255,${0.1 * (1 - d / 150)})`; ctx.lineWidth = 0.5; ctx.stroke();
        }
      }
    });
    requestAnimationFrame(frame);
  })();
})();
