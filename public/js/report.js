// "Report" for AI output — Google Play requires an in-app way to flag
// offensive or harmful AI-generated content.
import { api } from './api.js';
import { openSheet, toast, escapeHtml } from './ui.js';

const REASONS = ['Offensive or harmful', 'Inaccurate or misleading', 'Something else'];

export function reportContent(target) {
  const body = document.createElement('form');
  body.className = 'stack';
  body.innerHTML = `
    <p class="muted" style="margin:0">Tell us what’s wrong with this AI response. We review every report.</p>
    <div class="menu-list">${REASONS.map((r, i) => `
      <label class="menu-item"><input type="radio" name="reason" value="${escapeHtml(r)}" ${i === 0 ? 'checked' : ''}> <span>${escapeHtml(r)}</span></label>`).join('')}
    </div>
    <textarea class="input" name="details" rows="3" maxlength="900" placeholder="Details (optional)"></textarea>
    <button class="btn btn-primary btn-block" type="submit">Send report</button>`;
  const sheet = openSheet({ title: 'Report AI content', body });
  body.addEventListener('submit', async e => {
    e.preventDefault();
    const reason = body.elements.namedItem('reason').value;
    const details = body.elements.namedItem('details').value.trim();
    const btn = body.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await api('/api/reports', { method: 'POST', body: { ...target, reason: details ? `${reason}: ${details}` : reason } });
      sheet.close();
      toast(res.message, { type: 'success' });
    } catch (err) {
      btn.disabled = false;
      toast(err.message, { type: 'error' });
    }
  });
}
