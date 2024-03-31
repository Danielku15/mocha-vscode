/*---------------------------------------------------------
 * Copyright (C) OpenJS Foundation and contributors, https://openjsf.org
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import path from 'path';
import type { ITestSymbols } from './extract/types';

/** Pattern of files the CLI looks for */
export const configFilePattern = '**/.mocharc.{js,cjs,yaml,yml,json,jsonc}';

export const defaultTestSymbols: ITestSymbols = {
  suite: ['describe', 'suite'],
  test: ['it', 'test'],
  extractWith: 'evaluation',
  extractTimeout: 10_000,
};

export const showConfigErrorCommand = 'mocha-vscode.showConfigError';
export const getControllersForTestCommand = 'mocha-vscode.get-controllers-for-test';

function equalsIgnoreCase(a: string, b: string) {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

export function isTypeScript(filePath: string) {
  const ext = path.extname(filePath);
  // TODO: configuration for this extension list?
  return (
    equalsIgnoreCase(ext, '.ts') ||
    equalsIgnoreCase(ext, '.mts') ||
    equalsIgnoreCase(ext, '.tsx') ||
    equalsIgnoreCase(ext, '.cts') ||
    equalsIgnoreCase(ext, '.jsx')
  );
}

export function isEsm(filePath: string, code: string): boolean {
  const ext = path.extname(filePath);
  // very basic detection
  return equalsIgnoreCase(ext, '.mjs') || code.includes('import ') || code.includes('export ');
}
