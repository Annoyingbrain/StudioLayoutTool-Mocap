// Small DOM helpers shared across the app.
window.App = window.App || {};

App.dom = {
  qs(sel, root) { return (root || document).querySelector(sel); },
  qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); },

  el(tag, attrs, children) {
    const node = document.createElement(tag);
    attrs = attrs || {};
    for (const key in attrs) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key === 'html') node.innerHTML = attrs[key];
      else if (key.startsWith('on') && typeof attrs[key] === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
      } else {
        node.setAttribute(key, attrs[key]);
      }
    }
    (children || []).forEach(c => {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  },

  clear(node) { while (node.firstChild) node.removeChild(node.firstChild); },

  downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  // A frame grab is a REFERENCE PICTURE, and it is stored inside the setup's
  // JSON as a base64 data URL -- so its file size is the setup's file size,
  // times 1.33 for the base64. Stored as it came off the camera, nine grabs
  // took one setup to 72MB, which GitHub's contents API refuses outright
  // (422, "the file is too large to be processed") and which every save,
  // load and device sync then has to carry.
  //
  // Nothing looks at a grab bigger than this: it is shown as a panel
  // thumbnail and printed at page width in the report. So imports are
  // scaled to fit FRAME_GRAB_MAX_PX on the long edge and re-encoded as
  // JPEG, which takes a 16MB still to a few hundred KB.
  FRAME_GRAB_MAX_PX: 1920,
  FRAME_GRAB_QUALITY: 0.82,

  // Scales (w, h) down to fit a max-by-long-edge box, never up: a grab
  // smaller than the box is already smaller than anything looks at, and
  // enlarging it would add bytes for pixels that carry no detail. Pure, and
  // exported for test/frameGrabScale.test.js.
  fitWithin(w, h, max) {
    const factor = Math.min(1, max / Math.max(w, h));
    return { width: Math.round(w * factor), height: Math.round(h * factor) };
  },

  // Like readFileAsDataUrl, but for a picture that only has to be looked at.
  // Falls back to the untouched data URL if the browser can't decode the
  // file -- a grab that is too big is a much smaller problem than a grab
  // that silently didn't import.
  readImageFileAsDataUrl(file) {
    return this.readFileAsDataUrl(file).then(dataUrl => new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const size = App.dom.fitWithin(img.naturalWidth || img.width, img.naturalHeight || img.height, App.dom.FRAME_GRAB_MAX_PX);
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        canvas.getContext('2d').drawImage(img, 0, 0, size.width, size.height);
        try {
          resolve(canvas.toDataURL('image/jpeg', App.dom.FRAME_GRAB_QUALITY));
        } catch (e) {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    }));
  },

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }
};
