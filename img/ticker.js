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
//      subtraction (pos -= cycleWidth) rather than resetting to 0, means
//      there's no reset point at all, so nothing to snap.
//
// The bar can hold multiple phrases, not just one -- they scroll through
// in order (phrase 1, phrase 2, ... then back to phrase 1) rather than
// resetting after just the first. Internally that's one <span
// class="ticker-set"> holding one <span class="ticker-item"> per phrase;
// the *set* (not each item individually) is what gets cloned to fill the
// track, so a clone seam always lands between full cycles, never
// mid-phrase.
//
// The actual phrases are loaded from ToutaBot's site-content API (same
// one the lore/events click-to-edit panels use, see img/site_edit.js) as
// a JSON array of HTML strings, so it's the same for every visitor, not
// just this browser -- falling back to whatever placeholder phrase is
// already sitting in the page if nothing's saved yet or the server can't
// be reached. Editing works the same way the lore/events panels do --
// click the "click to edit" hint, type straight into a phrase in place,
// click away to save -- plus a color picker and a link field that both
// apply to whatever text is currently selected (in whichever phrase has
// it), and +/x controls to add or remove phrases.
document.addEventListener('DOMContentLoaded', function(){
  var wrap = document.querySelector('.tb-ticker');
  var track = document.querySelector('.ticker-track');
  var masterSet = track ? track.querySelector('.ticker-set') : null;
  var itemTemplate = masterSet ? masterSet.querySelector('.ticker-item') : null;
  if (!wrap || !track || !masterSet || !itemTemplate) return;

  var GLOBAL_PAGE_KEY = 'global';
  var TICKER_FIELD_KEY = 'ticker-text';
  var PLACEHOLDER_HTML = itemTemplate.innerHTML;

  var editing = false;

  function phraseItems(){
    return Array.prototype.slice.call(masterSet.querySelectorAll('.ticker-item'));
  }

  function setWidth(){
    // getBoundingClientRect() returns the *rendered* (already zoom-scaled)
    // width, but a transform assigned via JS is a *logical* value the
    // browser scales by zoom again on top of that -- same double-scaling
    // issue as #content-brown's height elsewhere on this page. Dividing by
    // the current zoom converts back to logical units, which is what
    // translateX(px) actually expects.
    var zoom = parseFloat(document.body.style.zoom) || 1;
    return masterSet.getBoundingClientRect().width / zoom;
  }

  // Rebuilds the scrolling clones from the master set (the first
  // .ticker-set -- always kept as index 0, holding one .ticker-item per
  // phrase) until the track comfortably overflows the visible window
  // twice over. Called on first load and again after every save, since
  // the phrases (and therefore the set's width) can change.
  function refillClones(){
    Array.prototype.slice.call(track.querySelectorAll('.ticker-set')).forEach(function(el, i){
      if (i > 0) el.remove();
    });
    var w = setWidth();
    if (!w) return;
    var minTrackWidth = wrap.getBoundingClientRect().width * 2 + w;
    var guard = 0;
    while (track.getBoundingClientRect().width < minTrackWidth && guard < 40){
      track.appendChild(masterSet.cloneNode(true));
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
        var w = setWidth();
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

  // The saved value is a JSON array of per-phrase HTML strings. Older
  // saves (from before multi-phrase support) are a bare HTML string --
  // treated as a single-phrase array so nothing already saved is lost.
  function parsePhrases(saved){
    if (typeof saved !== 'string' || !saved.trim()) return null;
    try {
      var parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch(e) { /* not JSON -- fall through to legacy single-string handling */ }
    return [saved];
  }

  function renderPhrases(phrases){
    itemTemplate.innerHTML = phrases[0];
    for (var i = 1; i < phrases.length; i++){
      var el = itemTemplate.cloneNode(false);
      el.innerHTML = phrases[i];
      masterSet.appendChild(el);
    }
  }

  // Load the real saved phrases before starting the scroll/clones, so
  // those are measured against the actual final content, not the
  // placeholder.
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
        var phrases = parsePhrases(saved);
        if (phrases) renderPhrases(phrases);
      })
      .catch(function(e){ console.warn('[ticker] load failed, showing placeholder text:', e); })
      .then(begin);
    setTimeout(begin, 2500); // backs up the fetch in case it just hangs
  } else {
    begin();
  }

  // ---------- inline editor: same interaction as the lore/events panels
  // (click a "click to edit" hint, type straight into the real text, click
  // away to save) plus a color picker and a link field that both apply to
  // whatever text is currently selected (in whichever phrase has it), and
  // +/x controls to add or remove whole phrases. ----------
  var hintBtn = document.getElementById('ticker-edit-btn');
  var menu = document.getElementById('ticker-edit-menu');
  var colorPicker = document.getElementById('ticker-color-picker');
  var colorApplyBtn = document.getElementById('ticker-color-apply');
  var linkInput = document.getElementById('ticker-link-input');
  var linkApplyBtn = document.getElementById('ticker-link-apply');
  var addPhraseBtn = document.getElementById('ticker-add-phrase');
  var doneBtn = document.getElementById('ticker-edit-done');
  if (!(hintBtn && menu && colorPicker && colorApplyBtn && linkInput && linkApplyBtn && addPhraseBtn && doneBtn && window.SiteEdit)) return;

  // The browser drops the text selection the moment focus leaves whichever
  // phrase it was in (which clicking into the native color <input>, or any
  // of the menu's other controls, always does), so the selection -- and
  // which phrase element it belongs to -- has to be captured right before
  // that happens and restored right before a command runs. Standard trick
  // for pairing a contenteditable with an external toolbar control,
  // generalized here to "whichever phrase currently has focus" instead of
  // one fixed element.
  var savedRange = null;
  var savedPhrase = null;
  function captureSelection(){
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var phrase = phraseItems().filter(function(p){ return p.contains(sel.anchorNode); })[0];
    if (phrase){
      savedRange = sel.getRangeAt(0).cloneRange();
      savedPhrase = phrase;
    }
  }
  function restoreSelection(){
    if (!savedRange || !savedPhrase) return false;
    savedPhrase.focus();
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return true;
  }
  masterSet.addEventListener('mouseup', captureSelection);
  masterSet.addEventListener('keyup', captureSelection);

  colorApplyBtn.addEventListener('click', function(e){
    e.stopPropagation();
    // foreColor has to run while the actual phrase text is focused again
    // (clicking the color swatch, and this button itself, both moved focus
    // away from it) -- focus + selection restore have to happen before the
    // command, not after, or it's a silent no-op.
    if (!restoreSelection()) return;
    // styleWithCSS makes foreColor write inline style="color:..." spans
    // instead of legacy <font color> tags -- cleaner HTML, and it's what
    // gets saved to the server as-is.
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, colorPicker.value);
    captureSelection();
  });

  // same highlight -> fill in -> press pattern as the color control:
  // highlight text, type/paste a URL, press Link, and that selection
  // becomes clickable (target="_blank" -- opens in a new tab like the rest
  // of the site's outbound links -- since execCommand's own createLink
  // doesn't set that itself). Leaving the URL field blank and pressing
  // Link removes an existing link from the selection instead.
  linkApplyBtn.addEventListener('click', function(e){
    e.stopPropagation();
    if (!restoreSelection()) return;
    var phrase = savedPhrase;
    var url = linkInput.value.trim();
    if (!url) {
      document.execCommand('unlink', false, null);
    } else {
      if (!/^([a-z][a-z0-9+.-]*:|#)/i.test(url)) url = 'https://' + url;
      document.execCommand('createLink', false, url);
      Array.prototype.slice.call(phrase.querySelectorAll('a:not([target])')).forEach(function(a){
        a.target = '_blank';
        a.rel = 'noopener';
      });
    }
    captureSelection();
  });

  // Injects a small "x" button into a phrase (only while editing, stripped
  // again before saving -- same pattern as the Season Timeline table's
  // per-row delete button on the Events page) so it can be removed on its
  // own without deleting the others. The last remaining phrase can't be
  // removed -- there always has to be at least one.
  function addRemoveButton(phrase){
    if (phrase.querySelector('.ticker-phrase-remove')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ticker-phrase-remove';
    btn.textContent = '×';
    btn.setAttribute('aria-label', 'Remove this phrase');
    btn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      if (phraseItems().length <= 1) return;
      if (savedPhrase === phrase){ savedRange = null; savedPhrase = null; }
      phrase.remove();
    });
    phrase.appendChild(btn);
  }

  addPhraseBtn.addEventListener('click', function(e){
    e.stopPropagation();
    if (!editing) return;
    var el = itemTemplate.cloneNode(false);
    el.textContent = 'New announcement';
    masterSet.appendChild(el);
    addRemoveButton(el);
    el.focus();
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });

  function beginEditing(){
    if (editing) return;
    editing = true;
    // drop the scrolling clones and freeze the track at rest so the text
    // isn't sliding out from under the cursor while typing/selecting.
    Array.prototype.slice.call(track.querySelectorAll('.ticker-set')).forEach(function(el, i){
      if (i > 0) el.remove();
    });
    track.style.transform = 'translateX(0px)';
    var items = phraseItems();
    items.forEach(function(phrase){
      phrase.contentEditable = 'true';
      phrase.classList.add('editing');
      addRemoveButton(phrase);
    });
    menu.hidden = false;
    var first = items[0];
    first.focus();
    var range = document.createRange();
    range.selectNodeContents(first);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function stopEditing(){
    if (!editing) return;
    editing = false;
    menu.hidden = true;
    savedRange = null;
    savedPhrase = null;

    var items = phraseItems();
    items.forEach(function(phrase){
      var btn = phrase.querySelector('.ticker-phrase-remove');
      if (btn) btn.remove();
      phrase.contentEditable = 'false';
      phrase.classList.remove('editing');
    });
    // fall back to the original placeholder rather than saving/showing
    // nothing if every phrase got typed empty and deleted down to blank.
    var phrases = items.map(function(p){ return p.innerHTML; }).filter(function(h){ return h.trim(); });
    if (!phrases.length) phrases = [PLACEHOLDER_HTML];

    window.SiteEdit.saveField(GLOBAL_PAGE_KEY, TICKER_FIELD_KEY, JSON.stringify(phrases))
      .then(function(){ window.SiteEdit.toast('Ticker text saved.'); })
      .catch(function(){ window.SiteEdit.toast('Save failed -- check your connection and try again.'); })
      .then(function(){ renderPhrases(phrases); refillClones(); });
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
  // phrases being edited and the menu before treating it as "done".
  masterSet.addEventListener('focusout', function(){
    requestAnimationFrame(function(){
      if (!editing) return;
      var active = document.activeElement;
      if (masterSet.contains(active) || menu.contains(active)) return;
      stopEditing();
    });
  });

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && editing) stopEditing();
  });
});
