# assets

Drop a screen recording here as **`demo.mp4`** and the landing page plays it
instead of the built-in scripted demo. No code change is needed.

- H.264 / MP4, **muted** (it autoplays — browsers block autoplay with sound)
- Roughly 16:9 to match the frame
- Keep it under ~5 MB so it does not dominate the page load

To cache it for offline use, add `assets/demo.mp4` to the `SHELL` array in
`sw.js` and bump `VERSION`.
