// ============================================================ what we're running on
// Phones and tablets drive the app by touch: the camera moves by gesture rather than by mouse button and modifier, the
// controls are made big enough for a fingertip, and on a small screen the side panel becomes a sheet that slides up from
// the bottom. A laptop with a touchscreen still reports a fine pointer as its primary one, so it stays as it was.
export const IS_TOUCH = window.matchMedia('(pointer: coarse)').matches;
// the phone layout (the panel as a bottom sheet) — the same breakpoint the `max-width: 760px` blocks in style.css use
export const NARROW_QUERY = '(max-width: 760px)';
export const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;
document.documentElement.classList.toggle('touch', IS_TOUCH);
