from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Any, Protocol

from .camera import Frame


class GraderError(RuntimeError):
    """Raised when the grader can't produce a GradeCard (API failure, or a
    response that isn't usable JSON even after a retry). Never swallowed
    silently -- callers decide whether to fail the capture."""


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


_GROQ_SYSTEM_PROMPT = """You are an item identification and condition grading assistant for a \
secondhand consignment shop. You are shown one photo of a single collectible item (e.g. a \
die-cast model car, trading card, action figure, comic book, vinyl record, or similar). \
Identify what it is as specifically as you can, and assess its physical condition from the \
photo alone.

Respond with ONLY a single JSON object, no prose, no markdown fences, matching exactly this shape:

{
  "category": string,          // short category label, e.g. "die-cast 1:64", "trading card",
                                // "action figure", "comic book", "vinyl record"; use your best
                                // judgement if the item doesn't fit a common category
  "identified_as": string,     // specific identification: brand, model/character, set, year,
                                // edition -- whatever is visible or inferable
  "condition": {
    "box_present": boolean,          // is original packaging/box visible in frame?
    "box_damage": string,            // describe box condition, or "n/a - no box"
    "paint_wear": string,             // describe paint/print/surface wear, or "none visible"
    "completeness": string,          // "appears complete", or note what looks missing
    "visible_defects": integer       // rough count of distinct visible defects (0 if none)
  },
  "grader_confidence": number   // your confidence in this identification, 0.0 to 1.0
}

Base grader_confidence on how clearly the item and its identifying details are visible in the \
photo -- lower it for blur, glare, partial framing, or an item you can't confidently identify."""


class GroqGrader:
    """Real vision-model grader: sends the captured frame to a Groq-hosted
    multimodal model and turns its structured JSON response into a GradeCard.

    Implements the same Grader Protocol as StubGrader -- capture.py just
    swaps which one it constructs.
    """

    def __init__(self, api_key: str, model: str, max_retries: int = 1):
        from groq import Groq  # deferred: keeps the dependency optional for stub-only use

        self._client = Groq(api_key=api_key)
        self._model = model
        self._max_retries = max_retries

    def _ask_groq(self, jpeg_bytes: bytes) -> str:
        image_b64 = base64.b64encode(jpeg_bytes).decode("ascii")
        try:
            response = self._client.chat.completions.create(
                model=self._model,
                temperature=0.2,
                max_completion_tokens=1024,
                # qwen3.6-27b is a reasoning model: left at its default, hidden
                # chain-of-thought competes with response_format for the token
                # budget and reliably produces empty/invalid JSON on harder
                # images. Turning reasoning off entirely is what makes
                # response_format=json_object reliable here (verified 10/10
                # across live + static test images vs. ~50% failure with
                # reasoning on, even with reasoning_format="hidden").
                reasoning_effort="none",
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": _GROQ_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": "Identify and grade the item in this photo."},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                            },
                        ],
                    },
                ],
            )
        except Exception as exc:  # noqa: BLE001 - re-raised typed, not swallowed
            raise GraderError(f"Groq API request failed: {exc}") from exc

        content = response.choices[0].message.content
        if not content:
            raise GraderError("Groq response had no content.")
        return content

    @staticmethod
    def _parse(content: str, item_id: str) -> GradeCard:
        content = content.strip()
        if content.startswith("```"):
            # Defensive: strip a ```json ... ``` fence if the model adds one
            # despite response_format=json_object and the "ONLY a JSON object"
            # instruction.
            content = content.strip("`")
            if content.startswith("json"):
                content = content[4:]
            content = content.strip()

        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise GraderError(f"Groq response was not valid JSON: {exc}") from exc

        try:
            condition = data["condition"]
            grade_card = GradeCard(
                item_id=item_id,
                category=str(data["category"]),
                identified_as=str(data["identified_as"]),
                condition={
                    "box_present": bool(condition["box_present"]),
                    "box_damage": str(condition["box_damage"]),
                    "paint_wear": str(condition["paint_wear"]),
                    "completeness": str(condition["completeness"]),
                    "visible_defects": int(condition["visible_defects"]),
                },
                grader_confidence=max(0.0, min(1.0, float(data["grader_confidence"]))),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise GraderError(f"Groq response JSON was missing/malformed fields: {exc}") from exc

        return grade_card

    def grade(self, frame: Frame, item_id: str) -> GradeCard:
        jpeg_bytes = frame.to_jpeg_bytes()

        last_error: GraderError | None = None
        for attempt in range(self._max_retries + 1):
            try:
                content = self._ask_groq(jpeg_bytes)
                return self._parse(content, item_id)
            except GraderError as exc:
                last_error = exc

        assert last_error is not None
        raise last_error
