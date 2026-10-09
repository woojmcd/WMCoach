import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextPrepDay, requestModeChange, applyPendingMode, phaseStatus, currentPhase, checkinDueDate, checkinState, adherenceFromTaps,
} from '../../coach/phase.js';
import { defaultSettings } from '../../coach/seed.js';

const now = new Date('2026-10-09T15:00:00Z');
const settings = defaultSettings({ now, tz: 'America/Los_Angeles' });

test('next prep day is strictly after today', () => {
  assert.equal(nextPrepDay('2026-10-09', 7), '2026-10-11'); // Fri → Sun
  assert.equal(nextPrepDay('2026-10-10', 7), '2026-10-11'); // Sat → tomorrow
  assert.equal(nextPrepDay('2026-10-11', 7), '2026-10-18'); // Sun → next Sun (this week is locked)
  assert.equal(nextPrepDay('2026-10-12', 1), '2026-10-19');
});

test('mode switch waits for the next prep day; flipping back cancels', () => {
  const r = requestModeChange(settings, 'cut', { now, today: '2026-10-09', tz: 'America/Los_Angeles', id: 'm1', targets: { weight_lb: 160 } });
  assert.equal(r.settings.mode, 'bulk', 'current week unchanged');
  assert.deepEqual(r.settings.pending_mode, { to: 'cut', effective_date: '2026-10-11', change_id: 'm1', targets: { weight_lb: 160 } });
  assert.equal(r.change.kind, 'switch');
  assert.equal(r.change.from, 'bulk');
  assert.equal(requestModeChange(r.settings, 'cut', { now, today: '2026-10-09', tz: 'x', id: 'm2' }), null, 'same pending switch twice');
  const c = requestModeChange(r.settings, 'bulk', { now, today: '2026-10-09', tz: 'America/Los_Angeles', id: 'm3' });
  assert.equal(c.change.kind, 'cancel');
  assert.equal(c.settings.pending_mode, null);
  assert.equal(requestModeChange(settings, 'bulk', { now, today: '2026-10-09', tz: 'x', id: 'm4' }), null, 'no-op');
});

test('pending mode applies on-device on the prep day and rolls the phases', () => {
  const r = requestModeChange(settings, 'maintenance', { now, today: '2026-10-09', tz: 'America/Los_Angeles', id: 'm1' });
  const phases = [{ id: 'bulk-2026-10-09', kind: 'bulk', start: '2026-10-09', end: null }, { id: 'cut-2026-02-01', kind: 'cut', start: '2026-02-01', end: '2026-05-14' }];
  assert.equal(applyPendingMode(r.settings, phases, '2026-10-10', now), null, 'not yet');
  const a = applyPendingMode(r.settings, phases, '2026-10-11', now);
  assert.equal(a.settings.mode, 'maintenance');
  assert.equal(a.settings.mode_since, '2026-10-11');
  assert.equal(a.settings.pending_mode, null);
  assert.deepEqual(a.phases.map((p) => [p.id, p.start, p.end]), [['bulk-2026-10-09', '2026-10-09', '2026-10-10'], ['maintenance-2026-10-11', '2026-10-11', null]]);
  assert.equal(currentPhase([...phases.slice(1), ...a.phases]).id, 'maintenance-2026-10-11');
});

test('a phase replaced on its first day is superseded, not left open', () => {
  const r = requestModeChange(settings, 'cut', { now, today: '2026-10-09', tz: 'x', id: 'm1' });
  const pending = { ...r.settings, pending_mode: { ...r.settings.pending_mode, effective_date: '2026-10-11' } };
  const phases = [{ id: 'bulk-2026-10-11', kind: 'bulk', start: '2026-10-11', end: null }];
  const a = applyPendingMode(pending, phases, '2026-10-11', now);
  assert.deepEqual(a.phases[0], { id: 'bulk-2026-10-11', kind: 'bulk', start: '2026-10-11', end: '2026-10-11', superseded: true, updated_utc: now.toISOString() });
  assert.equal(currentPhase([...a.phases]).id, 'cut-2026-10-11');
});

test('bulk end condition: ~6 months or waist +1.5 in', () => {
  const bulk = { kind: 'bulk', start: '2026-10-09', end: null };
  const s = phaseStatus(bulk, { today: '2026-10-09', measurements: [] });
  assert.equal(s.week, 1);
  assert.equal(s.days, 1);
  assert.equal(s.met, false);
  assert.match(s.endText, /6 months \(to 9 Apr 2027\)/);
  const ms = [{ local_date: '2026-10-09', avg: { waist: 32.0 } }, { local_date: '2027-01-08', avg: { waist: 33.6 } }];
  const s2 = phaseStatus(bulk, { today: '2027-01-08', measurements: ms });
  assert.equal(s2.met, true);
  assert.match(s2.reason, /\+1\.6 in/);
  assert.equal(phaseStatus(bulk, { today: '2027-04-10', measurements: [] }).met, true);
});

test('cut and maintenance end conditions', () => {
  const cut = { kind: 'cut', start: '2026-01-04', end: null, targets: { weight_lb: 165 } };
  assert.equal(phaseStatus(cut, { today: '2026-02-01', trendLb: 170 }).met, false);
  assert.equal(phaseStatus(cut, { today: '2026-02-01', trendLb: 164.9 }).met, true);
  assert.equal(phaseStatus({ ...cut, targets: null }, { today: '2026-04-27' }).met, true, '> 16 weeks');
  const maint = { kind: 'maintenance', start: '2026-01-04', end: null };
  assert.equal(phaseStatus(maint, { today: '2026-02-20' }).met, false);
  assert.equal(phaseStatus(maint, { today: '2026-03-02' }).met, true);
});

test('check-in window: Fri–Sun until done', () => {
  assert.equal(checkinDueDate('2026-10-09', 5), '2026-10-09');
  assert.equal(checkinDueDate('2026-10-12', 5), '2026-10-09');
  assert.deepEqual(checkinState('2026-10-09', 5, []).open, true);
  assert.deepEqual(checkinState('2026-10-11', 5, []).late, true);
  assert.equal(checkinState('2026-10-12', 5, []).open, false);
  assert.equal(checkinState('2026-10-10', 5, [{ local_date: '2026-10-09' }]).done.local_date, '2026-10-09');
  assert.equal(checkinState('2026-10-10', 5, [{ local_date: '2026-10-02' }]).done, null, 'last week does not count');
});

test('adherence from daily taps: Yes 100, Partial 50, Off 0; latest tap per day', () => {
  const taps = [
    { local_date: '2026-10-03', status: 'yes' }, // outside the 7 days
    { local_date: '2026-10-04', status: 'off' }, // first of the 7 days ending 2026-10-10
    { local_date: '2026-10-05', status: 'yes' },
    { local_date: '2026-10-06', status: 'partial' },
    { local_date: '2026-10-07', status: 'off', updated_utc: '1' },
    { local_date: '2026-10-07', status: 'yes', updated_utc: '2' },
  ];
  assert.deepEqual(adherenceFromTaps(taps, '2026-10-10'), { pct: 63, tapped: 4, days: 7 }); // (0 + 100 + 50 + 100) / 4
  assert.deepEqual(adherenceFromTaps([], '2026-10-10'), { pct: null, tapped: 0, days: 7 });
});
