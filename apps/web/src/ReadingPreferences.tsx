import React, { useState, type CSSProperties } from 'react';

export type ReadingPreferences = { scale: number; width: 'focused' | 'wide' | 'full' };
export const defaultReading: ReadingPreferences = { scale: 100, width: 'wide' };
const scales = [90, 100, 110, 125, 150];
const widths = { focused: '820px', wide: '1040px', full: '100%' };
const key = 'kkcode.web.reading';
function normalize(value: Partial<ReadingPreferences> | null): ReadingPreferences {
  return { scale: scales.includes(value?.scale ?? 0) ? value!.scale! : 100,
    width: value?.width && Object.hasOwn(widths, value.width) ? value.width : 'wide' };
}
export function useReadingPreferences() {
  const [reading, setReading] = useState<ReadingPreferences>(() => {
    try { return normalize(JSON.parse(localStorage.getItem(key) || 'null')); } catch { return { ...defaultReading }; }
  });
  const updateReading = (value: ReadingPreferences) => {
    const next = normalize(value); setReading(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* This browser may disable storage. */ }
  };
  return { reading, updateReading, style: { '--reading-scale': reading.scale / 100, '--reading-width': widths[reading.width] } as CSSProperties };
}
export function ReadingControls({ value, onChange }: { value: ReadingPreferences; onChange: (value: ReadingPreferences) => void }) {
  return <section className="reading-settings" aria-label="阅读显示">
    <h3>阅读显示</h3>
    <label>文字大小<select aria-label="文字大小" value={value.scale} onChange={event => onChange({ ...value, scale: Number(event.target.value) })}>
      {scales.map(scale => <option key={scale} value={scale}>{scale}%{scale === 100 ? ' · 标准' : ''}</option>)}
    </select></label>
    <label>阅读宽度<select aria-label="阅读宽度" value={value.width} onChange={event => onChange({ ...value, width: event.target.value as ReadingPreferences['width'] })}>
      <option value="focused">适中</option><option value="wide">宽阔</option><option value="full">铺满可用宽度</option>
    </select></label>
    <p className="sheet-note">保存在当前浏览器。也可以使用浏览器缩放；向上阅读时，新输出不会打断当前位置。</p>
    <button onClick={() => onChange({ ...defaultReading })}>恢复默认显示</button>
  </section>;
}
