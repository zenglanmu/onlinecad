/** Small display helpers shared by the UI components. */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`
}

/** `12345` → `12,345`. */
export function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—'
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function baseName(fileName: string): string {
  const trimmed = fileName.trim() || 'drawing'
  return trimmed.replace(/\.[^./\\]+$/, '') || 'drawing'
}

/** `plan.dwg` + `.dxf` → `plan.dxf`. */
export function replaceExtension(fileName: string, extension: string): string {
  const normalized = extension.startsWith('.') ? extension : `.${extension}`
  return `${baseName(fileName)}${normalized}`
}

/** Human labels for the DXF entity-type histogram. */
const ENTITY_TYPE_LABELS: Record<string, string> = {
  LINE: '直线',
  LWPOLYLINE: '轻量多段线',
  POLYLINE: '多段线',
  CIRCLE: '圆',
  ARC: '圆弧',
  ELLIPSE: '椭圆',
  SPLINE: '样条曲线',
  TEXT: '单行文字',
  MTEXT: '多行文字',
  DIMENSION: '标注',
  HATCH: '填充',
  INSERT: '块参照',
  POINT: '点',
  SOLID: '实体',
  '3DFACE': '三维面',
  MESH: '网格',
  RAY: '射线',
  XLINE: '构造线',
  VIEWPORT: '视口',
  LEADER: '引线',
  MULTILEADER: '多重引线',
  MLINE: '多线',
  TABLE: '表格',
  IMAGE: '图像',
  WIPEOUT: '遮罩',
  REGION: '面域',
  BODY: '体',
  '3DSOLID': '三维实体',
  SURFACE: '曲面',
  UNKNOWN: '未知'
}

export function entityTypeLabel(entityType: string): string {
  return ENTITY_TYPE_LABELS[entityType] ?? entityType
}

/** `AC1032` → `AutoCAD 2018+`. */
const VERSION_LABELS: Record<string, string> = {
  AC1009: 'R12',
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018+',
  UNKNOWN: '未知版本'
}

export function cadVersionLabel(version: string | null): string {
  if (!version) return '—'
  const label = VERSION_LABELS[version]
  return label ? `${version} · ${label}` : version
}
