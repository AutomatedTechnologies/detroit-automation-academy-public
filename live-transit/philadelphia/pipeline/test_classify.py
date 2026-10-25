#!/usr/bin/env python3
"""test_classify.py — §5 classification unit checks (KAES-25).

PHL REBUILD R2. Label: UNVERIFIED / legacy-unsigned.

The live SEPTA VP feed carries either a full TripDescriptor or
none at all (verified against the reference bindings on the
2026-10-24 polls), so a live poll exercises TRIP-MATCHED and
UNASSIGNED but not ROUTE-MATCHED. These synthetic cases prove
all three classes against the real static sets, including the
"_OWL" route variant measured on the live feed.

Run: python3 test_classify.py   (exit 0 = pass)
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from classify import StaticSets  # noqa: E402

GTFS = Path(__file__).resolve().parent.parent.parent / "gtfs"

CASES = [
    # (family, trip_id, route_id, expected_class, expected_unresolved)
    ("bus", "896106", "L1_OWL", "TRIP-MATCHED", False),
    ("bus", "999999999", "21", "ROUTE-MATCHED", True),
    ("bus", None, "L1_OWL", "ROUTE-MATCHED", False),
    ("bus", None, None, "UNASSIGNED", False),
    ("bus", None, "NOPE", "UNASSIGNED", False),
    ("rail", "AIR4584_20261019_SID189798", "AIR", "TRIP-MATCHED", False),
    ("rail", None, "PAO", "ROUTE-MATCHED", False),
]


def main():
    s = StaticSets()
    s.load("bus", GTFS / "google_bus.zip")
    s.load("rail", GTFS / "google_rail.zip")
    fails = 0
    for family, trip_id, route_id, want, want_unres in CASES:
        got, unres = s.classify(family, trip_id, route_id)
        ok = got == want and unres == want_unres
        fails += 0 if ok else 1
        print(
            f"{'PASS' if ok else 'FAIL'}  {family} trip={trip_id} "
            f"route={route_id} -> {got} (unresolved={unres})"
        )
    print(f"\n{len(CASES) - fails}/{len(CASES)} cases PASS")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
