/** `layout` namespace dictionaries: mobile overlay chrome (drawer opener, details sheet close). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'sidebar.open': '打开侧栏',
  'details.close': '关闭详情栏',
} satisfies Record<string, string>

/** The layout namespace key union. */
export type LayoutKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'sidebar.open': 'Open sidebar',
  'details.close': 'Close details',
} satisfies Record<LayoutKey, string>
