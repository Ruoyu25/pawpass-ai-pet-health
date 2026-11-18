import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { AlertCircle, ArrowRight, Camera, FileImage, LoaderCircle, PenLine, Plus, ScanLine, Trash2, X } from 'lucide-react';
import { api, ApiError } from './api';
import { localDate } from './reminders';
import type { ExtractedRecord, Pet, PetDraft, Vaccination, VaccinationDraft, Workspace } from './types';

type Fields = Record<string, string>;
type Health = { extraction_enabled: boolean };

function Modal({ title, subtitle, close, busy, children }: {
  title: string; subtitle: string; close: () => void; busy: boolean; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog ref={dialog} className="modal" aria-labelledby={titleId} aria-describedby={descId}
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
      <div className="modal-heading">
        <div><h2 id={titleId}>{title}</h2><p id={descId}>{subtitle}</p></div>
        <button className="icon-button" type="button" onClick={close} aria-label="Close dialog" disabled={busy}><X size={20} /></button>
      </div>
      {children}
    </dialog>
  );
}

function Field({ label, value, set, error, type = 'text', maxLength, min, max, optional, multiline, hint }: {
  label: string; value: string; set: (value: string) => void; error?: string; type?: string;
  maxLength?: number; min?: string; max?: string; optional?: boolean; multiline?: boolean; hint?: string;
}) {
  const id = useId();
  const common = {
    id, value, maxLength, 'aria-invalid': !!error,
    'aria-describedby': error ? id + '-error' : hint ? id + '-hint' : undefined,
  };
  return <div className="field">
    <label htmlFor={id}>{label} {optional && <span>Optional</span>}</label>
    {multiline
      ? <textarea {...common} onChange={event => set(event.target.value)} rows={2} />
      : <input {...common} type={type} min={min} max={max} onChange={event => set(event.target.value)} />}
    {error ? <small id={id + '-error'} className="field-error" role="alert">{error}</small>
      : hint && <small id={id + '-hint'}>{hint}</small>}
  </div>;
}

function Notice({ message }: { message: string }) {
  return <div className="form-notice" role="alert"><AlertCircle size={18} />{message}</div>;
}

export function PetForm({ pet, workspace, close, saved }: {
  pet?: Pet; workspace: Workspace; close: () => void; saved: (pet: Pet) => void;
}) {
  const [draft, setDraft] = useState<PetDraft>(pet ? { name: pet.name, species: pet.species, born_on: pet.born_on }
    : { name: '', species: '', born_on: '' });
  const [errors, setErrors] = useState<Fields>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (key: keyof PetDraft, value: string) => {
    setDraft(current => ({ ...current, [key]: value }));
    setErrors(current => ({ ...current, [key]: '' }));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next: Fields = {};
    if (!draft.name.trim()) next.name = 'Enter your pet’s name.';
    if (!draft.species.trim()) next.species = 'Enter your pet’s species.';
    if (!draft.born_on) next.born_on = 'Enter the date of birth.';
    else if (draft.born_on > localDate()) next.born_on = 'Date of birth cannot be in the future.';
    setErrors(next);
    setNotice('');
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const result = await api<Pet>(pet ? '/pets/' + pet.id : '/pets', workspace, {
        method: pet ? 'PUT' : 'POST', body: JSON.stringify(draft),
      });
      saved(pet ? { ...result, records: pet.records } : result);
    } catch (error) {
      if (error instanceof ApiError) setErrors(error.fields);
      setNotice(error instanceof Error ? error.message : 'Could not save the pet profile.');
    } finally {
      setBusy(false);
    }
  };
  return <Modal title={pet ? 'Edit pet profile' : 'Add a pet'} subtitle="Keep a separate vaccination history for each pet." close={close} busy={busy}>
    <form noValidate onSubmit={save}>
      <div className="modal-body">
        {notice && <Notice message={notice} />}
        <fieldset disabled={busy}>
          <Field label="Pet name" value={draft.name} set={value => update('name', value)} maxLength={60} error={errors.name} />
          <Field label="Species" value={draft.species} set={value => update('species', value)} maxLength={40} hint="For example, dog or cat." error={errors.species} />
          <Field label="Date of birth" value={draft.born_on} set={value => update('born_on', value)} type="date" max={localDate()} error={errors.born_on} />
        </fieldset>
      </div>
      <div className="modal-actions">
        <button className="button secondary" type="button" onClick={close} disabled={busy}>Cancel</button>
        <button className="button primary" disabled={busy}>{busy && <LoaderCircle size={17} className="spin" />}Save pet</button>
      </div>
    </form>
  </Modal>;
}

const blank: VaccinationDraft = { vaccine: '', given_on: '', due_on: '', clinic: '', lot: '', notes: '' };

interface ReviewRow {
  key: number;
  draft: VaccinationDraft;
  asWritten?: { given: string | null; due: string | null };
}

export function RecordForm({ pets, petId, record, initialMode, workspace, health, close, saved }: {
  pets: Pet[]; petId?: number; record?: Vaccination; initialMode: 'scan' | 'manual';
  workspace: Workspace; health: Health; close: () => void;
  saved: (petId: number, records: Vaccination[]) => void;
}) {
  const [selected, setSelected] = useState(petId ?? pets[0]?.id);
  const [mode, setMode] = useState<'scan' | 'manual' | 'review'>(initialMode);
  const [rows, setRows] = useState<ReviewRow[]>([{ key: 0, draft: record ? {
    vaccine: record.vaccine, given_on: record.given_on, due_on: record.due_on ?? '',
    clinic: record.clinic, lot: record.lot, notes: record.notes,
  } : { ...blank } }]);
  const nextKey = useRef(1);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState('');
  const [errors, setErrors] = useState<Fields>({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selectId = useId();
  const pet = pets.find(item => item.id === selected);
  const workspaceName = pet?.name ?? 'the selected pet';

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (candidate?: File) => {
    if (!candidate || busy) return;
    const supported = ['image/jpeg', 'image/png', 'image/webp'];
    if (!supported.includes(candidate.type)) {
      setNotice('Choose a JPEG, PNG or WebP image.');
    } else if (candidate.size > 8 * 1024 * 1024) {
      setNotice('Choose a photo no larger than 8 MB.');
    } else {
      setFile(candidate);
      setNotice('');
    }
    if (input.current) input.current.value = '';
  };

  const scan = async () => {
    if (!file || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api<{ records: ExtractedRecord[] }>('/extract', workspace, {
        method: 'POST', body: file, headers: { 'Content-Type': file.type },
      });
      if (result.records.length === 0) {
        setNotice('No readable vaccination entries were found. Try another photo or enter the details manually.');
        return;
      }
      setRows(result.records.map(item => ({
        key: nextKey.current++,
        draft: {
          vaccine: item.vaccine ?? '', given_on: item.given_on ?? '', due_on: item.due_on ?? '',
          clinic: item.clinic ?? '', lot: item.lot ?? '', notes: '',
        },
        asWritten: { given: item.given_as_written, due: item.due_as_written },
      })));
      setMode('review');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The photo could not be read. You can enter the details manually.');
    } finally {
      setBusy(false);
    }
  };

  const update = (index: number, key: keyof VaccinationDraft, value: string) => {
    setRows(items => items.map((item, i) => i === index ? { ...item, draft: { ...item.draft, [key]: value } } : item));
    setErrors(current => ({ ...current, [index + '.' + key]: '' }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || mode === 'scan') return;
    const next: Fields = {};
    setNotice('');
    if (!pet) {
      setErrors({ pet: 'Choose a pet.' });
      return;
    }
    const today = localDate();
    rows.forEach(({ draft }, index) => {
      if (!draft.vaccine.trim()) next[index + '.vaccine'] = 'Enter the vaccination name.';
      if (!draft.given_on) next[index + '.given_on'] = 'Enter the date given.';
      else if (draft.given_on > today) next[index + '.given_on'] = 'Date given cannot be in the future.';
      else if (draft.given_on < pet.born_on) next[index + '.given_on'] = 'Date given cannot precede the pet’s birth.';
      if (draft.due_on && draft.given_on && draft.due_on < draft.given_on) {
        next[index + '.due_on'] = 'Next due date must be on or after the date given.';
      }
    });
    setErrors(next);
    if (Object.keys(next).length) return;
    const payload = rows.map(({ draft }) => ({ ...draft, due_on: draft.due_on || null }));
    setBusy(true);
    try {
      const path = '/pets/' + pet.id + '/vaccinations';
      if (record) {
        const result = await api<Vaccination>(path + '/' + record.id, workspace, {
          method: 'PUT', body: JSON.stringify(payload[0]),
        });
        saved(pet.id, [result]);
      } else {
        const result = await api<{ records: Vaccination[] }>(path, workspace, {
          method: 'POST', body: JSON.stringify({ records: payload }),
        });
        saved(pet.id, result.records);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(Object.fromEntries(Object.entries(error.fields).map(([field, message]) => [
          record ? '0.' + field : field.replace(/^records\./, ''), message,
        ])));
      }
      setNotice(error instanceof Error ? error.message : 'Could not save the vaccination.');
    } finally {
      setBusy(false);
    }
  };

  const title = record ? 'Edit vaccination' : mode === 'scan' ? 'Scan a booklet' : mode === 'review' ? 'Review extracted records' : 'Add vaccination';
  const subtitle = mode === 'scan' ? 'Upload a clear photo of one vaccination page.'
    : mode === 'review' ? 'Compare each draft with your photo and fill in any missing details.'
    : 'Enter the details from the vaccination record.';

  return <Modal title={title} subtitle={subtitle} close={close} busy={busy}>
    <form noValidate onSubmit={save}>
      <div className="modal-body">
        {notice && <Notice message={notice} />}
        <fieldset disabled={busy}>
          <div className="field">
            <label htmlFor={selectId}>Pet</label>
            <select id={selectId} value={selected ?? ''} disabled={!!record || busy}
              aria-invalid={!!errors.pet}
              onChange={event => { setSelected(+event.target.value); setErrors({}); }}>
              {pets.map(item => <option value={item.id} key={item.id}>{item.name} · {item.species}</option>)}
            </select>
            {errors.pet && <small className="field-error" role="alert">{errors.pet}</small>}
          </div>
          {mode === 'scan' ? <>
            <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden
              onChange={event => choose(event.target.files?.[0])} />
            <button className={'upload-zone' + (dragging ? ' dragging' : '')} type="button"
              onClick={() => input.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }}>
              {preview ? <img src={preview} alt="Selected booklet page" /> : <span className="upload-icon"><Camera size={24} /></span>}
              <strong>{file ? file.name : 'Choose a photo or drop it here'}</strong>
              <span>{file ? 'Click to replace photo' : 'JPEG, PNG or WebP · Up to 8 MB'}</span>
            </button>
            {health.extraction_enabled
              ? <p className="scan-note">Your photo is sent to Gemini for transcription. PawPass keeps only the records you choose to save.</p>
              : <Notice message="Gemini isn’t configured. You can enter vaccination details manually." />}
          </> : <>
            {preview && <details className="review-photo">
              <summary><FileImage size={16} /> Show booklet photo</summary>
              <a href={preview} target="_blank" rel="noreferrer"><img src={preview} alt="Open the full-size booklet photo in a new tab" /></a>
            </details>}
            {rows.map(({ key, draft, asWritten }, index) => (
              <div className="review-row" key={key}>
                {rows.length > 1 && <div className="review-heading">
                  <strong>Record {index + 1}</strong>
                  <button type="button" className="icon-button" aria-label={'Remove draft ' + (index + 1)}
                    onClick={() => { setRows(items => items.filter(item => item.key !== key)); setErrors({}); }}><X size={17} /></button>
                </div>}
                <Field label="Vaccination name" value={draft.vaccine} set={value => update(index, 'vaccine', value)} maxLength={120} error={errors[index + '.vaccine']} />
                <div className="form-grid">
                  <Field label="Date given" type="date" value={draft.given_on}
                    set={value => update(index, 'given_on', value)} min={pet?.born_on} max={localDate()}
                    hint={asWritten?.given ? 'Read from photo: ' + asWritten.given : undefined} error={errors[index + '.given_on']} />
                  <Field label="Next due date" type="date" optional value={draft.due_on} min={draft.given_on || undefined}
                    set={value => update(index, 'due_on', value)} hint={asWritten?.due ? 'Read from photo: ' + asWritten.due : undefined}
                    error={errors[index + '.due_on']} />
                  <Field label="Clinic" optional value={draft.clinic} set={value => update(index, 'clinic', value)}
                    maxLength={120} error={errors[index + '.clinic']} />
                  <Field label="Batch or lot number" optional value={draft.lot} set={value => update(index, 'lot', value)}
                    maxLength={80} error={errors[index + '.lot']} />
                </div>
                <Field label="Notes" optional multiline value={draft.notes} set={value => update(index, 'notes', value)}
                  maxLength={500} error={errors[index + '.notes']} />
              </div>
            ))}
            {!record && rows.length < 30 && <button type="button" className="button secondary"
              onClick={() => setRows(items => [...items, { key: nextKey.current++, draft: { ...blank } }])}>
              <Plus size={16} /> Add another record
            </button>}
          </>}
        </fieldset>
      </div>
      <div className="modal-actions">
        {mode === 'scan' ? <>
          <button className="button secondary" type="button" disabled={busy}
            onClick={() => { setMode('manual'); setNotice(''); }}><PenLine size={16} />Enter manually</button>
          <button className="button primary" type="button" onClick={scan} disabled={!file || busy || !health.extraction_enabled}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <ScanLine size={17} />}{busy ? 'Reading photo…' : 'Extract records'}
          </button>
        </> : <>
          <button className="button secondary" type="button" onClick={close} disabled={busy}>Cancel</button>
          <button className="button primary" disabled={busy}>
            {busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={16} />}
            {record ? 'Save changes' : 'Save ' + (rows.length > 1 ? rows.length + ' records' : 'record') + ' to ' + workspaceName}
          </button>
        </>}
      </div>
    </form>
  </Modal>;
}

export function DeleteRecord({ pet, record, workspace, close, deleted }: {
  pet: Pet; record: Vaccination; workspace: Workspace; close: () => void; deleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  return <Modal title="Delete vaccination?" subtitle={record.vaccine + ' will be removed from ' + pet.name + '’s vaccination history.'} close={close} busy={busy}>
    {notice && <div className="modal-body"><Notice message={notice} /></div>}
    <div className="modal-actions">
      <button className="button secondary" onClick={close} disabled={busy}>Cancel</button>
      <button className="button danger" disabled={busy} onClick={async () => {
        setBusy(true);
        setNotice('');
        try {
          await api('/pets/' + pet.id + '/vaccinations/' + record.id, workspace, { method: 'DELETE' });
          deleted();
        } catch (error) {
          setNotice(error instanceof Error ? error.message : 'Could not delete the record.');
        } finally {
          setBusy(false);
        }
      }}><Trash2 size={16} />Delete record</button>
    </div>
  </Modal>;
}
