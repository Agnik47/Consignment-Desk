from __future__ import annotations

import json
import sys

from .config import ConfigError, load_settings
from .publish import PublishError, make_client, publish
from .queue import UploadQueue


def main(argv: list[str] | None = None) -> int:
    try:
        settings = load_settings(require_supabase=True)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    queue = UploadQueue(settings.queue_db_path)
    pending = queue.list_pending()

    if not pending:
        print("Queue is empty. Nothing to flush.")
        queue.close()
        return 0

    print(f"{len(pending)} queued capture(s) found. Retrying...\n")

    client = make_client(settings.supabase_url, settings.supabase_key)
    succeeded = 0
    failed = 0

    for entry in pending:
        print(f"[{entry.item_id}] attempt #{entry.attempts + 1} ...", end=" ")

        if not entry.local_image_path.exists():
            msg = f"local image file missing: {entry.local_image_path}"
            print(f"FAILED ({msg})")
            queue.mark_failed(entry.id, msg)
            failed += 1
            continue

        jpeg_bytes = entry.local_image_path.read_bytes()
        try:
            result = publish(
                client=client,
                bucket=settings.bucket,
                table=settings.table,
                item_id=entry.item_id,
                captured_at=entry.captured_at,
                jpeg_bytes=jpeg_bytes,
                grade_card=entry.grade_card,
            )
        except PublishError as exc:
            print(f"FAILED ({exc})")
            queue.mark_failed(entry.id, str(exc))
            failed += 1
            continue

        print("OK")
        print(f"  Storage URL: {result.image_url}")
        print(f"  Inserted row: {json.dumps(result.row)}")
        queue.remove(entry.id)
        succeeded += 1

    queue.close()
    print(f"\nDone. {succeeded} uploaded, {failed} still queued.")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
