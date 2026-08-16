/* Equirectangular panorama viewer, shared by the vr/* scenes.
 *
 * A page supplies window.PANO_CONFIG before loading this file:
 *
 *   window.PANO_CONFIG = {
 *     backHref: '../../portfolio/kitchen/',     // optional "back to project" link
 *     views: [{
 *       id:      'counter',          // used by the ?view= URL parameter
 *       label:   'By the counter',   // switcher button text (only shown with 2+ views)
 *       src:     'pano.jpg',         // full resolution equirectangular render
 *       width:   8192,               // pixel width of src, so we can check GPU limits
 *       srcLow:  'pano-4k.jpg',      // half-size copy, used on phones and old GPUs
 *       preview: 'pano-preview.jpg', // ~1024px copy shown instantly while src downloads
 *       yaw:     0                   // degrees, rotates the sphere to set the start heading
 *     }]
 *   };
 *
 * Only `src` is required. Everything else degrades: a missing preview just means the
 * loading overlay stays up longer, a missing srcLow means phones get the full image.
 *
 * URL parameters, useful while tuning a new render:
 *   ?view=<id>   open a specific viewpoint
 *   ?yaw=<deg>   override the start heading, to find the right value for the config
 *
 * The page chrome below is all DOM, so none of it survives entering VR. An in-scene
 * Exit VR button is added automatically for that case; see `pano-vr-menu`.
 *
 * Why a hand-built sphere instead of <a-sky>: we need control over colour space, tone
 * mapping, texture memory and cross-fading, and routing that through A-Frame's material
 * component fights it more than it helps.
 */
(function () {
  'use strict';

  var CFG = window.PANO_CONFIG || {};
  var VIEWS = (CFG.views || []).filter(function (v) { return v && v.src; });
  var params = new URLSearchParams(window.location.search);

  /* ---------------------------------------------------------------------- */
  /* Image loading                                                           */
  /* ---------------------------------------------------------------------- */

  /* fetch() rather than THREE.TextureLoader: the loader wraps an <img>, which
   * reports no download progress at all. A 30 MB render needs a real progress
   * number. Falls back to a plain blob read where response streaming is missing. */
  function fetchImage(url, onProgress) {
    return fetch(url).then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      var total = parseInt(res.headers.get('content-length') || '0', 10);
      var type = res.headers.get('content-type') || 'image/jpeg';
      if (!total || !onProgress || !res.body || !res.body.getReader) { return res.blob(); }

      var reader = res.body.getReader();
      var chunks = [];
      var loaded = 0;
      return (function pump() {
        return reader.read().then(function (r) {
          if (r.done) { return new Blob(chunks, { type: type }); }
          chunks.push(r.value);
          loaded += r.value.length;
          onProgress(loaded, total);
          return pump();
        });
      })();
    }).then(decodeBlob);
  }

  function decodeBlob(blob) {
    var objectUrl = URL.createObjectURL(blob);
    var img = new Image();
    img.src = objectUrl;
    // decode() resolves once the bitmap is ready, keeping the decode of a large
    // image off the frame that first shows it.
    var ready = img.decode ? img.decode() : new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = function () { reject(new Error('decode failed')); };
    });
    return ready.then(function () {
      URL.revokeObjectURL(objectUrl);
      return img;
    }, function (err) {
      URL.revokeObjectURL(objectUrl);
      throw err;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Sky                                                                     */
  /* ---------------------------------------------------------------------- */

  AFRAME.registerComponent('pano-sky', {
    schema: {
      radius: { default: 100 },
      fadeMs: { default: 500 }
    },

    init: function () {
      var self = this;
      this.group = new THREE.Group();
      // Seen from the inside, a back-faced sphere shows its texture mirrored. Negating
      // X flips it back; three.js reverses the winding for us because the world matrix
      // determinant goes negative. This is the same trick A-Frame's <a-sky> uses.
      this.group.scale.x = -1;
      this.el.setObject3D('mesh', this.group);

      // Conservative defaults until the renderer exists and can tell us the truth.
      this.maxTexSize = 4096;
      this.maxAniso = 1;
      this.current = 0;
      this.viewIndex = -1;
      this.loadToken = 0;

      // Two identical spheres, so a viewpoint change can cross-fade rather than pop.
      var geo = new THREE.SphereGeometry(this.data.radius, 64, 40);
      this.layers = [0, 1].map(function (i) {
        var mat = new THREE.MeshBasicMaterial({
          side: THREE.BackSide,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          // The Cycles render already carries its filmic look. Tone mapping it a
          // second time in the browser is what turns a good render flat and grey.
          toneMapped: false
        });
        var mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = i;
        self.group.add(mesh);
        return mesh;
      });

      var sceneEl = this.el.sceneEl;
      if (sceneEl.renderer) { this.onRenderStart(); }
      else { sceneEl.addEventListener('renderstart', this.onRenderStart.bind(this)); }
    },

    onRenderStart: function () {
      var renderer = this.el.sceneEl.renderer;
      this.maxTexSize = renderer.getContext().getParameter(WebGLRenderingContext.MAX_TEXTURE_SIZE);
      this.maxAniso = renderer.capabilities.getMaxAnisotropy();
      this.ready = true;
      this.el.emit('pano-ready');
    },

    /* An 8192x4096 texture costs ~134 MB of GPU memory. Desktops shrug that off;
     * mobile Safari is liable to drop the whole tab. Phones get the half-size copy
     * (~34 MB) whenever the page provides one. */
    pickSource: function (view) {
      var tooBig = view.width && view.width > this.maxTexSize;
      if (view.srcLow && (tooBig || AFRAME.utils.device.isMobile())) { return view.srcLow; }
      return view.src;
    },

    toTexture: function (img) {
      var tex = new THREE.Texture(img);
      // three r152+ renamed .encoding to .colorSpace; support whichever this build has.
      if (THREE.SRGBColorSpace) { tex.colorSpace = THREE.SRGBColorSpace; }
      else if (THREE.sRGBEncoding) { tex.encoding = THREE.sRGBEncoding; }
      // No mipmaps: a full-screen sky is magnified, not minified, so they would only
      // cost another third of the texture memory for no visible gain.
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = this.maxAniso;
      tex.wrapS = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      return tex;
    },

    /* Show a view: preview first (if there is one) so the screen fills immediately,
     * then swap in the full-resolution image once it has decoded. */
    showView: function (index) {
      var self = this;
      var view = VIEWS[index];
      if (!view || index === this.viewIndex) { return Promise.resolve(); }
      this.viewIndex = index;

      var yaw = params.has('yaw') ? parseFloat(params.get('yaw')) : (view.yaw || 0);
      this.group.rotation.y = THREE.MathUtils.degToRad(yaw || 0);

      var token = ++this.loadToken;   // ignore results from a superseded switch
      function stale() { return token !== self.loadToken; }

      var previewStep = view.preview
        ? fetchImage(view.preview).then(function (img) {
            if (stale()) { return; }
            self.swapTo(self.toTexture(img), 0);
            self.el.emit('pano-first-paint');
          }).catch(function () { /* the preview is optional */ })
        : Promise.resolve();

      return previewStep.then(function () {
        return fetchImage(self.pickSource(view), function (loaded, total) {
          if (!stale()) { self.el.emit('pano-progress', { loaded: loaded, total: total }); }
        });
      }).then(function (img) {
        if (stale()) { return; }
        // Backstop for a page whose `width` is missing or wrong: a texture wider than
        // the GPU allows would otherwise silently render as black.
        if (img.naturalWidth > self.maxTexSize && view.srcLow) {
          return fetchImage(view.srcLow).then(function (small) {
            if (!stale()) { self.swapTo(self.toTexture(small), self.data.fadeMs); }
          });
        }
        self.swapTo(self.toTexture(img), view.preview ? self.data.fadeMs : 0);
      }).then(function () {
        if (stale()) { return; }
        self.el.emit('pano-first-paint');
        self.el.emit('pano-loaded');
      }).catch(function (err) {
        if (!stale()) { self.el.emit('pano-error', { message: err.message }); }
      });
    },

    /* Fade the incoming texture in over the outgoing one. Driven by tick() rather
     * than its own requestAnimationFrame loop, so the fade is tied to the same clock
     * as rendering: if the browser throttles a backgrounded tab, the fade pauses and
     * resumes with it instead of stalling half-done. */
    swapTo: function (tex, ms) {
      var outgoing = this.layers[this.current];
      var incoming = this.layers[1 - this.current];

      if (incoming.material.map) { incoming.material.map.dispose(); }
      incoming.material.map = tex;
      incoming.material.needsUpdate = true;
      incoming.renderOrder = 1;
      outgoing.renderOrder = 0;
      this.current = 1 - this.current;

      if (!ms) {
        incoming.material.opacity = 1;
        outgoing.material.opacity = 0;
        this.fade = null;
        return;
      }
      this.fade = { from: outgoing, to: incoming, ms: ms, elapsed: 0 };
    },

    tick: function (time, dt) {
      var f = this.fade;
      if (!f) { return; }
      f.elapsed += dt;
      var t = Math.min(f.elapsed / f.ms, 1);
      f.to.material.opacity = t;
      // Hold the outgoing layer until the new one is nearly opaque, so the background
      // never shows through the cross-fade.
      f.from.material.opacity = 1 - Math.max(0, (t - 0.6) / 0.4);
      if (t >= 1) {
        f.from.material.opacity = 0;
        this.fade = null;
      }
    },

    remove: function () {
      this.layers.forEach(function (m) {
        if (m.material.map) { m.material.map.dispose(); }
        m.material.dispose();
      });
      this.layers[0].geometry.dispose();
      this.el.removeObject3D('mesh');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Zoom: wheel on desktop, two-finger pinch on touch. Field of view only,  */
  /* since the camera never moves. Inert in VR, where the headset owns fov.  */
  /* ---------------------------------------------------------------------- */

  AFRAME.registerComponent('pano-zoom', {
    schema: {
      min: { default: 32 },
      max: { default: 95 },
      start: { default: 80 }
    },

    init: function () {
      this.fov = this.data.start;
      // The canvas and the camera only exist once the renderer has started.
      var sceneEl = this.el.sceneEl;
      if (sceneEl.renderer) { this.setup(); }
      else { sceneEl.addEventListener('renderstart', this.setup.bind(this)); }
    },

    setup: function () {
      var self = this;
      var canvas = this.el.sceneEl.canvas;
      this.canvas = canvas;
      this.apply();

      this.onWheel = function (e) {
        if (self.el.sceneEl.is('vr-mode')) { return; }
        e.preventDefault();
        self.setFov(self.fov + (e.deltaY > 0 ? 3 : -3));
      };
      canvas.addEventListener('wheel', this.onWheel, { passive: false });

      // Pinch. One-finger drags belong to look-controls, so only act on two.
      this.pinchStart = 0;
      this.fovStart = this.fov;
      this.onTouchStart = function (e) {
        if (e.touches.length !== 2) { return; }
        self.pinchStart = self.spread(e.touches);
        self.fovStart = self.fov;
      };
      this.onTouchMove = function (e) {
        if (e.touches.length !== 2 || !self.pinchStart) { return; }
        e.preventDefault();
        self.setFov(self.fovStart * (self.pinchStart / self.spread(e.touches)));
      };
      this.onTouchEnd = function () { self.pinchStart = 0; };
      canvas.addEventListener('touchstart', this.onTouchStart, { passive: true });
      canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
      canvas.addEventListener('touchend', this.onTouchEnd, { passive: true });

      // Leaving VR restores whatever zoom the user had before entering.
      this.el.sceneEl.addEventListener('exit-vr', function () { self.apply(); });
    },

    spread: function (touches) {
      return Math.hypot(touches[0].clientX - touches[1].clientX,
                        touches[0].clientY - touches[1].clientY);
    },

    setFov: function (v) {
      this.fov = Math.min(this.data.max, Math.max(this.data.min, v));
      this.apply();
    },

    apply: function () {
      var cam = this.el.sceneEl.camera && this.el.sceneEl.camera.el;
      if (cam) { cam.setAttribute('camera', 'fov', this.fov); }
    },

    remove: function () {
      var canvas = this.canvas;
      if (!canvas) { return; }
      canvas.removeEventListener('wheel', this.onWheel);
      canvas.removeEventListener('touchstart', this.onTouchStart);
      canvas.removeEventListener('touchmove', this.onTouchMove);
      canvas.removeEventListener('touchend', this.onTouchEnd);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* In-VR menu                                                              */
  /*                                                                         */
  /* Everything else on the page is DOM, and DOM is invisible inside an      */
  /* immersive session, so once a visitor enters VR there is nothing left to */
  /* press. The way back out is a system button whose name differs per       */
  /* headset, which makes a written instruction wrong for someone. This      */
  /* draws an exit button into the scene instead, sitting below the horizon  */
  /* so it never covers the render, plus a hint on entry saying where it is. */
  /* ---------------------------------------------------------------------- */

  /* ctx.roundRect only reached Safari in 16.4, and this is the one path here
   * that would throw rather than degrade. */
  function pillPath(ctx, x, y, w, h) {
    var r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x + r, y + h);
    ctx.arc(x + r, y + r, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
  }

  /* A canvas-textured plane, rather than <a-text>: the SDF font A-Frame uses is a
   * separate download from a CDN, and this way the panel matches the page chrome
   * exactly and cannot arrive late or fail on its own. */
  function makeUiPlane(metresW, metresH, pxW, pxH) {
    var canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;

    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) { tex.colorSpace = THREE.SRGBColorSpace; }
    else if (THREE.sRGBEncoding) { tex.encoding = THREE.sRGBEncoding; }

    var mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, toneMapped: false,
      // The sky draws with renderOrder 0/1 and writes no depth. A high render order
      // and no depth test keep the menu in front of it whatever the sort decides.
      depthTest: false, depthWrite: false
    });
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(metresW, metresH), mat);
    mesh.renderOrder = 10;
    mesh.frustumCulled = false;

    return { mesh: mesh, mat: mat, tex: tex, ctx: canvas.getContext('2d'), w: pxW, h: pxH };
  }

  var UI_FONT = 'px system-ui, -apple-system, Helvetica, Arial, sans-serif';

  AFRAME.registerComponent('pano-vr-menu', {
    schema: {
      distance: { default: 1.05 },   // metres in front of the eyes
      // Roughly 39 degrees below the horizon. Nearer the horizon is easier to reach,
      // but 25 degrees down is also where someone admires the floor of the render,
      // and a fuse that far up would throw them out of the scene for looking at it.
      drop:     { default: 0.85 },
      fuseMs:   { default: 1500 },
      hintMs:   { default: 6000 },
      fadeMs:   { default: 800 }
    },

    init: function () {
      var self = this;
      this.pointers = 0;       // connected controllers; more than zero disables the fuse
      this.active = false;
      this.hovered = false;
      this.hoverMs = 0;
      this.drawnProgress = -1;
      this.hintElapsed = -1;
      this.controllers = [];
      this.followYaw = 0;
      this.camPos = new THREE.Vector3();
      this.camQuat = new THREE.Quaternion();
      this.camEuler = new THREE.Euler();

      var sceneEl = this.el;
      if (sceneEl.camera) { this.build(sceneEl.camera.el); }
      else {
        sceneEl.addEventListener('camera-set-active', function (e) {
          self.build(e.detail.cameraEl);
        }, { once: true });
      }
    },

    build: function (cameraEl) {
      var self = this;
      var d = this.data;
      this.cameraEl = cameraEl;

      /* Placed in the world and re-aimed each frame from the head's yaw, NOT parented
       * to the camera. A panel bolted to the camera can never be looked at: the gaze
       * ray is bolted to the same camera, so it keeps pointing the same distance above
       * the panel however far down the visitor looks. Anchoring it below the horizon
       * makes looking down aim at it, which is the whole interaction. */
      var btn = this.button = makeUiPlane(0.75, 0.25, 768, 256);
      btn.mesh.visible = false;
      btn.mat.opacity = 0;
      this.drawButton(0);

      /* The pill rides on a larger invisible quad. Aiming by head at something only ten
       * degrees tall is fussy to hold for the length of a fuse, and there is nothing
       * else down here to hit by mistake. */
      var hitEl = this.hitEl = document.createElement('a-entity');
      hitEl.classList.add('pano-ui');
      hitEl.setObject3D('mesh', new THREE.Mesh(
        new THREE.PlaneGeometry(0.95, 0.5),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      ));
      this.el.appendChild(hitEl);
      // Yaw before pitch, so the lean stays about the panel's own left-right axis.
      hitEl.object3D.rotation.order = 'YXZ';
      hitEl.object3D.add(btn.mesh);

      // The hint is head-locked: it is not a target, it just has to be read once.
      var hint = this.hint = makeUiPlane(1.3, 0.17, 960, 128);
      cameraEl.object3D.add(hint.mesh);
      hint.mesh.position.set(0, -0.22, -1.5);
      hint.mesh.rotation.x = -Math.atan2(0.22, 1.5);
      hint.mesh.visible = false;
      this.drawHint();

      // No geometry on the cursor: a reticle parked in the middle of a 360 render is
      // exactly the thing these pages exist to show off. Feedback lives on the button.
      var cursorEl = this.cursorEl = document.createElement('a-entity');
      cursorEl.setAttribute('cursor', 'fuse: true; fuseTimeout: ' + d.fuseMs + '; rayOrigin: entity');
      cursorEl.setAttribute('raycaster', 'objects: .pano-ui; far: 5; interval: 80');
      cameraEl.appendChild(cursorEl);

      ['left', 'right'].forEach(function (hand) {
        var c = document.createElement('a-entity');
        c.setAttribute('laser-controls', 'hand: ' + hand);
        c.setAttribute('raycaster',
          'objects: .pano-ui; far: 5; interval: 80; lineColor: #6ba8e0; lineOpacity: 0.75');
        c.addEventListener('controllerconnected', function () { self.countPointers(1); });
        c.addEventListener('controllerdisconnected', function () { self.countPointers(-1); });
        self.el.appendChild(c);
        self.controllers.push(c);
      });

      hitEl.addEventListener('mouseenter', function () {
        if (!self.active) { return; }
        self.hovered = true;
        self.hoverMs = 0;
        self.drawnProgress = -1;
        self.drawButton(0);
      });
      hitEl.addEventListener('mouseleave', function () {
        self.hovered = false;
        self.drawButton(0);
      });
      hitEl.addEventListener('click', function () {
        // Outside VR the button is hidden but the ray can still reach it if the visitor
        // drags the view far enough down, and exiting a session we are not in is noise.
        if (!self.el.is('vr-mode')) { return; }
        // This click is dispatched by the cursor component's fuse, which resolves
        // inside the same tick the WebXR session drives - so we are still inside that
        // frame's callback right now. Ending the session synchronously from within its
        // own frame callback is what left Quest Browser stuck on its Home loading
        // screen instead of handing back to the 2D tab. Deferring one macrotask lets
        // the current frame finish and present before end() runs.
        setTimeout(function () {
          if (self.el.is('vr-mode')) { self.el.exitVR(); }
        }, 0);
      });

      this.onEnter = function () { self.setActive(true); };
      this.onExit = function () { self.setActive(false); };
      this.el.addEventListener('enter-vr', this.onEnter);
      this.el.addEventListener('exit-vr', this.onExit);
      if (this.el.is('vr-mode')) { this.setActive(true); }
    },

    /* A fuse fires on its own after a delay, which is right for gaze and wrong for a
     * controller: pointing somewhere is not the same as choosing it. */
    countPointers: function (delta) {
      this.pointers = Math.max(0, this.pointers + delta);
      if (this.cursorEl) {
        this.cursorEl.setAttribute('cursor', 'fuse', this.pointers === 0);
      }
      this.hoverMs = 0;
      this.drawnProgress = -1;
      this.drawButton(0);
    },

    setActive: function (active) {
      if (!this.button) { return; }
      this.active = active;
      this.hovered = false;
      this.hoverMs = 0;
      this.drawButton(0);
      this.button.mat.opacity = 0;
      this.button.mesh.visible = false;

      if (active) {
        // Start under wherever the visitor happens to be facing, rather than swinging
        // in from the heading the page was opened at.
        this.cameraEl.object3D.getWorldQuaternion(this.camQuat);
        this.followYaw = this.camEuler.setFromQuaternion(this.camQuat, 'YXZ').y;
      }

      this.hint.mesh.visible = active;
      this.hint.mat.opacity = active ? 1 : 0;
      this.hintElapsed = active ? 0 : -1;
    },

    /* The panel keeps station below the horizon, following the head's heading only.
     * Its opacity ramps with how far down the visitor is looking, so it is out of the
     * way of the render until it is wanted. */
    follow: function (dt) {
      var d = this.data;
      var cam = this.cameraEl.object3D;
      cam.getWorldPosition(this.camPos);
      cam.getWorldQuaternion(this.camQuat);
      this.camEuler.setFromQuaternion(this.camQuat, 'YXZ');

      var delta = this.camEuler.y - this.followYaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));   // take the short way round
      this.followYaw += delta * (1 - Math.exp(-dt / 150));

      var obj = this.hitEl.object3D;
      obj.position.set(
        this.camPos.x - Math.sin(this.followYaw) * d.distance,
        this.camPos.y - d.drop,
        this.camPos.z - Math.cos(this.followYaw) * d.distance
      );
      obj.rotation.set(-Math.atan2(d.drop, d.distance), this.followYaw, 0);

      // Hovering holds it solid: a controller can point at it from any head angle.
      var pitch = -THREE.MathUtils.radToDeg(this.camEuler.x);
      var target = this.hovered ? 1 : Math.min(Math.max((pitch - 18) / 16, 0), 1);
      var mat = this.button.mat;
      mat.opacity += (target - mat.opacity) * (1 - Math.exp(-dt / 120));
      this.button.mesh.visible = mat.opacity > 0.01;

      // Once the button is on its way in, the hint has done its job. Retiring it here
      // also keeps the two from stacking up on each other as the head pitches down.
      if (mat.opacity > 0.15 && this.hintElapsed >= 0 && this.hintElapsed < this.data.hintMs) {
        this.hintElapsed = this.data.hintMs;
      }
    },

    drawButton: function (progress) {
      var b = this.button;
      if (!b) { return; }
      var ctx = b.ctx;
      var pad = 5;
      var w = b.w - pad * 2;
      var h = b.h - pad * 2;

      ctx.clearRect(0, 0, b.w, b.h);
      pillPath(ctx, pad, pad, w, h);
      ctx.fillStyle = this.hovered ? 'rgba(30, 42, 58, 0.92)' : 'rgba(20, 28, 38, 0.82)';
      ctx.fill();

      if (progress > 0) {
        ctx.save();
        ctx.clip();
        ctx.fillStyle = 'rgba(120, 180, 240, 0.55)';
        ctx.fillRect(pad, pad, w * progress, h);
        ctx.restore();
      }

      pillPath(ctx, pad, pad, w, h);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(120, 160, 200, 0.5)';
      ctx.stroke();

      ctx.fillStyle = '#eef3f8';
      ctx.font = '600 ' + Math.round(b.h * 0.4) + UI_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Exit VR', b.w / 2, b.h / 2);

      b.tex.needsUpdate = true;
    },

    drawHint: function () {
      var t = this.hint;
      var ctx = t.ctx;
      ctx.clearRect(0, 0, t.w, t.h);
      pillPath(ctx, 3, 3, t.w - 6, t.h - 6);
      ctx.fillStyle = 'rgba(20, 28, 38, 0.72)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(120, 160, 200, 0.35)';
      ctx.stroke();

      ctx.fillStyle = '#dce8f4';
      ctx.font = '500 ' + Math.round(t.h * 0.42) + UI_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Look down for the Exit VR button', t.w / 2, t.h / 2);

      t.tex.needsUpdate = true;
    },

    tick: function (time, dt) {
      if (!this.button) { return; }

      if (this.hintElapsed >= 0) {
        this.hintElapsed += dt;
        var over = this.hintElapsed - this.data.hintMs;
        if (over > 0) {
          var opacity = 1 - over / this.data.fadeMs;
          this.hint.mat.opacity = Math.max(0, opacity);
          if (opacity <= 0) {
            this.hint.mesh.visible = false;
            this.hintElapsed = -1;
          }
        }
      }

      if (!this.active) { return; }
      this.follow(dt);

      // Without a growing fill the fuse feels like nothing is happening, and people
      // look away again a few hundred milliseconds before it would have fired.
      if (!this.hovered || this.pointers > 0) { return; }
      this.hoverMs += dt;
      var progress = Math.min(this.hoverMs / this.data.fuseMs, 1);
      if (progress - this.drawnProgress >= 0.03 || progress >= 1) {
        this.drawButton(progress);
        this.drawnProgress = progress;
      }
    },

    remove: function () {
      this.el.removeEventListener('enter-vr', this.onEnter);
      this.el.removeEventListener('exit-vr', this.onExit);
      [this.button, this.hint].forEach(function (plane) {
        if (!plane) { return; }
        if (plane.mesh.parent) { plane.mesh.parent.remove(plane.mesh); }
        plane.mesh.geometry.dispose();
        plane.mat.dispose();
        plane.tex.dispose();
      });
      this.controllers.concat([this.cursorEl, this.hitEl]).forEach(function (el) {
        if (el && el.parentNode) { el.parentNode.removeChild(el); }
      });
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Page chrome: loading overlay, viewpoint switcher, iOS motion prompt     */
  /* ---------------------------------------------------------------------- */

  function whenComponentReady(el, name, cb) {
    if (el.components && el.components[name]) { cb(el.components[name]); return; }
    el.addEventListener('loaded', function () { cb(el.components[name]); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var skyEl = document.querySelector('[pano-sky]');
    var overlay = document.getElementById('pano-loading');
    var status = document.getElementById('pano-status');
    var help = document.getElementById('help');

    if (!skyEl) { return; }
    if (!VIEWS.length) {
      showError(overlay, 'No panorama is configured for this page.');
      return;
    }

    var back = document.getElementById('pano-back');
    if (back && CFG.backHref) { back.href = CFG.backHref; }

    // Added here rather than in the page markup so every scene gets the in-VR exit
    // without having to remember it. It stays hidden until a session starts.
    var sceneEl = document.querySelector('a-scene');
    if (sceneEl) { sceneEl.setAttribute('pano-vr-menu', ''); }

    // First paint dismisses the overlay; the pill then tracks the full-res upgrade.
    skyEl.addEventListener('pano-first-paint', function () {
      if (overlay) { overlay.classList.add('is-hidden'); }
    });
    skyEl.addEventListener('pano-progress', function (e) {
      if (!status || !e.detail.total) { return; }
      status.textContent = 'Loading full resolution ' +
        Math.round((e.detail.loaded / e.detail.total) * 100) + '%';
      status.classList.add('is-visible');
    });
    skyEl.addEventListener('pano-loaded', function () {
      if (status) { status.classList.remove('is-visible'); }
      if (help) { setTimeout(function () { help.classList.add('is-faded'); }, 8000); }
    });
    skyEl.addEventListener('pano-error', function (e) {
      showError(overlay, 'The panorama could not be loaded. (' + e.detail.message + ')');
    });

    whenComponentReady(skyEl, 'pano-sky', function (sky) {
      function start() {
        var requested = params.get('view');
        var index = 0;
        VIEWS.forEach(function (v, i) { if (v.id && v.id === requested) { index = i; } });
        buildSwitcher(sky, index);
        sky.showView(index);
      }
      // Wait for the renderer, so the GPU texture limit is known before we choose a file.
      if (sky.ready) { start(); } else { skyEl.addEventListener('pano-ready', start); }
    });

    setupMotionPrompt();
  });

  function showError(overlay, message) {
    if (!overlay) { return; }
    overlay.classList.remove('is-hidden');
    overlay.innerHTML = '<p class="pano-error"></p>';
    overlay.querySelector('.pano-error').textContent = message;
  }

  function buildSwitcher(sky, activeIndex) {
    if (VIEWS.length < 2) { return; }
    var bar = document.getElementById('pano-views');
    if (!bar) { return; }
    VIEWS.forEach(function (view, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = view.label || ('View ' + (i + 1));
      btn.setAttribute('aria-current', i === activeIndex ? 'true' : 'false');
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(bar.children, function (b) {
          b.setAttribute('aria-current', 'false');
        });
        btn.setAttribute('aria-current', 'true');
        sky.showView(i);
      });
      bar.appendChild(btn);
    });
    bar.style.display = 'flex';
  }

  /* iOS 13+ withholds deviceorientation until the user asks for it from a gesture.
   * Everywhere else look-controls just works, so the button stays hidden. */
  function setupMotionPrompt() {
    var btn = document.getElementById('pano-motion');
    if (!btn || typeof DeviceOrientationEvent === 'undefined' ||
        typeof DeviceOrientationEvent.requestPermission !== 'function') { return; }
    btn.classList.add('is-visible');
    btn.addEventListener('click', function () {
      DeviceOrientationEvent.requestPermission().then(function () {
        btn.classList.remove('is-visible');
      }).catch(function () {
        btn.textContent = 'Motion unavailable';
      });
    });
  }
})();
