# Consignment Desk — laptop quickstart

The camera, grading, and upload pipeline runs on the Jetson, not your
laptop. Your laptop's job is: reach the Jetson over the network, and (if
you're building the website) call the two HTTP endpoints it exposes. This
doc is the front door for that -- it points into the detailed docs for each
piece rather than repeating them.

## What runs where

| | Runs on | Purpose |
|---|---|---|
| `python -m lot.capture` | Jetson | One-shot: capture + grade + upload from the CLI (operator at the Jetson) |
| `python -m lot.stream` | Jetson | Continuous MJPEG live video, for a website `<img>` tag |
| `python -m lot.api` | Jetson | On-demand capture over HTTP, for a website "shoot" button |
| Website / dev tools | **Your laptop** | Displays the stream, calls the capture API, reads `items` from Supabase |

## 1. Reach the Jetson from your laptop

```bash
ssh af@10.122.207.168
```

That's the Jetson's stable ZeroTier address -- works regardless of which
Wi-Fi network the Jetson is on. Full details, and how to add a new Wi-Fi
network to the Jetson without breaking existing ones: **[NETWORK-SETUP.md](NETWORK-SETUP.md)**.

## 2. Start whichever server(s) you need (on the Jetson, over that SSH session)

```bash
python3 -m lot.stream   # live video, port 8080 by default
python3 -m lot.api      # on-demand capture, port 8081 by default
```

Both need exclusive access to the camera device -- don't run them against
the same `/dev/video*` at the same time as each other or as `lot.capture`.

## 3. Call them from your laptop / the website

**Live video** -- drop an `<img>` tag pointing at the Jetson's `/stream`
URL. No frontend library, no signaling server. Full write-up including how
to expose it past the LAN with an HTTPS tunnel once the site is deployed:
**[STREAMING.md](STREAMING.md)**.

**Trigger a capture** -- `POST` to the Jetson's `/capture` endpoint from a
button click; the response includes the uploaded image's public URL and the
grade card. Request/response shapes, auth, and error codes:
**[CAPTURE-API.md](CAPTURE-API.md)**.

```js
const res = await fetch("http://<jetson-ip>:8081/capture?item_id=LOT-001", {
  method: "POST",
});
const { image_url, grade_card } = await res.json();
```

**Read items** -- query the `items` table directly from the website with
the Supabase `anon` key (read-only; the Jetson writes with a separate
`service_role` key that never leaves the device). Schema: `supabase.sql`.

## 4. First-time environment setup

Full step-by-step (Supabase project, `.env`, Python deps, proving each piece
works before wiring up Supabase) lives in **[TESTING.md](TESTING.md)** --
that's written for whoever is at the Jetson, but the env var reference in
`.env.example` is useful from the laptop too if you're pointing a local dev
server at a different Jetson/port.

## Docs index

- **[NETWORK-SETUP.md](NETWORK-SETUP.md)** -- connecting to the Jetson, adding Wi-Fi networks
- **[STREAMING.md](STREAMING.md)** -- live video feed, `lot/stream.py`
- **[CAPTURE-API.md](CAPTURE-API.md)** -- on-demand capture trigger, `lot/api.py`
- **[TESTING.md](TESTING.md)** -- Supabase setup, local env setup, proving the pipeline works end to end
- **`supabase.sql`** -- database schema (`items` table + `item-images` bucket)
