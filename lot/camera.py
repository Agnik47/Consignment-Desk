from __future__ import annotations

import glob
import time
from dataclasses import dataclass
from typing import Optional, Protocol

import cv2
import numpy as np


class CameraError(RuntimeError):
    """Raised for any camera open/read/close failure. Never swallowed silently."""


@dataclass
class Frame:
    """A single captured frame plus its metadata."""

    image: np.ndarray  # BGR, HxWx3 uint8
    width: int
    height: int
    captured_at: float  # unix epoch seconds

    def to_jpeg_bytes(self, quality: int = 92) -> bytes:
        ok, buf = cv2.imencode(".jpg", self.image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if not ok:
            raise CameraError("Failed to encode captured frame as JPEG.")
        return buf.tobytes()


class Camera(Protocol):
    """Minimal camera interface.

    A future MJPEG streaming consumer (Feature 2) reads frames in a loop against
    this same interface -- no rewrite needed, just a new implementation or a new
    caller of read().
    """

    def open(self) -> None: ...

    def read(self) -> Frame: ...

    def close(self) -> None: ...


class USBCamera:
    """V4L2 USB camera, accessed via OpenCV."""

    def __init__(self, device: str, width: int, height: int, warmup_frames: int = 20):
        self.device = device
        self.width = width
        self.height = height
        self.warmup_frames = warmup_frames
        self._cap: Optional[cv2.VideoCapture] = None

    def open(self) -> None:
        cap = cv2.VideoCapture(self.device, cv2.CAP_V4L2)
        if not cap.isOpened():
            cap.release()
            raise CameraError(
                f"Could not open camera device {self.device!r}. Check it exists "
                f"(python -m lot.list-cameras) and that you have permission "
                f"(you must be in the 'video' group)."
            )
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        self._cap = cap

    def read(self) -> Frame:
        if self._cap is None:
            raise CameraError("Camera is not open. Call open() (or use as a context manager) first.")

        # Auto-exposure/white-balance need a handful of frames to settle before
        # the image we actually keep is captured.
        for i in range(self.warmup_frames):
            ok, _ = self._cap.read()
            if not ok:
                raise CameraError(
                    f"Camera {self.device!r} stopped returning frames during warm-up "
                    f"(frame {i + 1}/{self.warmup_frames})."
                )

        ok, image = self._cap.read()
        if not ok or image is None:
            raise CameraError(f"Failed to capture a frame from {self.device!r} after warm-up.")

        height, width = image.shape[:2]
        return Frame(image=image, width=width, height=height, captured_at=time.time())

    def iter_frames(self):
        """Continuous frame generator for live streaming.

        Unlike read(), which re-warms up on every call (right for a single
        deliberate still), this warms up once and then yields frames as fast
        as the camera provides them -- what a streaming consumer (Feature 2)
        needs. Runs until the camera stops returning frames, which raises.
        """
        if self._cap is None:
            raise CameraError("Camera is not open. Call open() (or use as a context manager) first.")

        for i in range(self.warmup_frames):
            ok, _ = self._cap.read()
            if not ok:
                raise CameraError(
                    f"Camera {self.device!r} stopped returning frames during warm-up "
                    f"(frame {i + 1}/{self.warmup_frames})."
                )

        while True:
            ok, image = self._cap.read()
            if not ok or image is None:
                raise CameraError(f"Camera {self.device!r} stopped returning frames.")
            height, width = image.shape[:2]
            yield Frame(image=image, width=width, height=height, captured_at=time.time())

    def close(self) -> None:
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def __enter__(self) -> "USBCamera":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


@dataclass
class DeviceInfo:
    path: str
    opened: bool
    width: Optional[int]
    height: Optional[int]
    fps: Optional[float]
    error: Optional[str] = None


def list_devices() -> list[DeviceInfo]:
    """Enumerate /dev/video* nodes and report what each one negotiates by default.

    Note: a single physical USB camera commonly exposes two nodes (e.g. video0
    for frames, video1 for metadata) -- both are listed honestly, without
    guessing which is the "real" one.
    """

    def sort_key(path: str) -> int:
        digits = "".join(ch for ch in path if ch.isdigit())
        return int(digits) if digits else -1

    paths = sorted(glob.glob("/dev/video*"), key=sort_key)
    results: list[DeviceInfo] = []

    for path in paths:
        cap = cv2.VideoCapture(path, cv2.CAP_V4L2)
        if not cap.isOpened():
            cap.release()
            results.append(
                DeviceInfo(
                    path=path,
                    opened=False,
                    width=None,
                    height=None,
                    fps=None,
                    error="failed to open (busy, no permission, or a metadata-only node)",
                )
            )
            continue

        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or None
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or None
        fps = cap.get(cv2.CAP_PROP_FPS) or None
        cap.release()
        results.append(DeviceInfo(path=path, opened=True, width=width, height=height, fps=fps))

    return results
