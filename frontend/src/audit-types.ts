export const viewports = [
  { id: 'phone', label: '手机', width: 390, height: 844 },
  { id: 'compact', label: '小屏', width: 360, height: 800 },
  { id: 'tablet', label: '平板', width: 768, height: 1024 },
  { id: 'desktop', label: '桌面', width: 1440, height: 900 },
] as const;

export type Capture = { url: string; width: number; height: number; updatedAt: string };
export type Screen = {
  id: string; index: number; title: string; category: string; summary: string;
  controls: string[]; width: number; height: number; reference: string;
  transitions: { to: string; action: string; confidence: string }[];
  captures: Record<string, Capture>;
};
export type Journey = { title: string; note: string; nodes: string[] };
export type Manifest = { name: string; screens: Screen[]; journeys: Journey[] };
export type AuthAuditState = {
  id: string; title: string; route: string; evidence: 'render' | 'real-kratos' | 'injected-response';
  referenceId?: string; comparison: string; captures: Record<string, Capture>;
};
export type AuthManifest = {
  name: string; scope: string; gaps: string[]; generatedAt: string;
  run: { passed: number; duration: number; startedAt: string };
  states: AuthAuditState[]; journeys: Journey[];
};
