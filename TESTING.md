# Testing Feature 1

## 1. Supabase setup

1. Create a Supabase project (or use an existing one) at supabase.com.
2. Open **SQL Editor -> New query**, paste the entire contents of `supabase.sql`
   from this repo, and run it. This creates the `items` table (with a public
   SELECT policy for your website) and the `item-images` storage bucket (public
   read). Safe to re-run.
3. Open **Project Settings -> API** and copy:
   - **Project URL** -> `SUPABASE_URL`
   - **service_role** key (not `anon`) -> `SUPABASE_SERVICE_ROLE_KEY`

   The service_role key bypasses Row Level Security, which is why no
   INSERT/UPDATE policies are defined in `supabase.sql` -- only this device
   writes, and it writes with that key. **Never** put the service_role key in
   the website/frontend; that one uses the `anon` key for read-only access.

## 2. Local setup

```bash
cd consignment-desk
cp .env.example .env
# edit .env: fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
pip3 install --user -r requirements.txt
```

Do **not** `pip install opencv-python` or create an isolated venv without
`--system-site-packages`. This Jetson already has OpenCV twice over (JetPack's
apt `python3-opencv`, and a pip `opencv-python`/`opencv-python-headless` pair
already sitting in `~/.local` that Python actually imports). `requirements.txt`
deliberately excludes it. If you do want a venv:

```bash
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 3. Prove it works, in order

```bash
# 1. Confirm the camera is visible and see its negotiated resolution.
python -m lot.list-cameras

# 2. Capture + grade only, no network involved. Confirms camera + grader +
#    local save all work before you touch Supabase.
python -m lot.capture --dry-run
```
Expect: a local file path under `lot_data/captures/`, a grade card JSON block,
and "Dry run: not uploaded." Open the JPEG file to confirm it's a real photo
of what was in front of the camera.

```bash
# 3. Real capture: uploads the image and inserts the row.
python -m lot.capture --item-id LOT-001
```
Expect all four things printed, per the spec:
- `Local file: ...` (the JPEG saved on-device)
- `Storage URL: ...` (public URL in the `item-images` bucket)
- the grade card JSON
- `Inserted row: { ... }` (the exact row written to `items`)

Paste the `Storage URL` into a browser -- it should show the photo directly,
no auth needed. In the Supabase dashboard, **Table Editor -> items**, confirm
the row with `id = LOT-001` matches what was printed.

```bash
# Run again with the same id to confirm upsert (re-shoot a lot without
# creating duplicate rows):
python -m lot.capture --item-id LOT-001
```

## 4. Prove the offline queue works (pull the network cable)

```bash
# Disconnect wifi/ethernet now (or unplug the cable), then:
python -m lot.capture --item-id LOT-002
```
Expect: an "Upload failed: ..." message, then "Capture is safe -- queued at
lot_data/queue.db. Run `python -m lot.flush` once you're back online.", exit
code `2`. The photo and grade card were still captured and saved locally --
nothing was lost. You can check `echo $?` right after to see the `2`.

Inspect the queue directly if you want to see it's really durable:
```bash
sqlite3 lot_data/queue.db "select id, item_id, attempts from pending_uploads;"
```

```bash
# Reconnect the network, then:
python -m lot.flush
```
Expect: `[LOT-002] attempt #1 ... OK`, the storage URL and inserted row printed,
and `Done. 1 uploaded, 0 still queued.`. Re-run `python -m lot.flush` -- it
should now print "Queue is empty. Nothing to flush."

## Exit codes (capture and flush)

- `0` -- fully succeeded (or a clean dry run).
- `1` -- hard failure before/during capture (bad config, camera not found/busy).
  Nothing was queued because nothing was captured.
- `2` -- capture succeeded but the upload didn't; queued for retry (`capture`),
  or one or more queued items still failed after retrying (`flush`).

## Notes

- `LOT_CAMERA_WIDTH`/`LOT_CAMERA_HEIGHT` in `.env` are a *request* to the
  camera; USB webcams often only support a fixed set of modes and will fall
  back to their nearest supported resolution. The printed/saved image always
  reflects what the camera actually returned, not what was requested.
- All local state (captured photos, grade card JSON sidecars, the retry queue)
  lives under `lot_data/`, which is gitignored.
