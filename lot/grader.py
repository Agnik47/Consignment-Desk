from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any, Protocol

from .camera import Frame


@dataclass
class GradeCard:
    item_id: str
    category: str
    identified_as: str
    condition: dict[str, Any]
    grader_confidence: float

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int | None = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)


class Grader(Protocol):
    """Anything that can turn a captured frame into a GradeCard.

    StubGrader below is the only implementation for Feature 1. The real vision
    model implements this same Protocol later; capture.py never has to change.
    """

    def grade(self, frame: Frame, item_id: str) -> GradeCard: ...


class StubGrader:
    """Deterministic fake grader: the same item_id always produces the same
    GradeCard, so runs are reproducible for testing without a real model."""

    _CATEGORIES = ["die-cast 1:64", "trading card", "action figure", "comic book", "vinyl record"]
    _MODELS = {
        "die-cast 1:64": ["Hot Wheels '67 Camaro", "Matchbox Ford Transit", "Tomica Nissan Skyline"],
        "trading card": ["1993 Topps rookie card", "1999 Pokemon holo", "2001 Upper Deck insert"],
        "action figure": ["Kenner Star Wars figure", "McFarlane sports figure", "G.I. Joe 3.75in"],
        "comic book": ["Silver age superhero issue", "Independent black-and-white one-shot"],
        "vinyl record": ["70s rock LP", "80s soundtrack pressing"],
    }
    _BOX_DAMAGE = ["none", "minor crushing, one corner", "shelf wear, edges soft", "torn window flap"]
    _PAINT_WEAR = ["none visible", "light wear on high points", "visible chips on edges"]
    _COMPLETENESS = ["appears complete", "missing one accessory", "missing packaging insert"]

    def grade(self, frame: Frame, item_id: str) -> GradeCard:
        digest = hashlib.sha256(item_id.encode("utf-8")).digest()

        category = self._CATEGORIES[digest[0] % len(self._CATEGORIES)]
        models = self._MODELS[category]
        identified_as = models[digest[1] % len(models)]
        box_present = digest[2] % 5 != 0
        box_damage = self._BOX_DAMAGE[digest[3] % len(self._BOX_DAMAGE)] if box_present else "n/a - no box"
        paint_wear = self._PAINT_WEAR[digest[4] % len(self._PAINT_WEAR)]
        completeness = self._COMPLETENESS[digest[5] % len(self._COMPLETENESS)]
        visible_defects = digest[6] % 4
        confidence = round(0.65 + (digest[7] / 255) * 0.30, 2)

        condition = {
            "box_present": box_present,
            "box_damage": box_damage,
            "paint_wear": paint_wear,
            "completeness": completeness,
            "visible_defects": visible_defects,
        }

        return GradeCard(
            item_id=item_id,
            category=category,
            identified_as=identified_as,
            condition=condition,
            grader_confidence=confidence,
        )
