/* Detroit Automation Academy — platform navigation, single source.
 * v2.2 (2026-10-11): flat lanes (dropdown layers removed), Bio added.
 * Renders the site header into #daa-nav. Works from any host serving this
 * file at site root (detroitautomationacademy.com, Netlify dev/uat).
 * data-audience hooks (viewer|reader|user|visitor|subscriber) are stable
 * attributes for future subscriber/user-state personalization. No auth here.
 */
(function () {
  'use strict';

  var NEWSLETTER_URL = 'https://www.linkedin.com/newsletters/7508391258638311424/';

  /* Audience lanes. Order is the nav order. Flat — no dropdown layers. */
  var LANES = [
    { label: 'Watch', href: '/watch/', audience: 'viewer' },
    { label: 'Read', href: '/signal/', audience: 'reader' },
    { label: 'Do', href: '/live-transit.html', audience: 'user' },
    { label: 'About', href: '/#mission', audience: 'visitor' },
    { label: 'Bio', href: '/apple-learning-coach/', audience: 'visitor' },
    { label: 'Subscribe', href: NEWSLETTER_URL, audience: 'subscriber', external: true }
  ];

  /* Map the current path to its lane for the active state. */
  function activeLane(path) {
    if (/^\/watch\//.test(path)) return 'Watch';
    if (/^\/signal\//.test(path)) return 'Read';
    if (/^\/live-transit\.html/.test(path)) return 'Do';
    if (/^\/apple-learning-coach\//.test(path)) return 'Bio';
    return null;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderLane(lane, active) {
    var isActive = active === lane.label;
    var act = isActive ? ' data-active="true"' : '';
    var ext = lane.external ? ' target="_blank" rel="noopener"' : '';
    return '<a class="lane"' + act + ' data-audience="' + lane.audience +
      '" href="' + esc(lane.href) + '"' + ext + '>' + esc(lane.label) + '</a>';
  }

  function build() {
    var mount = document.getElementById('daa-nav');
    if (!mount) return;

    var path = window.location.pathname || '/';
    var active = activeLane(path);
    var isHome = path === '/' || /\/index\.html$/.test(path);
    var brandHref = isHome ? '#top' : '/';

    var lanesHtml = LANES.map(function (l) { return renderLane(l, active); }).join('');

    mount.innerHTML =
      '<header class="nav">' +
      '<a class="brand" href="' + brandHref + '" aria-label="Detroit Automation Academy home">' +
      '<img src="/assets/logo.webp" alt="" class="brand-mark">' +
      '<span class="brand-word">Detroit Automation <em>Academy</em></span></a>' +
      '<nav class="nav-links" id="daaNavLinks" aria-label="Primary">' + lanesHtml + '</nav>' +
      '<button class="nav-toggle" id="daaNavToggle" aria-label="Toggle navigation" aria-expanded="false">' +
      '<span></span><span></span><span></span></button></header>';

    /* Mobile toggle — self-contained (ids are daa*-namespaced so the legacy
     * script.js navToggle wiring never double-binds). */
    var toggle = document.getElementById('daaNavToggle');
    var links = document.getElementById('daaNavLinks');
    if (toggle && links) {
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
