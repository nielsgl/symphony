#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CRITICAL_CONTRACT = [
  {
    group: 'approval/server-request',
    serverRequests: [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'execCommandApproval',
      'applyPatchApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/permissions/requestApproval'
    ],
    schemaDefinitions: [
      'CommandExecutionRequestApprovalParams',
      'CommandExecutionRequestApprovalResponse',
      'FileChangeRequestApprovalParams',
      'FileChangeRequestApprovalResponse',
      'ExecCommandApprovalParams',
      'ExecCommandApprovalResponse',
      'ApplyPatchApprovalParams',
      'ApplyPatchApprovalResponse',
      'ToolRequestUserInputParams',
      'ToolRequestUserInputResponse',
      'McpServerElicitationRequestParams',
      'McpServerElicitationRequestResponse',
      'PermissionsRequestApprovalParams',
      'PermissionsRequestApprovalResponse'
    ],
    tsExports: [
      'CommandExecutionRequestApprovalParams',
      'CommandExecutionRequestApprovalResponse',
      'FileChangeRequestApprovalParams',
      'FileChangeRequestApprovalResponse',
      'ExecCommandApprovalParams',
      'ExecCommandApprovalResponse',
      'ApplyPatchApprovalParams',
      'ApplyPatchApprovalResponse',
      'ToolRequestUserInputParams',
      'ToolRequestUserInputResponse',
      'McpServerElicitationRequestParams',
      'McpServerElicitationRequestResponse',
      'PermissionsRequestApprovalParams',
      'PermissionsRequestApprovalResponse'
    ]
  },
  {
    group: 'dynamic-tool',
    serverRequests: ['item/tool/call'],
    schemaDefinitions: ['DynamicToolSpec', 'DynamicToolCallParams', 'DynamicToolCallResponse'],
    tsExports: ['DynamicToolSpec', 'DynamicToolCallParams', 'DynamicToolCallResponse']
  },
  {
    group: 'lifecycle',
    clientRequests: ['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'thread/read'],
    schemaDefinitions: [
      'InitializeParams',
      'InitializeResponse',
      'ThreadStartParams',
      'ThreadStartResponse',
      'TurnStartParams',
      'TurnStartResponse',
      'TurnInterruptParams',
      'TurnInterruptResponse',
      'ThreadReadParams',
      'ThreadReadResponse'
    ],
    tsExports: [
      'InitializeParams',
      'InitializeResponse',
      'ThreadStartParams',
      'ThreadStartResponse',
      'TurnStartParams',
      'TurnStartResponse',
      'TurnInterruptParams',
      'TurnInterruptResponse',
      'ThreadReadParams',
      'ThreadReadResponse'
    ]
  },
  {
    group: 'sandbox',
    schemaDefinitions: ['AskForApproval', 'SandboxMode', 'SandboxPolicy'],
    tsExports: ['AskForApproval', 'SandboxMode', 'SandboxPolicy'],
    schemaRefs: [
      { definition: 'ThreadStartParams', ref: 'AskForApproval' },
      { definition: 'ThreadStartParams', ref: 'SandboxMode' },
      { definition: 'TurnStartParams', ref: 'AskForApproval' },
      { definition: 'TurnStartParams', ref: 'SandboxPolicy' }
    ]
  },
  {
    group: 'token',
    serverNotifications: ['thread/tokenUsage/updated'],
    schemaDefinitions: ['ThreadTokenUsageUpdatedNotification'],
    tsExports: ['ThreadTokenUsageUpdatedNotification']
  },
  {
    group: 'rate-limit',
    serverNotifications: ['account/rateLimits/updated'],
    schemaDefinitions: ['AccountRateLimitsUpdatedNotification'],
    tsExports: ['AccountRateLimitsUpdatedNotification']
  },
  {
    group: 'warning',
    serverNotifications: ['warning', 'guardianWarning', 'deprecationNotice', 'configWarning'],
    schemaDefinitions: [
      'WarningNotification',
      'GuardianWarningNotification',
      'DeprecationNoticeNotification',
      'ConfigWarningNotification'
    ],
    tsExports: [
      'WarningNotification',
      'GuardianWarningNotification',
      'DeprecationNoticeNotification',
      'ConfigWarningNotification'
    ]
  },
  {
    group: 'model-reroute',
    serverNotifications: ['model/rerouted'],
    schemaDefinitions: ['ModelReroutedNotification'],
    tsExports: ['ModelReroutedNotification']
  }
];

function parseArgs(argv) {
  const args = {
    generatedDir: null,
    tsDir: null,
    schemaDir: null,
    keepGenerated: false,
    codexBin: process.env.CODEX_BIN || 'codex'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value`);
      }
      i += 1;
      return value;
    };

    if (arg === '--generated-dir') {
      args.generatedDir = next();
    } else if (arg === '--ts-dir') {
      args.tsDir = next();
    } else if (arg === '--schema-dir') {
      args.schemaDir = next();
    } else if (arg === '--codex-bin') {
      args.codexBin = next();
    } else if (arg === '--keep-generated') {
      args.keepGenerated = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/check-codex-app-server-contract.js [options]

Regenerates or inspects Codex App Server generated TypeScript and JSON schema
for Symphony's critical protocol shapes.

Options:
  --generated-dir <dir>  Directory containing ts/ and schema/ generated outputs
  --ts-dir <dir>         Generated TypeScript directory
  --schema-dir <dir>     Generated JSON schema directory
  --codex-bin <bin>      Codex executable for regeneration (default: codex)
  --keep-generated       Keep temporary regenerated outputs and print the path
`);
}

function fail(failures) {
  process.stderr.write('Codex app-server contract drift check failed.\n');
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    const details = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`);
  }
}

function generateInputs(args) {
  const generatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-codex-appserver-contract-'));
  const tsDir = path.join(generatedRoot, 'ts');
  const schemaDir = path.join(generatedRoot, 'schema');
  run(args.codexBin, ['app-server', 'generate-ts', '--out', tsDir, '--experimental'], process.cwd());
  run(args.codexBin, ['app-server', 'generate-json-schema', '--out', schemaDir, '--experimental'], process.cwd());
  return { generatedRoot, tsDir, schemaDir, temporary: true };
}

function resolveInputs(args) {
  if (args.generatedDir) {
    return {
      generatedRoot: path.resolve(args.generatedDir),
      tsDir: path.resolve(args.generatedDir, 'ts'),
      schemaDir: path.resolve(args.generatedDir, 'schema'),
      temporary: false
    };
  }

  if (args.tsDir || args.schemaDir) {
    if (!args.tsDir || !args.schemaDir) {
      throw new Error('--ts-dir and --schema-dir must be provided together');
    }
    return {
      generatedRoot: null,
      tsDir: path.resolve(args.tsDir),
      schemaDir: path.resolve(args.schemaDir),
      temporary: false
    };
  }

  return generateInputs(args);
}

function readJson(filePath, failures) {
  if (!fs.existsSync(filePath)) {
    failures.push(`missing schema file ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    failures.push(`schema file ${filePath} is not valid JSON: ${error.message}`);
    return null;
  }
}

function schemaBundle(schemaDir, failures) {
  const bundlePath = path.join(schemaDir, 'codex_app_server_protocol.schemas.json');
  const bundle = readJson(bundlePath, failures);
  return bundle && typeof bundle === 'object' ? bundle : null;
}

function definitionsFrom(bundle) {
  const definitions = bundle && bundle.definitions && typeof bundle.definitions === 'object' ? bundle.definitions : {};
  const flattened = { ...definitions };
  for (const [namespace, nestedDefinitions] of Object.entries(definitions)) {
    if (!nestedDefinitions || typeof nestedDefinitions !== 'object' || Array.isArray(nestedDefinitions)) {
      continue;
    }
    for (const [name, value] of Object.entries(nestedDefinitions)) {
      if (!Object.prototype.hasOwnProperty.call(flattened, `${namespace}/${name}`)) {
        flattened[`${namespace}/${name}`] = value;
      }
    }
  }
  return flattened;
}

function hasDefinition(definitions, name) {
  return Object.prototype.hasOwnProperty.call(definitions, name) || Object.prototype.hasOwnProperty.call(definitions, `v2/${name}`);
}

function definitionValue(definitions, name) {
  return definitions[name] ?? definitions[`v2/${name}`] ?? null;
}

function stringify(value) {
  return JSON.stringify(value);
}

function containsEnumValue(value, expected) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value.enum) && value.enum.includes(expected)) {
    return true;
  }
  return Object.values(value).some((child) => containsEnumValue(child, expected));
}

function containsRef(value, expected) {
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (typeof value.$ref === 'string' && value.$ref.endsWith(`/${expected}`)) {
    return true;
  }
  return Object.values(value).some((child) => containsRef(child, expected));
}

function listFiles(dir) {
  const output = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) {
      return;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  };
  visit(dir);
  return output.sort();
}

function readTsExports(tsDir) {
  const exports = new Map();
  for (const filePath of listFiles(tsDir).filter((item) => item.endsWith('.ts'))) {
    const content = fs.readFileSync(filePath, 'utf8');
    const exportPattern = /export\s+(?:interface|type|enum|class)\s+([A-Za-z0-9_]+)/g;
    for (const match of content.matchAll(exportPattern)) {
      exports.set(match[1], path.relative(tsDir, filePath));
    }
  }
  return exports;
}

function checkMethodUnion({ label, methods, definitionName, definitions, failures }) {
  if (!methods || methods.length === 0) {
    return;
  }
  const union = definitionValue(definitions, definitionName);
  if (!union) {
    failures.push(`missing schema definition ${definitionName} for ${label} method discriminants`);
    return;
  }
  for (const method of methods) {
    if (!containsEnumValue(union, method)) {
      failures.push(`${definitionName} does not include ${label} method '${method}'`);
    }
  }
}

function checkContract(inputs) {
  const failures = [];
  if (!fs.existsSync(inputs.tsDir)) {
    failures.push(`missing generated TypeScript directory ${inputs.tsDir}`);
  }
  if (!fs.existsSync(inputs.schemaDir)) {
    failures.push(`missing generated JSON schema directory ${inputs.schemaDir}`);
  }
  if (failures.length > 0) {
    return { failures, summary: null };
  }

  const bundle = schemaBundle(inputs.schemaDir, failures);
  const definitions = definitionsFrom(bundle);
  const tsExports = readTsExports(inputs.tsDir);
  const checked = {
    groups: 0,
    schemaDefinitions: 0,
    tsExports: 0,
    methods: 0,
    refs: 0
  };

  for (const group of CRITICAL_CONTRACT) {
    checked.groups += 1;

    for (const definition of group.schemaDefinitions ?? []) {
      checked.schemaDefinitions += 1;
      if (!hasDefinition(definitions, definition)) {
        failures.push(`[${group.group}] missing schema definition ${definition}`);
      }
    }

    for (const tsExport of group.tsExports ?? []) {
      checked.tsExports += 1;
      if (!tsExports.has(tsExport)) {
        failures.push(`[${group.group}] missing TypeScript export ${tsExport}`);
      }
    }

    const methodSets = [
      { methods: group.clientRequests, definitionName: 'ClientRequest', label: 'client request' },
      { methods: group.serverRequests, definitionName: 'ServerRequest', label: 'server request' },
      { methods: group.serverNotifications, definitionName: 'ServerNotification', label: 'server notification' }
    ];
    for (const methodSet of methodSets) {
      checked.methods += methodSet.methods?.length ?? 0;
      checkMethodUnion({ ...methodSet, definitions, failures });
    }

    for (const refCheck of group.schemaRefs ?? []) {
      checked.refs += 1;
      const definition = definitionValue(definitions, refCheck.definition);
      if (!definition) {
        failures.push(`[${group.group}] missing schema definition ${refCheck.definition} for ref ${refCheck.ref}`);
      } else if (!containsRef(definition, refCheck.ref)) {
        failures.push(`[${group.group}] ${refCheck.definition} does not reference ${refCheck.ref}`);
      }
    }
  }

  return { failures, summary: checked };
}

function main() {
  let inputs;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    inputs = resolveInputs(args);
    const result = checkContract(inputs);
    if (result.failures.length > 0) {
      fail(result.failures);
    }

    const summary = result.summary;
    process.stdout.write(
      [
        'Codex app-server contract drift check passed.',
        `groups=${summary.groups}`,
        `schema_definitions=${summary.schemaDefinitions}`,
        `ts_exports=${summary.tsExports}`,
        `method_discriminants=${summary.methods}`,
        `schema_refs=${summary.refs}`
      ].join(' ') + '\n'
    );

    if (inputs.temporary && args.keepGenerated) {
      process.stdout.write(`generated_dir=${inputs.generatedRoot}\n`);
    }
  } catch (error) {
    fail([error.message]);
  } finally {
    if (inputs?.temporary && !args?.keepGenerated) {
      fs.rmSync(inputs.generatedRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CRITICAL_CONTRACT,
  checkContract,
  parseArgs
};
