
export interface SearchCondition {
    type: 'filename' | 'path' | 'content' | 'tag' | 'general';
    term: string;
    originalQuery: string;
    isRegex?: boolean;
    regex?: RegExp;
}
