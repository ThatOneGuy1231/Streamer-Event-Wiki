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
  var group = document.querySelector('.tb-ticker-group');
  var bar = document.getElementById('top-ticker-bar');
  var contentEl = document.getElementById('content');
  var track = document.querySelector('.ticker-track');
  var masterSet = track ? track.querySelector('.ticker-set') : null;
  var itemTemplate = masterSet ? masterSet.querySelector('.ticker-item') : null;
  if (!wrap || !track || !masterSet || !itemTemplate) return;

  var GLOBAL_PAGE_KEY = 'global';
  var TICKER_FIELD_KEY = 'ticker-text';
  var PLACEHOLDER_HTML = itemTemplate.innerHTML;

  var editing = false;

  // Centers the ticker box itself on #content's actual center (not the
  // ticker bar's own 50%) -- #content isn't symmetrically placed in the
  // bar's full width (its left sidebar border eats space only on one
  // side), so a plain left:50%/translateX(-50%) on the group only
  // coincidentally lines up at one specific viewport width and visibly
  // drifts at others, worse the more the page is zoomed out. Left/width
  // on .tb-ticker-group are logical px the browser re-scales by zoom, so
  // rendered (already zoom-scaled) measurements are divided back down
  // first, same reasoning as setWidth()/positionMenu() elsewhere here.
  function positionTicker(){
    if (!group || !bar || !contentEl) return;
    var zoom = parseFloat(document.body.style.zoom) || 1;
    var barRect = bar.getBoundingClientRect();
    var contentRect = contentEl.getBoundingClientRect();
    var tickerWidthRendered = 900 * zoom; // .tb-ticker's own CSS width
    var desiredTickerLeftRendered = (contentRect.left + contentRect.right) / 2 - tickerWidthRendered / 2;
    var groupLeftRendered = desiredTickerLeftRendered - barRect.left;
    group.style.left = (groupLeftRendered / zoom) + 'px';
    group.style.transform = 'none';
  }
  positionTicker();
  window.addEventListener('resize', positionTicker);

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

    // keeps scrolling exactly the same regardless of editing state --
    // editing happens entirely in the settings box now, never on this
    // element, so there's no reason left to ever pause or reset it.
    var PX_PER_SEC = 55;
    var pos = 0;
    var lastTime = null;
    function frame(now){
      if (lastTime === null) lastTime = now;
      var dt = (now - lastTime) / 1000;
      lastTime = now;
      var w = setWidth();
      pos += PX_PER_SEC * dt;
      if (w && pos >= w) pos -= w;
      track.style.transform = 'translateX(' + (-pos) + 'px)';
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // A phrase left untyped isn't necessarily an empty *string* -- an empty
  // contenteditable line commonly still holds a stray <br> (or similar),
  // which is non-empty HTML even though there's no real text in it.
  // Checking rendered textContent instead of the raw HTML string is what
  // actually detects "nothing was typed here" (or "nothing worth showing
  // was ever saved here").
  function isBlank(html){
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    return !tmp.textContent.trim();
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
    track.style.visibility = 'visible';
    startScrolling();
  }
  if (window.SiteEdit){
    window.SiteEdit.fetchPage(GLOBAL_PAGE_KEY)
      .then(function(data){
        var saved = data && data.panels && data.panels[TICKER_FIELD_KEY];
        var phrases = parsePhrases(saved);
        // drops any already-saved blank phrases (e.g. from testing +Add
        // phrase without typing into it before this got caught at save
        // time) so old bad data self-heals on load instead of needing to
        // be clicked through and removed by hand.
        if (phrases) phrases = phrases.filter(function(p){ return !isBlank(p); });
        if (phrases && phrases.length) renderPhrases(phrases);
      })
      .catch(function(e){ console.warn('[ticker] load failed, showing placeholder text:', e); })
      .then(begin);
    setTimeout(begin, 2500); // backs up the fetch in case it just hangs
  } else {
    begin();
  }

  // ---------- editor: click the "click to edit" hint, and a settings box
  // appears with each phrase as its own row *inside that box* -- the live
  // scrolling ticker itself is never touched at all (no size/overflow/wrap
  // changes, doesn't even pause), so its layout/animation can't shift
  // while editing. A color picker at the top applies to whatever text is
  // currently selected (in whichever phrase row has it). Each phrase row
  // has its own link input + Link button right beside it (2/3 phrase text,
  // 1/3 link) -- linking the *whole* phrase, not a specific highlighted
  // word, and scoped to that one row instead of "whichever row was last
  // focused" so there's never any ambiguity about which phrase a link
  // belongs to. +/x controls add or remove whole phrases, and Cancel/Save
  // are the only ways to close the box -- clicking elsewhere on the page
  // does nothing, so an accidental click outside it can't lose or discard
  // work. ----------
  var hintBtn = document.getElementById('ticker-edit-btn');
  var menu = document.getElementById('ticker-edit-menu');
  var phraseEditor = document.getElementById('ticker-phrase-editor');
  var colorPicker = document.getElementById('ticker-color-picker');
  var colorApplyBtn = document.getElementById('ticker-color-apply');
  var addPhraseBtn = document.getElementById('ticker-add-phrase');
  var cancelBtn = document.getElementById('ticker-cancel');
  var saveBtn = document.getElementById('ticker-save');
  if (!(hintBtn && menu && phraseEditor && colorPicker && colorApplyBtn && addPhraseBtn && cancelBtn && saveBtn && window.SiteEdit)) return;

  function editorRows(){
    return Array.prototype.slice.call(phraseEditor.querySelectorAll('.ticker-phrase-editor-item'));
  }

  // The browser drops the text selection the moment focus leaves whichever
  // row it was in (which clicking into the native color <input> always
  // does), so the selection -- and which row it belongs to -- has to be
  // captured right before that happens and restored right before a
  // command runs. Standard trick for pairing a contenteditable with an
  // external toolbar control, generalized here to "whichever row
  // currently has focus" instead of one fixed element.
  var savedRange = null;
  var savedRow = null;
  function captureSelection(){
    var sel = window.getSelection();
    if (!sel.rangeCount) return;
    var row = editorRows().filter(function(r){ return r.contains(sel.anchorNode); })[0];
    if (row){
      savedRange = sel.getRangeAt(0).cloneRange();
      savedRow = row;
    }
  }
  function restoreSelection(){
    if (!savedRange || !savedRow) return false;
    savedRow.focus();
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
    return true;
  }
  phraseEditor.addEventListener('mouseup', captureSelection);
  phraseEditor.addEventListener('keyup', captureSelection);

  colorApplyBtn.addEventListener('click', function(e){
    e.stopPropagation();
    // foreColor has to run while the actual row is focused again (clicking
    // the color swatch, and this button itself, both moved focus away from
    // it) -- focus + selection restore have to happen before the command,
    // not after, or it's a silent no-op.
    if (!restoreSelection()) return;
    // styleWithCSS makes foreColor write inline style="color:..." spans
    // instead of legacy <font color> tags -- cleaner HTML, and it's what
    // gets saved to the server as-is.
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, colorPicker.value);
    captureSelection();
  });

  // A phrase's content counts as "already just one whole-row link" only
  // when every child except the remove button is that single <a> --
  // distinguishes "link the whole phrase" from a color span or some other
  // partial markup that happens to contain a link.
  function wholeRowLink(row){
    var content = Array.prototype.filter.call(row.childNodes, function(n){
      return !(n.nodeType === 1 && n.classList && n.classList.contains('ticker-phrase-remove'));
    });
    if (content.length === 1 && content[0].nodeType === 1 && content[0].tagName === 'A') return content[0];
    return null;
  }

  // Links (or, with the field left blank, unlinks) the *entire* phrase row
  // -- not a specific highlighted word -- so the whole row's content
  // becomes one <a>. Re-running this on an already-linked row updates that
  // same <a>'s href instead of nesting a second link inside it. The remove
  // ("x") button lives outside this row entirely now (a sibling in the
  // wrapping .ticker-phrase-row, not layered on top of the text), so unlike
  // before there's nothing to lift out of the way first.
  function applyLinkToRow(row, url){
    var existing = wholeRowLink(row);
    if (!url) {
      if (existing) {
        while (existing.firstChild) row.insertBefore(existing.firstChild, existing);
        existing.remove();
      }
    } else {
      if (!/^([a-z][a-z0-9+.-]*:|#)/i.test(url)) url = 'https://' + url;
      if (existing) {
        existing.href = url;
      } else {
        var a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        while (row.firstChild) a.appendChild(row.firstChild);
        row.appendChild(a);
      }
    }
  }

  // Builds one row per phrase inside the menu's own phrase editor: the
  // phrase text itself (2/3 width, editable) with a small "x" *beside* it
  // (not overlaid on top -- overflow:hidden on the text box only clips at
  // its own edge, so a long phrase's auto-scrolled cursor could still end
  // up sliding underneath an x layered on top of it; a plain sibling can
  // never be covered by the box's own scrolling content) to remove this
  // phrase -- the last remaining one can't be removed, there always has to
  // be at least one -- plus that same phrase's own link input + button
  // (1/3 width) right beside that, pre-filled if the phrase is already
  // linked -- entirely separate from the live scrolling ticker.
  function addRow(html, focusIt){
    var rowWrap = document.createElement('div');
    rowWrap.className = 'ticker-phrase-row';

    var row = document.createElement('div');
    row.className = 'ticker-phrase-editor-item';
    row.contentEditable = 'true';
    row.innerHTML = html;

    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ticker-phrase-remove';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove this phrase');
    removeBtn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      if (editorRows().length <= 1) return;
      if (savedRow === row){ savedRange = null; savedRow = null; }
      rowWrap.remove();
    });

    var existingLink = wholeRowLink(row);
    var linkInput = document.createElement('input');
    linkInput.type = 'text';
    linkInput.className = 'ticker-phrase-link-input';
    linkInput.placeholder = 'https://...';
    if (existingLink) linkInput.value = existingLink.getAttribute('href');

    var linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'ticker-phrase-link-btn';
    linkBtn.textContent = 'Link';
    linkBtn.addEventListener('click', function(e){
      e.preventDefault();
      e.stopPropagation();
      applyLinkToRow(row, linkInput.value.trim());
      var applied = wholeRowLink(row);
      linkInput.value = applied ? applied.getAttribute('href') : ''; // reflects the https:// auto-prefix, if any
    });

    rowWrap.appendChild(row);
    rowWrap.appendChild(removeBtn);
    rowWrap.appendChild(linkInput);
    rowWrap.appendChild(linkBtn);
    phraseEditor.appendChild(rowWrap);
    if (focusIt){
      row.focus();
      var range = document.createRange();
      range.selectNodeContents(row);
      range.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return row;
  }

  addPhraseBtn.addEventListener('click', function(e){
    e.stopPropagation();
    if (!editing) return;
    addRow('New announcement', true);
  });

  // Lines the menu's left edge and width up with .tb-ticker's own actual
  // rendered box (not a hardcoded guess) -- getBoundingClientRect() gives
  // already zoom-scaled px, so it's divided back down to logical px first,
  // same reasoning as itemWidth()/setWidth() above, since the menu isn't
  // nested inside the ticker bar (that bar clips its own overflow, which
  // would otherwise cut this popup off) and so isn't affected by the same
  // zoom transform its ancestors are.
  function positionMenu(){
    var zoom = parseFloat(document.body.style.zoom) || 1;
    var r = wrap.getBoundingClientRect();
    menu.style.left = (r.left / zoom) + 'px';
    menu.style.width = (r.width / zoom) + 'px';
    menu.hidden = false;
  }

  function beginEditing(){
    if (editing) return;
    editing = true;
    // visibility, not the hidden attribute -- hidden removes it from
    // layout entirely, which shrinks .tb-ticker-group's total width and
    // re-centers it, nudging the ticker box itself sideways. Staying
    // invisible-but-still-taking-up-space keeps the group's width (and so
    // the ticker's position) exactly the same whether this is shown or not.
    hintBtn.style.visibility = 'hidden';
    phraseEditor.innerHTML = '';
    phraseItems().forEach(function(phrase, i){ addRow(phrase.innerHTML, i === 0); });
    positionMenu();
  }

  // Shared teardown for both Cancel and Save -- closes the box and clears
  // its editing-only state either way; the two differ only in whether the
  // phrase rows' content actually gets read and sent anywhere.
  function closeEditor(){
    editing = false;
    hintBtn.style.visibility = '';
    menu.hidden = true;
    savedRange = null;
    savedRow = null;
    activeRow = null;
    phraseEditor.innerHTML = '';
  }

  function cancelEditing(){
    if (!editing) return;
    closeEditor();
  }

  function saveEditing(){
    if (!editing) return;
    var rows = editorRows();
    rows.forEach(function(row){
      var btn = row.querySelector('.ticker-phrase-remove');
      if (btn) btn.remove();
    });
    // fall back to the original placeholder rather than saving/showing
    // nothing if every phrase got typed empty and deleted down to blank.
    var phrases = rows.map(function(r){ return r.innerHTML; }).filter(function(h){ return !isBlank(h); });
    if (!phrases.length) phrases = [PLACEHOLDER_HTML];
    closeEditor();

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

  cancelBtn.addEventListener('click', function(e){
    e.stopPropagation();
    cancelEditing();
  });

  saveBtn.addEventListener('click', function(e){
    e.stopPropagation();
    saveEditing();
  });

  // No click-away-to-close on purpose -- Cancel and Save are the only way
  // out, so an accidental click elsewhere on the page can never lose or
  // silently discard whatever's been typed. Escape is treated the same as
  // Cancel (never auto-saves).
  menu.addEventListener('click', function(e){ e.stopPropagation(); });

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && editing) cancelEditing();
  });
});
