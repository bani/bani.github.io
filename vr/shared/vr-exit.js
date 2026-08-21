/* Shared in-VR exit button for the A-Frame pages under vr/.
 *
 * Load it after A-Frame and it attaches itself to the page's <a-scene>:
 *
 *   <script src="../shared/vr-exit.js"></script>
 *
 * Extracted from vr/pano/viewer.js, where it started life as `pano-vr-menu`, so the
 * panorama pages and the walkthroughs share one implementation instead of two that
 * drift. Nothing in it is panorama-specific: the panel is placed in world space and
 * re-aimed each frame from the camera's world position, so it follows a visitor who
 * teleports just as well as one who cannot move.
 *
 * The one thing that differs between the two kinds of page is controllers. A
 * walkthrough already has laser-controls wired to blink-controls for teleport; a
 * panorama has none. See the note in build().
 *
 * Opt out on a page by putting `data-no-vr-exit` on the <a-scene>.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------------- */
  /* Breadcrumbs                                                             */
  /*                                                                         */
  /* Exiting VR is the one thing here that can only be tested on real        */
  /* hardware, and when it goes wrong the headset browser is wedged, so the  */
  /* console goes with it. These land in localStorage instead, which         */
  /* survives the browser being force-quit, and can be read back afterwards  */
  /* by loading any of these pages with ?vrlog in the URL.                   */
  /* ---------------------------------------------------------------------- */

  var VRLOG = (function () {
    var KEY = 'vr-exit-log';
    var MAX = 80;
    var t0 = Date.now();

    function read() {
      try { return JSON.parse(localStorage.getItem(KEY)) || []; }
      catch (e) { return []; }
    }
    function add(msg) {
      var line = { ms: Date.now() - t0, at: new Date().toISOString(), msg: String(msg) };
      try {
        var all = read();
        all.push(line);
        localStorage.setItem(KEY, JSON.stringify(all.slice(-MAX)));
      } catch (e) { /* private mode, or full: the console copy still helps */ }
      if (window.console) { console.log('[vr-exit] +' + line.ms + 'ms ' + line.msg); }
    }
    function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

    /* Rendered as plain DOM rather than into the scene: by the time anyone reads
     * this they are out of the headset, or wish they were. */
    function show() {
      var box = document.createElement('div');
      box.setAttribute('style', [
        'position:fixed;inset:0;z-index:100000;overflow:auto',
        'background:#0d1117;color:#d7e2ee;padding:16px 18px',
        'font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace'
      ].join(';'));
      var all = read();
      var head = '<div style="font:600 14px/1.6 system-ui,sans-serif;margin-bottom:10px">' +
        'vr-exit log &middot; ' + all.length + ' entries' +
        '<button id="vrlog-clear" style="float:right;font:12px system-ui;padding:4px 10px;' +
        'border-radius:6px;border:1px solid #30475e;background:#182430;color:#d7e2ee;' +
        'cursor:pointer">Clear</button></div>' +
        '<div style="color:#7f96ad;margin-bottom:10px;word-break:break-all">' +
        navigator.userAgent + '</div>';
      var body = all.length
        ? all.map(function (l) {
            return '<div><span style="color:#6f8aa6">' + l.at.slice(11, 23) +
                   '</span>  +' + String(l.ms).padStart(6) + 'ms  ' +
                   l.msg.replace(/[<&]/g, function (c) { return c === '<' ? '&lt;' : '&amp;'; }) +
                   '</div>';
          }).join('')
        : '<div style="color:#7f96ad">Nothing recorded yet. Enter VR and press the ' +
          'Exit VR button, then reload this page with ?vrlog.</div>';
      box.innerHTML = head + body;
      document.body.appendChild(box);
      var btn = document.getElementById('vrlog-clear');
      if (btn) { btn.addEventListener('click', function () { clear(); box.remove(); }); }
    }

    return { add: add, show: show, clear: clear, read: read };
  })();

  window.VRLOG = VRLOG;   // so it can be read from a console too

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

  AFRAME.registerComponent('vr-exit-menu', {
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
      this.controllers = [];        // all of them, for the pointer count
      this.ownedControllers = [];   // only ours, safe to delete on remove()
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
      hitEl.classList.add('vr-ui');
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
      cursorEl.setAttribute('raycaster', 'objects: .vr-ui; far: 5; interval: 80');
      cameraEl.appendChild(cursorEl);

      /* A walkthrough already has its own laser-controls, bound to blink-controls for
       * teleport. Creating a second pair would put two lasers on each hand and let
       * tracked-controls bind twice, so adopt what is already there and merely widen
       * its raycaster to also see the exit panel. Only when the page has no controllers
       * of its own (the panorama case) do we make them ourselves. */
      var existing = this.el.querySelectorAll('[laser-controls]');
      var watch = function (c) {
        c.addEventListener('controllerconnected', function () { self.countPointers(1); });
        c.addEventListener('controllerdisconnected', function () { self.countPointers(-1); });
        self.controllers.push(c);
      };

      if (existing.length) {
        Array.prototype.forEach.call(existing, function (c) {
          var rc = c.getAttribute('raycaster');
          var objs = (rc && rc.objects ? String(rc.objects) : '').trim();
          if (objs.indexOf('.vr-ui') === -1) {
            c.setAttribute('raycaster', 'objects', objs ? objs + ', .vr-ui' : '.vr-ui');
          }
          watch(c);
        });
      } else {
        ['left', 'right'].forEach(function (hand) {
          var c = document.createElement('a-entity');
          c.setAttribute('laser-controls', 'hand: ' + hand);
          c.setAttribute('raycaster',
            'objects: .vr-ui; far: 5; interval: 80; lineColor: #6ba8e0; lineOpacity: 0.75');
          watch(c);
          self.el.appendChild(c);
          self.ownedControllers.push(c);
        });
      }

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
        self.requestExit();
      });

      this.onEnter = function () { VRLOG.add('enter-vr'); self.setActive(true); };
      this.onExit = function () { VRLOG.add('exit-vr event'); self.setActive(false); };
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

    /* Ending the session, the way the headset's own menu does it.
     *
     * A-Frame gives two routes out and they are not equivalent. When the system menu
     * ends a session, the session's `end` event fires and A-Frame's own listener runs
     * exitVR() afterwards, so teardown happens on a session that has already stopped.
     * That route works. Calling sceneEl.exitVR() ourselves takes the other branch: it
     * removes that `end` listener, sets renderer.xr.enabled = false, fires end()
     * without awaiting it, and then tears the scene down synchronously while the
     * session is still live. That is the route that leaves Quest Browser on its Home
     * loading screen instead of handing back to the 2D panel.
     *
     * An earlier attempt deferred exitVR() by one macrotask on the theory that the
     * problem was ending a session from inside its own frame callback. It did not
     * help, because it changed only *when* exitVR() ran, not the order of end and
     * teardown, which is the thing that actually differs between the two routes.
     *
     * So: end the session and let A-Frame react to the event, exactly as it does for
     * the system menu. exitVR() stays only as a late fallback, for the case where the
     * session goes away without the event reaching us. */
    requestExit: function () {
      var self = this;
      var sceneEl = this.el;
      if (this.exiting) { return; }
      this.exiting = true;

      var session = sceneEl.xrSession ||
        (sceneEl.renderer && sceneEl.renderer.xr && sceneEl.renderer.xr.getSession());

      if (!session) {
        VRLOG.add('no-session, falling back to exitVR()');
        sceneEl.exitVR();
        this.exiting = false;
        return;
      }

      /* Our own listener, separate from A-Frame's. It answers the one question the
       * next headset test has to settle: does the session actually end? If it does
       * and the browser is still wedged, the fault is downstream of anything this
       * page can control. If it never fires, the session is refusing to end and the
       * button is not the place to look. */
      var ended = false;
      try {
        session.addEventListener('end', function () {
          ended = true;
          VRLOG.add('session "end" event fired');
        }, { once: true });
      } catch (err) {
        VRLOG.add('could not listen for end: ' + (err && err.message));
      }

      var xr = sceneEl.renderer && sceneEl.renderer.xr;
      VRLOG.add('calling end() [visibilityState=' + (session.visibilityState || '?') +
                ', renderer.xr.enabled=' + (xr ? xr.enabled : '?') + ']');

      var promise;
      try {
        promise = session.end();
      } catch (err) {
        VRLOG.add('end() threw: ' + (err && err.message));
      }
      if (promise && promise.then) {
        promise.then(
          function () { VRLOG.add('end() resolved'); },
          function (err) { VRLOG.add('end() rejected: ' + (err && err.message)); }
        );
      } else {
        VRLOG.add('end() returned no promise');
      }

      /* Deliberately conditional. Forcing exitVR() on a session that simply has not
       * finished ending yet would run the very teardown-while-live that this whole
       * method exists to avoid, so it is only a repair for the narrow case where the
       * session is provably gone and the scene did not notice. */
      setTimeout(function () {
        self.exiting = false;
        if (!sceneEl.is('vr-mode')) {
          VRLOG.add('clean exit, scene left vr-mode');
        } else if (ended) {
          VRLOG.add('session ended but scene still in vr-mode, forcing exitVR()');
          sceneEl.exitVR();
        } else {
          VRLOG.add('session has NOT ended 2s after end(); leaving it alone rather ' +
                    'than tearing down a live session');
        }
      }, 2000);
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
      this.ownedControllers.concat([this.cursorEl, this.hitEl]).forEach(function (el) {
        if (el && el.parentNode) { el.parentNode.removeChild(el); }
      });
    }
  });

  document.addEventListener('DOMContentLoaded', function () {
    if (window.location.search.indexOf('vrlog') !== -1) { VRLOG.show(); }

    var sceneEl = document.querySelector('a-scene');
    // Added here rather than in page markup so every scene gets the in-VR exit without
    // anyone having to remember it.
    if (sceneEl && !sceneEl.hasAttribute('data-no-vr-exit')) {
      sceneEl.setAttribute('vr-exit-menu', '');
    }
  });
})();
