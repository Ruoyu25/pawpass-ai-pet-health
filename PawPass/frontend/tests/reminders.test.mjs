import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysBetween, formatDate, getReminders, petAge, reminderLabel } from '../.test-build/reminders.js';

const today = '2026-11-18';
const pet = (records, id = 1) => ({ id, name: 'Pip', species: 'Dog', born_on: '2023-01-01', records });
const record = (id, vaccine, due_on, given_on = '2025-11-01') =>
  ({ id, vaccine, due_on, given_on, pet_id: 1, clinic: '', lot: '', notes: '' });

test('a date due today and the 30th day are upcoming', () => {
  const reminders = getReminders([pet([
    record(1, 'Today', today), record(2, 'Thirty', '2026-12-18'), record(3, 'Thirty-one', '2026-12-19'),
  ])], today);
  assert.deepEqual(reminders.map(({ status, days }) => [status, days]), [['upcoming', 0], ['upcoming', 30]]);
});

test('overdue reminders sort first and missing due dates stay out', () => {
  const reminders = getReminders([pet([
    record(1, 'Later', '2026-11-20'), record(2, 'Past', '2026-11-17'), record(3, 'Unknown', null),
  ])], today);
  assert.deepEqual(reminders.map(({ status, days }) => [status, days]), [['overdue', -1], ['upcoming', 2]]);
  assert.equal(reminderLabel(-1), '1d overdue');
  assert.equal(reminderLabel(0), 'Due today');
  assert.equal(reminderLabel(1), 'In 1 day');
});

test('newer doses supersede old dates only for the same pet and vaccine', () => {
  const reminders = getReminders([
    pet([
      record(3, 'combo   booster', null, '2026-10-01'),
      record(1, 'Combo Booster ', '2026-11-01'),
    ]),
    pet([record(4, 'Combo Booster', '2026-11-01')], 2),
  ], today);
  assert.deepEqual(reminders.map(({ pet: owner, record: { id } }) => [owner.id, id]), [[2, 4]]);
});

test('calendar math is independent of daylight-saving changes', () => {
  assert.equal(daysBetween('2026-03-28', '2026-03-30'), 2);
  assert.equal(formatDate('2026-03-29'), '29 Mar 2026');
});

test('ages respect birthdays and report months for young pets', () => {
  assert.equal(petAge('2022-11-19', today), '3 years old');
  assert.equal(petAge('2026-07-19', today), '3 months old');
  assert.equal(petAge('2026-11-18', today), 'Under 1 month');
});
