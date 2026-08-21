from __future__ import annotations

from .camera import list_devices


def main() -> int:
    devices = list_devices()
    if not devices:
        print("No /dev/video* devices found.")
        return 1

    print(f"{'DEVICE':<16}{'OPENED':<10}{'RESOLUTION':<14}{'FPS':<8}NOTES")
    for d in devices:
        res = f"{d.width}x{d.height}" if d.width and d.height else "-"
        fps = f"{d.fps:.1f}" if d.fps else "-"
        note = d.error or ""
        print(f"{d.path:<16}{str(d.opened):<10}{res:<14}{fps:<8}{note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
