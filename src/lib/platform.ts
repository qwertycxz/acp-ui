// Platform detection helpers for the browser frontend.

export type Platform =
  | 'macos'
  | 'linux'
  | 'windows'
  | 'ios'
  | 'android'
  | 'unknown';

let cached: Platform | null = null;

/** Detect the current platform from `navigator.userAgent`. */
export function getPlatform(): Platform {
  if (cached !== null) return cached;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const isIPad =
    /Macintosh/i.test(ua) &&
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints !==
      undefined &&
    ((navigator as Navigator & { maxTouchPoints: number }).maxTouchPoints ?? 0) > 1;

  if (/iPhone|iPad|iPod/i.test(ua) || isIPad) cached = 'ios';
  else if (/Android/i.test(ua)) cached = 'android';
  else if (/Mac/i.test(ua)) cached = 'macos';
  else if (/Windows/i.test(ua)) cached = 'windows';
  else if (/Linux/i.test(ua)) cached = 'linux';
  else cached = 'unknown';
  return cached;
}

/** True when running as a browser app. */
export function isWeb(): boolean {
  return true;
}

/** True for mobile browsers. */
export function isMobile(): boolean {
  const p = getPlatform();
  return p === 'ios' || p === 'android';
}

/** Native desktop capabilities are not available in the browser app. */
export function isDesktop(): boolean {
  return false;
}

/** Browser builds can only talk to remote agents. */
export function restrictedTransports(): boolean {
  return true;
}

/** Browser builds do not expose local filesystem RPCs. */
export function hasLocalFs(): boolean {
  return false;
}
