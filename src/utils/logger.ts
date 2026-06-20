import chalk from 'chalk';
import { getConfig } from '../config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level: LogLevel): boolean {
  try {
    const cfg = getConfig();
    return LEVELS[level] >= LEVELS[cfg.logLevel];
  } catch {
    return LEVELS[level] >= LEVELS['info'];
  }
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

export const logger = {
  debug(msg: string, ...args: unknown[]): void {
    if (!shouldLog('debug')) return;
    console.log(chalk.gray(`[${timestamp()}] DEBUG ${msg}`), ...args);
  },

  info(msg: string, ...args: unknown[]): void {
    if (!shouldLog('info')) return;
    console.log(chalk.blue(`[${timestamp()}] INFO  ${msg}`), ...args);
  },

  warn(msg: string, ...args: unknown[]): void {
    if (!shouldLog('warn')) return;
    console.warn(chalk.yellow(`[${timestamp()}] WARN  ${msg}`), ...args);
  },

  error(msg: string, ...args: unknown[]): void {
    if (!shouldLog('error')) return;
    console.error(chalk.red(`[${timestamp()}] ERROR ${msg}`), ...args);
  },

  // success/step are info-tier progress lines — respect logLevel like info,
  // so LOG_LEVEL=warn/error actually silences them.
  success(msg: string): void {
    if (!shouldLog('info')) return;
    console.log(chalk.green(`✓ ${msg}`));
  },

  step(msg: string): void {
    if (!shouldLog('info')) return;
    console.log(chalk.cyan(`→ ${msg}`));
  },
};
