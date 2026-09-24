export interface OfficeRequest {
  operation: 'capabilities' | 'inspect' | 'create' | 'edit' | 'render' | 'merge_pdf' | 'select_pdf_pages' | 'fill_pdf' | 'annotate_pdf' | 'ocr';
  inputs?: string[]; outputDir?: string; filename?: string;
  format?: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md';
  spec?: Record<string, unknown>; changes?: Record<string, unknown>;
  pages?: number[]; language?: 'eng' | 'chi_sim' | 'eng+chi_sim';
  fields?: Record<string, string>; annotations?: Array<{page: number; rect: [number,number,number,number]; text: string}>;
}
export interface OfficeArtifactReference {id: string; sha256: string; size: number}
export interface OfficeOutput {name: string; path: string; mime: string; bytes: number; sha256: string; artifactRef?: OfficeArtifactReference}
export interface OfficeResult {
  ok: true; primary?: string; capabilities?: Record<string, unknown>; content?: Record<string, unknown>;
  outputs?: OfficeOutput[];
  validation?: Record<string, unknown>;
  inputs: Array<{path: string; sha256: string; bytes: number}>;
  isolation: {backend: 'docker'; imageId: string; network: 'none'; fileTransfer: 'isolated-dirfd'};
}
export interface OfficeService {
  readonly cwd: string; readonly strict: true;
  capabilities(options?: {signal?: AbortSignal}): Promise<OfficeResult>;
  run(request: OfficeRequest, options?: {signal?: AbortSignal;
    onOutput?: (item: {output: Readonly<OfficeOutput>; content: AsyncIterable<Uint8Array>; signal: AbortSignal|null}) => Promise<OfficeArtifactReference>}): Promise<OfficeResult>;
  dispose(): Promise<void>;
}
export class OfficeError extends Error { code: string; details: unknown }
export function createOfficeService(options: {cwd: string; image: string}): Promise<OfficeService>;
export function isOfficeService(value: unknown): value is OfficeService;
export function createOfficeTools(): Array<Record<string, unknown>>;
