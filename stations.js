/* Detroit Automation Academy — stations: rendered station buildings.
 *
 * Classic IIFE; exposes window.DAAStations = { buildStations: function(THREE) }.
 * One-square-mile rescope (2026-10-01): the four open C-loop platforms get
 * enclosed waiting halls (retrofit under the existing arch-kit canopies), the
 * Central Interchange concourse rises at ground level beside the Academy HQ
 * platform with a stair tower to the deck, and the intercity transfer hall
 * (railways.js section B3) gets its completion pass: entrance doors + canopy,
 * roof windscreens, level glow strips, and a PROPOSED-service sign.
 *
 * Copy rule: the intercity service stays signed PROPOSED — no opening dates,
 * no operator names. No external assets, no network, deterministic (seeded
 * PRNG only — never Math.random). Units: meters; x = east, z = south, y = up.
 */
(function () {
  'use strict';

  var ORANGE = 0xE85D1A, AMBER = 0xFFB000,
      CONCRETE = 0x9AA0A6, DARK = 0x14171b, GLASS = 0x2a3f4d,
      BRICK = 0x8a4632, ROOF = 0x23282e;

  // mulberry32 — seeded PRNG. Same sequence on every boot.
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildStations(THREE) {
    var g = new THREE.Group();
    var R = rng(20261001);

    // shared materials — one per finish across every building
    function std(o) { return new THREE.MeshStandardMaterial(o); }
    var mBrick = std({ color: BRICK, roughness: 0.9 });
    var mConcrete = std({ color: CONCRETE, roughness: 0.9 });
    var mDark = std({ color: DARK, roughness: 0.8 });
    var mGlass = std({ color: GLASS, roughness: 0.2, metalness: 0.6 });
    var mOrange = std({ color: ORANGE, roughness: 0.55, metalness: 0.25 });
    var mRoof = std({ color: ROOF, roughness: 0.6, metalness: 0.4 });
    var mWarm = std({ color: 0xfff2cf, emissive: 0xffe9b0, emissiveIntensity: 1.6 });
    var mAmber = std({ color: AMBER, emissive: AMBER, emissiveIntensity: 1.1, roughness: 0.4 });
    var mWood = std({ color: 0x8a6a48, roughness: 0.9 });

    function box(w, h, d, mat, x, y, z, ry) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      if (ry) m.rotation.y = ry;
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
      return m;
    }

    // canvas sign painter — matches the railways.js totem visual language
    function signTex(title, sub, wM, hM) {
      var c = document.createElement('canvas');
      var PXM = 64;
      c.width = Math.max(2, Math.round(wM * PXM));
      c.height = Math.max(2, Math.round(hM * PXM));
      var x2 = c.getContext('2d');
      x2.fillStyle = '#10141a'; x2.fillRect(0, 0, c.width, c.height);
      x2.strokeStyle = '#E85D1A'; x2.lineWidth = Math.max(4, c.height * 0.08);
      x2.strokeRect(4, 4, c.width - 8, c.height - 8);
      x2.fillStyle = '#f5f2ea'; x2.textAlign = 'center'; x2.textBaseline = 'middle';
      var fs = Math.round(c.height * (sub ? 0.34 : 0.44));
      x2.font = 'bold ' + fs + 'px sans-serif';
      while (x2.measureText(title).width > c.width * 0.86 && fs > 8) {
        fs -= 2; x2.font = 'bold ' + fs + 'px sans-serif';
      }
      x2.fillText(title, c.width / 2, sub ? c.height * 0.36 : c.height / 2);
      if (sub) {
        x2.font = Math.round(c.height * 0.2) + 'px sans-serif';
        x2.fillStyle = '#E85D1A';
        x2.fillText(sub, c.width / 2, c.height * 0.72);
      }
      var t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
      return t;
    }
    function totem(title, sub, x, y, z, ry) {
      var fm = std({ map: signTex(title, sub, 3.2, 1.1), roughness: 0.7 });
      var b = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.1, 0.1),
        [mDark, mDark, mDark, mDark, fm, fm]);
      b.position.set(x, y, z);
      if (ry) b.rotation.y = ry;
      b.castShadow = true;
      g.add(b);
    }

    // ---- four enclosed waiting halls on the open C-loop platforms ----
    // Retrofit: walls rise 2.2 m from the platform deck (7.5) and the roof
    // slab tucks UNDER the existing arch-kit canopy (10.14). The pre-existing
    // canopy poles may pierce a roof here and there — retrofit construction.
    // (px,pz): platform center per arch-kit.js station(); away: lateral
    // direction from the track (+1/-1); czOff: optional z shift of the hall
    // (used at Academy HQ to clear the stair tower).
    function stationHall(px, pz, alongZ, away, czOff) {
      var L = 6, Wd = 1.4, H = 2.2;
      var cx = px + (alongZ ? away * 0.1 : 0);
      var cz = pz + (alongZ ? (czOff || 0) : away * 0.1);
      if (!alongZ) cx = px + (czOff || 0);
      var y0 = 7.5; // platform deck top
      var jx = (R() - 0.5) * 0.3; // seeded bench offset — same every boot
      if (alongZ) {
        box(Wd, 0.06, L, mConcrete, cx, y0 + 0.03, cz);
        box(Wd, H, 0.1, mBrick, cx, y0 + H / 2, cz - L / 2 + 0.05);
        box(Wd, H, 0.1, mBrick, cx, y0 + H / 2, cz + L / 2 - 0.05);
        box(0.1, H, L, mGlass, cx - Wd / 2 + 0.05, y0 + H / 2, cz);
        box(0.1, H, L, mGlass, cx + Wd / 2 - 0.05, y0 + H / 2, cz);
        box(Wd + 0.3, 0.12, L + 0.3, mRoof, cx, y0 + H + 0.06, cz);
        box(0.08, 0.1, L + 0.3, mOrange, cx - away * (Wd / 2), y0 + H + 0.02, cz);
        box(1.1, 0.45, 0.4, mWood, cx + away * 0.1 + jx * 0.2, y0 + 0.28, cz);
        box(Wd - 0.3, 0.05, L - 0.6, mWarm, cx, y0 + H - 0.05, cz);
      } else {
        box(L, 0.06, Wd, mConcrete, cx, y0 + 0.03, cz);
        box(0.1, H, Wd, mBrick, cx - L / 2 + 0.05, y0 + H / 2, cz);
        box(0.1, H, Wd, mBrick, cx + L / 2 - 0.05, y0 + H / 2, cz);
        box(L, H, 0.1, mGlass, cx, y0 + H / 2, cz - Wd / 2 + 0.05);
        box(L, H, 0.1, mGlass, cx, y0 + H / 2, cz + Wd / 2 - 0.05);
        box(L + 0.3, 0.12, Wd + 0.3, mRoof, cx, y0 + H + 0.06, cz);
        box(L + 0.3, 0.1, 0.08, mOrange, cx, y0 + H + 0.02, cz - away * (Wd / 2));
        box(0.4, 0.45, 1.1, mWood, cx + jx * 0.2, y0 + 0.28, cz + away * 0.1);
        box(L - 0.6, 0.05, Wd - 0.3, mWarm, cx, y0 + H - 0.05, cz);
      }
    }
    // Platform centers + track sides per arch-kit.js station():
    // THINKABIT LAB (-23.35,3) track west; UM INNOVATION (-23.35,-30) track west;
    // RIVERFRONT (0,24.1) track south (z+); ACADEMY HQ (19.6,0) track east.
    stationHall(-23.35, 3, true, 1, 0);
    stationHall(-23.35, -30, true, 1, 0);
    stationHall(0, 24.1, false, -1, 0);
    stationHall(19.6, 0, true, -1, -1); // shifted south — stair tower lands north

    // ---- Central Interchange: ground concourse + stair tower ----
    // Ground hall tucked beside/under the Academy HQ platform (deck 7.5):
    // x[17.6,21.0] clears the HQ massing (world x>=29.6) and the C-loop
    // pylons (x=22.5); top at 5.5 clears the guideway deck above (7.2).
    (function interchange() {
      var hx = 19.3, hz = 0;
      box(3.4, 5.5, 8, mBrick, hx, 2.75, hz);                       // main hall
      box(0.1, 4.2, 7.6, mGlass, hx + 1.76, 2.6, hz);               // east glass face (track side)
      box(3.8, 0.15, 8.4, mRoof, hx, 5.57, hz);                    // roof slab
      box(3.85, 0.1, 0.12, mOrange, hx, 5.5, hz + 4.2);            // roof trim, south edge
      box(1.7, 2.4, 0.1, mGlass, hx - 0.4, 1.5, hz - 4.02);         // entrance doors, south face
      box(2.6, 0.12, 1.4, mRoof, hx - 0.4, 3.3, hz - 4.7);          // entrance canopy
      box(0.12, 3.3, 0.12, mDark, hx - 1.5, 1.65, hz - 5.2);        // canopy poles
      box(0.12, 3.3, 0.12, mDark, hx + 0.7, 1.65, hz - 5.2);
      box(3.0, 0.06, 7.4, mWarm, hx, 5.35, hz);                     // interior light strip
      totem('CENTRAL INTERCHANGE', 'FORGE LINE', hx, 6.25, hz - 2, 0);
      // stair/elevator tower: glass shaft from the concourse through the
      // hall roof, landing on the platform's north end as a bulkhead
      var tx = 19.1, tz = 3.4;
      box(1.2, 8.0, 2.0, mGlass, tx, 4.0, tz);                     // shaft
      box(1.4, 0.25, 2.2, mRoof, tx, 8.1, tz);                     // bulkhead cap
      box(1.6, 0.12, 2.2, mConcrete, tx - 0.1, 7.56, tz);          // landing slab to deck
      box(0.9, 0.08, 1.8, mAmber, tx, 7.68, tz);                   // landing edge light
    })();

    // ---- intercity transfer hall (railways.js B3) completion pass ----
    // The hall exists at (30,-4.5): ground lobby / Forge concourse (7.5) /
    // intercity concourse (11.85). This pass adds only the unfinished layer:
    // entrance doors + canopy on the west (Forge Line) face, windscreens on
    // the roof concourse, glow strips under each level, and the sign.
    (function transferCompletion() {
      var hx = 30, hz = -4.5;
      // west-face entrance (faces the Forge Line): double doors + canopy
      box(0.08, 2.4, 0.9, mGlass, hx - 3.02, 1.5, hz + 0.3);
      box(0.08, 2.4, 0.9, mGlass, hx - 3.02, 1.5, hz - 0.6);
      box(2.0, 0.12, 3.0, mRoof, hx - 4.0, 3.4, hz - 0.15);
      box(0.12, 3.4, 0.12, mDark, hx - 4.8, 1.7, hz + 1.0);
      box(0.12, 3.4, 0.12, mDark, hx - 4.8, 1.7, hz - 1.3);
      // roof intercity concourse windscreens (north + shortened east/west —
      // the south edge holds the track bumper)
      box(5.4, 1.1, 0.08, mGlass, hx, 12.45, hz + 3.0);
      box(0.08, 1.1, 5.0, mGlass, hx - 2.6, 12.45, hz + 0.5);
      box(0.08, 1.1, 5.0, mGlass, hx + 2.6, 12.45, hz + 0.5);
      // glow strips under the Forge concourse and roof concourse slabs
      box(5.4, 0.06, 0.08, mAmber, hx, 7.36, hz + 3.1);
      box(5.4, 0.06, 0.08, mAmber, hx, 11.71, hz + 3.1);
      // sign — the SERVICE stays proposed: no dates, no operators
      totem('INTERCITY TRANSFER', 'PROPOSED SERVICE', hx - 2.5, 4.7, hz, -Math.PI / 2);
    })();

    return g;
  }

  window.DAAStations = { buildStations: buildStations };
})();
