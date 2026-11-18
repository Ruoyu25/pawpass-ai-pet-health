import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDownUp, ArrowLeft, ArrowRight, ArrowUpRight, Bell, BookOpen, CalendarDays, CalendarClock,
  ChevronRight, CircleAlert, CircleCheck, ClipboardPlus, FlaskConical, LayoutGrid,
  LoaderCircle, PawPrint, Pencil, Plus, ScanLine, ShieldCheck, Syringe, Trash2, X,
} from 'lucide-react';
import { api } from './api';
import { DeleteRecord, PetForm, RecordForm } from './forms';
import { formatDate, getReminders, localDate, petAge, reminderLabel } from './reminders';
import type { Reminder } from './reminders';
import type { Pet, Vaccination, Workspace } from './types';

type View = 'dashboard' | 'pets' | 'records';
type Filter = 'all' | 'upcoming' | 'overdue' | 'attention';
type Mode = 'scan' | 'manual';
type Health = { demo_enabled: boolean; extraction_enabled: boolean };
type Dialog =
  | { kind: 'pet'; pet?: Pet; continueWith?: Mode }
  | { kind: 'add'; petId?: number; mode: Mode }
  | { kind: 'edit' | 'delete'; pet: Pet; record: Vaccination };

const nav = [
  { key: 'dashboard', title: 'Dashboard', icon: LayoutGrid },
  { key: 'pets', title: 'My Pets', icon: PawPrint },
  { key: 'records', title: 'Vaccinations', icon: Syringe },
] as const;
const portraits = new Set(['milo', 'luna', 'cooper']);

function Avatar({ pet }: { pet: Pet }) {
  return <span className={'avatar avatar-' + (pet.avatar ?? 'default')}>
    {pet.avatar && portraits.has(pet.avatar)
      ? <img src={'/images/' + pet.avatar + '.webp'} alt="" />
      : <PawPrint size={23} aria-hidden="true" />}
  </span>;
}

function PetCard({ pet, today, open }: { pet: Pet; today: string; open: () => void }) {
  const count = pet.records.length;
  return <button className="pet-card" onClick={open} aria-label={'Open ' + pet.name + '’s vaccination card'}>
    <div className={'pet-cover cover-' + (pet.avatar ?? 'default')}>
      <Avatar pet={pet} />
      <PawPrint className="pet-watermark" size={90} aria-hidden="true" />
      <span className="pet-open"><ArrowUpRight size={16} /></span>
    </div>
    <div className="pet-info">
      <h3>{pet.name}</h3>
      <p>{pet.species} <span>·</span> {petAge(pet.born_on, today)}</p>
      <div className="pet-record-count"><BookOpen size={14} />{count} {count === 1 ? 'record' : 'records'}</div>
    </div>
  </button>;
}

function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty">
    <span className="empty-icon"><PawPrint size={22} /></span>
    <h3>{title}</h3><p>{description}</p>{action}
  </div>;
}

function Badge({ reminder }: { reminder: Reminder }) {
  return <span className={'badge ' + reminder.status}><span />{reminderLabel(reminder.days)}</span>;
}

function ReminderList({ reminders, open, seeAll }: {
  reminders: Reminder[]; open: (item: Reminder) => void; seeAll: () => void;
}) {
  return <div className="reminder-box">
    {reminders.length ? <>
      <div className="reminder-list">
        {reminders.slice(0, 4).map(item =>
          <button className="reminder-row" key={item.record.id} onClick={() => open(item)}>
            <span className={'reminder-icon ' + item.status}>
              {item.status === 'overdue' ? <CircleAlert size={19} /> : <CalendarClock size={19} />}
            </span>
            <span className="reminder-content"><strong>{item.record.vaccine}</strong>
              <span>{item.pet.name} <span aria-hidden="true">·</span> {formatDate(item.record.due_on!)}</span>
            </span>
            <Badge reminder={item} />
          </button>
        )}
      </div>
      <button className="all-reminders" onClick={seeAll}>View all reminders <ArrowRight size={15} /></button>
    </> : <div className="reminders-clear">
      <span className="reminder-icon upcoming"><CircleCheck size={21} /></span>
      <div><strong>No reminders right now</strong><p>Due dates will appear here as they approach.</p></div>
    </div>}
  </div>;
}

function VaccinationCard({ pet, record, reminder, edit, remove }: {
  pet: Pet; record: Vaccination; reminder?: Reminder; edit: () => void; remove: () => void;
}) {
  return <article className="record-card">
    <div className="record-top">
      <span className="record-icon"><Syringe size={21} /></span>
      <div><h3>{record.vaccine}</h3><p>{pet.name} · {pet.species}</p></div>
      <div className="record-tools">
        <button className="icon-button" aria-label={'Edit ' + record.vaccine + ' for ' + pet.name} onClick={edit}><Pencil size={16} /></button>
        <button className="icon-button delete-icon" aria-label={'Delete ' + record.vaccine + ' for ' + pet.name} onClick={remove}><Trash2 size={16} /></button>
      </div>
    </div>
    <dl className="record-details">
      <div><dt>Date given</dt><dd>{formatDate(record.given_on)}</dd></div>
      <div><dt>Next due</dt><dd>{record.due_on ? formatDate(record.due_on) : '—'}</dd></div>
      {record.clinic && <div><dt>Clinic</dt><dd>{record.clinic}</dd></div>}
      {record.lot && <div><dt>Batch or lot</dt><dd>{record.lot}</dd></div>}
    </dl>
    {record.notes && <p className="record-notes">{record.notes}</p>}
    <div className="record-bottom">
      {reminder ? <Badge reminder={reminder} /> : <span className="badge neutral">{record.due_on ? 'Recorded' : 'No due date'}</span>}
    </div>
  </article>;
}

export function App() {
  const [health, setHealth] = useState<Health>();
  const [workspace, setWorkspace] = useState<Workspace>(() =>
    new URLSearchParams(window.location.search).get('workspace') === 'demo' ? 'demo' : 'personal');
  const [pets, setPets] = useState<Pet[]>([]);
  const [view, setView] = useState<View>('dashboard');
  const [petFilter, setPetFilter] = useState<number>();
  const [filter, setFilter] = useState<Filter>('all');
  const [dialog, setDialog] = useState<Dialog>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [toast, setToast] = useState('');
  const [today, setToday] = useState(localDate);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    setLoading(true);
    setError('');
    api<Health>('/health', 'personal', { signal }).then(async status => {
      if (signal.aborted) return;
      setHealth(status);
      if (workspace === 'demo' && !status.demo_enabled) {
        switchWorkspace('personal');
        return;
      }
      const data = await api<{ pets: Pet[] }>('/dashboard', workspace, { signal });
      if (!signal.aborted) {
        setPets(data.pets);
        setLoading(false);
      }
    }).catch(err => {
      if (signal.aborted) return;
      setError(err.message);
      setLoading(false);
    });
    return () => controller.abort();
  }, [workspace, retry]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(''), 4500);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const refreshDate = () => setToday(localDate());
    const interval = window.setInterval(refreshDate, 30_000);
    window.addEventListener('focus', refreshDate);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', refreshDate); };
  }, []);

  function switchWorkspace(next: Workspace) {
    const url = new URL(window.location.href);
    if (next === 'demo') url.searchParams.set('workspace', 'demo');
    else url.searchParams.delete('workspace');
    window.history.replaceState(null, '', url);
    setPets([]);
    setToast('');
    setLoading(true);
    setWorkspace(next);
    navigate('dashboard');
  }

  function navigate(next: View, petId?: number, nextFilter: Filter = 'all') {
    setView(next);
    setPetFilter(petId);
    setFilter(nextFilter);
    window.scrollTo({ top: 0 });
  }

  function startRecord(mode: Mode, petId?: number) {
    if (!pets.length) setDialog({ kind: 'pet', continueWith: mode });
    else setDialog({ kind: 'add', petId, mode });
  }

  function saveRecords(petId: number, updated: Vaccination[]) {
    const replaced = new Set(updated.map(record => record.id));
    setPets(current => current.map(pet => pet.id === petId ? {
      ...pet, records: [...updated, ...pet.records.filter(record => !replaced.has(record.id))]
        .sort((a, b) => b.given_on.localeCompare(a.given_on) || b.id - a.id),
    } : pet));
    setToast(updated.length === 1 ? 'Vaccination saved.' : updated.length + ' vaccinations saved.');
    if (view === 'records') {
      setPetFilter(petId);
      setFilter('all');
    }
    setDialog(undefined);
  }

  const reminders = getReminders(pets, today);
  const upcoming = reminders.filter(item => item.status === 'upcoming');
  const overdue = reminders.filter(item => item.status === 'overdue');
  const reminderById = new Map(reminders.map(item => [item.record.id, item]));
  const pet = pets.find(item => item.id === petFilter);
  const displayRecords = (pet ? [pet] : pets).flatMap(item =>
    item.records.map(record => ({ pet: item, record })))
    .filter(({ record }) => {
      const status = reminderById.get(record.id)?.status;
      return filter === 'all' || (filter === 'attention' ? !!status : status === filter);
    })
    .sort((a, b) => filter === 'all'
      ? b.record.given_on.localeCompare(a.record.given_on) || b.record.id - a.record.id
      : reminderById.get(a.record.id)!.days - reminderById.get(b.record.id)!.days || a.record.id - b.record.id);
  const currentNav = nav.find(item => item.key === view)!;
  const CurrentIcon = currentNav.icon;
  const ready = !loading && !error;

  return <div className="shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('dashboard')} aria-label="PawPass dashboard">
        <span className="brand-mark"><PawPrint size={22} strokeWidth={2.35} /></span>
        <span>Paw<span>Pass</span></span>
      </button>
      <nav className="navigation" aria-label="Main navigation">
        {nav.map(({ key, title, icon: Icon }) => <button key={key} aria-current={view === key ? 'page' : undefined}
          className={view === key ? 'nav-item active' : 'nav-item'} onClick={() => navigate(key)}>
          <Icon size={19} strokeWidth={1.8} /><span>{title}</span>{view === key && <ChevronRight className="nav-chevron" size={15} />}
        </button>)}
      </nav>
      <div className="workspace">
        <div className="workspace-info">
          <span className="workspace-icon">{workspace === 'demo' ? <FlaskConical size={17} /> : <ShieldCheck size={18} />}</span>
          <div><strong>{workspace === 'demo' ? 'Demo workspace' : 'Personal workspace'}</strong>
            <small>{workspace === 'demo' ? 'Fictional sample records' : 'Records saved locally'}</small></div>
        </div>
        {health?.demo_enabled && <button className="workspace-switch" disabled={loading}
          onClick={() => switchWorkspace(workspace === 'demo' ? 'personal' : 'demo')}>
          <ArrowDownUp size={13} />{workspace === 'demo' ? 'Switch to personal' : 'Open demo'}
        </button>}
      </div>
    </aside>

    <div className="app">
      <header className="topbar">
        <div className="location"><CurrentIcon size={18} /><span>{currentNav.title}</span></div>
        <div className="top-actions">
          <span className="today"><CalendarDays size={16} />{formatDate(today)}</span>
          <button className="button primary" onClick={() => startRecord('scan', petFilter)} disabled={!ready}><ScanLine size={17} />Scan booklet</button>
        </div>
      </header>

      <main id="main-content" ref={main} tabIndex={-1} className="content">
        {loading ? <div className="load-state" role="status"><LoaderCircle className="spin" size={23} />Loading PawPass…</div>
          : error ? <div role="alert"><Empty title="PawPass could not load" description={error}
            action={<button className="button primary" onClick={() => setRetry(value => value + 1)}>Try again</button>} /></div>
          : view === 'dashboard' ? <>
            <section className="hero" aria-labelledby="hero-title">
              <div className="hero-art" aria-hidden="true"><img src="/images/hero.webp" alt="" /></div>
              <div className="hero-copy">
                <h1 id="hero-title">A healthier pack,<br /> one record at a time.</h1>
                <p>Track vaccinations and stay ahead of your pets’ next doses.</p>
                <button className="button primary" onClick={() => startRecord('manual')}><Plus size={18} />Add vaccination</button>
              </div>
            </section>
            <div className="stats" aria-label="Vaccination summary">
              {([
                { title: 'Pet profiles', count: pets.length, Icon: PawPrint, tone: 'green', action: () => navigate('pets') },
                { title: 'Due in 30 days', count: upcoming.length, Icon: CalendarClock, tone: 'gold', action: () => navigate('records', undefined, 'upcoming') },
                { title: 'Overdue', count: overdue.length, Icon: CircleAlert, tone: 'rose', action: () => navigate('records', undefined, 'overdue') },
              ]).map(({ title, count, Icon, tone, action }) =>
                <button className="stat" key={title} onClick={action}>
                  <span className={'stat-icon ' + tone}><Icon size={22} strokeWidth={1.9} /></span>
                  <span className="stat-copy"><span>{title}</span><strong>{count}</strong></span>
                  <ChevronRight size={17} className="stat-arrow" />
                </button>)}
            </div>
            <div className="dashboard-grid">
              <section aria-labelledby="dashboard-pets">
                <div className="section-heading">
                  <div><h2 id="dashboard-pets">My pets</h2><p>Vaccination cards for every pet</p></div>
                  <button className="button secondary" onClick={() => setDialog({ kind: 'pet' })}><Plus size={16} />Add pet</button>
                </div>
                {pets.length ? <>
                  <div className="pet-grid">{pets.slice(0, 3).map(item =>
                    <PetCard key={item.id} pet={item} today={today} open={() => navigate('records', item.id)} />)}</div>
                  {pets.length > 3 && <button className="text-button more-pets" onClick={() => navigate('pets')}>View all {pets.length} pets <ArrowRight size={15} /></button>}
                </> : <Empty title="Add your first pet" description="Create a profile to start saving vaccinations."
                  action={<button className="button primary" onClick={() => setDialog({ kind: 'pet' })}><Plus size={16} />Add pet</button>} />}
              </section>
              <section aria-labelledby="dashboard-reminders">
                <div className="section-heading">
                  <div><h2 id="dashboard-reminders">Reminders</h2><p>Overdue and due in the next 30 days</p></div>
                  <span className="section-icon"><Bell size={17} /></span>
                </div>
                <ReminderList reminders={reminders}
                  open={item => setDialog({ kind: 'edit', pet: item.pet, record: item.record })}
                  seeAll={() => navigate('records', undefined, 'attention')} />
              </section>
            </div>
          </> : view === 'pets' ? <>
            <div className="page-heading">
              <div><h1>My pets</h1><p>Open a profile to see its vaccination history.</p></div>
              <button className="button primary" onClick={() => setDialog({ kind: 'pet' })}><Plus size={17} />Add pet</button>
            </div>
            {pets.length ? <div className="pet-grid all-pets">{pets.map(item =>
              <PetCard key={item.id} pet={item} today={today} open={() => navigate('records', item.id)} />)}</div>
              : <Empty title="Add your first pet" description="Create a profile to start saving vaccinations." />}
          </> : <>
            {pet && <button className="text-button back-link" onClick={() => navigate('pets')}><ArrowLeft size={16} /> My pets</button>}
            <div className="page-heading">
              <div className="profile-heading">
                {pet && <Avatar pet={pet} />}
                <div>
                  <h1>{pet ? pet.name : 'Vaccinations'}</h1>
                  <p>{pet ? pet.species + ' · Born ' + formatDate(pet.born_on) : 'Review vaccination records and due dates across your pets.'}</p>
                </div>
              </div>
              <div className="heading-actions">
                {pet && <button className="button secondary" onClick={() => setDialog({ kind: 'pet', pet })}><Pencil size={16} />Edit pet</button>}
                <button className="button primary" onClick={() => startRecord('manual', petFilter)}><Plus size={17} />Add vaccination</button>
              </div>
            </div>
            {pets.length > 0 && <div className="record-filters">
              <label>Pet<select value={petFilter ?? ''} onChange={event => setPetFilter(event.target.value ? +event.target.value : undefined)}>
                <option value="">All pets</option>{pets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select></label>
              <label>Status<select value={filter} onChange={event => setFilter(event.target.value as Filter)}>
                <option value="all">All records</option><option value="attention">All reminders</option>
                <option value="upcoming">Due in 30 days</option><option value="overdue">Overdue</option>
              </select></label>
              <span>{displayRecords.length} {displayRecords.length === 1 ? 'record' : 'records'}</span>
            </div>}
            {displayRecords.length ? <div className="record-grid">{displayRecords.map(({ pet: owner, record }) =>
              <VaccinationCard key={record.id} pet={owner} record={record} reminder={reminderById.get(record.id)}
                edit={() => setDialog({ kind: 'edit', pet: owner, record })}
                remove={() => setDialog({ kind: 'delete', pet: owner, record })} />)}</div>
              : <Empty title={filter === 'all' ? 'No vaccinations yet' : 'No matching reminders'}
                description={filter === 'all' ? 'Scan a booklet or add a record manually.' : 'Choose another status or view all records.'}
                action={filter === 'all'
                  ? <button className="button secondary" onClick={() => startRecord('scan', petFilter)}><ScanLine size={16} />Scan booklet</button>
                  : <button className="button secondary" onClick={() => setFilter('all')}>View all records</button>} />}
          </>}
        {ready && view === 'dashboard' && pets.length > 0 && <div className="bottom-note">
          <ClipboardPlus size={17} /><span>Have a paper vaccination booklet?</span>
          <button className="text-button" onClick={() => startRecord('scan')}>Scan a page <ArrowRight size={14} /></button>
        </div>}
      </main>
    </div>

    {dialog?.kind === 'pet' && <PetForm pet={dialog.pet} workspace={workspace} close={() => setDialog(undefined)}
      saved={item => {
        setPets(current => dialog.pet ? current.map(existing => existing.id === item.id ? item : existing) : [...current, item]);
        setToast(dialog.pet ? 'Pet profile updated.' : item.name + ' added to PawPass.');
        setDialog(dialog.continueWith ? { kind: 'add', mode: dialog.continueWith, petId: item.id } : undefined);
      }} />}
    {dialog && (dialog.kind === 'add' || dialog.kind === 'edit') && health && <RecordForm
      pets={pets} petId={dialog.kind === 'add' ? dialog.petId : dialog.pet.id}
      record={dialog.kind === 'edit' ? dialog.record : undefined}
      initialMode={dialog.kind === 'add' ? dialog.mode : 'manual'} workspace={workspace} health={health}
      close={() => setDialog(undefined)} saved={saveRecords} />}
    {dialog?.kind === 'delete' && <DeleteRecord workspace={workspace} pet={dialog.pet} record={dialog.record}
      close={() => setDialog(undefined)} deleted={() => {
        setPets(current => current.map(item => item.id === dialog.pet.id ? {
          ...item, records: item.records.filter(record => record.id !== dialog.record.id),
        } : item));
        setToast('Vaccination deleted.');
        setDialog(undefined);
      }} />}
    {toast && <div className="toast" role="status"><CircleCheck size={18} />{toast}
      <button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast('')}><X size={16} /></button></div>}
  </div>;
}
