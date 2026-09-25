// Drives the top-bar ticker, via requestAnimationFrame rather than a CSS
// @keyframes animation. Two problems with the CSS version:
//   1. Two static copies of the text left long stretches of empty space
//      once the ticker window (matched to the content box's width) turned
//      out much wider than short placeholder text -- fixed by cloning the
//      template until the track comfortably overflows the window.
//   2. A CSS "infinite" loop has to hard-reset from its 100% keyframe back
//      to 0% every cycle, and that discrete jump rendered a few px off
//      from the smoothly-interpolated frames around it -- visible as a
//      snap right as the loop wrapped. Recomputing the transform every
//      frame here instead, and wrapping the position with a plain
//      subtraction (pos -= itemWidth) rather than resetting to 0, means
//      there's no reset point at all, so nothing to snap.
//
// The actual text is loaded from ToutaBot's site-content API (same one
// the lore/events click-to-edit panels use, see img/site_edit.js) so it's
// the same for every visitor, not just this browser -- falling back to
// whatever placeholder text is already sitting in the page if nothing's
// saved yet or the server can't be reached. Editing itself now works the
// same way the lore/events panels do -- click the "click to edit" hint,
// type straight into the ticker text in place, click away to save -- with
// one addition: a small color picker sits next to it while editing, and
// applies to whatever's currently selected (a single letter, a word, or
// the whole line), not just the text as a whole.
document.addEventListener('DOMContentLoaded', function(){
  var wrap = document.querySelector('.tb-ticker');
  var track = document.querySelector('.ticker-track');
  var template = track ? track.querySelector('.ticker-item') : null;
  if (!wrap || !track || !template) return;

  var GLOBAL_PAGE_KEY = 'global';
  var TICKER_FIELD_KEY = 'ticker-text';

  var editing = false;

  function itemWidth(){
    // getBoundingClientRect() returns the *rendered* (already zoom-scaled)
    // width, but a transform assigned via JS is a *logical* value the
    // browser scales by zoom again on top of that -- same double-scaling
    // issue as #content-brown's height elsewhere on this page. Dividing by
    // the current zoom converts back to logical units, which is what
    // translateX(px) actually expects.
    var zoom = parseFloat(document.body.style.zoom) || 1;
    return template.getBoundingClientRect().width / zoom;
  }

  // Rebuilds the scrolling clones from the master template (the first
  // .ticker-item -- always kept as index 0) until the track comfortably
  // overflows the visible window twice over. Called on first load and
  // again after every save, since the text (and therefore its width) can
  // change.
  function refillClones(){
    Array.prototype.slice.call(track.querySelectorAll('.ticker-item')).forEach(function(el, i){
      if (i > 0) el.remove();
    });
    var w = itemWidth();
    if (!w) return;
    var minTrackWidth = wrap.getBoundingClientRect().width * 2 + w;
    var guard = 0;
    while (track.getBoundingClientRect().width < minTrackWidth && guard < 40){
      track.appendChild(template.cloneNode(true));
      guard++;
    }
  }

  function startScrolling(){
    refillClones();

    var PX_PER_SEC = 55;
    var pos = 0;
    var lastTime = null;
    function frame(now){
      if (lastTime === null) lastTime = now;
      var dt = (now - lastTime) / 1000;
      lastTime = now;
      if (!editing){
        var w = itemWidth();
        pos += PX_PER_SEC * dt;
        if (w && pos >= w) pos -= w;
        track.style.transform = 'translateX(' + (-pos) + 'px)';
      } else {
        lastTime = now; // don't let a big gap while paused count as elapsed time once resumed
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // Load the real saved text before starting the scroll/clones, so those
  // are measured against the actual final text, not the placeholder.
  var started = false;
  function begin(){
    if (started) return;
    started = true;
    startScrolling();
  }
  if (window.SiteEdit){
    window.SiteEdit.fetchPage(GLOBAL_PAGE_KEY)
      .then(function(data){
        var saved = data && data.panels && data.panels[TICKER_FIELD_KEY];
        if (typeof saved === 'string' && saved.trim()) template.innerHTML = saved;
      })
      .catch(function(e){ console.warn('[ticker] load failed, showing placeholder text:', e); })
      .then(begin);
    setTimeout(begin, 2500); // backs up the fetch in case it just hangs
  } else {
    begin();
  }

  // ---------- inline editor: same interaction as the lore/events panels
  // (click a "click to edit" hint, type straight into the real text, click
  // away to save) plus a small color picker that appears alongside it,
  // applying to whatever text is currently selected rather than the whole
  // line. ----------
  var hintBtn = document.getElementById('ticker-edit-btn');
  var menu = document.getElementById('ticker-edit-menu');
  var colorPicker = document.getElementById('ticker-color-picker');
  var doneBtn = document.getElementById('ticker-edit-done');
  if (!(hintBtn && menu && colorPicker && doneBtn && window.SiteEdit)) return;

  // The browser drops the text selection the moment focus leaves the
  // contenteditable element (which clicking into the native color <input>
  // always does), so the selection has to be captured right before that
  // happens and re-applied right before the color command runs -- standard
  // trick for pairing a contenteditable with an external toolbar control.
  var savedRange = null;
  function captureSelection(){
    var sel = window.getSelection();
    if (sel.rangeCount && template.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  }
  template.addEventListener('mouseup', captureSelection);
  template.addEventListener('keyup', captureSelection);

  colorPicker.addEventListener('input', function(){
    if (savedRange){
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    // styleWithCSS makes foreColor write inline style="color:..." spans
    // instead of legacy <font color> tags -- cleaner HTML, and it's what
    // gets saved to the server as-is.
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, colorPicker.value);
    template.focus();
    captureSelection();
  });

  function positionMenu(){
    menu.hidden = false;
  }

  function beginEditing(){
    if (editing) return;
    editing = true;
    // drop the scrolling clones and freeze the track at rest so the text
    // isn't sliding out from under the cursor while typing/selecting.
    Array.prototype.slice.call(track.querySelectorAll('.ticker-item')).forEach(function(el, i){
      if (i > 0) el.remove();
    });
    track.style.transform = 'translateX(0px)';
    template.contentEditable = 'true';
    template.classList.add('editing');
    positionMenu();
    template.focus();
    var range = document.createRange();
    range.selectNodeContents(template);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function stopEditing(){
    if (!editing) return;
    editing = false;
    template.contentEditable = 'false';
    template.classList.remove('editing');
    menu.hidden = true;
    savedRange = null;

    var html = template.innerHTML;
    window.SiteEdit.saveField(GLOBAL_PAGE_KEY, TICKER_FIELD_KEY, html)
      .then(function(){ window.SiteEdit.toast('Ticker text saved.'); })
      .catch(function(){ window.SiteEdit.toast('Save failed -- check your connection and try again.'); })
      .then(function(){ refillClones(); });
  }

  hintBtn.addEventListener('click', function(e){
    e.stopPropagation();
    if (editing) return;
    window.SiteEdit.ensureAuthed().then(function(ok){
      if (ok) beginEditing();
    });
  });

  doneBtn.addEventListener('click', function(e){
    e.stopPropagation();
    stopEditing();
  });

  menu.addEventListener('click', function(e){ e.stopPropagation(); });

  // click-away safety net, same pattern as the lore/events panels: a
  // focusout that (on the next frame, so the newly-focused element has
  // actually landed) checks whether focus moved somewhere outside both the
  // editable text and the color menu before treating it as "done".
  template.addEventListener('focusout', function(){
    requestAnimationFrame(function(){
      if (!editing) return;
      var active = document.activeElement;
      if (template.contains(active) || menu.contains(active)) return;
      stopEditing();
    });
  });

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && editing) stopEditing();
  });
});
