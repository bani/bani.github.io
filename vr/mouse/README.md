# Mouse — 3D / AR Viewer

A `<model-viewer>` page for the cartoon mouse character, exported from `mouse.blend`.
Orbit, zoom, and pan on desktop or mobile; launch AR on a phone.

## Files
- `index.html` — the viewer page.
- `mouse_viewer.glb` — the character (Draco-compressed, ~7 MB, ~578k tris). Vertex colors and
  the glass eyes (`KHR_materials_transmission`) are baked in.
- `studio_env.hdr` — a 1K soft studio environment used for lighting. The Blender scene had no
  HDR world (it was lit by lamps, which don't export to glTF), so this neutral map provides
  even, matte-friendly lighting. Swap it for any equirectangular `.hdr` to relight.
- `.nojekyll` — tells GitHub Pages to serve files as-is.

## A note on mesh density
The original Head (399k tris) and Flower (147k tris) were dense Nomad sculpts that wouldn't
compress (they exported as a ~54 MB file). They were decimated ~3× on export — a visually
lossless change at this stylized scale — bringing the file to ~7 MB. The decimation happens
on a temporary modifier at export time; `mouse.blend` is untouched.

## Controls
- **Drag** — orbit. **Scroll / pinch** — zoom. **Two-finger / right-drag** — pan.
- Auto-rotates after ~0.8 s of no interaction.
- **View in your space** — AR (Android Scene Viewer / iOS Quick Look); only appears on
  AR-capable devices.

## Tuning (in `index.html`)
- `exposure` — overall brightness (try 0.8–1.4).
- `environment-image` — lighting; add `skybox-image="studio_env.hdr"` to also show it as the background.
- `shadow-intensity` / `shadow-softness` — the contact shadow under the character.
- `camera-orbit="theta phi radius"` — opening angle; `radius:auto` auto-fits.

## View locally
```bash
cd nomad/mouse-viewer
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy to GitHub Pages
1. Commit `index.html`, `mouse_viewer.glb`, `studio_env.hdr`, and `.nojekyll` to `main`.
2. **Settings → Pages:** Source = *Deploy from a branch*, Branch = `main`, folder = `/ (root)`. Save.
3. Visit `https://<user>.github.io/<repo>/nomad/mouse-viewer/` (AR needs the HTTPS Pages provides).
