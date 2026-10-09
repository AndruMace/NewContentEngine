import montserrat900 from '@fontsource/montserrat/files/montserrat-latin-900-normal.woff2?url';

/** Canvas text needs the font loaded up front, or the first frames render in a fallback face. */
export async function loadFonts() {
  const face = new FontFace('Montserrat', `url(${montserrat900})`, { weight: '900' });
  await face.load();
  document.fonts.add(face);
}
