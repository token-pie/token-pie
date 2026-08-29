/**
 * The two theme palettes the preview and the rendering checks both paint with.
 *
 * One copy, because a second one drifts: a variable added to the panel and to
 * only one of the tables renders as a browser default in the other, which is
 * precisely the failure the preview's own undefined-variable check exists to
 * catch.
 */
export const DARK = {
  'foreground': '#cccccc', 'font-family': 'system-ui, -apple-system, sans-serif',
  'font-size': '13px', 'editor-background': '#1f1f1f',
  'editor-font-family': 'Menlo, Monaco, monospace',
  'descriptionForeground': '#9d9d9d', 'widget-border': '#3c3c3c',
  'editorWidget-background': '#252526', 'editorWidget-border': '#454545',
  'list-hoverBackground': '#2a2d2e', 'charts-foreground': '#cccccc',
  'charts-blue': '#3794ff', 'charts-green': '#89d185', 'charts-purple': '#b180d7',
  'charts-red': '#f14c4c', 'charts-yellow': '#cca700',
  'inputValidation-warningBackground': '#352a05', 'inputValidation-warningBorder': '#b89500',
  'inputValidation-errorBackground': '#5a1d1d', 'inputValidation-errorBorder': '#be1100',
  'textLink-foreground': '#4daafc', 'editorWarning-foreground': '#cca700',
  'editorError-foreground': '#f14c4c',
  'charts-orange': '#d18616', 'panel-border': '#2b2b2b',
  'textBlockQuote-background': '#2a2a2a'
};
export const LIGHT = {
  ...DARK, 'foreground': '#3b3b3b', 'editor-background': '#ffffff',
  'descriptionForeground': '#6a6a6a', 'widget-border': '#d4d4d4',
  'editorWidget-background': '#f8f8f8', 'editorWidget-border': '#c8c8c8',
  'list-hoverBackground': '#f0f0f0', 'charts-foreground': '#3b3b3b',
  'charts-blue': '#1a85ff', 'charts-green': '#388a34', 'charts-purple': '#652d90',
  'inputValidation-warningBackground': '#fff8c5', 'textLink-foreground': '#005fb8', 'editorWarning-foreground': '#bf8803',
  'inputValidation-errorBackground': '#fddede', 'inputValidation-errorBorder': '#be1100',
  'editorError-foreground': '#e51400',
  'charts-orange': '#bf6a02', 'panel-border': '#e5e5e5',
  'textBlockQuote-background': '#f3f3f3'
};

export function vars(theme) {
  return Object.entries(theme).map(([k, v]) => `  --vscode-${k}: ${v};`).join('\n');
}
