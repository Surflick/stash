# Give Stash away on X

X cannot attach a zip. Host the file, then paste a post with the public link.

Giveaway zips (self-contained — people do not install Node, ffmpeg, or yt-dlp):

```text
https://github.com/Surflick/stash/releases/latest
https://github.com/Surflick/stash/releases/tag/v1.3.1
https://github.com/Surflick/stash/releases/download/v1.3.1/Stash-macOS.zip
https://github.com/Surflick/stash/releases/download/v1.3.1/Stash-windows.zip
```

The original X post used `v1.2.0`. That URL still works — it serves the same current zip.

Folder apps: unzip, keep everything together, double-click **Open Stash**. Do not ship `data/` or your Chrome CSV.

---

## 1. Host the zip (pick one)

### GitHub (best)

1. Create a public repo at [github.com/new](https://github.com/new) — name it `stash` (or similar).
2. **Releases → Draft a new release**
   - Tag: `v1.3.1`
   - Title: `Stash 1.3.1`
   - Attach `Stash-macOS.zip` and `Stash-windows.zip`
   - Publish

Your post link is the **release page**:

`https://github.com/Surflick/stash/releases/latest`

### Drive / Dropbox / iCloud (faster, no git)

1. Upload the Mac zip, the Windows zip, or both.
2. Share → **Anyone with the link can view**.
3. Paste that URL in the post.

Replace `LINK` below with whichever URL you used.

---

## 2. Paste this on X

Attach `assets/stash-x-card.png` as the image.

### Recommended (fits 280)

```text
I made a tiny app that saves a YouTube video to Downloads.

Mac or Windows. Unzip, open Stash. Nothing else to install.
Right-click Open first time. Keep the folder together.

Allowed content only.

https://github.com/Surflick/stash/releases/latest
```

### Longer (X Premium)

```text
I made a tiny app that saves a personal copy of a YouTube video to Downloads.

Paste a link. Hit download. File shows up.

Mac + Windows · unzip and open · nothing else to install
Unsigned: right-click Open Stash the first time. Keep the folder together.

Personal copies of content you’re allowed to keep — not a pirate tool.

https://github.com/Surflick/stash/releases/latest
```

### Image alt text

```text
Dark 16:9 card. Left: KEEP THE FILE. Right: Stash window with a YouTube link, Download button, and a finished mp4 in Downloads.
```

---

## 3. What to tell people in replies

- Unzip. Don’t pull the app out of the folder.
- Mac: right-click → Open (unsigned). Or run **Fix macOS warning**.
- Windows: if SmartScreen warns, More info → Run anyway. Leave the window open.
- Nothing else to install. No API keys.
- Output is Downloads.
- Personal use of allowed content only.

Rebuild after code changes:

```bash
./scripts/package.sh
```
