from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .grader import GradeCard

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    local_image_path TEXT NOT NULL,
    grade_card_json TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
"""


@dataclass
class QueueEntry:
    id: int
    item_id: str
    captured_at: datetime
    local_image_path: Path
    grade_card: GradeCard
    attempts: int
    last_error: str | None


class UploadQueue:
    """Local SQLite durable queue. A capture that can't reach Supabase lands
    here instead of being lost; `flush` retries everything in it."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._conn.execute(_SCHEMA)
        self._conn.commit()

    def enqueue(self, item_id: str, captured_at: datetime, local_image_path: Path, grade_card: GradeCard) -> int:
        cur = self._conn.execute(
            "INSERT INTO pending_uploads "
            "(item_id, captured_at, local_image_path, grade_card_json, enqueued_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                item_id,
                captured_at.isoformat(),
                str(local_image_path),
                grade_card.to_json(indent=None),
                datetime.now(timezone.utc).isoformat(),
            ),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def list_pending(self) -> list[QueueEntry]:
        rows = self._conn.execute(
            "SELECT id, item_id, captured_at, local_image_path, grade_card_json, attempts, last_error "
            "FROM pending_uploads ORDER BY id ASC"
        ).fetchall()
        entries = []
        for r in rows:
            entries.append(
                QueueEntry(
                    id=r[0],
                    item_id=r[1],
                    captured_at=datetime.fromisoformat(r[2]),
                    local_image_path=Path(r[3]),
                    grade_card=GradeCard(**json.loads(r[4])),
                    attempts=r[5],
                    last_error=r[6],
                )
            )
        return entries

    def mark_failed(self, entry_id: int, error: str) -> None:
        self._conn.execute(
            "UPDATE pending_uploads SET attempts = attempts + 1, last_error = ? WHERE id = ?",
            (error, entry_id),
        )
        self._conn.commit()

    def remove(self, entry_id: int) -> None:
        self._conn.execute("DELETE FROM pending_uploads WHERE id = ?", (entry_id,))
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()
