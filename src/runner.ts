/*---------------------------------------------------------
 * Copyright (C) Daniel Kuschny (Danielku15) and contributors.
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import styles from 'ansi-styles';
import { randomUUID } from 'crypto';
import * as path from 'path';
import split2 from 'split2';
import * as vscode from 'vscode';
import { ConfigValue } from './configValue';
import { ConfigurationFile } from './configurationFile';
import { DisposableStore } from './disposable';
import { TestProcessExitedError } from './errors';
import { ItemType, testMetadata } from './metadata';
import { OutputQueue } from './outputQueue';
import { MochaEvent, MochaEventTuple } from './reporter/fullJsonStreamReporterTypes';
import { SourceMapStore } from './source-map-store';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

interface ISpawnOptions {
  config: ConfigurationFile;
  args: string[];
  onLine: (line: string) => void;
  token: vscode.CancellationToken;
}

export type RunHandler = (
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken,
) => Promise<void>;

export class TestRunner {
  constructor(
    private readonly logChannel: vscode.LogOutputChannel,
    private readonly smStore: SourceMapStore,
    private readonly launchConfig: ConfigValue<Record<string, any>>,
  ) {}

  public makeHandler(
    ctrl: vscode.TestController,
    config: ConfigurationFile,
    debug: boolean,
  ): RunHandler {
    return async (request) => {
      this.logChannel.debug('Creating new test run ', request);

      const run = ctrl.createTestRun(request);
      const { args, compiledFileTests, leafTests } = await this.prepareArguments(
        ctrl,
        [],
        request,
        run,
      );
      if (run.token.isCancellationRequested) {
        return;
      }

      let ranAnyTest = false;
      let isOutsideTestRun = true;
      const outputQueue = new OutputQueue();
      const enqueueLine = (line: string) => {
        // vscode can log some preamble as it boots: grey those out
        if (isOutsideTestRun) {
          line = `${styles.dim.open}${line}${styles.dim.close}`;
        }
        outputQueue.enqueue(() => run.appendOutput(`${line}\r\n`));
      };

      const spawnCts = new vscode.CancellationTokenSource();
      run.token.onCancellationRequested(() => spawnCts.cancel());

      const spawnOpts: ISpawnOptions = {
        args,
        config,
        onLine: (line) => {
          let parsed: MochaEventTuple;
          try {
            parsed = JSON.parse(line);
          } catch {
            // just normal output
            enqueueLine(line);
            return;
          }
          switch (parsed[0]) {
          case MochaEvent.Start:
            isOutsideTestRun = false;
            break;
          case MochaEvent.TestStart: {
            const { file, path } = parsed[1];
            const test = compiledFileTests.lookup(file, path);
            if (test) run.started(test);
            break;
          }
          case MochaEvent.SuiteStart: {
            const { path } = parsed[1];
            if (path.length > 0) {
              enqueueLine(
                `${'  '.repeat(path.length - 1)}${styles.green.open} ✓ ${styles.green.close}${
                  path[path.length - 1]
                }`,
              );
            }
            break;
          }
          case MochaEvent.Pass: {
            ranAnyTest = true;
            const { file, path } = parsed[1];
            enqueueLine(
              `${'  '.repeat(path.length - 1)}${styles.green.open} ✓ ${styles.green.close}${
                path[path.length - 1]
              }`,
            );
            const test = compiledFileTests.lookup(file, path);
            if (test) {
              run.passed(test);
              leafTests.delete(test);
            }
            break;
          }
          case MochaEvent.Fail: {
            ranAnyTest = true;
            const { err, path, stack, duration, expected, actual, file } = parsed[1];
            const tcase = compiledFileTests.lookup(file, path);

            enqueueLine(
              `${'  '.repeat(path.length - 1)}${styles.red.open} x ${path.join(' ')}${
                styles.red.close
              }`,
            );
            const rawErr = stack || err;
            const locationsReplaced = replaceAllLocations(this.smStore, forceCRLF(rawErr));
            if (rawErr) {
              outputQueue.enqueue(async () =>
                run.appendOutput(await locationsReplaced, undefined, tcase),
              );
            }

            if (!tcase) {
              return;
            }

            leafTests.delete(tcase);
            const hasDiff = actual !== expected;
            const testFirstLine =
                tcase.range &&
                new vscode.Location(
                  tcase.uri!,
                  new vscode.Range(
                    tcase.range.start,
                    new vscode.Position(tcase.range.start.line, 100),
                  ),
                );

            const locationProm = tryDeriveStackLocation(this.smStore, rawErr, tcase!);
            outputQueue.enqueue(async () => {
              const location = await locationProm;
              let message: vscode.TestMessage;

              if (hasDiff) {
                message = new vscode.TestMessage(tryMakeMarkdown(err));
                message.actualOutput = outputToString(actual);
                message.expectedOutput = outputToString(expected);
              } else {
                message = new vscode.TestMessage(
                  stack ? await sourcemapStack(this.smStore, stack) : await locationsReplaced,
                );
              }

              message.location = location ?? testFirstLine;
              run.failed(tcase!, message, duration);
            });
            break;
          }
          case MochaEvent.End:
            isOutsideTestRun = true;
            break;
          default:
            // just normal output
            outputQueue.enqueue(() => run.appendOutput(`${line}\r\n`));
          }
        },
        token: spawnCts.token,
      };

      run.appendOutput(
        `${styles.inverse.open} > ${styles.inverse.close} ${(
          await config.getMochaSpawnArgs(spawnOpts.args)
        ).join(' ')}}\r\n`,
      );

      try {
        if (debug) {
          await this.runDebug(spawnOpts);
        } else {
          await this.runWithoutDebug(spawnOpts);
        }
      } catch (e) {
        const errorMessage = e instanceof Error ? e : `Error executing tests ${e}`;
        this.logChannel.error(errorMessage);
        if (!spawnCts.token.isCancellationRequested) {
          enqueueLine(String(e));
        }
      }

      if (!spawnCts.token.isCancellationRequested) {
        if (ranAnyTest) {
          for (const t of leafTests) {
            run.skipped(t);
          }
        } else {
          const md = new vscode.MarkdownString(
            'Test process exited unexpectedly, [view output](command:testing.showMostRecentOutput)',
          );
          md.isTrusted = true;
          for (const t of leafTests) {
            run.errored(t, new vscode.TestMessage(md));
          }
        }
      }

      if (!ranAnyTest) {
        this.logChannel.debug('No tests ran, show error');
        await vscode.commands.executeCommand('testing.showMostRecentOutput');
      }

      await outputQueue.drain();
      run.end();
    };
  }

  private async runDebug({ args, config, onLine, token }: ISpawnOptions) {
    const ds = new DisposableStore();

    const spawnArgs = await config.getMochaSpawnArgs(args);
    this.logChannel.debug('Start test debugging with args', spawnArgs);

    return new Promise<void>((resolve, reject) => {
      const sessionKey = randomUUID();
      const includedSessions = new Set<vscode.DebugSession | undefined>();
      const launchConfig = this.launchConfig.value || {};

      Promise.resolve(
        vscode.debug.startDebugging(config.wf, {
          ...launchConfig,
          type: 'node',
          request: 'launch',
          name: `Mocha Test (${config.uri.fsPath})`,
          program: spawnArgs[1],
          args: [...spawnArgs.slice(2), ...(launchConfig.args || [])],
          env: { ...launchConfig.env },

          __extensionSessionKey: sessionKey,
        }),
      ).catch(reject);

      ds.add(
        token.onCancellationRequested(() => {
          for (const session of includedSessions) {
            if (!session?.parentSession) {
              vscode.debug.stopDebugging(session);
            }
          }

          resolve();
        }),
      );

      let didFindFirst = false;
      ds.add(
        vscode.debug.onDidTerminateDebugSession((session) => {
          includedSessions.delete(session);
          if (didFindFirst && includedSessions.size === 0) {
            resolve();
          }
        }),
      );

      let output = '';
      ds.add(
        vscode.debug.registerDebugAdapterTrackerFactory('*', {
          createDebugAdapterTracker(session) {
            if (
              session.configuration.__extensionSessionKey !== sessionKey &&
              !includedSessions.has(session.parentSession)
            ) {
              return undefined;
            }

            didFindFirst = true;
            includedSessions.add(session);

            return {
              onDidSendMessage({ type, event, body }) {
                if (
                  type === 'event' &&
                  event === 'output' &&
                  body.output &&
                  body.category !== 'telemetry'
                ) {
                  output += body.output;
                }

                let newLine = output.indexOf('\n');
                while (newLine !== -1) {
                  onLine(output.substring(0, newLine));
                  output = output.substring(newLine + 1);
                  newLine = output.indexOf('\n');
                }
              },
            };
          },
        }),
      );
    }).finally(() => {
      ds.dispose();
    });
  }

  private async runWithoutDebug({ args, config, onLine, token }: ISpawnOptions) {
    const spawnArgs = await config.getMochaSpawnArgs(args);
    this.logChannel.debug('Start test execution with args', spawnArgs);

    const cli = await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      const p = spawn(spawnArgs[0], spawnArgs.slice(1), {
        cwd: path.dirname(config.uri.fsPath),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      p.on('spawn', () => resolve(p));
      p.on('error', reject);
    });

    if (token.isCancellationRequested) {
      return cli.kill();
    }

    token.onCancellationRequested(() => cli.kill());
    cli.stderr.pipe(split2()).on('data', onLine);
    cli.stdout.pipe(split2()).on('data', onLine);
    return new Promise<void>((resolve, reject) => {
      cli.on('error', reject);
      cli.on('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new TestProcessExitedError(code));
        }
      });
    });
  }

  /**
   * Prepares arguments for running the test. Returns
   *  - The CLI args to pass to the runner
   *  - A map of compiled file names to the source files' test items for each test
   */
  private async prepareArguments(
    ctrl: vscode.TestController,
    baseArgs: ReadonlyArray<string>,
    request: vscode.TestRunRequest,
    run: vscode.TestRun,
  ) {
    const reporter = path.resolve(__dirname, 'reporter', 'fullJsonStreamReporter.js');
    const args = [...baseArgs, '--reporter', reporter];
    const exclude = new Set(request.exclude);
    const leafTests = new Set<vscode.TestItem>();
    const include = request.include?.slice() ?? [...ctrl.items].map(([, item]) => item);

    const grepRe: string[] = [];
    const compiledFileTests = new CompiledFileTests();

    for (const test of include) {
      const data = testMetadata.get(test);
      if (!data || exclude.has(test)) {
        continue;
      }

      if (data.type === ItemType.Directory) {
        for (const [, child] of test.children) {
          include.push(child);
        }
        continue;
      }

      if (data.type === ItemType.Test || data.type === ItemType.Suite) {
        grepRe.push(escapeRe(getFullName(test)) + (data.type === ItemType.Test ? '$' : ' '));
      }

      forEachLeaf(test, (t) => {
        leafTests.add(t);
        run.enqueued(t);
      });

      for (let i = test as vscode.TestItem | undefined; i; i = i.parent) {
        const metadata = testMetadata.get(i);
        if (metadata?.type === ItemType.File) {
          compiledFileTests.push(metadata.compiledIn.fsPath, i);
          break;
        }
      }
    }

    // if there's no include, omit --run so that every file is executed
    // TODO[mocha]: expose an "--include" variant which allows limiting the tests to individual files independent from the loaded config
    if (!request.include || !exclude.size) {
      for (const path of compiledFileTests.value.keys()) {
        args.push('--run', path);
      }
    }

    if (grepRe.length) {
      args.push('--grep', `/^(${grepRe.join('|')})/`);
    }

    return { args, compiledFileTests, leafTests };
  }
}

class CompiledFileTests {
  public readonly value = new Map<
    /* compiled file path */ string,
    /* source file test items */ Set<vscode.TestItem>
  >();

  /**
   * Gets a test by its path of test titles. Ideally it reads the hinted
   * `file` and can look it up efficiently, but in some test configurations
   * this is not present and we need to iterate file in the controller.
   */
  public lookup(file: string | undefined, path: readonly string[]) {
    file = this.sanitizePath(file);

    if (file) {
      const items = this.value.get(file);
      return items && this.getPathInTestItems(items, path);
    } else {
      for (const items of this.value.values()) {
        const found = this.getPathInTestItems(items, path);
        if (found) {
          return found;
        }
      }
    }
  }

  /**
   * Gets a test item by its path of titles in the test file.
   */
  private getPathInTestItems(items: Set<vscode.TestItem>, path: readonly string[]) {
    for (const item of items) {
      let candidate: vscode.TestItem | undefined = item;
      for (let i = 0; i < path.length && candidate; i++) {
        candidate = candidate.children.get(path[i]);
      }
      if (candidate !== undefined) {
        return candidate;
      }
    }
  }

  /** Associated a test with the given file path. */
  public push(file: string, test: vscode.TestItem) {
    file = this.sanitizePath(file)!;

    let set = this.value.get(file);
    if (!set) {
      this.value.set(file, (set = new Set()));
    }

    set.add(test);
  }

  private sanitizePath(file: string | undefined): string | undefined {
    if (file === undefined) {
      return undefined;
    }

    // on windows paths are case insensitive and we sometimes get inconsistent
    // casings (e.g. C:\ vs c:\) - happens especially on debugging
    if (process.platform === 'win32') {
      return file.toLowerCase();
    }

    return file;
  }
}

const getFullName = (test: vscode.TestItem) => {
  let name = test.label;
  while (test.parent && testMetadata.get(test.parent)?.type === ItemType.Suite) {
    test = test.parent;
    name = `${test.label} ${name}`;
  }
  return name;
};

const forEachLeaf = (test: vscode.TestItem, fn: (test: vscode.TestItem) => void) => {
  const queue: vscode.TestItem[] = [test];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.children.size > 0) {
      for (const [, child] of current.children) {
        queue.push(child);
      }
    } else {
      fn(current);
    }
  }
};

const escapeRe = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forceCRLF = (str: string) => str.replace(/(?<!\r)\n/gm, '\r\n');
const locationRe = /(file:\/{3}.+):([0-9]+):([0-9]+)/g;

/**
 * Replaces all stack frames in the stack with source-mapped equivalents.
 */
async function sourcemapStack(store: SourceMapStore, str: string) {
  locationRe.lastIndex = 0;

  const replacements = await Promise.all(
    [...str.matchAll(locationRe)].map(async (match) => {
      const location = await deriveSourceLocation(store, match);
      if (!location) {
        return;
      }
      return {
        from: match[0],
        to: location?.uri.with({
          fragment: `L${location.range.start.line + 1}:${location.range.start.character + 1}`,
        }),
      };
    }),
  );

  for (const replacement of replacements) {
    if (replacement) {
      str = str.replace(replacement.from, replacement.to.toString(true));
    }
  }

  return str;
}

/**
 * Replaces all file URIs in the string with the source-mapped equivalents.
 */
async function replaceAllLocations(store: SourceMapStore, str: string) {
  const output: (string | Promise<string>)[] = [];
  let lastIndex = 0;

  for (const match of str.matchAll(locationRe)) {
    const locationPromise = deriveSourceLocation(store, match);
    const startIndex = match.index || 0;
    const endIndex = startIndex + match[0].length;

    if (startIndex > lastIndex) {
      output.push(str.substring(lastIndex, startIndex));
    }

    output.push(
      locationPromise.then((location) =>
        location
          ? `${location.uri}:${location.range.start.line + 1}:${location.range.start.character + 1}`
          : match[0],
      ),
    );

    lastIndex = endIndex;
  }

  // Preserve the remaining string after the last match
  if (lastIndex < str.length) {
    output.push(str.substring(lastIndex));
  }

  const values = await Promise.all(output);
  return values.join('');
}

/**
 * Parses the stack trace and figures out the best place to associate the error
 * with. Prefers to place it in the same range as the test case, or at least
 * in the same file.
 */
async function tryDeriveStackLocation(
  store: SourceMapStore,
  stack: string,
  tcase: vscode.TestItem,
) {
  locationRe.lastIndex = 0;

  return new Promise<vscode.Location | undefined>((resolve) => {
    const matches = [...stack.matchAll(locationRe)];
    let todo = matches.length;
    if (todo === 0) {
      return resolve(undefined);
    }

    let best: undefined | { location: vscode.Location; i: number; score: number };
    for (const [i, match] of matches.entries()) {
      deriveSourceLocation(store, match)
        .catch(() => undefined)
        .then((location) => {
          if (location) {
            let score = 0;
            if (tcase.uri && tcase.uri.toString() === location.uri.toString()) {
              score = 1;
              if (tcase.range && tcase.range.contains(location?.range)) {
                score = 2;
              }
            }
            if (!best || score > best.score || (score === best.score && i < best.i)) {
              best = { location, i, score };
            }
          }

          if (!--todo) {
            resolve(best?.location);
          }
        });
    }
  });
}

async function deriveSourceLocation(store: SourceMapStore, parts: RegExpMatchArray) {
  const [, fileUriStr, line, col] = parts;
  const fileUri = fileUriStr.startsWith('file:')
    ? vscode.Uri.parse(fileUriStr)
    : vscode.Uri.file(fileUriStr);
  const maintainer = store.maintain(fileUri);
  const mapping = await (maintainer.value || maintainer.refresh());
  const value =
    mapping?.originalPositionFor(Number(line), Number(col)) ||
    new vscode.Location(fileUri, new vscode.Position(Number(line), Number(col)));

  // timeout the maintainer async so that it stays alive for any other immediate teset usage in the file:
  setTimeout(() => maintainer.dispose(), 5000);

  return value;
}

const outputToString = (output: unknown) =>
  typeof output === 'object' ? JSON.stringify(output, null, 2) : String(output);

const tryMakeMarkdown = (message: string) => {
  const lines = message.split('\n');
  const start = lines.findIndex((l) => l.includes('+ actual'));
  if (start === -1) {
    return message;
  }

  lines.splice(start, 1, '```diff');
  lines.push('```');
  return new vscode.MarkdownString(lines.join('\n'));
};
