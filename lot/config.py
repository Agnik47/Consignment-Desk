from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or invalid."""


@dataclass(frozen=True)
class Settings:
    supabase_url: str | None
    supabase_key: str | None
    bucket: str
    table: str
    camera_device: str
    camera_width: int
    camera_height: int
    warmup_frames: int
    jpeg_quality: int
    data_dir: Path

    @property
    def captures_dir(self) -> Path:
        return self.data_dir / "captures"

    @property
    def queue_db_path(self) -> Path:
        return self.data_dir / "queue.db"


def load_settings(require_supabase: bool = True) -> Settings:
    """Load settings from environment / .env. Raises ConfigError with a readable
    message if something required for the current operation is missing."""
    load_dotenv()

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if require_supabase:
        missing = [
            name
            for name, val in (
                ("SUPABASE_URL", supabase_url),
                ("SUPABASE_SERVICE_ROLE_KEY", supabase_key),
            )
            if not val
        ]
        if missing:
            raise ConfigError(
                "Missing required environment variable(s): "
                + ", ".join(missing)
                + ". Copy .env.example to .env and fill them in."
            )

    try:
        camera_width = int(os.getenv("LOT_CAMERA_WIDTH", "1920"))
        camera_height = int(os.getenv("LOT_CAMERA_HEIGHT", "1080"))
        warmup_frames = int(os.getenv("LOT_WARMUP_FRAMES", "20"))
        jpeg_quality = int(os.getenv("LOT_JPEG_QUALITY", "92"))
    except ValueError as exc:
        raise ConfigError(f"A numeric env var was set to a non-integer value: {exc}") from exc

    return Settings(
        supabase_url=supabase_url,
        supabase_key=supabase_key,
        bucket=os.getenv("SUPABASE_BUCKET", "item-images"),
        table=os.getenv("SUPABASE_TABLE", "items"),
        camera_device=os.getenv("LOT_CAMERA_DEVICE", "/dev/video0"),
        camera_width=camera_width,
        camera_height=camera_height,
        warmup_frames=warmup_frames,
        jpeg_quality=jpeg_quality,
        data_dir=Path(os.getenv("LOT_DATA_DIR", "./lot_data")),
    )
