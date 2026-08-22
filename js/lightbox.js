/* Project gallery lightbox: click a detail image to open a carousel that also
   includes the project cover as its first slide. */
(function () {
  'use strict';

  var gallery = document.querySelector('.project-gallery');
  if (!gallery) return;

  var galleryImages = Array.prototype.slice.call(gallery.querySelectorAll('img'));
  if (!galleryImages.length) return;

  var items = galleryImages.map(function (img) {
    return { src: img.getAttribute('src'), alt: img.getAttribute('alt') || '' };
  });

  // The cover shares the gallery's 4:3 ratio, so it leads the carousel.
  var cover = gallery.getAttribute('data-cover');
  var offset = 0;
  if (cover) {
    var title = document.querySelector('.project-title');
    items.unshift({
      src: cover,
      alt: gallery.getAttribute('data-cover-alt') ||
        (title ? title.textContent.trim() : '')
    });
    offset = 1;
  }

  var index = 0;
  var lastFocused = null;

  var overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Project image viewer');
  overlay.hidden = true;
  overlay.innerHTML =
    '<button type="button" class="lightbox-close" aria-label="Close">&times;</button>' +
    '<button type="button" class="lightbox-nav lightbox-prev" aria-label="Previous image">&#8249;</button>' +
    '<figure class="lightbox-figure">' +
      '<img class="lightbox-image" src="" alt="" width="800" height="600">' +
      '<figcaption class="lightbox-caption"></figcaption>' +
    '</figure>' +
    '<button type="button" class="lightbox-nav lightbox-next" aria-label="Next image">&#8250;</button>' +
    '<p class="lightbox-counter" aria-live="polite"></p>';
  document.body.appendChild(overlay);

  var image = overlay.querySelector('.lightbox-image');
  var caption = overlay.querySelector('.lightbox-caption');
  var counter = overlay.querySelector('.lightbox-counter');
  var closeBtn = overlay.querySelector('.lightbox-close');
  var prevBtn = overlay.querySelector('.lightbox-prev');
  var nextBtn = overlay.querySelector('.lightbox-next');
  var single = items.length < 2;

  if (single) {
    prevBtn.hidden = true;
    nextBtn.hidden = true;
    counter.hidden = true;
  }

  function show(i) {
    index = (i + items.length) % items.length;
    var item = items[index];
    image.setAttribute('src', item.src);
    image.setAttribute('alt', item.alt);
    caption.textContent = item.alt;
    counter.textContent = (index + 1) + ' / ' + items.length;
  }

  function open(i) {
    lastFocused = document.activeElement;
    show(i);
    overlay.hidden = false;
    document.body.classList.add('lightbox-open');
    (single ? closeBtn : nextBtn).focus();
  }

  function close() {
    overlay.hidden = true;
    document.body.classList.remove('lightbox-open');
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  galleryImages.forEach(function (img, i) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-item';
    button.setAttribute('aria-label', 'Open image ' + (i + 1 + offset) + ' of ' + items.length);
    img.parentNode.insertBefore(button, img);
    button.appendChild(img);
    button.addEventListener('click', function () { open(i + offset); });
  });

  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', function () { show(index - 1); });
  nextBtn.addEventListener('click', function () { show(index + 1); });

  overlay.addEventListener('click', function (event) {
    if (event.target === overlay || event.target.classList.contains('lightbox-figure')) close();
  });

  // Horizontal swipe on touch devices.
  var touchStartX = null;
  var touchStartY = null;
  overlay.addEventListener('touchstart', function (event) {
    if (event.touches.length !== 1) return;
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
  }, { passive: true });

  overlay.addEventListener('touchend', function (event) {
    if (single || touchStartX === null) return;
    var touch = event.changedTouches[0];
    var dx = touch.clientX - touchStartX;
    var dy = touch.clientY - touchStartY;
    touchStartX = null;
    touchStartY = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      show(dx < 0 ? index + 1 : index - 1);
    }
  }, { passive: true });

  document.addEventListener('keydown', function (event) {
    if (overlay.hidden) return;
    if (event.key === 'Escape') {
      close();
    } else if (!single && (event.key === 'ArrowLeft')) {
      show(index - 1);
    } else if (!single && (event.key === 'ArrowRight')) {
      show(index + 1);
    } else if (event.key === 'Tab') {
      // Keep focus inside the dialog.
      var focusable = Array.prototype.filter.call(
        overlay.querySelectorAll('button'),
        function (el) { return !el.hidden; }
      );
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
})();
