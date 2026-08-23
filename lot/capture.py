from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .camera import CameraError, Frame, USBCamera
from .config import ConfigError, Settings, load_settings
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


@dataclass
class CaptureResult:
    """Outcome of one capture_and_publish() call. Shared by the CLI (capture.py's
    main()) and the HTTP trigger (api.py), so both report the same facts instead
    of the HTTP layer re-deriving them."""

    item_id: str
    local_path: Path
    grade_card: GradeCard
    image_url: str | None  # None when queued (upload failed) or dry_run
    row: dict[str, Any] | None  # None when queued or dry_run
    queued: bool
    queue_error: str | None = None  # set when queued: why the upload failed

    def to_dict(self) -> dict[str, Any]:
        return {
            "item_id": self.item_id,
            "local_path": str(self.local_path),
            "grade_card": self.grade_card.to_dict(),
            "image_url": self.image_url,
            "row": self.row,
            "queued": self.queued,
            "queue_error": self.queue_error,
        }


def capture_and_publish(settings: Settings, item_id: str, dry_run: bool = False) -> CaptureResult:
    """Capture a still, grade it, save it locally, and (unless dry_run) upload
    it. Raises CameraError/GraderError on hard failures -- nothing was queued
    because nothing usable was produced. A publish failure is not raised: it's
    reported back as CaptureResult(queued=True) and durably queued for `flush`,
    since the capture itself already succeeded and shouldn't be lost.
    """
    captured_at = datetime.now(timezone.utc)

    with USBCamera(
        settings.camera_device, settings.camera_width, settings.camera_height, settings.warmup_frames
    ) as camera:
        frame: Frame = camera.read()

    grader = GroqGrader(api_key=settings.groq_api_key, model=settings.groq_model)
    grade_card = grader.grade(frame, item_id)

    jpeg_bytes = frame.to_jpeg_bytes(settings.jpeg_quality)
    local_path = _save_local(settings.captures_dir, item_id, captured_at, jpeg_bytes, grade_card)

    if dry_run:
        return CaptureResult(
            item_id=item_id, local_path=local_path, grade_card=grade_card, image_url=None, row=None, queued=False
        )

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
        return CaptureResult(
            item_id=item_id,
            local_path=local_path,
            grade_card=grade_card,
            image_url=None,
            row=None,
            queued=True,
            queue_error=str(exc),
        )

    return CaptureResult(
        item_id=item_id,
        local_path=local_path,
        grade_card=grade_card,
        image_url=result.image_url,
        row=result.row,
        queued=False,
    )


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

    try:
        result = capture_and_publish(settings, item_id, dry_run=args.dry_run)
    except CameraError as exc:
        print(f"Camera error: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except GraderError as exc:
        print(f"Grading error: {exc}", file=sys.stderr)
        return EXIT_ERROR

    print(f"Local file: {result.local_path}")
    print("Grade card:")
    print(result.grade_card.to_json())

    if args.dry_run:
        print("\nDry run: not uploaded.")
        return EXIT_OK

    if result.queued:
        print(f"\nUpload failed: {result.queue_error}", file=sys.stderr)
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
