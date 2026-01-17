/**
 * Debug logging utility for Semantic Notes Vault MCP
 * Only logs when debug mode is enabled in settings
 */

export interface DebugLogger {
    log(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
}

export class Debug {
    private static debugEnabled = false;
    
    static setDebugMode(enabled: boolean): void {
        this.debugEnabled = enabled;
    }
    
    static isDebugMode(): boolean {
        return this.debugEnabled;
    }
    
    static log(message: string, ...args: unknown[]): void {
        if (this.debugEnabled) {
            // eslint-disable-next-line no-console -- Debug utility must use console
            console.log(`[MCP] ${message}`, ...args);
        }
    }
    
    static error(message: string, ...args: unknown[]): void {
        // Always log errors
        console.error(`[MCP] ERROR: ${message}`, ...args);
    }
    
    static warn(message: string, ...args: unknown[]): void {
        if (this.debugEnabled) {
            console.warn(`[MCP] WARN: ${message}`, ...args);
        }
    }
    
    static info(message: string, ...args: unknown[]): void {
        if (this.debugEnabled) {
            // eslint-disable-next-line no-console -- Debug utility must use console
            console.info(`[MCP] INFO: ${message}`, ...args);
        }
    }
    
    static createLogger(module: string): DebugLogger {
        return {
            log: (message: string, ...args: unknown[]) => Debug.log(`[${module}] ${message}`, ...args),
            error: (message: string, ...args: unknown[]) => Debug.error(`[${module}] ${message}`, ...args),
            warn: (message: string, ...args: unknown[]) => Debug.warn(`[${module}] ${message}`, ...args),
            info: (message: string, ...args: unknown[]) => Debug.info(`[${module}] ${message}`, ...args)
        };
    }
}