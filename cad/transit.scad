// Detroit Automation Academy — Forge Line vehicle prototypes
// Parametric OpenSCAD models. Units = meters. Export per-vehicle STLs:
//   openscad -D vehicle='"pod"' -o pod.stl transit.scad
// PNG renders for the site:
//   openscad -D vehicle='"pod"' -o pod.png --camera=0,0,1,65,0,30,11 --imgsize=800,600 --autocenter transit.scad

vehicle = "pod"; // pod | hauler | tender | heritage
$fn = 24;

ORANGE = [0.91, 0.36, 0.10];  // Forge Orange #E85D1A
DARK   = [0.10, 0.12, 0.14];  // Midnight
STEEL  = [0.55, 0.58, 0.62];  // Concrete
CREAM  = [0.96, 0.95, 0.92];  // Paper
GREEN  = [0.18, 0.49, 0.31];  // heritage green
AMBER  = [1.00, 0.69, 0.00];  // Amber #FFB000
GLASS  = [0.12, 0.20, 0.26];

module bogie(x, w) {
  // guideway bogie: dark truck + wheel hints
  color(DARK) {
    translate([x - 0.7, -w/2 + 0.25, 0.05]) cube([1.4, w - 0.5, 0.35]);
    for (sx = [-0.45, 0.45])
      translate([x + sx, 0, 0.22]) rotate([90, 0, 0])
        cylinder(r = 0.22, h = w - 0.6, center = true);
  }
}

// ---- 1. Forge Pod: automated passenger pod (elevated guideway) ----
module pod() {
  L = 6; W = 2.6;
  bogie(-1.9, W); bogie(1.9, W);
  color(DARK) translate([-L/2 + 0.2, -W/2 + 0.15, 0.35]) cube([L - 0.4, W - 0.3, 0.3]); // skirt
  color(ORANGE) {
    translate([-L/2, -W/2, 0.6]) cube([L, W, 1.45]);                       // hull
    translate([-L/2 + 0.6, -W/2 + 0.2, 2.05]) cube([L - 1.2, W - 0.4, 0.28]); // roof cap
  }
  color(GLASS) translate([-L/2 + 0.4, -W/2 - 0.03, 1.25]) cube([L - 0.8, W + 0.06, 0.62]); // window band
  color(DARK) {
    translate([0.8, 0, 2.33]) cylinder(r = 0.16, h = 0.18);                // sensor mast
    translate([0.8, 0, 2.55]) sphere(r = 0.14);                            // sensor dome
  }
  color(AMBER) translate([-L/2 - 0.02, -0.5, 1.0]) cube([0.06, 1.0, 0.3]);  // tail light bar
  color([1, 0.95, 0.8]) translate([L/2 - 0.04, -0.5, 1.0]) cube([0.06, 1.0, 0.3]); // headlight bar
}

// ---- 2. Forge Hauler: cargo pod (equipment & materials) ----
module hauler() {
  L = 5; W = 2.6;
  bogie(-1.5, W); bogie(1.5, W);
  color(DARK) translate([-L/2 + 0.2, -W/2 + 0.15, 0.35]) cube([L - 0.4, W - 0.3, 0.3]);
  color(STEEL) translate([-L/2, -W/2, 0.6]) cube([L, W, 2.1]);             // cargo box
  color(ORANGE) translate([-L/2 - 0.02, -W/2 - 0.02, 1.5]) cube([L + 0.04, W + 0.04, 0.35]); // livery stripe
  color(DARK) {                                                            // cargo doors (both sides)
    for (s = [-1, 1])
      translate([-1.6, s * (W/2 - 0.02), 0.9]) cube([3.2, 0.06, 1.5]);
  }
  color(STEEL) translate([-L/2 + 0.4, -W/2 + 0.4, 2.7]) cube([L - 0.8, W - 0.8, 0.12]); // roof panel
  color(DARK) translate([L/2 - 0.9, 0, 2.82]) cylinder(r = 0.12, h = 0.14); // roof vent
}

// ---- 3. Line Tender: guideway inspection & maintenance rig ----
module tender() {
  L = 4; W = 2.4;
  bogie(-1.2, W); bogie(1.2, W);
  color(DARK) translate([-L/2, -W/2, 0.55]) cube([L, W, 0.25]);            // flatbed
  color(ORANGE) translate([L/2 - 1.3, -W/2 + 0.15, 0.8]) cube([1.15, W - 0.3, 0.95]); // cab
  color(GLASS) translate([L/2 - 1.25, -W/2 + 0.3, 1.25]) cube([0.5, W - 0.6, 0.4]);   // cab window
  color(AMBER) translate([L/2 - 0.75, 0, 1.85]) sphere(r = 0.11);          // beacon
  color(STEEL) {                                                           // sensor mast
    translate([-L/2 + 0.5, 0, 0.8]) cylinder(r = 0.07, h = 2.1);
    translate([-L/2 + 0.5, 0, 2.9]) cube([0.5, 0.3, 0.22], center = true); // sensor head
  }
  color(ORANGE) {                                                          // work-platform railing
    for (x = [-L/2 + 0.2 : 0.6 : L/2 - 1.6], s = [-1, 1])
      translate([x, s * (W/2 - 0.08), 0.8]) cylinder(r = 0.03, h = 0.9);
    for (s = [-1, 1])
      translate([-L/2 + 0.2, s * (W/2 - 0.08), 1.66]) cube([L - 1.8, 0.06, 0.06]);
  }
  color(DARK) translate([-L/2 + 0.3, -0.7, 0.8]) cube([0.9, 1.4, 0.5]);    // toolbox
}

// ---- 4. Heritage Car: Phase-2 at-grade streetcar (QLINE homage) ----
module heritage() {
  L = 8; W = 2.5;
  color(DARK) {                                                            // trucks + wheels
    for (x = [-2.4, 2.4]) {
      translate([x - 0.8, -W/2 + 0.3, 0.15]) cube([1.6, W - 0.6, 0.3]);
      for (sx = [-0.5, 0.5])
        translate([x + sx, 0, 0.32]) rotate([90, 0, 0])
          cylinder(r = 0.32, h = W - 0.7, center = true);
    }
  }
  color(CREAM) translate([-L/2, -W/2, 0.55]) cube([L, W, 1.9]);            // body
  color(GREEN) {                                                           // window band + roof
    translate([-L/2 + 0.3, -W/2 - 0.03, 1.5]) cube([L - 0.6, W + 0.06, 0.7]);
    translate([-L/2, -W/2, 2.45]) cube([L, W, 0.28]);
    translate([-L/2 + 1.5, -W/2 + 0.5, 2.73]) cube([L - 3, W - 1, 0.35]);   // clerestory
  }
  color(GLASS) translate([-L/2 + 1.7, -W/2 + 0.62, 2.78]) cube([L - 3.4, W - 1.24, 0.22]);
  color(DARK) {                                                            // trolley pole
    translate([0.5, 0, 2.9]) rotate([0, -32, 0]) cylinder(r = 0.035, h = 2.6);
  }
  color(AMBER) translate([L/2 - 0.05, 0, 1.1]) sphere(r = 0.14);           // headlamp
  color(CREAM) translate([-L/2 - 0.25, -0.9, 0.55]) cube([0.25, 1.8, 0.5]); // pilot (cowcatcher hint)
}

// ---------- vehicle selector ----------
if (vehicle == "pod") { pod(); }
else if (vehicle == "hauler") { hauler(); }
else if (vehicle == "tender") { tender(); }
else if (vehicle == "heritage") { heritage(); }
