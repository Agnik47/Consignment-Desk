# Streaming the camera to a website

Feature 2: a live MJPEG video feed from the USB camera, served over HTTP by
`lot/stream.py`, meant to be dropped straight into a Next.js page.

MJPEG (not WebRTC) is the deliberate choice here -- a plain `<img>` tag
renders it natively in any browser, no video library, no signaling server,
no extra npm package. `Camera.iter_frames()` in `lot/camera.py` reuses the
same `USBCamera` used for grading captures, just read continuously instead
of as a single deliberate still.

## 1. Run it

```bash
python3 -m lot.stream
```

It opens the camera once, warms it up (same warm-up as a normal capture),
then serves continuously. Output looks like:

```
Streaming at:  http://192.168.0.109:8080/stream
Preview page:  http://192.168.0.109:8080/
Snapshot:      http://192.168.0.109:8080/snapshot
```

Open the preview page in any browser on the same network to confirm you see
live video. `Ctrl+C` to stop.

Port is `LOT_STREAM_PORT` in `.env` (default `8080`).

Three endpoints:
- `/stream` -- MJPEG video (multipart JPEG stream), what you embed on a page.
- `/snapshot` -- a single current JPEG (handy for polling/testing, or a
  lightweight thumbnail instead of a live feed).
- `/` -- a bare `<img>` preview page, for a quick sanity check without any
  frontend code at all.

## 2. Wire it into Next.js

```tsx
// components/CameraStream.tsx
export default function CameraStream() {
  return (
    <img
      src={process.env.NEXT_PUBLIC_STREAM_URL}
      alt="Live camera feed"
      style={{ maxWidth: "100%", height: "auto" }}
    />
  );
}
```

```bash
# .env.local in the Next.js project
NEXT_PUBLIC_STREAM_URL=http://192.168.0.109:8080/stream
```

That's it for LAN use -- run the Next.js dev server on the same network as
the Jetson and the `<img>` just works. `<img>` tags aren't subject to CORS,
so no proxying is needed even cross-origin.

## 3. Exposing it beyond the LAN (optional, do this when you deploy)

Once the Next.js site is deployed somewhere like Vercel, the browser needs
to reach the Jetson over the public internet -- and if the site is served
over HTTPS, a plain `http://` stream URL gets blocked as mixed content. Two
free options, both give an HTTPS URL you drop into `NEXT_PUBLIC_STREAM_URL`
with no code changes on either side.

**Tailscale Funnel** (recommended -- simplest, a stable URL, free for
personal use):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale funnel 8080
```

Gives a persistent `https://<device>.<your-tailnet>.ts.net` URL that proxies
to port 8080.

**Cloudflare Tunnel** (no account needed for a quick test URL):

```bash
cloudflared tunnel --url http://localhost:8080
```

Prints a random `https://*.trycloudflare.com` URL on the spot. Fine for
testing; a permanent named tunnel needs a free Cloudflare account + domain.

Either way, just swap `NEXT_PUBLIC_STREAM_URL` to the tunnel's `/stream` URL
and nothing else changes.

## Notes

- `iter_frames()` warms up once on open, then reads as fast as the camera
  provides frames -- unlike `read()` (used for single captures), which
  re-warms up on every call and would be far too slow for continuous video.
- The stream server needs exclusive access to the camera device. Don't run
  `lot.stream` and `lot.capture`/`lot.grade-image` against the same
  `/dev/video*` device at the same time.
