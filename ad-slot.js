/* Detroit Automation Academy — sponsored slot include (WS-A build A1).
 *
 * Design: commercial-posture-audit/wsa-a1-ad-surface-design-2026-10-19.md
 *
 * Ships DARK. ADS_ENABLED below is the single source of truth and the
 * kill switch: while false, this script performs an allowlist check and
 * returns before any DOM write, style injection, or network request.
 * `?daa_ads=preview` renders the house creative for one view on an
 * allowlisted page (owner preview + gates); `?daa_ads=off` forces off.
 *
 * Enforcement is an allowlist of page classes, never a denylist: a
 * page receives a slot only if (1) this include and a mount element
 * were grafted onto it, (2) its path matches ALLOWLIST, and (3) the
 * mount's data-ad-slot name is registered in SLOTS. The map
 * (live-transit.html), the voter guide, and every rider decision path
 * are absent from the allowlist — there is no code path by which they
 * can receive a slot.
 *
 * The rendered slot always carries its "Sponsored" label: the label is
 * generated inside render() as part of the slot unit (Gate 5 labeling
 * discipline), and a guard clears the slot if the label node is ever
 * removed. The A1 payload is the academy's own Card X sponsorship
 * house creative; a network payload later swaps in behind the same
 * contract (mount, label, flag, measurement unchanged).
 */
(function () {
  'use strict';

  /* The dark flag. false = no slot renders in normal serving. */
  var ADS_ENABLED = false;

  /* Allowlisted page classes (design §1 IN classes). Mounts arrive per
   * tranche; a path match alone renders nothing without a mount. */
  var ALLOWLIST = [
    /^\/signal(\/|$)/,
    /^\/engineering(\/|$)/,
    /^\/press(\/|$)/
  ];

  /* Registered slots (design §3). An unregistered data-ad-slot name
   * renders nothing. */
  var SLOTS = {
    'signal-article-end': true,
    'signal-hub-end': true
  };

  /* House creative — Card X sponsorship card (rates as published on
   * /sponsor.html: $5,000 presenting / $2,000 supporting / $12,500
   * three-edition partner). */
  var HOUSE_CREATIVE = {
    id: 'house-card-x',
    kicker: 'The Signal · Sponsorship',
    headline: 'This space is brought to readers by sponsors.',
    body: 'The Signal is sponsored, not sold: one presenting sponsor ' +
      'per edition ($5,000) and three supporting slots ($2,000). ' +
      'Sponsors fund the work — they don\u2019t shape it.',
    ctaText: 'See sponsorship \u2192',
    href: '/sponsor.html'
  };

  /* Slot styles, scoped under .daa-ad and injected only when a slot
   * renders, so a dark page carries no ad styling at all. When the
   * surface lights for real, this block graduates into styles.css
   * with the standing site-wide stamp bump (design §5). */
  var CSS = [
    '.daa-ad{margin:2.5rem 0 0;border:1px solid var(--line,rgba(245,242,234,.09));',
    'background:var(--card,#131a21);border-radius:14px;padding:22px 24px;}',
    '.daa-ad-label{display:inline-block;font-size:.72rem;font-weight:600;',
    'letter-spacing:.08em;text-transform:uppercase;color:var(--amber,#FFB000);',
    'border:1px solid var(--line,rgba(245,242,234,.09));border-radius:999px;',
    'padding:3px 10px;margin:0 0 12px;}',
    '.daa-ad-kicker{margin:0 0 4px;font-size:.8rem;color:var(--concrete,#9AA0A6);}',
    '.daa-ad-headline{margin:0 0 6px;font-size:1.15rem;font-weight:600;',
    'color:var(--paper,#F5F2EA);}',
    '.daa-ad-body{margin:0 0 14px;color:var(--concrete,#9AA0A6);max-width:60ch;}',
    '.daa-ad-cta{display:inline-block;min-height:44px;line-height:44px;',
    'font-weight:600;color:var(--forge,#E85D1A);text-decoration:none;}',
    '.daa-ad-cta:hover{color:var(--amber,#FFB000);}',
    '.daa-ad-mount[data-ad-slot="signal-article-end"] .daa-ad{max-width:720px;}',
    '.daa-ad a{text-decoration:none;}'
  ].join('');

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function allowlisted(path) {
    for (var i = 0; i < ALLOWLIST.length; i++) {
      if (ALLOWLIST[i].test(path)) return true;
    }
    return false;
  }

  function flagState(search) {
    var q = String(search || '');
    if (/[?&]daa_ads=off(&|$)/.test(q)) return 'off';
    if (ADS_ENABLED) return 'on';
    if (/[?&]daa_ads=preview(&|$)/.test(q)) return 'preview';
    return 'off';
  }

  function injectStyle(doc) {
    if (doc.getElementById('daa-ad-style')) return;
    var st = doc.createElement('style');
    st.id = 'daa-ad-style';
    st.textContent = CSS;
    doc.head.appendChild(st);
  }

  function render(doc, mount, creative) {
    var slotName = mount.getAttribute('data-ad-slot');
    injectStyle(doc);
    mount.innerHTML =
      '<aside class="daa-ad" role="complementary" aria-label="Sponsored">' +
      '<span class="daa-ad-label">Sponsored</span>' +
      '<p class="daa-ad-kicker">' + esc(creative.kicker) + '</p>' +
      '<p class="daa-ad-headline">' + esc(creative.headline) + '</p>' +
      '<p class="daa-ad-body">' + esc(creative.body) + '</p>' +
      '<a class="daa-ad-cta" href="' + esc(creative.href) + '">' +
      esc(creative.ctaText) + '</a></aside>';
    mount.hidden = false;
    mount.setAttribute('data-ad-creative', creative.id);
    mount.setAttribute('data-ad-rendered', '1');

    /* Label invariant: if the label node is removed, the slot clears
     * itself (design §3 — removable by no control while on). */
    if (typeof MutationObserver !== 'undefined') {
      var obs = new MutationObserver(function () {
        if (!mount.querySelector('.daa-ad-label')) {
          obs.disconnect();
          mount.innerHTML = '';
          mount.hidden = true;
          mount.removeAttribute('data-ad-rendered');
        }
      });
      obs.observe(mount, { childList: true, subtree: true });
    }

    /* Measurement hooks (design §6) — local only, no beacons. */
    var rec = {
      slot: slotName,
      surface: window.location.pathname,
      creative: creative.id,
      ts: new Date().toISOString()
    };
    window.daaAds = window.daaAds || [];
    window.daaAds.push(rec);
    try {
      doc.dispatchEvent(new CustomEvent('daa-ad-impression', { detail: rec }));
    } catch (e) { /* event surface is best-effort; the record stands */ }
    return rec;
  }

  function main() {
    var path = window.location.pathname || '/';
    if (!allowlisted(path)) return;
    if (flagState(window.location.search) === 'off') return;
    var mounts = document.querySelectorAll('[data-ad-slot]');
    for (var i = 0; i < mounts.length; i++) {
      var name = mounts[i].getAttribute('data-ad-slot');
      if (SLOTS[name]) render(document, mounts[i], HOUSE_CREATIVE);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
