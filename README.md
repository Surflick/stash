# Stash

Paste a YouTube link. Hit download. A playable file lands in **Downloads**.

No account. No cloud. No API keys. It only runs on your machine (`127.0.0.1`).

Use this for personal copies of videos you’re allowed to download. Respect YouTube’s terms and the creator’s rights.

The zip already includes Node, ffmpeg, and yt-dlp. Friends do **not** install anything else.

## Download

- [Stash for Mac](https://github.com/Surflick/stash/releases/download/v1.2.0/Stash-macOS.zip)
- [Stash for Windows](https://github.com/Surflick/stash/releases/download/v1.2.0/Stash-windows.zip)
- [Release notes](https://github.com/Surflick/stash/releases/tag/v1.2.0)

## Mac

1. Unzip **Stash-macOS.zip**. Keep the whole **Stash** folder together — don’t drag `Stash.app` out by itself.
2. Right-click **Stash.app** → **Open** → **Open** (macOS will warn because it isn’t signed by Apple).
3. Or double-click **Open Stash.command**.

Files land in `~/Downloads` as H.264 MP4 so QuickTime shows the picture, not a black screen with audio.

### If macOS blocks it

Right-click the app → Open. Or double-click **Fix macOS warning** in the unzipped folder.

## Windows

1. Unzip **Stash-windows.zip**. Keep the whole **Stash** folder together.
2. Double-click **Open Stash.bat**.
3. If SmartScreen warns, click **More info** → **Run anyway**. Leave the black window open while you use it.

Files land in your **Downloads** folder.

## What it does

- Fetch title, thumbnail, duration, and available qualities
- Download video (H.264 MP4) or audio (M4A / MP3)
- Queue with live progress
- Playlists (this video vs whole list)
- Library of finished files — open or reveal in Finder / Explorer

## Developing on this Mac

Your own copy can keep using Homebrew Node / ffmpeg / yt-dlp. The vendor folder is only inside the giveaway zips.

```bash
npm install
npm start
# → http://127.0.0.1:47841
```

Rebuild the giveaway zips:

```bash
./scripts/package.sh
```
