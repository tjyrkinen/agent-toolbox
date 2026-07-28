/* interactive-page annotation toolbox — injected by serve.py --annotate.
 * Turns any served page into a highlight-and-comment surface with zero page code:
 *   - select text -> "Comment" -> highlight + popover -> corner list
 *   - anchors each comment by block id + quote + prefix/suffix + offsets (W3C-style)
 *   - rides the page's existing /submit commit (fetch patch); if the page has no
 *     commit of its own, adds a Cancel/Discuss/Submit bar so comments still return.
 * Highlighting uses the CSS Custom Highlight API (no DOM surgery; spans element
 * boundaries). Config (injected): window.__ANNOTATE_CFG__ = { nonce, root?, commit? }.
 */
(function () {
  const CFG = window.__ANNOTATE_CFG__ || {};
  const NONCE = CFG.nonce || new URLSearchParams(location.search).get('n') || '';
  const rootEl = () => document.querySelector(CFG.root || '[data-annotate]') || document.querySelector('main') || document.body;
  const BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,dd,dt,td,.line,[data-block]';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const style = document.createElement('style');
  style.textContent = `
    ::highlight(anx){ background: color-mix(in srgb, #d8961f 32%, transparent); }
    ::highlight(anx-active){ background: color-mix(in srgb, #d8961f 55%, transparent); }
    .anx-fab{ position:fixed; z-index:2147483000; transform:translate(-50%,6px); background:#0d6b6a; color:#fff;
      border:0; border-radius:8px; padding:.35rem .6rem; font:600 .8rem/1 ui-sans-serif,system-ui,sans-serif;
      cursor:pointer; box-shadow:0 3px 12px rgba(0,0,0,.28); }
    .anx-pop{ position:fixed; z-index:2147483001; width:min(26rem,calc(100vw - 2rem)); background:var(--surface,#fff); color:var(--ink,#131a1c);
      border:1px solid var(--border-strong,#c6d0d0); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.22); padding:.7rem; }
    .anx-pop textarea{ width:100%; min-height:3.6rem; resize:vertical; font:.9rem/1.45 ui-sans-serif,system-ui,sans-serif;
      color:inherit; background:var(--surface-2,#eef2f2); border:1px solid var(--border,#dde4e4); border-radius:7px; padding:.5rem .6rem; box-sizing:border-box; }
    .anx-row{ display:flex; gap:.4rem; justify-content:flex-end; margin-top:.5rem; }
    .anx-row button{ font:600 .78rem/1 ui-sans-serif,system-ui,sans-serif; padding:.35rem .6rem; border-radius:7px; cursor:pointer; border:1px solid var(--border-strong,#c6d0d0); background:var(--surface,#fff); color:var(--ink,#131a1c); }
    .anx-row button.save{ background:#0d6b6a; border-color:#0d6b6a; color:#fff; }
    .anx-row button.del{ color:#b23a2c; }
    .anx-panel{ position:fixed; left:1rem; bottom:1rem; z-index:2147482999; font:.8rem ui-sans-serif,system-ui,sans-serif; }
    .anx-tab{ background:var(--surface,#fff); color:var(--ink,#131a1c); border:1px solid var(--border-strong,#c6d0d0);
      border-radius:100px; padding:.4rem .8rem; cursor:pointer; box-shadow:0 3px 12px rgba(0,0,0,.16); font-weight:600; }
    .anx-list{ display:none; margin-top:.5rem; width:19rem; max-height:50vh; overflow:auto; background:var(--surface,#fff);
      border:1px solid var(--border,#dde4e4); border-radius:10px; box-shadow:0 8px 28px rgba(0,0,0,.2); }
    .anx-list.open{ display:block; }
    .anx-item{ padding:.6rem .7rem; border-bottom:1px solid var(--border,#dde4e4); cursor:pointer; }
    .anx-item:last-child{ border-bottom:0; }
    .anx-item .q{ font:.72rem/1.3 ui-monospace,monospace; color:var(--ink-3,#6d7c81); margin-top:.2rem; }
    .anx-empty{ padding:.7rem; color:var(--ink-3,#6d7c81); }
    .anx-bar{ position:fixed; right:1rem; bottom:1rem; z-index:2147483002; display:flex; gap:.5rem; }
    .anx-sb{ font:600 .85rem/1 ui-sans-serif,system-ui,sans-serif; padding:.5rem .9rem; border-radius:9px; cursor:pointer;
      border:1px solid var(--border-strong,#c6d0d0); background:var(--surface,#fff); color:var(--ink,#131a1c); box-shadow:0 3px 12px rgba(0,0,0,.16); }
    .anx-sb.primary{ background:#0d6b6a; border-color:#0d6b6a; color:#fff; }
    .anx-over{ position:fixed; inset:0; z-index:2147483601; display:grid; place-items:center; text-align:center; padding:2rem;
      background:var(--ground,#f5f7f7); color:var(--ink,#131a1c); font:1.1rem ui-sans-serif,system-ui,sans-serif; }
  `;
  document.head.appendChild(style);

  const supportsHL = typeof Highlight !== 'undefined' && window.CSS && CSS.highlights;
  const hl = supportsHL ? new Highlight() : null;
  const hlActive = supportsHL ? new Highlight() : null;
  if (supportsHL) { CSS.highlights.set('anx', hl); CSS.highlights.set('anx-active', hlActive); }

  const annots = [];   // { id, range, anchor, comment, h? } — h = this comment's own resized box height
  let seq = 0, blockSeq = 0;

  // Assign a stable id to each LEAF text block (no descendant block), so nested
  // containers aren't double-counted. Idempotent + additive for late-rendered content.
  function assignBlocks() {
    const r = rootEl();
    let blocks = Array.from(r.querySelectorAll(BLOCK_SEL)).filter(el => !el.querySelector(BLOCK_SEL));
    if (!blocks.length) blocks = Array.from(r.children);
    blocks.forEach(el => { if (!el.hasAttribute('data-anchor')) el.setAttribute('data-anchor', 'b' + (blockSeq++)); });
    return blocks;
  }
  const blockOf = node => { const el = node.nodeType === 1 ? node : node.parentElement; return el ? el.closest('[data-anchor]') : null; };

  function offsetWithin(block, node, off) {
    const r = document.createRange();
    r.selectNodeContents(block);
    try { r.setEnd(node, off); } catch (e) { return 0; }
    return r.toString().length;
  }
  function computeAnchor(range) {
    const sB = blockOf(range.startContainer), eB = blockOf(range.endContainer);
    const all = Array.from(rootEl().querySelectorAll('[data-anchor]'));
    const si = all.indexOf(sB), ei = all.indexOf(eB);
    const blockIds = [];
    if (si >= 0 && ei >= 0) for (let i = si; i <= ei; i++) blockIds.push(all[i].getAttribute('data-anchor'));
    const start = sB ? offsetWithin(sB, range.startContainer, range.startOffset) : null;
    const end = eB ? offsetWithin(eB, range.endContainer, range.endOffset) : null;
    const sText = sB ? sB.textContent : '', eText = eB ? eB.textContent : '';
    return {
      blockId: sB ? sB.getAttribute('data-anchor') : null,
      blockIds, quote: range.toString(),
      // for a multi-block span: start is an offset in the FIRST block, end in the LAST.
      prefix: start != null ? sText.slice(Math.max(0, start - 32), start) : '',
      suffix: end != null ? eText.slice(end, end + 32) : '',
      start, end, multiBlock: blockIds.length > 1
    };
  }

  function paint() {
    if (!supportsHL) return;
    hl.clear(); hlActive.clear();
    annots.forEach(a => { if (a.range) hl.add(a.range); });
  }
  function flash(a) {
    if (!supportsHL || !a.range) return;
    hlActive.clear(); hlActive.add(a.range);
    setTimeout(() => hlActive.clear(), 1200);
  }

  // --- floating "Comment" button on a fresh selection ---
  const fab = document.createElement('button');
  fab.className = 'anx-fab'; fab.textContent = '💬 Comment'; fab.style.display = 'none';
  document.body.appendChild(fab);
  let pendingRange = null;

  function refreshFab() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { fab.style.display = 'none'; return; }
    const range = sel.getRangeAt(0);
    if (!rootEl().contains(range.commonAncestorContainer)) { fab.style.display = 'none'; return; }
    const rects = range.getClientRects();
    if (!rects.length) { fab.style.display = 'none'; return; }
    const r = rects[rects.length - 1];
    pendingRange = range.cloneRange();
    fab.style.left = r.right + 'px'; fab.style.top = r.bottom + 'px'; fab.style.display = 'block';
  }
  document.addEventListener('selectionchange', () => requestAnimationFrame(refreshFab));

  fab.addEventListener('mousedown', e => e.preventDefault()); // keep the selection
  fab.addEventListener('click', () => {
    if (!pendingRange) return;
    assignBlocks(); // ensure content rendered since load has anchor ids
    const a = { id: 'an' + (++seq), range: pendingRange.cloneRange(), anchor: computeAnchor(pendingRange), comment: '' };
    annots.push(a); paint();
    document.getSelection().removeAllRanges();
    fab.style.display = 'none';
    openPopover(a, true);
    renderList();
  });

  // --- popover to write/edit a comment ---
  let pop = null, popCleanup = null;
  function closePopover() { if (popCleanup) { popCleanup(); popCleanup = null; } if (pop) { pop.remove(); pop = null; } }
  function openPopover(a, isNew) {
    closePopover();
    pop = document.createElement('div'); pop.className = 'anx-pop';
    pop.innerHTML = `<textarea placeholder="Your comment…">${esc(a.comment)}</textarea>
      <div class="anx-row"><button class="del">Delete</button></div>`;
    document.body.appendChild(pop);
    const rects = a.range ? a.range.getClientRects() : [];
    const r = rects.length ? rects[rects.length - 1] : { left: window.innerWidth / 2, bottom: 80 };
    pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 12) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    const ta = pop.querySelector('textarea');
    if (a.h) ta.style.height = a.h + 'px';   // restore this comment's own resized height
    ta.focus();
    flash(a);
    const save = () => { a.comment = ta.value.trim(); if (!a.comment) removeAnnot(a); closePopover(); renderList(); };
    // grow to fit content (never shrinks below a manual resize)
    const grow = () => { if (ta.scrollHeight > ta.clientHeight) ta.style.height = ta.scrollHeight + 'px'; };
    grow();
    ta.addEventListener('input', grow);
    pop.querySelector('.del').onclick = () => { removeAnnot(a); closePopover(); renderList(); };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(); if (e.key === 'Escape') { if (isNew && !a.comment) removeAnnot(a); closePopover(); renderList(); } });
    // remember a manual drag-resize (pointer down on the box + height changed) for next time
    let downH = 0;
    const pd = () => { downH = ta.offsetHeight; };
    const pu = () => { if (!pop || !downH || ta.offsetHeight === downH) return; a.h = ta.offsetHeight; };   // remember for THIS comment only
    ta.addEventListener('pointerdown', pd);
    window.addEventListener('pointerup', pu);
    // click away = save & close (attached next tick so the opening click doesn't fire it)
    const onDown = e => { if (pop && !pop.contains(e.target)) save(); };
    setTimeout(() => document.addEventListener('mousedown', onDown), 0);
    popCleanup = () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('pointerup', pu); };
  }
  function removeAnnot(a) { const i = annots.indexOf(a); if (i >= 0) annots.splice(i, 1); paint(); }

  // click an existing highlight -> edit (delegated; ignore drag-selections + popover clicks)
  document.addEventListener('click', e => {
    if (!supportsHL || (pop && pop.contains(e.target))) return;
    if (!rootEl().contains(e.target)) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return; // user is selecting, not clicking a highlight
    let cr = null;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(e.clientX, e.clientY); if (p) { cr = document.createRange(); cr.setStart(p.offsetNode, p.offset); } }
    else if (document.caretRangeFromPoint) cr = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!cr) return;
    const hit = annots.find(a => { try { return a.range && a.range.comparePoint(cr.startContainer, cr.startOffset) === 0; } catch (x) { return false; } });
    if (hit) openPopover(hit, false);
  });

  // --- corner list ---
  const panel = document.createElement('div'); panel.className = 'anx-panel';
  panel.innerHTML = `<button class="anx-tab">▸ Comments (0)</button><div class="anx-list"></div>`;
  document.body.appendChild(panel);
  const tab = panel.querySelector('.anx-tab'), list = panel.querySelector('.anx-list');
  tab.onclick = () => { list.classList.toggle('open'); renderList(); };
  function renderList() {
    const withText = annots.filter(a => a.comment);
    panel.style.display = withText.length ? '' : 'none';   // no clutter until a comment exists
    tab.textContent = (list.classList.contains('open') ? '▾' : '▸') + ' Comments (' + withText.length + ')';
    if (!withText.length) { list.innerHTML = '<div class="anx-empty">No comments yet — select text to add one.</div>'; return; }
    list.innerHTML = '';
    withText.forEach(a => {
      const row = document.createElement('div'); row.className = 'anx-item';
      row.innerHTML = `<div class="c">${esc(a.comment)}</div><div class="q">“${esc((a.anchor.quote || '').slice(0, 80))}”</div>`;
      row.onclick = () => { const b = document.querySelector('[data-anchor="' + a.anchor.blockId + '"]'); if (b) b.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(a); openPopover(a, false); };
      list.appendChild(row);
    });
  }

  // --- collect + ride the page's commit ---
  function collect() {
    return annots.filter(a => a.comment).map(a => ({ id: a.id, comment: a.comment, quotedText: a.anchor.quote, anchor: a.anchor }));
  }
  window.__getAnnotations__ = collect;
  const _fetch = window.fetch;
  window.fetch = function (input, opts) {
    try {
      const u = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((opts && opts.method) || (input && input.method) || 'GET').toUpperCase();
      const resolved = u ? new URL(u, location.href) : null;
      if (resolved && resolved.origin === location.origin && method === 'POST' && resolved.pathname === '/submit' && opts && typeof opts.body === 'string') {
        const b = JSON.parse(opts.body);
        if (b && typeof b === 'object') { b.annotations = collect(); opts = Object.assign({}, opts, { body: JSON.stringify(b) }); }
      }
    } catch (e) { /* leave the request untouched on any non-JSON / Request-object body */ }
    return _fetch.call(this, input, opts);
  };

  // Standalone commit: a bare --annotate page with no footer of its own still needs
  // a way to send comments back. Suppressed when the page carries its own .bar footer
  // (the scaffolds do) or when CFG.commit === false.
  function addStandaloneBar() {
    if (CFG.commit === false || document.querySelector('.bar')) return;
    const bar = document.createElement('div'); bar.className = 'anx-bar';
    bar.innerHTML = '<button class="anx-sb" data-k="cancel">Cancel</button><button class="anx-sb" data-k="discuss">Discuss</button><button class="anx-sb primary" data-k="submit">Submit</button>';
    document.body.appendChild(bar);
    let done = false;
    bar.addEventListener('click', async e => {
      const btn = e.target.closest('.anx-sb'); if (!btn || done) return;
      done = true;
      const kind = btn.dataset.k;
      const payload = { nonce: NONCE, action: kind, actionKind: kind === 'submit' ? 'primary' : kind, generalNote: '', annotations: collect() };
      try { await _fetch('/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); } catch (x) { /* server may have closed */ }
      const ov = document.createElement('div'); ov.className = 'anx-over';
      ov.textContent = kind === 'cancel' ? 'Cancelled — return to the chat.'
        : kind === 'discuss' ? 'Sent for discussion — return to the chat.'
          : 'Submitted — your comments are back in the chat. You can close this tab.';
      document.body.appendChild(ov);
    });
  }

  function init() { assignBlocks(); addStandaloneBar(); renderList(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
