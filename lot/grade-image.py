from __future__ import annotations

import argparse
import sys
from pathlib import Path

import cv2

from .camera import Frame
from .config import ConfigError, load_settings
from .grader import GraderError, GroqGrader


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m lot.grade-image",
        description="Run the Groq grader on an existing image file. No camera or Supabase needed.",
    )
    parser.add_argument("image_path", type=Path, help="Path to a JPEG/PNG photo of a single item.")
    parser.add_argument("--item-id", default="TEST-IMAGE", help="Item id to tag the grade card with.")
    args = parser.parse_args(argv)

    if not args.image_path.exists():
        print(f"No such file: {args.image_path}", file=sys.stderr)
        return 1

    image = cv2.imread(str(args.image_path))
    if image is None:
        print(f"Could not decode image: {args.image_path}", file=sys.stderr)
        return 1
    height, width = image.shape[:2]
    frame = Frame(image=image, width=width, height=height, captured_at=0.0)

    try:
        settings = load_settings(require_supabase=False)
    except ConfigError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    grader = GroqGrader(api_key=settings.groq_api_key, model=settings.groq_model)
    try:
        grade_card = grader.grade(frame, args.item_id)
    except GraderError as exc:
        print(f"Grading error: {exc}", file=sys.stderr)
        return 1

    print(grade_card.to_json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
