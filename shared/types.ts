// Types shared by the server, the web client and the MCP tools. Anything here
// is part of the public shape of a list, so changes are API changes.

export const COLUMN_TYPES = [
  'text',
  'number',
  'currency',
  'url',
  'image',
  'checkbox',
  'select',
  'date',
] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Named rather than hex so a list's custom CSS can restyle every tag at once. */
export const TAG_COLORS = [
  'gray',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export interface SelectOption {
  value: string;
  color: TagColor;
}

export interface Column {
  /** Stable key. Derived from the first name and kept through renames, so CSS can target it. */
  id: string;
  name: string;
  type: ColumnType;
  /** `select` only. */
  options?: SelectOption[];
  /** `currency` only. ISO 4217 code. */
  currency?: string;
}

export type CellValue = string | number | boolean | null;

export interface Item {
  id: string;
  /** Keyed by column id. A missing key and `null` both mean empty. */
  values: Record<string, CellValue>;
  created_at: string;
  updated_at: string;
}

export interface ListView {
  /** A `select` or `checkbox` column to group rows under. */
  group_by: string | null;
}

export type Role = 'admin' | 'editor' | 'viewer';

/** A list as the web client and `get_list` see it. */
export interface ListPayload {
  id: string;
  url: string;
  title: string;
  description: string;
  editable: boolean;
  columns: Column[];
  items: Item[];
  view: ListView;
  version: number;
  has_css: boolean;
  /** Changes whenever the custom CSS does, so the page knows to reload it. */
  css_rev: string;
  created_at: string;
  updated_at: string;
  role: Role;
}

export interface ListSummary {
  id: string;
  url: string;
  title: string;
  items: number;
  editable: boolean;
  created_at: string;
  updated_at: string;
}

export interface ColumnInput {
  name: string;
  type?: ColumnType;
  options?: (string | { value: string; color?: TagColor })[];
  currency?: string;
}
