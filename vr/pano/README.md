# Panorama viewer

A small equirectangular panorama viewer built on the same A-Frame that the WebXR
walkthrough pages use. It runs in Safari, Chrome, Firefox and headsets, with no build
step and no generated project folder.

`viewer.js` and `viewer.css` are shared. Each scene page holds only a `PANO_CONFIG`
block and the markup, so both scenes stay in sync automatically.

## Rendering the panorama in Blender

1. Select the camera, then Object Data Properties > Lens.
2. Type: **Panoramic**, Panorama Type: **Equirectangular**. This is Cycles only, so
   set the render engine to Cycles first.
3. Leave the Longitude and Latitude extents at their defaults (-180/180, -90/90).
   Anything narrower is no longer a full sphere and will not wrap.
4. Output resolution **8192 x 4096** (exactly 2:1; any other aspect ratio distorts).
5. Position the camera at standing eye height, roughly in the middle of the space.
   The whole room is visible at once, so anything hidden behind the camera in the
   original render now shows up.

Save as JPEG, quality around 90.

## Producing the three files

The viewer wants three sizes per viewpoint. `sips` ships with macOS:

```bash
sips -Z 4096 pano.jpg --out pano-4k.jpg
```

```bash
sips -Z 1024 pano.jpg --out pano-preview.jpg
```

| File               | Size      | Used for                                          |
| ------------------ | --------- | ------------------------------------------------- |
| `pano.jpg`         | 8192x4096 | Desktop                                           |
| `pano-4k.jpg`      | 4096x2048 | Phones and tablets, and any GPU that caps below 8k |
| `pano-preview.jpg` | 1024x512  | Shown instantly while the full image downloads    |

The size split is about GPU memory, not download time. An 8192x4096 texture occupies
about 134 MB on the GPU regardless of how well the JPEG compresses, which mobile Safari
will not reliably survive. The 4k copy costs about 34 MB.

Drop the files next to the scene's `pano.html`.

## Aiming the starting view

`yaw: 270` opens the page facing the middle column of the equirectangular image, which
is the direction the Blender camera was pointing. To start somewhere else, add
`?yaw=200` to the URL, drag until the view is right, then write that number into the
page's `PANO_CONFIG`.

## More than one viewpoint

Add entries to `views`. A switcher bar appears automatically at two or more, and
`?view=<id>` deep links to one. Switching cross-fades rather than cutting.

## Going live

The new pages sit at `pano.html` so the existing WebXR walkthroughs keep working until
the renders are ready. Once a scene's panorama is in place and checked:

1. `git mv vr/<scene>/pano.html vr/<scene>/index.html`
2. Update the portfolio link in `portfolio/<scene>/index.html`, which currently reads
   "View in WebXR".
3. Decide what to do with `vr/<scene>/<scene>.glb` (64 MB for the kitchen, 13 MB for the
   modern interior). Deleting it does not shrink the repository, since the blobs stay
   in git history.

## Checking the viewer

`vr/pano/test/` renders a labelled lat/long grid. At yaw 0 you face "0 FRONT" with
"90 RIGHT" to your right, the horizon sits at eye level, and the colour swatches stay
saturated. Washed out swatches mean something re-applied tone mapping to an image that
already had it baked in.
