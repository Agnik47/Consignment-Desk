# Adding a Wi-Fi network to the Jetson

How to add a new Wi-Fi network via NetworkManager (`nmcli`) without breaking
any of the networks already saved on the device.

## Connect to the Jetson

```bash
ssh af@10.122.207.168
```

This is the Jetson's ZeroTier overlay address (interface `ztktiuyovl`), not
its local Wi-Fi IP. Use this address for this whole procedure, not the
LAN IP (`192.168.0.109` as of writing) -- the LAN IP belongs to whichever
Wi-Fi network is currently active and will change or disappear the moment
you switch networks. The ZeroTier address stays the same regardless of
which Wi-Fi network the Jetson is on, as long as it has internet access, so
your SSH session is far less likely to be the thing that breaks.

## Why this is safe

The Jetson currently has these connection profiles saved in NetworkManager:

| Name | Type | Notes |
|---|---|---|
| `TP-Link_5G` | Wi-Fi | currently active |
| `Admin-Office` | Wi-Fi | saved, inactive |
| `Afnaan's M34` | Wi-Fi | saved, inactive |
| `sHOCKwaVE` | Wi-Fi | saved, inactive |
| `Wired connection 1` | Ethernet | saved, inactive |

`nmcli device wifi connect` (step 3 below) is **additive**: it creates a
brand-new connection profile and switches the Wi-Fi radio (`wlP1p1s0`) to
it. It does not touch, delete, or overwrite any of the profiles above --
they stay saved with `autoconnect` on, ready to reconnect automatically
whenever the Jetson is back in range of one of them (e.g. if you carry it
back to the office). The only thing that changes is which one the single
Wi-Fi radio is actively using right now, since a device can only join one
Wi-Fi network at a time.

Don't use `nmcli connection delete` or edit `/etc/NetworkManager/system-connections/*.nmconnection`
directly -- that's how you'd actually lose a saved network, and it's not
needed here.

## Steps

**1. List what's currently saved**, so you have a before/after to compare against:

```bash
nmcli -t -f NAME,TYPE,AUTOCONNECT connection show
```

**2. Scan for the new network:**

```bash
sudo nmcli device wifi rescan
nmcli device wifi list
```

**3. Add and connect to it:**

```bash
sudo nmcli device wifi connect "SSID_HERE" password "PASSWORD_HERE"
```

Replace `SSID_HERE` / `PASSWORD_HERE`. This both creates the saved profile
and switches to it immediately.

**4. Verify the new network is active:**

```bash
nmcli -t -f NAME,DEVICE,TYPE,STATE connection show --active
ip -brief addr show wlP1p1s0
```

**5. Confirm your SSH session is still alive** (it's on the ZeroTier
address, so it should be unaffected):

```bash
echo still connected
```

**6. Confirm nothing from the table above disappeared:**

```bash
nmcli -t -f NAME,TYPE,AUTOCONNECT connection show
```
All five should still be listed, `TP-Link_5G` included, just no longer the
active one.

**7. (Optional) Set a boot preference** if you want the Jetson to prefer
this network over the others whenever more than one is in range:

```bash
sudo nmcli connection modify "SSID_HERE" connection.autoconnect-priority 10
```
Higher number wins. Existing profiles default to priority `0`.

## If it goes wrong

- **New network has no real internet access or a captive portal:** the
  Jetson can lose its route out, which can also take ZeroTier (and this SSH
  session) down with it, even though Wi-Fi itself connected fine. This is
  the one case the ZeroTier address can't protect you from, since it also
  needs a working internet path. Recovery needs physical/local access
  (keyboard+monitor, or SSH from a device already on the Jetson's LAN):
  ```bash
  nmcli connection up "TP-Link_5G"
  ```
- **Don't delete `TP-Link_5G` or any other saved profile** until the new
  network has been confirmed working end-to-end (SSH via
  `af@10.122.207.168` succeeds while on it). Untested is not the same as
  working.
