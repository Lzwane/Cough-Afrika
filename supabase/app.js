"use strict";
/* ============================================================ SUPABASE (patient records) ============================================================
   Security model: the browser only ever holds the PUBLIC key. Patients can INSERT a consented row and nothing else;
   only signed-in owners (listed in public.owners) can read / annotate / delete - enforced by Row Level Security in
   supabase/schema.sql, NOT by this UI. */
const CFG = window.CA_CONFIG || {};
const SB_OK = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(CFG.SUPABASE_URL || '') &&
              typeof CFG.SUPABASE_PUBLISHABLE_KEY === 'string' && CFG.SUPABASE_PUBLISHABLE_KEY.length > 40 &&
              !/PASTE|\.\.\./.test(CFG.SUPABASE_PUBLISHABLE_KEY);
let sb = null;                                   // NB: deliberately not called "supabase" (clashes with the CDN global)
try {
  if (SB_OK && window.supabase && window.supabase.createClient) {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: true, storage: window.sessionStorage, autoRefreshToken: true, detectSessionInUrl: false } });
  }
} catch (e) { console.error('Supabase init failed:', e && e.message); sb = null; }

const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
const clampInt = (v, lo, hi) => { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null; };
const TIERS = ['low', 'med', 'high'];
const safeTier = t => TIERS.includes(t) ? t : 'low';
function h(tag, props, ...kids) {                // tiny DOM builder - text is always set via textContent (no HTML injection)
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v);
  }
  kids.forEach(c => c != null && el.append(c));
  return el;
}

async function saveScreeningToDatabase(d) {      // returns {ok, reason}; never throws
  if (!sb) return { ok: false, reason: 'not-configured' };
  const row = {
    patient_name: cleanText(d.name, 80) || 'Anonymous',
    age: clampInt(d.age, 1, 120),
    acoustic_score: d.acoustic == null ? null : clampInt(d.acoustic, 0, 100),
    clinical_score: clampInt(d.clinical, 0, 10),
    triage_result: safeTier(d.ensemble),
    screener_notes: cleanText(d.notes, 2000),
    consent_given: true
  };
  try {
    const { error } = await sb.from('patients_screening').insert([row]);
    if (error) { console.error('Save failed:', error.message); return { ok: false, reason: 'error' }; }
    return { ok: true };
  } catch (e) { console.error('Save failed:', e && e.message); return { ok: false, reason: 'error' }; }
}

/* ---- owner portal ---- */
let ownerRows = [], ownerIdleT = null, ownerFails = 0, ownerLockUntil = 0;
const ownerEl = id => document.getElementById(id);
function ownerShowPanel(on) { ownerEl('ownerLogin').classList.toggle('hidden', on); ownerEl('ownerPanel').classList.toggle('hidden', !on); }
function ownerBumpIdle() {                       // auto sign-out after 15 min of inactivity
  clearTimeout(ownerIdleT);
  ownerIdleT = setTimeout(() => { ownerSignOut(); showToast('Signed out due to inactivity'); }, 15 * 60 * 1000);
}
async function ownerIsAuthorised() {
  if (!sb) return false;
  try {
    const { data: { session } } = await sb.auth.getSession(); if (!session) return false;
    const { data, error } = await sb.rpc('is_owner'); return !error && data === true;
  } catch (e) { return false; }
}
async function showOwner() {
  setView('owner');
  if (!sb) { ownerShowPanel(false); ownerLoginError('Database not configured: add your publishable key to config.js.'); return; }
  if (await ownerIsAuthorised()) { ownerShowPanel(true); ownerBumpIdle(); loadOwnerDashboard(); } else ownerShowPanel(false);
}
function ownerLoginError(msg) { const e = ownerEl('ownerLoginErr'); e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }
async function ownerSignIn() {
  ownerLoginError('');
  if (!sb) return ownerLoginError('Database not configured: add your publishable key to config.js.');
  if (Date.now() < ownerLockUntil) return ownerLoginError('Too many attempts. Wait a minute and try again.');
  const email = ownerEl('ownerEmail').value.trim(), password = ownerEl('ownerPassword').value;
  if (!email || !password) return ownerLoginError('Enter your email and password.');
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error || !(await ownerIsAuthorised())) {
      if (!error) await sb.auth.signOut();
      if (++ownerFails >= 5) { ownerLockUntil = Date.now() + 60000; ownerFails = 0; }
      return ownerLoginError('Sign-in failed, or this account does not have owner access.');
    }
  } catch (e) { return ownerLoginError('Could not reach the server. Check your connection.'); }
  ownerFails = 0; ownerEl('ownerPassword').value = '';
  ownerShowPanel(true); ownerBumpIdle(); loadOwnerDashboard();
}
async function ownerSignOut() {
  clearTimeout(ownerIdleT); ownerRows = [];
  ownerEl('ownerPatientTableBody').replaceChildren(); ownerEl('ownerSearch').value = '';
  try { if (sb) await sb.auth.signOut(); } catch (e) {}
  ownerShowPanel(false); showLanding();
}
async function loadOwnerDashboard() {
  const body = ownerEl('ownerPatientTableBody'); if (!body) return;
  const msg = (t, color) => body.replaceChildren(h('tr', {}, h('td', { colspan: '5', style: 'text-align:center;padding:20px;color:' + color, text: t })));
  if (!sb) return msg('Database not configured.', 'var(--rose-500)');
  msg('Loading patient records…', 'var(--text-dim)');
  try {
    const { data, error } = await sb.from('patients_screening').select('*').order('created_at', { ascending: false }).limit(500);
    if (error) throw error;
    ownerRows = data || [];
  } catch (e) {
    console.error('Fetch failed:', e && e.message);
    ownerRows = []; msg('Failed to load patient records (are you signed in as an owner?).', 'var(--rose-500)'); return;
  }
  renderOwnerRows();
}
function renderOwnerRows() {
  const body = ownerEl('ownerPatientTableBody'), q = ownerEl('ownerSearch').value.trim().toLowerCase();
  const rows = ownerRows.filter(p => !q || [p.patient_name, p.triage_result, p.screener_notes].join(' ').toLowerCase().includes(q));
  ownerEl('ownerCount').textContent = rows.length + ' of ' + ownerRows.length + ' record' + (ownerRows.length === 1 ? '' : 's') + (ownerRows.length >= 500 ? ' (newest 500)' : '');
  if (!rows.length) { body.replaceChildren(h('tr', {}, h('td', { colspan: '5', style: 'text-align:center;padding:20px;color:var(--text-dim)', text: 'No screening records found.' }))); return; }
  body.replaceChildren(...rows.map(p => {
    const t = safeTier(p.triage_result);
    const note = h('input', { type: 'text', maxlength: '2000', placeholder: 'Add clinical note…', 'aria-label': 'Screener note' });
    note.value = p.screener_notes || '';
    note.addEventListener('change', () => updateNotes(p.id, note.value));
    const del = h('button', { class: 'btn btn-danger btn-sm', text: 'Delete' });
    del.addEventListener('click', () => deleteRecord(p.id));
    return h('tr', {},
      h('td', { text: new Date(p.created_at).toLocaleDateString() }),
      h('td', {}, h('strong', { text: p.patient_name || 'Anonymous' }), h('br'), h('small', { style: 'color:var(--text-dim)', text: 'Age: ' + (p.age || 'N/A') })),
      h('td', {}, h('span', { class: 'badge badge-' + t, text: t.toUpperCase() })),
      h('td', {}, note), h('td', {}, del));
  }));
}
async function updateNotes(id, text) {
  try {
    const { data, error } = await sb.from('patients_screening').update({ screener_notes: cleanText(text, 2000) }).eq('id', id).select('id');
    if (error || !data || !data.length) throw error || new Error('not permitted');
    const r = ownerRows.find(x => x.id === id); if (r) r.screener_notes = cleanText(text, 2000);
    showToast('Note saved');
  } catch (e) { console.error('Note update failed:', e && e.message); showToast('Failed to save note'); }
}
async function deleteRecord(id) {
  if (!confirm('Permanently delete this patient record? This cannot be undone.')) return;
  try {
    const { data, error } = await sb.from('patients_screening').delete().eq('id', id).select('id');
    if (error || !data || !data.length) throw error || new Error('not permitted');
    ownerRows = ownerRows.filter(x => x.id !== id); renderOwnerRows(); showToast('Record deleted');
  } catch (e) { console.error('Delete failed:', e && e.message); showToast('Failed to delete record'); }
}

const LEGAL_TEXT = {
  privacy: {
    title: 'Privacy policy',
    html: `<p>Cough Afrika is a student capstone project by MediCode&amp;Cure. Health information is special personal information, so we keep what we collect to a minimum.</p>
    <h4>What stays on your device</h4>
    <p>Your account (name, email, a salted password hash) and your screening history are saved in this browser only.</p>
    <h4>What we receive, and only with your consent</h4>
    <p>If you tick the optional consent box when saving a result, we store your name, age, acoustic score, symptom red-flag count, triage result and any system notes in a secured database so that MediCode&amp;Cure clinicians can follow up. Only authorised MediCode&amp;Cure staff can read these records. If you do not tick the box, nothing is sent to us.</p>
    <h4>Microphone recordings</h4>
    <p>Cough recordings are held in memory, analysed inside your browser by the AI model, and discarded when the result is shown. The raw audio is never uploaded or saved to disk.</p>
    <h4>Deleting your data</h4>
    <p>"Delete my data" in Profile removes your account and history from this device. To have a record we hold about you erased, email us and we will delete it.</p>
    <h4>Contact</h4>
    <p>Questions about this policy can be sent through the Contact section above, or by email to medicodecure@gmali.com.</p>`
  },
  terms: {
    title: 'Terms of use',
    html: `<p>By using this demo, you agree to the following:</p>
    <h4>Not a medical device</h4>
    <p>Cough Afrika is a screening and triage aid built for academic and demonstration purposes. It is not a certified diagnostic device and must not be used as the sole basis for a medical decision.</p>
    <h4>How results are produced</h4>
    <p>The acoustic score is the output of a machine‑learning model (a random forest) trained on a small research dataset and run in your browser. It is not a calibrated probability of having TB and has not been clinically validated on phone‑browser recordings. The symptom screen is rule‑based and follows the WHO four‑symptom screen. Overall triage is deliberately cautious and is intended only to prompt a clinic test.</p>
    <h4>No warranty</h4>
    <p>This project is provided "as is" for evaluation, with no guarantee of clinical accuracy or uptime.</p>
    <h4>Acceptable use</h4>
    <p>Don't use this tool to make or delay a real medical decision — always seek in‑person care for concerning symptoms.</p>`
  }
};
function openLegal(key){
  const t=LEGAL_TEXT[key];
  document.getElementById('legalTitle').textContent=t.title;
  document.getElementById('legalBody').innerHTML=t.html;
  document.getElementById('legalModal').classList.add('show');
}
function closeLegal(){document.getElementById('legalModal').classList.remove('show');}
function handleContactSubmit(){
  const name=document.getElementById('cfName').value.trim();
  const email=document.getElementById('cfEmail').value.trim();
  const msg=document.getElementById('cfMsg').value.trim();
  if(!name||!email||!msg){ showToast('Fill in your name, email and message first'); return; }
  document.getElementById('formSent').classList.add('show');
  document.getElementById('cfName').value='';
  document.getElementById('cfEmail').value='';
  document.getElementById('cfMsg').value='';
}

/* ============================================================ STATE / STORAGE ============================================================ */
const LS_USERS='ca_users', LS_SESSION='ca_session', LS_THEME='ca_theme';
let currentUser=null;
let screeningState={duration:1,symptoms:{},age:32,recordSeconds:0,audio:null};
let mediaStream=null, audioCtx=null, analyser=null, rafId=null, recTimerInt=null, recSeconds=0, recording=false;
let pcmChunks=[], captureNode=null, captureSink=null, captureRate=0;

/* ---- AI models (loaded once, from models/models-data.js, evaluated locally) ---- */
let MODELS=null, MODEL_ERROR=null;
try{
  if(!window.TB_MODELS||!window.TBEngine) throw new Error('model files missing');
  MODELS=TBEngine.loadModels(window.TB_MODELS);
}catch(e){ MODEL_ERROR=e; console.error('Could not load TB models:',e); }
const nextFrame=()=>new Promise(r=>requestAnimationFrame(()=>setTimeout(r,0)));

function loadUsers(){try{return JSON.parse(localStorage.getItem(LS_USERS)||'{}');}catch(e){return {};}}
function saveUsers(u){localStorage.setItem(LS_USERS,JSON.stringify(u));}
function historyKey(email){return 'ca_history_'+email;}
function loadHistory(email){try{return JSON.parse(localStorage.getItem(historyKey(email))||'[]');}catch(e){return [];}}
function saveHistory(email,arr){localStorage.setItem(historyKey(email),JSON.stringify(arr));}

/* ============================================================ THEME ============================================================ */
function applyThemeIcons(){
  const dark = document.documentElement.getAttribute('data-theme')==='dark' ||
    (!document.documentElement.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('[id$="ThemeSun"]').forEach(el=>el.classList.toggle('hidden',!dark));
  document.querySelectorAll('[id$="ThemeMoon"]').forEach(el=>el.classList.toggle('hidden',dark));
}
function toggleTheme(){
  const cur=document.documentElement.getAttribute('data-theme');
  const isDark = cur==='dark' || (!cur && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const next = isDark?'light':'dark';
  document.documentElement.setAttribute('data-theme',next);
  try{localStorage.setItem(LS_THEME,next);}catch(e){}
  applyThemeIcons();
}
(function initTheme(){
  try{const saved=localStorage.getItem(LS_THEME); if(saved) document.documentElement.setAttribute('data-theme',saved);}catch(e){}
  applyThemeIcons();
})();

/* ============================================================ TOAST ============================================================ */
let toastT=null;
function showToast(msg){
  const t=document.getElementById('toast');
  document.getElementById('toastMsg').textContent=msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT=setTimeout(()=>t.classList.remove('show'),2600);
}

/* ============================================================ VIEW ROUTING ============================================================ */
function setView(v){
  document.getElementById('view-landing').classList.toggle('hidden',v!=='landing');
  document.getElementById('view-auth').classList.toggle('hidden',v!=='auth');
  document.getElementById('view-owner').classList.toggle('hidden',v!=='owner');
  document.getElementById('app-shell').classList.toggle('active',v==='app');
  if(v!=='owner'){ clearTimeout(ownerIdleT); }
  window.scrollTo(0,0);
}
function showLanding(){ setView('landing'); }
function showAuth(mode){ setView('auth'); switchAuth(mode||'login'); }
function switchAuth(mode){
  document.getElementById('loginForm').classList.toggle('hidden',mode!=='login');
  document.getElementById('signupForm').classList.toggle('hidden',mode!=='signup');
}
function enterApp(){
  setView('app');
  renderSidebarUser();
  showApp('dashboard');
}
function showApp(name){
  document.querySelectorAll('.app-view').forEach(v=>v.classList.add('hidden'));
  document.getElementById('app-'+name).classList.remove('hidden');
  document.querySelectorAll('.side-link[data-app]').forEach(b=>b.classList.toggle('active',b.dataset.app===name));
  document.querySelectorAll('.mobile-nav button[data-app]').forEach(b=>b.classList.toggle('active',b.dataset.app===name));
  if(name==='dashboard') renderDashboard();
  if(name==='history') renderHistory();
  if(name==='profile') renderProfile();
  window.scrollTo(0,0);
}

/* ============================================================ AUTH LOGIC (local demo) ============================================================ */
const PBKDF2_ITER=310000, DEMO_EMAIL='demo@coughafrika.app';
function legacyHash(str){let h=0;for(let i=0;i<str.length;i++){h=(h<<5)-h+str.charCodeAt(i);h|=0;}return String(h);}   // only to upgrade old accounts
const toB64=buf=>btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function deriveHash(pw,saltB64,iter){
  if(!window.crypto||!crypto.subtle) throw new Error('This browser cannot hash passwords here. Open the site over https:// (or localhost).');
  const salt=saltB64?fromB64(saltB64):crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:iter},key,256);
  return {salt:toB64(salt),hash:toB64(bits),iter};
}
const hasUser=(users,email)=>Object.prototype.hasOwnProperty.call(users,email);
const EMAIL_RE=/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const sameStr=(a,b)=>{ if(a.length!==b.length) return false; let d=0; for(let i=0;i<a.length;i++) d|=a.charCodeAt(i)^b.charCodeAt(i); return d===0; };
function startSession(email,users){localStorage.setItem(LS_SESSION,email); currentUser={email,...users[email]};}

async function handleSignup(){
  const name=cleanText(document.getElementById('suName').value,80);
  const email=document.getElementById('suEmail').value.trim().toLowerCase().slice(0,254);
  const pw=document.getElementById('suPassword').value;
  const role=document.getElementById('suRole').value==='worker'?'worker':'patient';
  const err=document.getElementById('suErr');
  const fail=m=>{err.textContent=m;err.style.display='block';};
  err.style.display='none';
  if(!name||!email||!pw){return fail('Fill in every field.');}
  if(!EMAIL_RE.test(email)){return fail('Enter a valid email address.');}
  if(pw.length<8||pw.length>128){return fail('Password must be 8–128 characters.');}
  const users=loadUsers();
  if(hasUser(users,email)){return fail('An account with that email already exists.');}
  try{
    const d=await deriveHash(pw,null,PBKDF2_ITER);
    users[email]={name,role,salt:d.salt,hash:d.hash,iter:d.iter,createdAt:Date.now()};
    saveUsers(users); startSession(email,users);
  }catch(e){return fail(e.message||'Could not create the account.');}
  showToast('Account created — welcome, '+name.split(' ')[0]+'!');
  enterApp();
}
async function handleLogin(){
  const email=document.getElementById('loginEmail').value.trim().toLowerCase();
  const pw=document.getElementById('loginPassword').value;
  const err=document.getElementById('loginErr');
  err.style.display='none';
  const bad=()=>{err.textContent='Incorrect email or password.';err.style.display='block';};
  const users=loadUsers();
  if(!hasUser(users,email)||pw.length>128) return bad();
  const u=users[email]; let ok=false;
  try{
    if(u.hash){ ok=sameStr((await deriveHash(pw,u.salt,u.iter||PBKDF2_ITER)).hash,u.hash); }
    else if(u.pass){                              // legacy account: verify the old hash once, then upgrade it
      ok=sameStr(legacyHash(pw),String(u.pass));
      if(ok){ const d=await deriveHash(pw,null,PBKDF2_ITER); delete u.pass; Object.assign(u,{salt:d.salt,hash:d.hash,iter:d.iter}); saveUsers(users); }
    }
  }catch(e){err.textContent=e.message||'Could not log in.';err.style.display='block';return;}
  if(!ok) return bad();
  startSession(email,users);
  showToast('Welcome back, '+currentUser.name.split(' ')[0]+'!');
  enterApp();
}
async function quickDemo(){
  const users=loadUsers();
  if(!hasUser(users,DEMO_EMAIL)){
    try{ const d=await deriveHash('demo-'+Math.random().toString(36).slice(2),null,PBKDF2_ITER);
      users[DEMO_EMAIL]={name:'Demo User',role:'patient',salt:d.salt,hash:d.hash,iter:d.iter,createdAt:Date.now()}; saveUsers(users);
    }catch(e){ showToast(e.message||'Demo unavailable'); return; }
  }
  startSession(DEMO_EMAIL,users);
  showToast('Signed in with the demo account');
  enterApp();
}
function handleLogout(){
  localStorage.removeItem(LS_SESSION);
  currentUser=null;
  showLanding();
}
function tryRestoreSession(){
  const email=localStorage.getItem(LS_SESSION);
  if(!email) return;
  const users=loadUsers();
  if(hasUser(users,email)){currentUser={email,...users[email]}; enterApp();}
}

/* ============================================================ SIDEBAR / PROFILE ============================================================ */
function renderSidebarUser(){
  if(!currentUser) return;
  const initials=currentUser.name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  document.getElementById('sideAvatar').textContent=initials;
  document.getElementById('sideName').textContent=currentUser.name;
  document.getElementById('sideRole').textContent=currentUser.role==='worker'?'Health worker':'Community member';
}
function renderProfile(){
  document.getElementById('profName').value=currentUser.name;
  document.getElementById('profEmail').value=currentUser.email;
  document.getElementById('profRole').value=currentUser.role==='worker'?'Health worker':'Community member';
}
function saveProfile(){
  const users=loadUsers();
  const newName=cleanText(document.getElementById('profName').value,80);
  if(!newName) return;
  users[currentUser.email].name=newName;
  saveUsers(users);
  currentUser.name=newName;
  renderSidebarUser();
  showToast('Profile updated');
}
function clearAllData(){
  if(!confirm('Delete your account and all saved screenings on this device? This cannot be undone.')) return;
  const users=loadUsers();
  delete users[currentUser.email];
  saveUsers(users);
  localStorage.removeItem(historyKey(currentUser.email));
  localStorage.removeItem(LS_SESSION);
  currentUser=null;
  showToast('Your data has been deleted');
  showLanding();
}

/* ============================================================ DASHBOARD ============================================================ */
function tierFromPct(p){return TBEngine.tierFromScore(p/100);}
function tierLabel(t){return t==='low'?'Low risk':(t==='med'?'Medium risk':'High risk');}

function renderDashboard(){
  document.getElementById('dashGreeting').textContent='Welcome back, '+currentUser.name.split(' ')[0];
  const hist=loadHistory(currentUser.email);
  document.getElementById('statTotal').textContent=hist.length;
  const last=hist[0];
  const sl=document.getElementById('statLast'); sl.replaceChildren();
  if(last){ sl.append(tierLabel(safeTier(last.tier))); if(last.percent!=null) sl.append(' ',h('small',{text:'acoustic '+Number(last.percent)+'%'})); } else sl.textContent='—';
  const trendEl=document.getElementById('statTrend'); trendEl.innerHTML='';
  const trend=hist.slice(0,6).reverse();
  if(trend.length===0){trendEl.innerHTML='<span style="font-size:12px;color:var(--text-dim)">No data yet</span>';}
  trend.forEach(rec=>{
    const t=safeTier(rec.tier);
    const i=document.createElement('i'); i.style.height=(t==='low'?25:(t==='med'?55:90))+'%';
    i.style.background = t==='low'?'#1FAE7A':(t==='med'?'var(--amber-500)':'var(--rose-500)');
    trendEl.appendChild(i);
  });
  const listEl=document.getElementById('dashRecentList'); listEl.innerHTML='';
  if(hist.length===0){
    listEl.innerHTML='<div class="empty-state"><svg><use href="#ic-mic"/></svg><p>No screenings yet. Start your first one to see it here.</p><button class="btn btn-primary btn-sm" data-act="startScreening">Start screening</button></div>';
  }else{
    hist.slice(0,5).forEach(rec=>listEl.appendChild(historyRowEl(rec)));
  }
  const tip=document.getElementById('dashTip');
  if(!last){tip.innerHTML='<p>No screenings yet — start one to get a personalised recommendation.</p>';}
  else{tip.replaceChildren(h('p',{text:protocolText(safeTier(last.tier))}));}
}
function historyRowEl(rec){
  const t=safeTier(rec.tier);
  const row=h('div',{class:'hist-row',style:'cursor:pointer'}); row.onclick=()=>openDetail(rec);
  const icBg = t==='low'?'var(--grn-100)':(t==='med'?'var(--amber-100)':'var(--rose-100)');
  const icColor = t==='low'?'#0D6B44':(t==='med'?'#8A5B0C':'#A32E23');
  const ic=h('div',{class:'hist-ic',style:'background:'+icBg+';color:'+icColor}); ic.innerHTML='<svg width="17" height="17"><use href="#ic-lungs"/></svg>';
  row.append(ic,
    h('div',{class:'meta'},h('div',{class:'t',text:tierLabel(t)+' screening'+(rec.v?'':' · simulated (old demo)')}),h('div',{class:'d',text:fmtDate(rec.date)})),
    h('div',{class:'pct',text:rec.percent!=null?Number(rec.percent)+'%':'—'}));
  return row;
}
function fmtDate(ts){const d=new Date(ts); return d.toLocaleDateString(undefined,{month:'short',day:'numeric'})+' · '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}

function renderHistory(){
  const hist=loadHistory(currentUser.email);
  const el=document.getElementById('historyList'); el.innerHTML='';
  if(hist.length===0){el.innerHTML='<div class="empty-state"><svg><use href="#ic-clock"/></svg><p>Nothing saved yet.</p></div>';return;}
  hist.forEach(rec=>el.appendChild(historyRowEl(rec)));
}
function openDetail(rec){
  const t=safeTier(rec.tier);
  document.getElementById('dmTitle').textContent=tierLabel(t);
  document.getElementById('dmDate').textContent=fmtDate(rec.date)+(rec.v?'':' · simulated result from an older demo build');
  document.getElementById('dmAcoustic').textContent=rec.acoustic!=null?Number(rec.acoustic)+'%':'Not used';
  document.getElementById('dmClinical').textContent=rec.v?(rec.flags?Number(rec.flags)+' red flag'+(rec.flags>1?'s':''):'No red flags'):(rec.clinical!=null?Number(rec.clinical)+'% (simulated)':'–');
  document.getElementById('dmEnsemble').textContent=tierLabel(t);
  document.getElementById('dmProtocol').replaceChildren(h('p',{text:protocolText(t)}));
  document.getElementById('detailModal').classList.add('show');
}
function closeDetail(){document.getElementById('detailModal').classList.remove('show');}

/* ============================================================ SCREENING FLOW ============================================================ */
function startScreening(){
  restartScreeningState();
  showApp('screening');
  goStep('symptoms');
}
function cancelScreening(){ stopMediaTracks(); showApp('dashboard'); }
function restartScreening(){ restartScreeningState(); goStep('symptoms'); }
function restartScreeningState(){
  screeningState={duration:1,symptoms:{},age:32,recordSeconds:0,audio:null};
  pcmChunks=[];
  document.querySelectorAll('.toggle-chip').forEach(c=>c.classList.remove('on'));
  document.getElementById('qDuration').value=1; updateDurationLabel();
  document.getElementById('qAge').value=32; document.getElementById('qAgeVal').textContent=32;
  document.getElementById('recContinueBtn').disabled=true;
  document.getElementById('recTimer').textContent='00:00';
  document.getElementById('recStatus').textContent='Tap the mic and cough naturally 2–3 times';
  document.getElementById('shareConsent').checked=false;
  document.getElementById('micError').classList.add('hidden');
  document.getElementById('recRing').classList.remove('live');
  stopMediaTracks();
}
function updateDurationLabel(){
  const v=+document.getElementById('qDuration').value;
  screeningState.duration=v;
  const labels=['<1 day','2–3 days','1 week','2 weeks','3 weeks','1 month','6 weeks','2 months','3+ months'];
  document.getElementById('qDurationVal').textContent=labels[v]||v+' wks';
}
function toggleChip(el){
  el.classList.toggle('on');
  screeningState.symptoms[el.dataset.sym]=el.classList.contains('on');
}
const stepOrder=['symptoms','record','analyzing','results'];
function goStep(step){
  document.querySelectorAll('.flow-step').forEach(s=>s.classList.remove('active'));
  document.getElementById('step-'+step).classList.add('active');
  const idx=stepOrder.indexOf(step);
  ['seg1','seg2','seg3'].forEach((id,i)=>{
    const seg=document.getElementById(id);
    seg.className='seg'+(i<Math.min(idx,2)?' done':(i===Math.min(idx,2)?' now':''));
  });
  const subLabels={symptoms:'Step 1 of 3 — symptom check',record:'Step 2 of 3 — cough recording',analyzing:'Analysing…',results:'Result'};
  document.getElementById('screeningSub').textContent=subLabels[step];
  screeningState.age=+document.getElementById('qAge').value;
  if(step==='analyzing') runAnalysis();
}

/* ---- microphone capture: raw PCM, no browser DSP, so the signal matches what the model was trained on ---- */
function showMicError(html){
  const el=document.getElementById('micError'); el.innerHTML=html; el.classList.remove('hidden');
}
async function toggleRecording(){
  if(!recording){ await startRecording(); } else { stopRecording(); }
}
async function attachCapture(ctx, src){
  captureSink=ctx.createGain(); captureSink.gain.value=0; captureSink.connect(ctx.destination);   // keeps the graph alive, silent
  try{
    if(!ctx.audioWorklet) throw new Error('no AudioWorklet');
    await ctx.audioWorklet.addModule('capture-worklet.js');
    captureNode=new AudioWorkletNode(ctx,'tb-capture');
    captureNode.port.onmessage=e=>{ if(recording) pcmChunks.push(e.data); };
  }catch(err){                                   // fallback for older browsers
    captureNode=ctx.createScriptProcessor(4096,1,1);
    captureNode.onaudioprocess=e=>{ if(recording) pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  }
  src.connect(captureNode); captureNode.connect(captureSink);
}
async function startRecording(){
  document.getElementById('micError').classList.add('hidden');
  document.getElementById('recContinueBtn').disabled=true;
  if(!MODELS){ showMicError('The AI model could not be loaded, so screening is unavailable. Reload the page; if it persists, the <b>models/models-data.js</b> file is missing.'); return; }
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    showMicError('This browser cannot access the microphone here. Open the site over <b>https://</b> (or localhost) in an up‑to‑date browser.'); return;
  }
  try{
    mediaStream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  }catch(e){
    const denied=e&&(e.name==='NotAllowedError'||e.name==='SecurityError');
    showMicError(denied?'Microphone access was blocked. Allow microphone permission for this site in your browser, then try again.'
                       :'No working microphone was found. Check that one is connected and not in use by another app.');
    return;
  }
  audioCtx=new (window.AudioContext||window.webkitAudioContext)();
  if(audioCtx.state==='suspended'){ try{await audioCtx.resume();}catch(e){} }
  captureRate=audioCtx.sampleRate; pcmChunks=[]; recSeconds=0; screeningState.audio=null;
  const src=audioCtx.createMediaStreamSource(mediaStream);
  analyser=audioCtx.createAnalyser(); analyser.fftSize=1024; src.connect(analyser);
  await attachCapture(audioCtx, src);
  recording=true;
  document.getElementById('recBtn').classList.add('stop');
  document.getElementById('recBtn').innerHTML='<svg><use href="#ic-stop"/></svg>';
  document.getElementById('recRing').classList.add('live');
  document.getElementById('recStatus').textContent='Recording — cough now';
  document.getElementById('recTimer').textContent='00:00';
  const canvas=document.getElementById('waveCanvas'); const ctx=canvas.getContext('2d');
  canvas.width=canvas.clientWidth*2; canvas.height=128;
  const buf=new Uint8Array(analyser.fftSize);
  function draw(){
    analyser.getByteTimeDomainData(buf);
    ctx.fillStyle=getComputedStyle(document.documentElement).getPropertyValue('--paper-100');
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.lineWidth=3; ctx.strokeStyle='#4A78C4'; ctx.beginPath();
    for(let i=0;i<buf.length;i++){
      const x=i/buf.length*canvas.width, y=(buf[i]/255)*canvas.height;
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.stroke();
    rafId=requestAnimationFrame(draw);
  }
  draw();
  recTimerInt=setInterval(()=>{
    recSeconds++;
    const m=String(Math.floor(recSeconds/60)).padStart(2,'0'), sec=String(recSeconds%60).padStart(2,'0');
    document.getElementById('recTimer').textContent=m+':'+sec;
    if(recSeconds>=15) stopRecording();
  },1000);
}
async function stopRecording(){
  if(!recording) return;
  recording=false;
  clearInterval(recTimerInt);
  cancelAnimationFrame(rafId);
  document.getElementById('recBtn').classList.remove('stop');
  document.getElementById('recBtn').innerHTML='<svg><use href="#ic-mic"/></svg>';
  document.getElementById('recRing').classList.remove('live');
  screeningState.recordSeconds=recSeconds;
  // join the captured chunks and release the microphone
  let n=0; pcmChunks.forEach(c=>n+=c.length);
  const pcm=new Float32Array(n); let o=0; pcmChunks.forEach(c=>{pcm.set(c,o);o+=c.length;});
  const rate=captureRate; pcmChunks=[];
  stopMediaTracks();
  // resample to the model's rate and check quality straight away, so a bad take is caught now
  const status=document.getElementById('recStatus'), recBtn=document.getElementById('recBtn');
  status.textContent='Checking recording quality…';
  recBtn.disabled=true;
  await nextFrame();
  const sr=MODELS.audio.sampleRate;
  const y=TBEngine.resample(pcm,rate,sr);
  const q=TBEngine.assessRecording(y,sr);
  recBtn.disabled=false;
  const err=document.getElementById('micError');
  if(!q.ok){
    screeningState.audio=null;
    status.textContent='That recording can’t be analysed — please try again.';
    err.innerHTML='<b>Please re‑record:</b><ul>'+q.issues.map(i=>'<li>'+i+'</li>').join('')+'</ul>';
    err.classList.remove('hidden');
    document.getElementById('recContinueBtn').disabled=true;
  }else{
    screeningState.audio={y,quality:q};
    err.classList.add('hidden');
    status.textContent='Recording captured ('+q.duration.toFixed(1)+'s, '+q.coughCount+' cough'+(q.coughCount===1?'':'s')+' detected). Ready to analyze.';
    document.getElementById('recContinueBtn').disabled=false;
  }
}
function stopMediaTracks(){
  if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream=null; }
  try{ if(captureNode){ captureNode.disconnect(); if(captureNode.port) captureNode.port.onmessage=null; if('onaudioprocess' in captureNode) captureNode.onaudioprocess=null; } }catch(e){}
  captureNode=null; captureSink=null;
  if(audioCtx){ try{audioCtx.close();}catch(e){} audioCtx=null; }
  cancelAnimationFrame(rafId);
}

/* ---- scoring: real acoustic model + guideline symptom screen ---- */
function currentAnswers(){
  const s=screeningState.symptoms;
  return {durationIdx:screeningState.duration, fever:!!s.fever, nightSweats:!!s.nght_swts, weightLoss:!!s.un_wght_loss,
          bloodInCough:!!s.cough_bld, hiv:!!s.hiv_infected_a, smoker:!!s.smkr_a, age:screeningState.age};
}
async function runAnalysis(){
  const txt=document.getElementById('analyzeTxt');
  try{
    if(!MODELS) throw new Error('models not loaded');
    const ans=currentAnswers();
    const notes=[];
    let audio=null;

    txt.textContent='Extracting acoustic features…'; await nextFrame();
    if(ans.age<TBEngine.CONFIG.ADULT_MIN_AGE){
      notes.push('The acoustic model was trained on adults, so it was not used for age '+ans.age+'. This result comes from the symptom screen only — please have a clinician assess a child with a persistent cough.');
    }else if(!screeningState.audio){
      throw new Error('no recording');
    }else{
      const sc=TBEngine.scoreAudio(MODELS,screeningState.audio.y);
      txt.textContent='Running the acoustic model…'; await nextFrame();
      if(!sc.reliable){
        notes.push('This recording sounds unlike the audio the model was trained on, so its acoustic score was set aside. Try again in a quieter room with the phone about 20 cm from your mouth.');
      }else{
        audio={usable:true,score:sc.score,tier:sc.tier};
      }
      screeningState.audio.quality.warnings.forEach(w=>notes.push(w));
    }

    txt.textContent='Applying the symptom screen…'; await nextFrame();
    const sym=TBEngine.symptomScreen(ans);
    const comb=TBEngine.combine(sym,audio);
    if(comb.capped) notes.push('The acoustic score was high but you reported no symptoms, so the overall result is capped at Medium. A clinic test is still the right next step.');
    if(audio && audio.tier==='low' && sym.tier!=='low') notes.push('Your answers put you above Low even though the acoustic score was low — the symptom screen always counts.');

    screeningState.result={
      tier:comb.tier, capped:comb.capped,
      acoustic:audio?Math.round(audio.score*100):null, acousticTier:audio?audio.tier:null,
      symptom:sym, notes
    };
    renderResults();
    goStep('results');
  }catch(e){
    console.error('Analysis failed:',e);
    goStep('record');
    showMicError('Analysis could not be completed ('+(e&&e.message?e.message:'unknown error')+'). Please record again.');
    document.getElementById('recContinueBtn').disabled=true;
  }
}
function protocolText(tier){
  if(tier==='low') return 'Low risk on this screen — no urgent referral needed. A low result does not rule out TB: get tested if your cough lasts 2 weeks or more, or you develop fever, night sweats, weight loss or blood in your cough.';
  if(tier==='med') return 'Medium risk — visit your nearest clinic for a sputum test (GeneXpert or microscopy) within the next few days, especially if symptoms continue.';
  return 'High risk — please visit a clinic as soon as possible for confirmatory TB testing. Avoid close contact in enclosed spaces until you\u2019ve been assessed.';
}
function polarToXY(cx,cy,r,angleDeg){const a=(angleDeg-180)*Math.PI/180;return {x:cx+r*Math.cos(a), y:cy+r*Math.sin(a)};}
function describeArc(cx,cy,r,startAngle,endAngle){
  const s=polarToXY(cx,cy,r,endAngle), e=polarToXY(cx,cy,r,startAngle);
  const largeArc = endAngle-startAngle<=180?'0':'1';
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${largeArc} 0 ${e.x} ${e.y}`;
}
function renderResults(){
  const r=screeningState.result;
  const tierColor=t=>t==='low'?'#1FAE7A':(t==='med'?'#E2A63C':'#E1594F');
  const tierText=t=>t==='low'?'#0D6B44':(t==='med'?'#8A5B0C':'#A32E23');
  const hasAudio=r.acoustic!=null;
  document.getElementById('gaugeNum').textContent=hasAudio?r.acoustic+'%':'—';
  document.getElementById('gaugeCap').textContent=hasAudio?'Acoustic model score':'Acoustic score not used';
  document.getElementById('gaugeTier').textContent=tierLabel(r.tier)+' · overall';
  document.getElementById('gaugeTier').style.color=tierText(r.tier);
  document.getElementById('rBreakAcoustic').textContent=hasAudio?r.acoustic+'%':'Not used';
  document.getElementById('rBreakClinical').textContent=r.symptom.count?(r.symptom.count+' red flag'+(r.symptom.count>1?'s':'')):(r.symptom.hiv?'HIV‑positive':'None');
  document.getElementById('rBreakEnsemble').textContent=tierLabel(r.tier);
  const notes=r.notes.slice();
  if(r.symptom.hiv) notes.unshift('Living with HIV raises your screening priority — people with HIV are screened on a cough of any duration.');
  if(r.symptom.flags.length) notes.unshift('Symptom screen flagged: '+r.symptom.flags.join(', ')+'.');
  const nb=document.getElementById('rNotes');
  if(notes.length){ nb.replaceChildren(h('ul',{},...notes.map(n=>h('li',{text:n})))); nb.classList.remove('hidden'); }
  else { nb.classList.add('hidden'); nb.innerHTML=''; }
  document.getElementById('rProtocol').replaceChildren(h('p',{text:protocolText(r.tier)}));
  const canShare=!!sb&&currentUser&&currentUser.email!==DEMO_EMAIL;     // demo account never writes to the real database
  document.getElementById('consentBox').classList.toggle('hidden',!canShare);
  const cx=110,cy=110,rad=90;
  let svg=`
    <path d="${describeArc(cx,cy,rad,0,180)}" fill="none" stroke="var(--paper-200)" stroke-width="16" stroke-linecap="round"/>
    <path d="${describeArc(cx,cy,rad,0,54)}" fill="none" stroke="#1FAE7A" stroke-width="16" opacity=".35"/>
    <path d="${describeArc(cx,cy,rad,54,117)}" fill="none" stroke="#E2A63C" stroke-width="16" opacity=".35"/>
    <path d="${describeArc(cx,cy,rad,117,180)}" fill="none" stroke="#E1594F" stroke-width="16" opacity=".35"/>`;
  if(hasAudio){
    const needleEnd=polarToXY(cx,cy,rad-14,(r.acoustic/100)*180);
    const color=tierColor(r.acousticTier);
    svg+=`<line x1="${cx}" y1="${cy}" x2="${needleEnd.x}" y2="${needleEnd.y}" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
          <circle cx="${cx}" cy="${cy}" r="7" fill="${color}"/>`;
  }
  document.getElementById('gaugeSvg').innerHTML=svg;
}
let savingNow=false;
async function saveScreeningAndGoDash(){
  const r=screeningState.result; if(!r||savingNow||!currentUser) return;
  savingNow=true;
  const btn=document.querySelector('[data-act="saveScreeningAndGoDash"]'); if(btn) btn.disabled=true;
  let msg='Screening saved to your history';
  try{
    try{
      const hist=loadHistory(currentUser.email);
      hist.unshift({v:2,id:'s_'+Date.now(),date:Date.now(),percent:r.acoustic,tier:r.tier,acoustic:r.acoustic,symptomTier:r.symptom.tier,flags:r.symptom.count,duration:screeningState.duration,age:screeningState.age});
      saveHistory(currentUser.email,hist.slice(0,200));
    }catch(e){ msg='Could not save to this device (browser storage is full or blocked)'; }
    const wantsShare=document.getElementById('shareConsent').checked && sb && currentUser.email!==DEMO_EMAIL;
    if(wantsShare){
      const res=await saveScreeningToDatabase({name:currentUser.name,age:screeningState.age,acoustic:r.acoustic,clinical:r.symptom.count,ensemble:r.tier,notes:r.notes.join(' | ')});
      msg=res.ok?'Saved — and shared with MediCode&Cure':'Saved on this device, but sharing with MediCode&Cure failed. Please try again later.';
    }
  }finally{ savingNow=false; if(btn) btn.disabled=false; }
  showToast(msg);
  showApp('dashboard');
}

/* ============================================================ HERO ANIMATED BARS ============================================================ */
(function heroBars(){
  const wrap=document.getElementById('heroBars'); if(!wrap) return;
  const heights=[40,70,55,90,60,45,80,50,65,42];
  heights.forEach((h,i)=>{
    const bar=document.createElement('i');
    bar.style.height=h+'%';
    bar.style.animationDelay=(i*0.08)+'s';
    wrap.appendChild(bar);
  });
})();

/* ============================================================ INIT ============================================================ */

/* ============================================================ EVENT WIRING (no inline handlers - CSP-safe) ============================================================ */
const ACTIONS={
  toggleTheme, showLanding, showOwner, ownerSignIn, ownerSignOut, ownerRefresh:()=>loadOwnerDashboard(),
  showAuth:a=>showAuth(a), switchAuth:a=>switchAuth(a), handleLogin, handleSignup, quickDemo, handleLogout,
  handleContactSubmit, openLegal:a=>openLegal(a), closeLegal,
  closeLegalBackdrop:(a,el,e)=>{ if(e.target===el) closeLegal(); },
  closeDetail, closeDetailBackdrop:(a,el,e)=>{ if(e.target===el) closeDetail(); },
  showApp:a=>showApp(a), startScreening, cancelScreening, restartScreening, goStep:a=>goStep(a),
  toggleChip:(a,el)=>toggleChip(el), toggleRecording, saveScreeningAndGoDash, saveProfile, clearAllData,
  scrollToId:a=>{ const t=document.getElementById(a); if(t) t.scrollIntoView({behavior:'smooth'}); }
};
const INPUTS={
  durationInput:updateDurationLabel,
  ageInput:el=>{ document.getElementById('qAgeVal').textContent=el.value; }
};
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-act]'); if(!el) return;
  const fn=ACTIONS[el.dataset.act]; if(!fn) return;
  if(el.tagName==='A') e.preventDefault();
  try{ const r=fn(el.dataset.arg,el,e); if(r&&r.catch) r.catch(err=>console.error(err)); }catch(err){ console.error(err); }
});
document.addEventListener('input',e=>{ const f=e.target.dataset&&INPUTS[e.target.dataset.input]; if(f) f(e.target); });
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter'||e.target.tagName!=='INPUT') return;
  const map={loginEmail:'handleLogin',loginPassword:'handleLogin',suPassword:'handleSignup',ownerPassword:'ownerSignIn'};
  const a=map[e.target.id]; if(a){ e.preventDefault(); ACTIONS[a](); }
});
['click','keydown'].forEach(ev=>document.addEventListener(ev,()=>{ if(!document.getElementById('view-owner').classList.contains('hidden') && !document.getElementById('ownerPanel').classList.contains('hidden')) ownerBumpIdle(); }));
document.getElementById('ownerSearch').addEventListener('input',()=>renderOwnerRows());

/* ============================================================ INIT (each step isolated so one failure can't kill the rest) ============================================================ */
try{ if(location.hash==='#owner') showOwner(); else tryRestoreSession(); }catch(e){ console.error('Init failed:',e); }

