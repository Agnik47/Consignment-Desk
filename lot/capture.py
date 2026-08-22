from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .camera import CameraError, Frame, USBCamera
from .config import ConfigError, load_settings
from .grader import GradeCard, GraderError, GroqGrader
from .publish import PublishError, make_client, publish
from .queue import UploadQueue

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_QUEUED = 2


def _save_local(captures_dir: Path, item_id: str, captured_at: datetime, jpeg_bytes: bytes, grade_card: GradeCard) -> Path:
    captures_dir.mkdir(parents=True, exist_ok=True)
    stamp = captured_at.strftime("%Y%m%dT%H%M%S%f") + "Z"
    base = captures_dir / f"{item_id}_{stamp}"
    image_path = base.with_suffix(".jpg")
    json_path = base.with_suffix(".json")
    image_path.write_bytes(jpeg_bytes)
    json_path.write_text(grade_card.to_json())
    return image_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m lot.capture",
        description="Capture a still from the USB camera, grade it, and publish it to Supabase.",
    )
    parser.add_argument("--item-id", help="Item id, e.g. LOT-001. Required unless --dry-run.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Capture and grade only; save locally and skip the upload entirely.",
    )
    args = parser.parse_args(argv)

    item_id = args.item_id
    if not item_id:
        if args.dry_run:
            item_id = "DRYRUN-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
        else:
            parser.error("--item-id is required unless --dry-run is set")

    try:
        settings = load_settings(require_supabase=not args.dry_run)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    captured_at = datetime.now(timezone.utc)

    try:
        with USBCamera(
            settings.camera_device, settings.camera_width, settings.camera_height, settings.warmup_frames
        ) as camera:
            frame: Frame = camera.read()
    except CameraError as exc:
        print(f"Camera error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    grader = GroqGrader(api_key=settings.groq_api_key, model=settings.groq_model)
    try:
        grade_card = grader.grade(frame, item_id)
    except GraderError as exc:
        print(f"Grading error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    jpeg_bytes = frame.to_jpeg_bytes(settings.jpeg_quality)

    local_path = _save_local(settings.captures_dir, item_id, captured_at, jpeg_bytes, grade_card)
    print(f"Local file: {local_path}")
    print("Grade card:")
    print(grade_card.to_json())

    if args.dry_run:
        print("\nDry run: not uploaded.")
        return EXIT_OK

    try:
        client = make_client(settings.supabase_url, settings.supabase_key)
        result = publish(
            client=client,
            bucket=settings.bucket,
            table=settings.table,
            item_id=item_id,
            captured_at=captured_at,
            jpeg_bytes=jpeg_bytes,
            grade_card=grade_card,
        )
    except PublishError as exc:
        queue = UploadQueue(settings.queue_db_path)
        queue.enqueue(item_id, captured_at, local_path, grade_card)
        queue.close()
        print(f"\nUpload failed: {exc}", file=sys.stderr)
        print(
            f"Capture is safe -- queued at {settings.queue_db_path}. "
            f"Run `python -m lot.flush` once you're back online.",
            file=sys.stderr,
        )
        return EXIT_QUEUED

    print(f"\nStorage URL: {result.image_url}")
    print("Inserted row:")
    print(json.dumps(result.row, indent=2))
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
