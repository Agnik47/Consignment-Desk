from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from supabase import Client, create_client

from .grader import GradeCard


class PublishError(RuntimeError):
    """Raised when the image upload or row insert fails. Callers are expected
    to catch this and fall back to the local offline queue."""


@dataclass
class PublishResult:
    image_path: str
    image_url: str
    row: dict[str, Any]


def make_client(url: str, key: str) -> Client:
    return create_client(url, key)


def storage_path(item_id: str, captured_at: datetime) -> str:
    stamp = captured_at.strftime("%Y%m%dT%H%M%S%f") + "Z"
    return f"{item_id}/{stamp}.jpg"


def publish(
    client: Client,
    bucket: str,
    table: str,
    item_id: str,
    captured_at: datetime,
    jpeg_bytes: bytes,
    grade_card: GradeCard,
) -> PublishResult:
    """Upload the JPEG to Storage, then upsert the row. Raises PublishError on
    any failure (network, auth, HTTP) -- never fails silently."""

    path = storage_path(item_id, captured_at)

    try:
        client.storage.from_(bucket).upload(
            path,
            jpeg_bytes,
            {"content-type": "image/jpeg", "x-upsert": "true"},
        )
    except Exception as exc:  # noqa: BLE001 - re-raised typed, not swallowed
        raise PublishError(f"Image upload to bucket {bucket!r} failed: {exc}") from exc

    image_url = client.storage.from_(bucket).get_public_url(path)

    row: dict[str, Any] = {
        "id": item_id,
        "captured_at": captured_at.isoformat(),
        "image_path": path,
        "image_url": image_url,
        "category": grade_card.category,
        "identified_as": grade_card.identified_as,
        "condition": grade_card.condition,
        "grader_confidence": grade_card.grader_confidence,
    }

    try:
        client.table(table).upsert(row, on_conflict="id").execute()
    except Exception as exc:  # noqa: BLE001
        raise PublishError(f"Row insert/upsert into {table!r} failed: {exc}") from exc

    return PublishResult(image_path=path, image_url=image_url, row=row)
