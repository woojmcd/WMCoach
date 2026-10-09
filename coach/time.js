// Time and timezone helpers (spec §2b). Pure functions: no DOM, no storage.
// "Today", "this morning" and "Saturday" always mean Walter's current local
// time, never a fixed server zone. Dates are plain 'YYYY-MM-DD' strings.

export const HOME_TZ = 'America/Los_Angeles';
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 86400000;

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function supportedTimeZones() {
  if (typeof Intl.supportedValuesOf === 'function') {
    try { return Intl.supportedValuesOf('timeZone'); } catch { /* fall through */ }
  }
  return [HOME_TZ, 'America/Denver', 'America/Chicago', 'America/New_York', 'Pacific/Honolulu',
    'Europe/London', 'Europe/Berlin', 'Europe/Rome', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
}

// Calendar parts of an instant as seen in `tz`.
export function localParts(instant, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  if (out.hour === 24) out.hour = 0;
  return out;
}

export function localDate(instant, tz) {
  const p = localParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Minutes east of UTC for `tz` at `instant` (e.g. Tokyo = +540, LA in summer = -420).
export function tzOffsetMinutes(instant, tz) {
  const p = localParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((asUtc - whole) / 60000);
}

// Every stored entry carries UTC time + the local date + the zone at entry time.
export function stamp(instant, tz) {
  return { utc: instant.toISOString(), local_date: localDate(instant, tz), tz };
}

export function parseDate(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
  if (!m) throw new Error(`Bad date: ${dateStr}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parseDate(s));
}

export function formatDateUTC(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(dateStr, n) {
  return formatDateUTC(parseDate(dateStr) + n * DAY_MS);
}

export function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

// ISO weekday: 1 = Monday ... 7 = Sunday.
export function isoWeekday(dateStr) {
  const d = new Date(parseDate(dateStr)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function weekStart(dateStr) {
  return addDays(dateStr, 1 - isoWeekday(dateStr));
}

export function weekDates(dateStr) {
  const start = weekStart(dateStr);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

// ISO-8601 week id, e.g. '2026-W41' (used for last_weekly_run_week).
export function isoWeekId(dateStr) {
  const thursday = addDays(dateStr, 4 - isoWeekday(dateStr));
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1;
  return `${year}-W${pad(week)}`;
}

// 'America/Los_Angeles' -> 'Los Angeles'
export function tzCity(tz) {
  if (!tz) return '';
  if (tz === 'UTC' || tz === 'Etc/UTC') return 'UTC';
  return tz.split('/').pop().replace(/_/g, ' ');
}

export function formatDayMonth(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function formatLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${WEEKDAYS_LONG[isoWeekday(dateStr) - 1]}, ${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

export function formatMonthYear(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
