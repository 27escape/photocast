// Shared caption-formatting logic for photocast's two display surfaces: the
// browser web UI (index.html) and the Chromecast custom receiver
// (receiver.html). Both include this file rather than each having their own
// copy - fix a formatting quirk once here, both places pick it up.
//
// Deliberately plain functions with no DOM access, so it works the same
// whether it's running in a normal browser tab or the Cast receiver's
// embedded browser environment.

// Extracts just the "YYYY-MM-DD HH:MM" portion from Date/Time Original -
// shared by both caption functions below so the date-parsing logic itself
// only exists in one place. Deliberately truncates to HH:MM (no seconds) -
// this also has the side effect of stripping any trailing timezone offset
// some Pixel DNG timestamps carry (e.g. "17:282491+02:00"), since that comes
// later in the string than the 5 characters being kept.
function formatPhotoDate(exif) {
  if (!exif || !exif['Date/Time Original']) return '';
  const dtParts = exif['Date/Time Original'].split(' ');
  const datePart = dtParts[0] ? dtParts[0].replace(/:/g, '-') : '';
  const timePart = dtParts[1] ? dtParts[1].slice(0, 5) : '';
  return timePart ? `${datePart} ${timePart}` : datePart;
}

// Full caption line for the browser web UI: timestamp, location,
// aperture/shutter/ISO, focal length. Unchanged in output from before this
// was split out - the browser display is intentionally left as-is.
function formatPhotoCaption(exif) {
  if (!exif) return '';
  let line = formatPhotoDate(exif);

  line += ` F${exif.pc_aperture || '--'} | SS ${exif.pc_shutter || '--'} | ISO ${exif.pc_iso || '--'}`;

  const focalLength = exif['Focal Length In 35mm Format'] || exif['Focal Length 35mm Equiv'];
  let zoom = '--';
  if (focalLength) {
    const val = parseFloat(focalLength);
    if (!isNaN(val)) zoom = Math.round(val);
  }
  line += ` | Z (FF) ${zoom}`;
  // we know this is added to innerText, so no need to worry about HTML escaping here
  line += exif.pc_location ? ('\n' + exif.pc_location) : '';

  return line;
}

// Simplified caption for the Chromecast receiver: just the photo's date and
// location, no technical details. Deliberately separate from
// formatPhotoCaption above rather than a shared function with options, so
// each display's content can evolve independently without a branching
// parameter creeping in.
function formatReceiverCaption(exif) {
  if (!exif) return '';
  let line = formatPhotoDate(exif);
  if (exif.pc_location) line += (line ? ' | ' : '') + exif.pc_location;
  return line;
}

// Whether the caption/HUD should use light text - matches the existing
// pc_is_dark convention from index.html.
function isDarkPhoto(exif) {
  return String(exif?.pc_is_dark ?? '').toLowerCase() === 'true';
}