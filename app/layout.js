// Screen layout on iPhone (Walter, 2026-10-13). Pure, so it can be unit-tested.
//
// The home-screen app is full screen (black-translucent status bar, portrait), so the
// layout should end at the screen's bottom edge. When iOS ends it higher, this is the gap
// (CSS px) that the bottom-pinned parts extend into (--vp-gap in styles.css). 0 in a
// browser tab, while typing (the keyboard), and for anything implausible.
export const MAX_GAP = 120;

export function screenGap({ standalone, innerWidth, innerHeight, screenWidth, screenHeight, typing = false }) {
  if (!standalone || typing) return 0;
  const portrait = innerHeight >= innerWidth;
  const full = portrait ? Math.max(screenWidth, screenHeight) : Math.min(screenWidth, screenHeight);
  const gap = Math.round(full - innerHeight);
  return gap > 0 && gap <= MAX_GAP ? gap : 0;
}
