const NODE_SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';
const FILTER_INSTALLED = Symbol.for('symphony.test.sqliteWarningFilterInstalled');

type EmitWarning = typeof process.emitWarning;

function warningName(warning: string | Error, typeOrOptions?: string | NodeJS.EmitWarningOptions): string | undefined {
  if (warning instanceof Error) {
    return warning.name;
  }

  if (typeof typeOrOptions === 'string') {
    return typeOrOptions;
  }

  return typeOrOptions?.type;
}

function shouldSuppressWarning(
  warning: string | Error,
  typeOrOptions?: string | NodeJS.EmitWarningOptions
): boolean {
  const message = warning instanceof Error ? warning.message : warning;
  return message === NODE_SQLITE_EXPERIMENTAL_WARNING && warningName(warning, typeOrOptions) === 'ExperimentalWarning';
}

const processWithFilterState = process as NodeJS.Process & {
  [FILTER_INSTALLED]?: boolean;
};

if (!processWithFilterState[FILTER_INSTALLED]) {
  const originalEmitWarning = process.emitWarning.bind(process) as EmitWarning;

  process.emitWarning = ((warning: string | Error, typeOrOptions?: string | NodeJS.EmitWarningOptions, ...rest: unknown[]) => {
    if (shouldSuppressWarning(warning, typeOrOptions)) {
      return;
    }

    originalEmitWarning(warning as string & Error, typeOrOptions as string, ...(rest as [string?, Function?]));
  }) as EmitWarning;

  processWithFilterState[FILTER_INSTALLED] = true;
}
