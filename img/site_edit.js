// Shared site-content edit/login helpers -- the same ToutaBot
// site-content API and #edit-login-modal (password prompt, not a bare
// browser prompt()) that the lore/events click-to-edit panels already
// use, factored out so anything else on the site (like the ticker text
// editor in the admin panel) can save real, server-persisted content too.
// The auth token lives in sessionStorage under "siteEditToken" -- shared
// across every page in the same tab, so logging in once on any page
// carries over to the rest for that session.
window.SiteEdit = (function(){
  var API_BASE = 'https://toutabot-production.up.railway.app';
  var TOKEN_KEY = 'siteEditToken';

  function getToken(){ try{ return sessionStorage.getItem(TOKEN_KEY); }catch(e){ return null; } }
  function setToken(t){ try{ sessionStorage.setItem(TOKEN_KEY, t); }catch(e){} }
  function clearToken(){ try{ sessionStorage.removeItem(TOKEN_KEY); }catch(e){} }

  var toastEl = null;
  function toast(msg){
    if (!toastEl){
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed; left:50%; bottom:24px; transform:translateX(-50%); z-index:5100; ' +
        'background:#fff; color:var(--color-base); font-size:0.85em; font-weight:bold; padding:10px 16px; max-width:90vw; text-align:center; ' +
        'border:3px solid var(--panel-border); box-shadow:inset 0 0 0 3px var(--panel-ring); ' +
        'opacity:0; transition:opacity .2s ease;';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function(){ toastEl.style.opacity = '0'; }, 3200);
  }

  var modal, modalForm, modalInput, modalError, modalCancel, modalResolve = null, modalWired = false;
  function ensureModal(){
    if (modalWired) return !!modal;
    modal = document.getElementById('edit-login-modal');
    if (!modal) return false;
    modalForm = document.getElementById('edit-login-form');
    modalInput = document.getElementById('edit-login-input');
    modalError = document.getElementById('edit-login-error');
    modalCancel = document.getElementById('edit-login-cancel');
    modalWired = true;

    modalCancel.addEventListener('click', function(){ closeModal(false); });
    modal.addEventListener('click', function(e){ if (e.target === modal) closeModal(false); });
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(false); });
    modalForm.addEventListener('submit', function(e){
      e.preventDefault();
      var pw = modalInput.value;
      if (!pw) return;
      modalError.classList.remove('show');
      fetch(API_BASE + '/api/public/site-content-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      })
        .then(function(r){ return r.json(); })
        .then(function(data){
          if (data && data.success){ setToken(data.token); closeModal(true); }
          else { modalError.classList.add('show'); modalInput.select(); }
        })
        .catch(function(){ modalError.textContent = 'Could not reach the server -- try again in a moment.'; modalError.classList.add('show'); });
    });
    return true;
  }
  function openModal(){
    modalError.classList.remove('show');
    modalInput.value = '';
    modal.classList.add('open');
    setTimeout(function(){ modalInput.focus(); }, 0);
  }
  function closeModal(result){
    modal.classList.remove('open');
    if (modalResolve){ modalResolve(result); modalResolve = null; }
  }
  function login(){
    if (!ensureModal()) return Promise.resolve(false);
    return new Promise(function(resolve){
      modalResolve = resolve;
      openModal();
    });
  }
  function ensureAuthed(){
    return getToken() ? Promise.resolve(true) : login();
  }

  function fetchPage(pageKey){
    return fetch(API_BASE + '/api/public/site-content/' + pageKey).then(function(r){ return r.json(); });
  }
  function saveField(pageKey, key, value){
    var token = getToken();
    if (!token) return Promise.reject(new Error('not authed'));
    return fetch(API_BASE + '/api/public/site-content/' + pageKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': token },
      body: JSON.stringify({ key: key, html: value })
    }).then(function(r){
      if (r.status === 401){ clearToken(); throw new Error('unauthorized'); }
      return r;
    });
  }

  return {
    getToken: getToken,
    clearToken: clearToken,
    ensureAuthed: ensureAuthed,
    fetchPage: fetchPage,
    saveField: saveField,
    toast: toast
  };
})();
