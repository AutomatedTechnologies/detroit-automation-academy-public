/* Detroit Automation Academy — platform navigation, single source.
 * v4.0 (2026-10-31): the nav markup is inlined in every page's static HTML
 * (domain fix program T4), so the static/no-JS link graph is complete.
 * This script now ENHANCES the static markup — mobile toggle + active-lane
 * state — and renders from scratch only as a fallback for a page whose
 * mount is empty. data-audience hooks (viewer|reader|user|visitor|
 * subscriber) are stable attributes for future personalization. No auth.
 */
(function () {
  'use strict';

    /* Audience lanes. Order is the nav order. Flat — no dropdown layers.
   * Keep in sync with the static markup inlined in the pages. */
  var LANES = [
    { label: 'Live Map', href: '/live-transit.html', audience: 'user' },
    { label: 'Cities', href: '/live-transit/', audience: 'user' },
    { label: 'Programs', href: '/programs.html', audience: 'visitor' },
    { label: 'Voter Guide', href: '/voter-guide.html', audience: 'visitor' },
    { label: 'The Signal', href: '/signal/', audience: 'reader' },
    { label: 'Contact', href: '/inquire.html', audience: 'visitor' },
    { label: 'Find', href: '/find.html', audience: 'visitor' }
  ];

  /* Map the current path to its lane for the active state. */
  function activeLane(path) {
    if (/^\/live-transit\.html/.test(path) || /^\/board\//.test(path)) return 'Live Map';
    if (/^\/live-transit\//.test(path)) return 'Cities';
    if (/^\/programs\.html/.test(path) || /^\/curriculum\//.test(path)) return 'Programs';
    if (/^\/voter-guide/.test(path)) return 'Voter Guide';
    if (/^\/signal\//.test(path)) return 'The Signal';
    if (/^\/inquire\.html/.test(path)) return 'Contact';
    if (/^\/find\.html/.test(path)) return 'Find';
    return null;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderLane(lane, active) {
    var isActive = active === lane.label;
    var act = isActive ? ' data-active="true" aria-current="page"' : '';
    var ext = lane.external ?
      ' target="_blank" rel="noopener" aria-label="' + esc(lane.label) + ', opens in new tab"' : '';
    return '<a class="lane"' + act + ' data-audience="' + lane.audience +
      '" href="' + esc(lane.href) + '"' + ext + '>' + esc(lane.label) + '</a>';
  }

  function wire(toggle, links) {
    if (!toggle || !links) return;
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        links.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function build() {
    var mount = document.getElementById('daa-nav');
    if (!mount) return;

    var path = window.location.pathname || '/';
    var active = activeLane(path);

    /* Static markup present (the normal case since T4): enhance only. */
    if (mount.children.length) {
      var lanes = mount.querySelectorAll('.lane');
      for (var i = 0; i < lanes.length; i++) {
        if (lanes[i].textContent.replace(/\s+/g, ' ').trim() === active) {
          lanes[i].setAttribute('data-active', 'true');
          lanes[i].setAttribute('aria-current', 'page');
        } else {
          lanes[i].removeAttribute('data-active');
          lanes[i].removeAttribute('aria-current');
        }
      }
      wire(document.getElementById('daaNavToggle'),
           document.getElementById('daaNavLinks'));
      return;
    }

    /* Fallback: render the full header, as before T4. */
    var isHome = path === '/' || /\/index\.html$/.test(path);
    var brandHref = isHome ? '#top' : '/';
    var lanesHtml = LANES.map(function (l) { return renderLane(l, active); }).join('');

    mount.innerHTML =
      '<header class="nav">' +
      '<a class="brand" href="' + brandHref + '" aria-label="Detroit Automation Academy \u2014 home">' +
      '<img src="/assets/logo.webp" alt="" class="brand-mark">' +
      '<span class="brand-word">Detroit Automation <em>Academy</em></span></a>' +
      '<nav class="nav-links" id="daaNavLinks" aria-label="Primary">' + lanesHtml + '</nav>' +
      '<button class="nav-toggle" id="daaNavToggle" aria-label="Toggle navigation" aria-expanded="false">' +
      '<span></span><span></span><span></span></button></header>';

    wire(document.getElementById('daaNavToggle'),
         document.getElementById('daaNavLinks'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
