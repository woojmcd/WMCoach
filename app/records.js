// Writing daily records (spec §2b): keyed by local date, stamped with UTC time,
// local date and zone. Saving again for a date edits that day's entry made in
// the same zone; an entry for the same calendar date made in another zone
// (a repeated day after crossing the date line) is kept, never merged.
import { get, getAllByIndex, put } from './db.js';
import { newId } from './seed.js';

export async function saveDaily(db, store, { localDate, tz, now = new Date(), fields, prefix, editable = (r) => true }) {
  const utc = now.toISOString();
  const same = (await getAllByIndex(db, store, 'local_date', localDate)).filter((r) => !r.deleted && editable(r));
  const mine = same.find((r) => r.tz === tz) || null;
  const record = mine
    ? { ...mine, ...fields, updated_utc: utc }
    : { id: newId(prefix), local_date: localDate, utc, tz, ...fields, updated_utc: utc };
  await put(db, store, record);
  return { record, edited: Boolean(mine) };
}

export async function latestForDate(db, store, localDate, tz) {
  const same = (await getAllByIndex(db, store, 'local_date', localDate)).filter((r) => !r.deleted);
  return same.find((r) => r.tz === tz) || same.sort((a, b) => ((a.updated_utc || '') < (b.updated_utc || '') ? 1 : -1))[0] || null;
}

// Soft delete: the record stays with deleted: true, so a later sync or a
// merge with an older backup (newer record wins) can't bring it back.
export async function removeRecord(db, store, id, now = new Date()) {
  const rec = await get(db, store, id);
  if (!rec) return null;
  const utc = now.toISOString();
  const next = { ...rec, deleted: true, deleted_utc: utc, updated_utc: utc };
  await put(db, store, next);
  return next;
}

export const live = (records) => records.filter((r) => !r.deleted);
