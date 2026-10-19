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
  /** How much room the column gets on a wide screen. Unset is normal. */
  width?: ColumnWidth;
  /** Left out of the table and the phone layout, but still in each row's form. */
  hidden?: boolean;
  /** `url` only. Look the page up when a link is added. Unset means on. */
  lookup?: boolean;
  /**
   * `url` only. Which columns a lookup fills, by id. Unset picks the first
   * money column, the first image column and the row's name; null fills nothing.
   */
  fill?: LinkFill;
}

export const COLUMN_WIDTHS = ['narrow', 'normal', 'wide'] as const;
export type ColumnWidth = (typeof COLUMN_WIDTHS)[number];

export interface LinkFill {
  price?: string | null;
  image?: string | null;
  title?: string | null;
}

export type CellValue = string | number | boolean | null;

/** What a lookup found on a linked page, kept with the row. */
export interface LinkInfo {
  url: string;
  status: 'pending' | 'done' | 'failed';
  checked_at: string;
  site?: string;
  title?: string;
  image?: string;
  price?: number;
  currency?: string;
  /** Why a lookup failed, in words a person can act on. */
  error?: string;
}

export interface Item {
  id: string;
  /** Keyed by column id. A missing key and `null` both mean empty. */
  values: Record<string, CellValue>;
  /** Keyed by the id of a `url` column: the last lookup of the link in it. */
  links?: Record<string, LinkInfo>;
  created_at: string;
  updated_at: string;
}

export interface ListView {
  /** A `select` or `checkbox` column to group rows under. */
  group_by: string | null;
  /** The order rows are shown in until someone picks their own. Unset is the list's own order. */
  sort?: { column: string; dir: 'asc' | 'desc' } | null;
}

/** `owner` is only ever an MCP token that created the list; people in a browser are editors or viewers. */
export type Role = 'owner' | 'editor' | 'viewer';

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
  width?: ColumnWidth;
  hidden?: boolean;
  lookup?: boolean;
  fill?: LinkFill;
}
