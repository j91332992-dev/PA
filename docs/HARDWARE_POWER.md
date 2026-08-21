# Power design

Rod stack, from outside inward: continuous +5 V copper foil, Kapton insulation, metal rod GND. Place the fuse at the main +5 V input. Two positive pogos are parallel for contact resilience, not separate rails.

Initial 5 V/3 A charger is only for 3-5 prototype hangers. Size final supply using measured worst-case hanger current × concurrent hangers + gateway + margin. Measure voltage at rod start/end with 5/10/25/50 loads; add injection/feed points or zones if needed. `REQUIRES_PHYSICAL_TEST`.
