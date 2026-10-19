import type { ColumnInput } from './types.ts';

/** Starting columns for a new list. Every one of them can be changed afterwards. */
export const PRESETS: Record<string, { label: string; columns: ColumnInput[] }> = {
  blank: {
    label: 'Blank',
    columns: [
      { name: 'Name', type: 'text' },
      { name: 'Notes', type: 'text' },
    ],
  },
  shopping: {
    label: 'Shopping',
    columns: [
      { name: 'Got it', type: 'checkbox' },
      { name: 'Item', type: 'text' },
      { name: 'Price', type: 'currency', currency: 'USD' },
      { name: 'Link', type: 'url' },
      { name: 'Photo', type: 'image' },
      { name: 'Notes', type: 'text' },
    ],
  },
  checklist: {
    label: 'Checklist',
    columns: [
      { name: 'Done', type: 'checkbox' },
      { name: 'Task', type: 'text' },
      { name: 'Notes', type: 'text' },
    ],
  },
  tracker: {
    label: 'Tracker',
    columns: [
      { name: 'Name', type: 'text' },
      {
        name: 'Status',
        type: 'select',
        options: [
          { value: 'To do', color: 'gray' },
          { value: 'In progress', color: 'yellow' },
          { value: 'Done', color: 'green' },
        ],
      },
      { name: 'Owner', type: 'text' },
      { name: 'Due', type: 'date' },
      { name: 'Notes', type: 'text' },
    ],
  },
};

export type PresetName = keyof typeof PRESETS;
