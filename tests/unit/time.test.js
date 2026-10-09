import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDate, tzOffsetMinutes, stamp, addDays, daysBetween, isoWeekday, weekStart, weekDates,
  isoWeekId, tzCity, isValidTimeZone, formatLong,
} from '../../coach/time.js';

test('local date follows the zone, not UTC', () => {
  const t = new Date('2026-10-09T23:30:00Z');
  assert.equal(localDate(t, 'UTC'), '2026-10-09');
  assert.equal(localDate(t, 'Asia/Tokyo'), '2026-10-10');
  assert.equal(localDate(t, 'America/Los_Angeles'), '2026-10-09');
  assert.equal(localDate(new Date('2026-10-10T05:00:00Z'), 'America/Los_Angeles'), '2026-10-09');
});

test('midnight is hour 0, not 24', () => {
  assert.equal(localDate(new Date('2026-10-09T15:00:00Z'), 'Asia/Tokyo'), '2026-10-10');
});

test('offsets, including DST', () => {
  assert.equal(tzOffsetMinutes(new Date('2026-07-01T12:00:00Z'), 'America/Los_Angeles'), -420);
  assert.equal(tzOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'America/Los_Angeles'), -480);
  assert.equal(tzOffsetMinutes(new Date('2026-12-01T12:00:00Z'), 'Asia/Tokyo'), 540);
  assert.equal(tzOffsetMinutes(new Date('2026-10-09T12:00:00Z'), 'Asia/Kolkata'), 330);
});

test('stamp carries utc, local date and zone', () => {
  const s = stamp(new Date('2026-10-09T22:15:00Z'), 'Asia/Tokyo');
  assert.deepEqual(s, { utc: '2026-10-09T22:15:00.000Z', local_date: '2026-10-10', tz: 'Asia/Tokyo' });
});

test('date arithmetic across month/year/DST boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(daysBetween('2026-05-14', '2026-10-09'), 148);
});

test('ISO weekdays and weeks (Mon first)', () => {
  assert.equal(isoWeekday('2026-10-09'), 5); // Friday
  assert.equal(isoWeekday('2026-10-11'), 7); // Sunday
  assert.equal(weekStart('2026-10-11'), '2026-10-05');
  assert.deepEqual(weekDates('2026-10-09'), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
  assert.equal(isoWeekId('2026-10-09'), '2026-W41');
  assert.equal(isoWeekId('2027-01-01'), '2026-W53');
  assert.equal(isoWeekId('2026-01-01'), '2026-W01');
});

test('zone helpers', () => {
  assert.equal(tzCity('America/Los_Angeles'), 'Los Angeles');
  assert.equal(tzCity('Asia/Tokyo'), 'Tokyo');
  assert.equal(isValidTimeZone('Europe/Berlin'), true);
  assert.equal(isValidTimeZone('Mars/Olympus'), false);
  assert.equal(formatLong('2026-10-09'), 'Friday, 9 October 2026');
});
