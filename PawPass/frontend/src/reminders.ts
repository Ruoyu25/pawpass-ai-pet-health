import type { Pet, Vaccination } from './types';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
});

export function localDate(value = new Date()) {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  return [year, month, String(value.getDate()).padStart(2, '0')].join('-');
}

export function formatDate(value: string) {
  return dateFormatter.format(new Date(value + 'T00:00:00Z'));
}

export function daysBetween(from: string, to: string) {
  return (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000;
}

export function petAge(born: string, today: string) {
  const years = +today.slice(0, 4) - +born.slice(0, 4) - Number(today.slice(5) < born.slice(5));
  if (years > 0) return years + (years === 1 ? ' year old' : ' years old');
  const months = (+today.slice(0, 4) - +born.slice(0, 4)) * 12
    + +today.slice(5, 7) - +born.slice(5, 7)
    - Number(today.slice(8) < born.slice(8));
  return months > 0 ? months + (months === 1 ? ' month old' : ' months old') : 'Under 1 month';
}

export interface Reminder {
  pet: Pet;
  record: Vaccination;
  days: number;
  status: 'overdue' | 'upcoming';
}

export function getReminders(pets: Pet[], today: string): Reminder[] {
  const reminders: Reminder[] = [];
  for (const pet of pets) {
    const latest = new Map<string, Vaccination>();
    for (const record of pet.records) {
      const label = record.vaccine.trim().replace(/\s+/g, ' ').toLowerCase();
      const existing = latest.get(label);
      if (!existing || record.given_on > existing.given_on
        || (record.given_on === existing.given_on && record.id > existing.id)) {
        latest.set(label, record);
      }
    }
    for (const record of latest.values()) {
      if (!record.due_on) continue;
      const days = daysBetween(today, record.due_on);
      if (days <= 30) reminders.push({ pet, record, days, status: days < 0 ? 'overdue' : 'upcoming' });
    }
  }
  return reminders.sort((a, b) => a.days - b.days || a.record.id - b.record.id);
}

export function reminderLabel(days: number) {
  if (days < 0) return Math.abs(days) + 'd overdue';
  if (days === 0) return 'Due today';
  return 'In ' + days + (days === 1 ? ' day' : ' days');
}
