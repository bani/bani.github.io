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
