# Triggering a capture from a website

An HTTP endpoint, served by `lot/api.py`, that lets a website ask the Jetson
to take a photo right now: capture a still from the USB camera, grade it,
upload it to Supabase, and hand back the public image URL in the response.
This is separate from `lot/stream.py` (Feature 2, continuous live video) --
this is a single on-demand shot, triggered by a button click or similar on
the site.

It reuses the exact same pipeline as `python -m lot.capture` (same camera
warm-up, same Groq grading, same Supabase upload, same offline queue on
upload failure) via `capture_and_publish()` in `lot/capture.py` -- the CLI
and this API are two thin wrappers around one shared function.

## 1. Run it

```bash
python3 -m lot.api
```

```
Capture API at: http://192.168.0.109:8081/capture  (POST, ?item_id=LOT-001)
Health check:   http://192.168.0.109:8081/health
Auth: none (LOT_API_KEY not set) -- keep this off the public internet.
```

Port is `LOT_API_PORT` in `.env` (default `8081`).

Needs exclusive access to the camera device, same as `lot.stream` -- don't
run this alongside `lot.stream` or `lot.capture` against the same
`/dev/video*` at the same time.

## 2. Call it from a website

```js
const res = await fetch("http://192.168.0.109:8081/capture?item_id=LOT-001", {
  method: "POST",
  headers: { "X-API-Key": "..." }, // only needed if LOT_API_KEY is set
});
const data = await res.json();
// data.image_url -- the public Supabase Storage URL, or null if queued/dry_run
// data.grade_card -- category, identified_as, condition, grader_confidence
```

`item_id` can also go in a JSON body instead of the query string:
`{"item_id": "LOT-001"}`. Add `"dry_run": true` (or `?dry_run=true`) to
capture + grade without uploading -- handy for testing the button without
writing to Supabase; `item_id` is optional when `dry_run` is set (one is
generated).

Responses:
- `200` -- captured and uploaded. Body includes `image_url` and `row` (the
  exact row written to `items`).
- `200` -- dry run. `image_url` and `row` are `null`.
- `202` -- captured and graded, but the Supabase upload failed (offline,
  etc). `queued: true`, `queue_error` explains why. The photo isn't lost --
  it's in the local retry queue; run `python -m lot.flush` once back online.
- `400` -- missing `item_id` (and not a dry run).
- `401` -- missing/wrong `X-API-Key`, only when `LOT_API_KEY` is set.
- `500` -- camera or grading error. Nothing was queued because nothing
  usable was produced.
- `503` -- camera was busy with another request for >30s.

## 3. Auth

Unset by default, matching `lot.stream` -- fine for LAN-only use. Since this
endpoint (unlike the read-only stream) triggers a paid Groq call and writes
to Supabase on every hit, set `LOT_API_KEY` in `.env` before exposing it
past the LAN (e.g. through a Tailscale Funnel or Cloudflare Tunnel, same as
described in `STREAMING.md`), and send it as the `X-API-Key` header. Keep
the key server-side in whatever calls this from the website -- don't ship it
in client-side JS if the site is public.

## Notes

- Requests are serialized against a single in-process lock: the camera can
  only do one capture at a time, so a second request that arrives mid-capture
  waits for the first to finish rather than colliding on the device.
- CORS is wide open (`Access-Control-Allow-Origin: *`), same posture as
  `lot.stream`, so a browser can call this directly with `fetch()` from any
  origin.
