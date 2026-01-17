export interface ObsidianConfig {
  apiKey: string;
  apiUrl?: string;
  vaultName?: string;
}

export interface ObsidianFile {
  path: string;
  content: string;
  tags?: string[];
  frontmatter?: Record<string, unknown>;
}

export interface ObsidianImageFile {
  path: string;
  mimeType: string;
  base64Data: string;
}

export type ObsidianFileResponse = ObsidianFile | ObsidianImageFile;

export function isImageFile(file: ObsidianFileResponse): file is ObsidianImageFile {
  return 'mimeType' in file && 'base64Data' in file;
}

export interface SearchResult {
  path: string;
  content: string;
  score?: number;
  context?: string;
}