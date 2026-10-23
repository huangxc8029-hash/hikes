'use strict';
const queue = document.querySelector('#queue');
const statusText = document.querySelector('#status');
const filter = document.querySelector('#filter');
async function api(path, body) {
  const token = localStorage.getItem('hikes.auth.token');
  if (!token) throw new Error('请先登录审核员账号。');
  const response = await fetch('/api' + path, {method: body ? 'POST' : 'GET',
    headers: {'Content-Type':'application/json', Authorization:'Bearer ' + token},
    ...(body ? {body:JSON.stringify(body)} : {})});
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail?.error?.message || data.error?.message || `请求失败 (${response.status})`);
  return data;
}
function element(tag, text) { const el = document.createElement(tag); el.textContent = text; return el; }
async function load() {
  queue.replaceChildren(); statusText.textContent = '正在读取举报…';
  document.querySelector('#refresh').disabled = true;
  try {
    const items = await api('/admin/reports?status=' + filter.value + '&limit=100');
    statusText.textContent = items.length ? `本页 ${items.length} 条举报` : '当前队列没有举报。';
    for (const item of items) {
      const card = element('article', '');
      card.append(element('h2', `举报 #${item.id} · ${item.pointName || '路段留言'}`),
        element('p', `${item.reason} · ${item.reporter} · ${new Date(item.createdAt).toLocaleString()}`),
        element('blockquote', item.comment || '内容已不可用'), element('p', item.detail || '无补充说明'));
      if (filter.value === 'pending') {
        const note = document.createElement('textarea'); note.maxLength = 500; note.placeholder = '处理理由（至少 8 字）'; note.setAttribute('aria-label','处理理由'); card.append(note);
        for (const [label, decision, action] of [['受理并隐藏','accepted','hide'],['受理但保留','accepted','none'],['驳回举报','rejected','none']]) {
          const button = element('button', label);
          button.onclick = async () => {
            const reason = note.value.trim();
            if (reason.length < 8) { statusText.textContent = '请填写至少 8 字的处理理由。'; note.focus(); return; }
            if (!confirm(`确认${label}？\n${reason}`)) return;
            card.querySelectorAll('button').forEach(b => b.disabled = true);
            try { await api(`/admin/reports/${item.id}/review`, {decision, action, reason}); await load(); }
            catch (error) { statusText.textContent = error.message; card.querySelectorAll('button').forEach(b => b.disabled = false); }
          };
          card.append(button);
        }
      }
      queue.append(card);
    }
  } catch (error) { statusText.textContent = error.message; }
  finally { document.querySelector('#refresh').disabled = false; }
}
filter.onchange = load; document.querySelector('#refresh').onclick = load; load();
