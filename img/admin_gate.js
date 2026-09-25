// "Admin Login" gate. Text-editing only: toggling body.admin-unlocked
// reveals the small "Edit" button next to this one in the ticker bar
// (img/ticker.js, #ticker-edit-btn/#ticker-edit-menu) -- lore/events have
// their own inline editors on their own pages (all three share this same
// login). #layout-editor (the drag/resize/group dev tool) is
// intentionally NOT tied to this -- it stays permanently hidden/dev-only,
// unrelated to Admin Login. Uses the same real, server-validated login as
// the lore/events click-to-edit panels (see img/site_edit.js and
// #edit-login-modal) -- one password, one styled modal, one shared
// session token. img/site_edit.js must load before this file.
document.addEventListener('DOMContentLoaded', function(){
  var btn = document.getElementById('admin-login-btn');
  if (!btn || !window.SiteEdit) return;

  function setUnlocked(on){
    document.body.classList.toggle('admin-unlocked', on);
    btn.textContent = on ? 'Log Out' : 'Admin Login';
  }

  setUnlocked(!!window.SiteEdit.getToken());

  btn.addEventListener('click', function(){
    if (document.body.classList.contains('admin-unlocked')){
      window.SiteEdit.clearToken();
      setUnlocked(false);
      return;
    }
    window.SiteEdit.ensureAuthed().then(function(ok){
      if (ok) setUnlocked(true);
    });
  });
});
