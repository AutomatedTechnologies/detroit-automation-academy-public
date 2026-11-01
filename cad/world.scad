// Detroit Automation Academy — Training District, world v1
// Parametric OpenSCAD model. Export per-part STLs for the web viewer:
//   openscad -D part='"bot"' -o bot.stl world.scad
// Units ~ meters. Ground plane 130 x 130, top surface at z = 0.

part = "all";
$fn = 24;

// ---------- layout constants (mirrored in the web viewer) ----------
PLAZA = 34;          // central plaza half-size... (square, centered)
ROAD_W = 8;
GX = 65;             // ground half-size

// building centers: [x, y]
C_WORKSHOP   = [0, 0];
C_TECHTOWN   = [0, 44];
C_STATION    = [44, 0];
C_RIVERFRONT = [0, -44];
C_THINKABIT  = [-44, 0];

// ---------- ground ----------
module ground() {
  color("ground")
  translate([-GX, -GX, -2]) cube([2*GX, 2*GX, 2]);
}

module roads() {
  // four spokes from plaza edge to ground edge
  for (a = [0, 90, 180, 270])
    rotate([0, 0, a])
      translate([-ROAD_W/2, PLAZA/2, 0]) cube([ROAD_W, GX - PLAZA/2, 0.35]);
  // plaza pad
  translate([-PLAZA/2, -PLAZA/2, 0]) cube([PLAZA, PLAZA, 0.35]);
}

module water() {
  // river strip along the south edge
  translate([-GX, -GX, 0]) cube([2*GX, 12, 0.5]);
}

// ---------- buildings ----------
module workshop() {
  w = 26; d = 20; h = 10;
  translate([C_WORKSHOP[0] - w/2, C_WORKSHOP[1] - d/2, 0]) {
    cube([w, d, h]);
    // sawtooth roof: three teeth (triangular profile rising in z, running along y)
    for (i = [0:2])
      translate([i * w/3, d, h])
        rotate([90, 0, 0])
          linear_extrude(height = d)
            polygon(points = [[0,0], [w/3,0], [w/3,4.5]]);
    // entrance: roll-up freight door (4 x 4.5) + pedestrian door (1.2 x 2.4)
    // — human scale for a 1.1 m bot (the old single 6 x 7 door was oversized)
    translate([w/2 - 2, -0.4, 0]) cube([4, 0.8, 4.5]);          // roll-up door
    for (z = [0.75 : 0.75 : 3.75])
      translate([w/2 - 2, -0.45, z]) cube([4, 0.1, 0.08]);      // slat hints
    translate([w/2 + 3.2, -0.4, 0]) cube([1.2, 0.8, 2.4]);      // pedestrian door
    translate([w/2 + 2.9, -0.9, 2.4]) cube([1.8, 1.0, 0.15]);   // canopy
    // chimney — workshop-stack scale, not a smokestack 80% of building height
    translate([w - 5, d/2, h + 1]) cylinder(r = 0.6, h = 3.5);
    // window band
    translate([-0.3, 3, 6]) cube([0.6, d - 6, 2]);
  }
}

module techtown() {
  // tower + annex
  translate([C_TECHTOWN[0] - 10, C_TECHTOWN[1] - 10, 0]) {
    cube([20, 20, 30]);
    // window strips (thin, proud)
    for (z = [6:6:24])
      translate([-0.3, 2, z]) cube([0.6, 16, 1.6]);
    // annex
    translate([20, 4, 0]) cube([12, 12, 9]);
    // roof crown
    translate([7, 7, 30]) cube([6, 6, 3]);
  }
}

module station() {
  // long hall + half-cylinder roof (Michigan Central nod)
  translate([C_STATION[0] - 17, C_STATION[1] - 9, 0]) {
    cube([34, 18, 8]);
    // barrel roof: half-cylinder riding on top of the walls
    translate([-2, 9, 8])
      intersection() {
        rotate([0, 90, 0]) cylinder(r = 9, h = 38);
        translate([0, -9, 0]) cube([38, 18, 9]);
      }
    // entrance block + human-scale doorway (the 6x3x6 block was a blank mass)
    translate([14, -2.5, 0]) cube([6, 3, 6]);
    translate([16.3, -2.9, 0]) cube([2.4, 0.8, 3.2]);            // doorway, proud of face
    for (sx = [-1, 1])
      translate([16.3 + sx*1.9, -2.9, 0.4]) cube([0.8, 0.8, 2.4]); // sidelights
    translate([15.9, -3.4, 3.2]) cube([3.2, 1.2, 0.15]);          // canopy
    // column hints along the face
    for (x = [2:6:32])
      translate([x, -0.4, 0]) cube([1.2, 0.8, 8]);
  }
}

module riverfront() {
  // open pavilion: columns + roof slab
  translate([C_RIVERFRONT[0] - 11, C_RIVERFRONT[1] - 8, 0]) {
    for (sx = [-1, 1], sy = [-1, 1])
      translate([sx*9, sy*6, 0]) cylinder(r = 0.35, h = 7);   // columns — slender (were 1.8 m across)
    translate([-11, -8, 7]) cube([22, 16, 1.6]);
    // bench blocks — seat height (~0.5 m), not wall height (bot is 1.1 m)
    translate([-6, -2, 0]) {
      for (lx = [0.3, 5.35, 10.85])
        translate([lx, 0.15, 0]) cube([0.5, 0.9, 0.38]);   // legs
      translate([0, 0, 0.38]) cube([12, 1.2, 0.12]);       // seat slab
    }
  }
}

module thinkabit() {
  translate([C_THINKABIT[0] - 12, C_THINKABIT[1] - 9, 0]) {
    cube([24, 18, 9]);
    // accent fin wall
    translate([-1.2, 2, 0]) cube([1.6, 14, 13]);
    // skylight strips
    for (x = [4:8:20])
      translate([x, -0.3, 5]) cube([3, 0.6, 2]);
  }
}

// ---------- props ----------
module trees() {
  spots = [[-30, 30], [28, 26], [-28, -30], [30, -32], [-52, 18], [52, -20], [18, 54], [-20, -54]];
  for (s = spots)
    translate([s[0], s[1], 0]) {
      cylinder(r1 = 0.5, r2 = 0.4, h = 3.5);
      translate([0, 0, 3.2]) cylinder(r1 = 0.15, r2 = 2.6, h = 6);
    }
}

module street() {
  // lamp posts along each spoke — human scale (was 8 m poles with 1.4 m globes)
  for (a = [0, 90, 180, 270], d = [24:14:58])
    rotate([0, 0, a])
      translate([ROAD_W/2 + 1.6, d, 0]) {
        cylinder(r = 0.14, h = 6);
        translate([-0.9, 0, 6]) rotate([0, 90, 0]) cylinder(r = 0.08, h = 1.8, center = true);
        translate([-1.8, 0, 6]) sphere(r = 0.28, $fn = 12);
      }
  // crates near the workshop
  translate([14, 10, 0]) cube([2.4, 2.4, 2.4]);
  translate([16.8, 10.4, 0]) cube([1.8, 1.8, 1.8]);
  translate([14.6, 12.8, 0]) cube([1.6, 1.6, 1.6]);
}

// ---------- the bot (training robot, matches the SVG silhouette) ----------
// Real-world scale: ~1.1 m tall service robot (was 12 m in v1 — building
// sized; rescaled 2026-09-30 for the scale-realism pass).
module bot() {
  // wheels
  for (sx = [-1, 1])
    translate([sx * 0.242, 0, 0.149]) rotate([90, 0, 0]) cylinder(r = 0.149, h = 0.102, center = true);
  // body
  translate([-0.298, -0.195, 0.223]) cube([0.595, 0.391, 0.316]);
  // chest panel
  translate([-0.112, 0.20, 0.316]) cube([0.223, 0.028, 0.167]);
  // arms
  for (sx = [-1, 1])
    translate([sx * 0.363, -0.047, 0.298]) cube([0.093, 0.093, 0.335]);
  // head
  translate([-0.242, -0.177, 0.540]) cube([0.484, 0.353, 0.316]);
  // eyes
  for (sx = [-1, 1])
    translate([sx * 0.121, 0.181, 0.688]) sphere(r = 0.060, $fn = 12);
  // antenna
  translate([0, 0, 0.856]) cylinder(r = 0.017, h = 0.205);
  translate([0, 0, 1.079]) sphere(r = 0.051, $fn = 12);
}

// ---------- part selector ----------
if (part == "all") {
  ground(); roads(); water();
  workshop(); techtown(); station(); riverfront(); thinkabit();
  trees(); street();
} else if (part == "ground") {
  ground();
} else if (part == "roads") {
  roads();
} else if (part == "water") {
  water();
} else if (part == "workshop") {
  workshop();
} else if (part == "techtown") {
  techtown();
} else if (part == "station") {
  station();
} else if (part == "riverfront") {
  riverfront();
} else if (part == "thinkabit") {
  thinkabit();
} else if (part == "trees") {
  trees();
} else if (part == "street") {
  street();
} else if (part == "bot") {
  bot();
}
