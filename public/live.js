(() => {
  const $ = id => document.getElementById(id) || Object.assign(document.createElement('div'), { value: '' }); // pages only contain some elements
  const has = id => !!document.getElementById(id);
  let apiBase = (localStorage.getItem('TIKTOK_BACKEND_URL') || '').replace(/\/$/, '');
  let token = localStorage.getItem('TIKTOK_ADMIN_TOKEN') || '';
  let cursor = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let poller = null, mediaStream = null, captureTimer = null, replyCount = 0;
  $('apiUrl').value = apiBase; $('adminToken').value = token; $('username').value = localStorage.getItem('TIKTOK_USERNAME') || '';
  function message(text, error=false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
  function headers() { return { 'Content-Type': 'application/json', 'X-Admin-Token': token }; }
  async function api(path, opts={}) {
    if (!apiBase) throw new Error('Enter the backend API URL first.');
    const r = await fetch(apiBase + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Request failed (${r.status})`); }
    return r.status === 204 ? null : r.json();
  }
  $('saveConfig').onclick = () => {
    apiBase = $('apiUrl').value.trim().replace(/\/$/, ''); token = $('adminToken').value.trim();
    localStorage.setItem('TIKTOK_BACKEND_URL', apiBase); localStorage.setItem('TIKTOK_ADMIN_TOKEN', token); localStorage.setItem('TIKTOK_USERNAME', $('username').value.trim());
    message('Connection settings saved in this browser.'); refreshStatus(); loadKnowledge(); loadViewers();
  };
  function pill(connected) { $('statusPill').className = `pill ${connected ? 'on' : 'off'}`; $('statusPill').textContent = connected ? 'Event stream connected' : 'Not connected'; $('connectionMetric').textContent = connected ? 'Connected' : 'Offline'; $('connectionSub').textContent = connected ? `@${(localStorage.getItem('TIKTOK_USERNAME')||'').replace(/^@/,'')}` : 'Direct event listener'; }
  $('connectBtn').onclick = async () => { try { const username = $('username').value.trim().replace(/^@/, ''); if (!username) throw new Error('Enter the TikTok username first.'); localStorage.setItem('TIKTOK_USERNAME', username); message('Connecting to TikTok LIVE…'); const d = await api('/api/live/connect', { method:'POST', body: JSON.stringify({ username }) }); pill(true); message(d.message || 'Connected.'); startPolling(); } catch(e) { pill(false); message(e.message, true); } };
  $('disconnectBtn').onclick = async () => { try { await api('/api/live/disconnect', { method:'POST', body:'{}' }); pill(false); message('Disconnected.'); } catch(e) { message(e.message, true); } };
  async function refreshStatus() { try { const d = await api('/api/live/status'); pill(d.connected); $('connectionSub').textContent = d.mongo === 'connected' ? 'MongoDB connected' : 'MongoDB disconnected'; if (d.error) message(d.error, true); } catch(e) { if (apiBase && token) message(e.message, true); } }
  function renderEvents(events) { if (!events.length && !$('eventList').dataset.loaded) $('eventList').innerHTML = '<div class="empty">No recent activity yet. Keep this page open during your stream.</div>'; $('eventList').dataset.loaded = '1'; for (const e of events) { const div = document.createElement('article'); div.className='event'; const type = ({ screen_comment: 'Screen chat', like_milestone: 'Likes', follow: 'Follow', game_start: 'Game', game_hint: 'Hint', game_win: 'Winner', game_end: 'Game over', goal_reached: 'Goal', crown_change: 'Crown', special_request: 'Pick', idle: 'Idle', teaser: 'Teaser', segment: 'Segment' })[e.type] || e.type; div.innerHTML = `<div class="event-type"></div><div><strong></strong><p class="source-text"></p><p class="reply"></p></div>`; div.querySelector('.event-type').textContent = type; div.querySelector('.event-type').dataset.type = e.type; div.querySelector('strong').textContent = `${e.username || 'Viewer'}${e.giftName ? ' · ' + e.giftName : ''}`; div.querySelector('.source-text').textContent = e.text || (e.type === 'join' ? 'Joined the LIVE' : e.giftName ? 'Sent a gift' : 'Event received'); div.querySelector('.reply').textContent = e.replyText ? `AI host: ${e.replyText}` : ''; $('eventList').prepend(div); } while ($('eventList').children.length > 50) $('eventList').lastElementChild.remove(); }
  async function pollEvents() { try { const d = await api('/api/live/events?after=' + encodeURIComponent(cursor)); if (d.events?.length) { renderEvents(d.events); for (const e of d.events) if (e.replyText) replyCount++; $('replyCount').textContent = replyCount; cursor = new Date(d.events[d.events.length-1].createdAt).toISOString(); } } catch(e) { /* transient while disconnected */ } }
  function startPolling() { if (poller) clearInterval(poller); pollEvents(); poller = setInterval(pollEvents, 2500); }
  $('refreshBtn').onclick = () => { pollEvents(); refreshStatus(); loadKnowledge(); loadViewers(); };
  async function loadViewers() {
    try {
      const d = await api('/api/live/viewers?limit=30');
      const list = $('viewerList'); list.replaceChildren();
      if (!d.viewers?.length) { list.innerHTML = '<div class="empty">No viewer memories yet. They appear after the host receives viewer events.</div>'; return; }
      for (const viewer of d.viewers) {
        const card = document.createElement('article'); card.className = 'event';
        const details = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = '@' + (viewer.username || 'viewer');
        const meta = document.createElement('p'); meta.className = 'source-text';
        meta.textContent = `Last seen: ${viewer.lastSeenAt ? new Date(viewer.lastSeenAt).toLocaleString() : 'unknown'} · Last event: ${viewer.lastEventType || 'unknown'}`;
        const stats = document.createElement('p'); stats.className = 'source-text'; stats.textContent = [viewer.badge, viewer.visitCount ? `${viewer.visitCount} visits` : '', viewer.streak > 1 ? `${viewer.streak}-day streak (best ${viewer.bestStreak})` : '', viewer.gamePoints ? `${viewer.gamePoints} game points` : '', viewer.lifetimeDiamonds ? `${viewer.lifetimeDiamonds} diamonds gifted` : ''].filter(Boolean).join(' · ');
        details.append(title, meta, stats);
        for (const msg of (viewer.recentConversation || [])) {
          const line = document.createElement('p'); line.className = msg.role === 'assistant' ? 'reply' : 'source-text';
          line.textContent = `${msg.role === 'assistant' ? 'AI host' : 'Viewer'}: ${msg.content}`;
          details.append(line);
        }
        card.append(details); list.append(card);
      }
    } catch(e) { if (apiBase && token) message(e.message, true); }
  }
  $('refreshViewersBtn')?.addEventListener('click', loadViewers);
  async function loadKnowledge() { try { const d = await api('/api/live/knowledge'); $('knowledgeCount').textContent = d.items.length; $('knowledgeList').replaceChildren(); if (!d.items.length) { $('knowledgeList').innerHTML = '<p class="muted">No knowledge notes added yet.</p>'; return; } for (const item of d.items) { const row = document.createElement('div'); row.className='knowledge-item'; const body=document.createElement('div'), title=document.createElement('strong'), content=document.createElement('p'), del=document.createElement('button'); title.textContent=item.title; content.textContent=item.content; del.textContent='Delete'; del.onclick=async()=>{try{await api('/api/live/knowledge/'+item._id,{method:'DELETE'});loadKnowledge();}catch(e){message(e.message,true)}}; body.append(title,content); row.append(body,del); $('knowledgeList').append(row); } } catch(e) { if (apiBase && token) message(e.message, true); } }
  if (has('knowledgeForm')) $('knowledgeForm').onsubmit = async e => { e.preventDefault(); try { await api('/api/live/knowledge',{method:'POST',body:JSON.stringify({title:$('knowledgeTitle').value.trim(),content:$('knowledgeContent').value.trim()})}); $('knowledgeTitle').value='';$('knowledgeContent').value='';message('Knowledge note saved.');loadKnowledge(); } catch(err) { message(err.message,true); } };
  if (apiBase && token) { refreshStatus(); if (has('knowledgeList')||has('knowledgeCount')) loadKnowledge(); if (has('viewerList')) loadViewers(); if (has('eventList')||has('replyCount')) startPolling(); }
})();
