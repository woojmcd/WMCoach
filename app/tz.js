// Timezone settings (spec §2b). Pure: each function returns new settings, or
// null when nothing changed. The caller saves and shows the toast.
import { isValidTimeZone } from '../coach/time.js';

function withZone(settings, tz, now, patch = {}) {
  const utc = now.toISOString();
  return {
    ...settings,
    ...patch,
    tz_current: tz,
    tz_history: [...(settings.tz_history || []), { tz, from_utc: utc }],
    updated_utc: utc,
  };
}

// Called on every launch and whenever the app comes back to the foreground.
export function applyDeviceZone(settings, deviceTz, now) {
  if (settings.tz_mode !== 'auto') return null;
  if (!isValidTimeZone(deviceTz) || deviceTz === settings.tz_current) return null;
  return withZone(settings, deviceTz, now);
}

export function setManualZone(settings, tz, now) {
  if (!isValidTimeZone(tz)) throw new Error(`Unknown timezone ${tz}`);
  if (settings.tz_mode === 'manual' && settings.tz_current === tz) return null;
  if (settings.tz_current === tz) return { ...settings, tz_mode: 'manual', tz_manual: tz, updated_utc: now.toISOString() };
  return withZone(settings, tz, now, { tz_mode: 'manual', tz_manual: tz });
}

export function setAutoZone(settings, deviceTz, now) {
  if (settings.tz_mode === 'auto' && settings.tz_current === deviceTz) return null;
  if (settings.tz_current === deviceTz) return { ...settings, tz_mode: 'auto', tz_manual: null, updated_utc: now.toISOString() };
  return withZone(settings, deviceTz, now, { tz_mode: 'auto', tz_manual: null });
}

export function offsetLabel(minutes) {
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return `UTC${sign}${hh}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}
