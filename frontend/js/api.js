/* ═══════════════════════════════════════
   WANTED — Client API partagé v2 (design blanc/rouge)
═══════════════════════════════════════ */
// Nettoie l'URL — supprime les slashes en trop
const API_BASE = (window.WANTED_API || 'http://localhost:5000/api').replace(/\/+$/, '');

const Auth = {
  getToken:   ()  => localStorage.getItem('wt'),
  setToken:   t   => localStorage.setItem('wt', t),
  getUser:    ()  => { try { return JSON.parse(localStorage.getItem('wu')); } catch { return null; } },
  setUser:    u   => localStorage.setItem('wu', JSON.stringify(u)),
  isLoggedIn: ()  => !!localStorage.getItem('wt'),
  logout() {
    localStorage.removeItem('wt'); localStorage.removeItem('wu');
    window.location.href = '/pages/login.html';
  }
};

async function apiReq(method, ep, data, isForm) {
  const h = {};
  const token = Auth.getToken();
  if (token) h['Authorization'] = 'Bearer ' + token;
  if (!isForm) h['Content-Type'] = 'application/json';
  const opts = { method, headers: h };
  if (data) opts.body = isForm ? data : JSON.stringify(data);

  let res;
  try {
    res = await fetch(API_BASE + ep, opts);
  } catch (networkErr) {
    // Le backend est inaccessible (pas démarré, mauvaise URL…)
    throw new Error(
      'Impossible de contacter le serveur. Vérifiez que le backend est démarré ' +
      'et que l\'URL dans js/config.js est correcte. (' + networkErr.message + ')'
    );
  }

  // Lire la réponse comme texte d'abord pour éviter l'erreur "not valid JSON"
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // La réponse n'est pas du JSON → afficher un message clair
    throw new Error(
      'Réponse invalide du serveur (reçu du HTML au lieu de JSON). ' +
      'Vérifiez que WANTED_API dans js/config.js pointe sur votre backend ' +
      'et non sur le frontend. URL actuelle : ' + API_BASE
    );
  }

  if (res.status === 401) { Auth.logout(); throw new Error('Session expirée — reconnectez-vous'); }
  if (!res.ok) throw new Error(json.error || json.message || 'Erreur ' + res.status);
  return json;
}

const api = {
  get:  ep      => apiReq('GET', ep),
  post: (ep, d) => apiReq('POST', ep, d),
  put:  (ep, d) => apiReq('PUT',  ep, d),
  del:  ep      => apiReq('DELETE', ep),
  up:   (ep, fd)=> apiReq('POST', ep, fd, true),
  putp: (ep, fd)=> apiReq('PUT',  ep, fd, true),
};

function esc(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function ago(d) {
  const diff = Date.now() - new Date(d).getTime(), m = Math.floor(diff / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m}min`;
  const h = Math.floor(m / 60); if (h < 24) return `il y a ${h}h`;
  const days = Math.floor(h / 24); if (days < 30) return `il y a ${days}j`;
  return new Date(d).toLocaleDateString('fr', { day:'numeric', month:'short', year:'numeric' });
}
function fmt(d) { if (!d) return ''; return new Date(d).toLocaleDateString('fr', { day:'numeric', month:'short', year:'numeric' }); }
function initials(name) { return (name || '?').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2); }

/* ── Toast ── */
function toast(msg, type = 'info') {
  let stack = document.getElementById('toast-stack');
  if (!stack) { stack = document.createElement('div'); stack.id = 'toast-stack'; stack.className = 'toast-stack'; document.body.appendChild(stack); }
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

function requireAuth() {
  if (!Auth.isLoggedIn()) { window.location.href = '/pages/login.html?next=' + encodeURIComponent(location.pathname + location.search); return false; }
  return true;
}

function updateNavCoins(coins) {
  document.querySelectorAll('.nav-coins-val').forEach(el => el.textContent = Number(coins).toLocaleString('fr'));
  const u = Auth.getUser(); if (u) { u.coins = coins; Auth.setUser(u); }
}

/* ── Build nav ── */
function buildNav(activePage) {
  const user = Auth.getUser();
  const pages = [
    { id:'home',     label:'Accueil',    href:'/index.html'          },
    { id:'feed',     label:'Recherches', href:'/pages/feed.html'     },
    { id:'messages', label:'Messages',   href:'/pages/messages.html', auth:true },
    { id:'profile',  label:'Profil',     href:'/pages/profile.html',  auth:true },
  ];

  const navLinks = document.getElementById('nav-links');
  if (navLinks) {
    navLinks.innerHTML = pages
      .filter(p => !p.auth || Auth.isLoggedIn())
      .map(p => `<button class="nav-btn${p.id===activePage?' active':''}" onclick="location.href='${p.href}'">${p.label}</button>`)
      .join('');
    if (user?.role === 'admin') navLinks.innerHTML += `<button class="nav-btn${activePage==='admin'?' active':''}" onclick="location.href='/pages/admin.html'">Admin</button>`;
  }

  const navRight = document.getElementById('nav-right');
  if (navRight) {
    if (Auth.isLoggedIn() && user) {
      navRight.innerHTML = `
        <div class="nav-coins" onclick="location.href='/pages/profile.html'" title="Mes coins">🪙 <span class="nav-coins-val">${(user.coins||0).toLocaleString('fr')}</span></div>
        <div class="notif-btn-wrap">
          <button class="btn-icon" onclick="toggleNotifs()" id="notif-btn">🔔<span class="notif-dot-badge" id="notif-dot" style="display:none"></span></button>
        </div>
        <button class="nav-avatar-btn" onclick="location.href='/pages/profile.html'">${user.avatar_url?`<img src="${user.avatar_url}">`:`${initials(user.full_name)}`}</button>
        <button class="btn btn-ghost btn-sm" onclick="Auth.logout()">Déco</button>`;
    } else {
      navRight.innerHTML = `
        <button class="btn btn-ghost btn-sm" onclick="location.href='/pages/login.html'">Connexion</button>
        <button class="btn btn-primary btn-sm" onclick="location.href='/pages/register.html'">S'inscrire</button>`;
    }
  }

  const mobileRight = document.getElementById('mobile-right');
  if (mobileRight) {
    if (Auth.isLoggedIn() && user) {
      mobileRight.innerHTML = `
        <div class="nav-coins" style="font-size:11px;padding:4px 10px" onclick="location.href='/pages/profile.html'">🪙 <span class="nav-coins-val">${(user.coins||0).toLocaleString('fr')}</span></div>
        <div class="notif-btn-wrap"><button class="btn-icon" onclick="toggleNotifs()">🔔<span class="notif-dot-badge" id="notif-dot-m" style="display:none"></span></button></div>
        <button class="nav-avatar-btn" onclick="location.href='/pages/profile.html'">${user.avatar_url?`<img src="${user.avatar_url}">`:`${initials(user.full_name)}`}</button>`;
    } else {
      mobileRight.innerHTML = `<button class="btn btn-primary btn-sm" onclick="location.href='/pages/login.html'">Connexion</button>`;
    }
  }

  document.querySelectorAll('.bnav-item[data-page]').forEach(btn => btn.classList.toggle('active', btn.dataset.page === activePage));
  if (Auth.isLoggedIn()) fetchNotifCount();
}

async function fetchNotifCount() {
  try {
    const d = await api.get('/notifications');
    const unread = d.unread > 0;
    document.querySelectorAll('#notif-dot,#notif-dot-m').forEach(el => { if (el) el.style.display = unread?'block':'none'; });
  } catch(_) {}
}

function toggleNotifs() {
  const p = document.getElementById('notif-panel');
  if (!p) return;
  p.classList.toggle('open');
  if (p.classList.contains('open')) loadNotifs();
}

async function loadNotifs() {
  const list = document.getElementById('notif-list'); if (!list) return;
  try {
    const d = await api.get('/notifications');
    const icons = { comment:'💬', repost:'🔁', like:'❤️', found:'✅', coins:'🪙', message:'📩', welcome:'👋' };
    list.innerHTML = d.notifications.length
      ? d.notifications.map(n => `<div class="notif-item"><span style="font-size:18px;flex-shrink:0">${icons[n.type]||'🔔'}</span><div style="flex:1"><div class="notif-text">${esc(n.body||n.title)}</div><div class="notif-time">${ago(n.created_at)}</div></div></div>`).join('')
      : '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">Aucune notification</div>';
    document.querySelectorAll('#notif-dot,#notif-dot-m').forEach(el => { if(el) el.style.display='none'; });
  } catch(_) {}
}

async function markNotifsRead() {
  try { await api.put('/notifications/read-all'); document.getElementById('notif-panel')?.classList.remove('open'); } catch(_) {}
}

/* ── Post card — chambre-style ── */
function renderPostCard(p) {
  const statusColors = {
    found:    { top:'#16a34a', lbl:'RETROUVÉ',   badge:'badge-green',  bg:'#f0fdf4', txt:'#15803d' },
    critical: { top:'#E8312A', lbl:'CRITIQUE',   badge:'badge-red',    bg:'#fef2f2', txt:'#dc2626' },
    urgent:   { top:'#ea580c', lbl:'URGENT',     badge:'badge-orange', bg:'#fff7ed', txt:'#c2410c' },
    normal:   { top:'#2563EB', lbl:'RECHERCHÉ',  badge:'badge-blue',   bg:'#eff6ff', txt:'#1d4ed8' },
  };
  const sc = p.status==='found' ? statusColors.found : statusColors[p.urgency] || statusColors.normal;
  const init = initials(p.person_name);
  const pInit = initials(p.poster_name || '?');
  const av1color = ['#E8312A','#2563EB','#16a34a','#ea580c','#8b5cf6','#0891b2'];
  const avcolor = av1color[init.charCodeAt(0) % av1color.length];
  const detailUrl = `/pages/post-detail.html?id=${p.id}`;
  const profileUrl = `/pages/profile.html?id=${p.poster_id||p.user_id||''}`;

  return `<div class="post-card fade-up" id="pc-${p.id}">
    <div class="post-card-top" style="background:${sc.top}"></div>
    <div class="post-inner">
      <div class="post-header" onclick="location.href='${detailUrl}'" style="cursor:pointer">
        <div class="post-mugshot" style="background:${sc.bg}">
          ${p.photo_url ? `<img src="${esc(p.photo_url)}" alt="${esc(p.person_name)}">` : `<span class="mugshot-init" style="color:${sc.top}">${init}</span>`}
          <div class="mugshot-lbl" style="background:${sc.top};color:white">${sc.lbl}</div>
        </div>
        <div class="post-info">
          <div class="post-name">${esc(p.person_name)}</div>
          <div class="post-tags">
            <span class="tag">📍 ${esc(p.last_seen)}</span>
            ${p.person_age?`<span class="tag">🎂 ${p.person_age} ans</span>`:''}
            <span class="badge ${sc.badge}" style="font-size:10px">${sc.lbl}</span>
          </div>
          <div class="post-desc">${esc(p.description)}</div>
          ${p.contact_phone?`<div class="post-contact">📞 ${esc(p.contact_phone)}</div>`:''}
          ${p.reward_coins>0?`<div class="post-reward">🪙 Récompense : ${p.reward_coins} coins</div>`:''}
        </div>
      </div>
      <div class="post-footer">
        <div class="post-poster" onclick="event.stopPropagation();location.href='${profileUrl}'">
          <div class="av av-sm av-circle" style="background:${avcolor};color:white;font-size:11px;font-weight:700">${pInit}</div>
          <div class="poster-name"><strong>${esc(p.poster_name||'')}</strong>${p.poster_city?` · ${esc(p.poster_city)}`:''}</div>
        </div>
        <div class="post-actions" onclick="event.stopPropagation()">
          <button class="act-btn ${p.user_liked?'liked':''}" id="like-btn-${p.id}" onclick="doLike('${p.id}')">${p.user_liked?'❤️':'🤍'} <span id="lc-${p.id}">${p.likes_count||0}</span></button>
          <button class="act-btn ${p.user_reposted?'reposted':''}" id="repost-btn-${p.id}" onclick="doRepost('${p.id}')">🔁 <span id="rc-${p.id}">${p.reposts_count||0}</span></button>
          <button class="act-btn" onclick="doShare('${p.id}','${esc(p.person_name)}')">📤 <span id="sc-${p.id}">${p.shares_count||0}</span></button>
          <button class="act-btn" onclick="location.href='${detailUrl}'">💬 ${p.comments_count||0}</button>
        </div>
      </div>
    </div>
  </div>`;
}

/* ── Actions ── */
async function doLike(id) {
  if (!Auth.isLoggedIn()) { toast('Connectez-vous pour liker', 'info'); return; }
  try {
    const d = await api.post('/posts/' + id + '/like');
    const btn = document.getElementById('like-btn-' + id);
    const cnt = document.getElementById('lc-' + id);
    const n = parseInt(cnt?.textContent||0) + (d.liked?1:-1);
    if (btn) { btn.className = 'act-btn'+(d.liked?' liked':''); btn.innerHTML = `${d.liked?'❤️':'🤍'} <span id="lc-${id}">${n}</span>`; }
  } catch(err) { toast(err.message,'error'); }
}

async function doRepost(id) {
  if (!Auth.isLoggedIn()) { toast('Connectez-vous pour repartager','info'); return; }
  try {
    const d = await api.post('/posts/' + id + '/repost');
    const btn = document.getElementById('repost-btn-' + id);
    const cnt = document.getElementById('rc-' + id);
    const n = parseInt(cnt?.textContent||0) + (d.reposted?1:-1);
    if (btn) { btn.className='act-btn'+(d.reposted?' reposted':''); btn.innerHTML=`🔁 <span id="rc-${id}">${n}</span>`; }
    if (d.coinsEarned) { const u=Auth.getUser(); if(u) updateNavCoins((u.coins||0)+d.coinsEarned); toast(`+${d.coinsEarned} coins 🪙`,'coin'); }
  } catch(err) { toast(err.message,'error'); }
}

async function doShare(id, name) {
  if (!Auth.isLoggedIn()) { toast('Connectez-vous pour partager','info'); return; }
  try {
    const url = location.origin + '/pages/post-detail.html?id=' + id;
    if (navigator.share) await navigator.share({ title:'WANTED — '+name, url });
    else { await navigator.clipboard.writeText(url); toast('Lien copié 📋'); }
    const d = await api.post('/posts/' + id + '/share', { platform: navigator.share?'native':'clipboard' });
    const cnt = document.getElementById('sc-'+id); if(cnt) cnt.textContent=parseInt(cnt.textContent||0)+1;
    if (d.coinsEarned) { const u=Auth.getUser(); if(u) updateNavCoins((u.coins||0)+d.coinsEarned); toast(`+${d.coinsEarned} coins 🪙`,'coin'); }
  } catch(err) { if(err.name!=='AbortError') toast(err.message,'error'); }
}

/* ── Payment helpers ── */
function openPayModal(postId) {
  if (!Auth.isLoggedIn()) { toast('Connectez-vous d\'abord','info'); return; }
  const overlay = document.getElementById('pay-modal');
  if (!overlay) return;
  overlay.dataset.postId = postId;
  overlay.classList.add('open');
}

async function submitPayment() {
  const overlay = document.getElementById('pay-modal');
  const postId  = overlay?.dataset.postId;
  const amount  = parseInt(document.getElementById('pay-amount')?.value);
  const phone   = document.getElementById('pay-phone')?.value.trim();
  const provider = document.querySelector('.pay-opt.selected')?.dataset.provider || 'orange';
  const errEl   = document.getElementById('pay-error');
  if (!amount || amount < 100) { if(errEl) errEl.textContent='Montant minimum 100 XAF'; return; }
  if (!phone)  { if(errEl) errEl.textContent='Numéro requis'; return; }
  const btn = document.getElementById('pay-submit-btn');
  try {
    if(btn){btn.disabled=true;btn.textContent='Traitement…';}
    const d = await api.post('/payments/initiate', { amountXaf:amount, postId, phone, provider });
    overlay.classList.remove('open');
    if (d.devMode) toast(`✅ ${d.coins} coins ajoutés à la récompense !`,'coin');
    else if (d.paymentUrl) { window.open(d.paymentUrl,'_blank'); toast('Fenêtre paiement ouverte','info'); }
  } catch(err) { if(errEl) errEl.textContent=err.message; }
  finally { if(btn){btn.disabled=false;btn.textContent='Payer';} }
}

function selectProvider(el) {
  document.querySelectorAll('.pay-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
}

function handleSearch(val) {
  if (val.length > 1 && !location.pathname.includes('feed'))
    location.href = '/pages/feed.html?search=' + encodeURIComponent(val);
}

function openNewPost() {
  if (!Auth.isLoggedIn()) { location.href='/pages/login.html?next=/pages/feed.html'; return; }
  const m = document.getElementById('new-post-modal');
  if (m) m.classList.add('open');
  else location.href='/pages/feed.html?newpost=1';
}
