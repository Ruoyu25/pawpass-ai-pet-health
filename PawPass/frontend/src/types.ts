export interface VaccinationDraft {
  vaccine: string;
  given_on: string;
  due_on: string;
  clinic: string;
  lot: string;
  notes: string;
}

export interface Vaccination extends Omit<VaccinationDraft, 'due_on'> {
  id: number;
  pet_id: number;
  due_on: string | null;
}

export interface Pet {
  id: number;
  name: string;
  species: string;
  born_on: string;
  avatar: string | null;
  records: Vaccination[];
}

export type PetDraft = Pick<Pet, 'name' | 'species' | 'born_on'>;
export type Workspace = 'personal' | 'demo';

export type ExtractedRecord = {
  [K in Exclude<keyof VaccinationDraft, 'notes'>]: string | null;
} & { given_as_written: string | null; due_as_written: string | null };
