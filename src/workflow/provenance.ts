export interface WorkflowCustomizationReference {
  path: string;
  kind: 'skill' | 'prompt' | 'customization';
  source: string;
}

export interface WorkflowGeneratedProfileProvenance {
  profile: string | null;
  bundle: string | null;
  packs: string[];
  references: WorkflowCustomizationReference[];
  sources: string[];
}

export interface WorkflowGeneratedProfileProvenanceRead {
  metadata: WorkflowGeneratedProfileProvenance | null;
  errors: string[];
  present: boolean;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(
  value: unknown,
  field: string,
  source: string,
  errors: string[],
  options: { allowCommaString?: boolean } = { allowCommaString: true }
): string[] {
  if (typeof value === 'undefined' || value === null) {
    return [];
  }
  if (typeof value === 'string') {
    if (options.allowCommaString === false) {
      errors.push(`${source}.${field} must be a string list`);
      return [];
    }
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const [index, item] of value.entries()) {
      const stringValue = readString(item);
      if (!stringValue) {
        errors.push(`${source}.${field}[${index}] must be a non-empty string`);
        continue;
      }
      values.push(stringValue);
    }
    return values;
  }
  errors.push(`${source}.${field} must be a string list`);
  return [];
}

function splitMetadataFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of raw.split(/[;\n]/)) {
    const [rawKey, ...rawValue] = part.split('=');
    const key = rawKey?.trim();
    const value = rawValue.join('=').trim();
    if (key && value) {
      fields[key] = value;
    }
  }
  return fields;
}

function referencesFromFields(
  fields: Record<string, unknown>,
  source: string,
  errors: string[]
): WorkflowCustomizationReference[] {
  const references: WorkflowCustomizationReference[] = [];
  for (const key of ['skill', 'skills']) {
    for (const item of readStringArray(fields[key], key, source, errors)) {
      references.push({ path: item, kind: 'skill', source });
    }
  }
  for (const key of ['prompt', 'prompts']) {
    for (const item of readStringArray(fields[key], key, source, errors)) {
      references.push({ path: item, kind: 'prompt', source });
    }
  }
  for (const key of ['file', 'files', 'customization', 'customizations']) {
    for (const item of readStringArray(fields[key], key, source, errors)) {
      references.push({ path: item, kind: 'customization', source });
    }
  }
  return references;
}

function requireStringField(
  fields: Record<string, unknown>,
  field: 'profile' | 'bundle',
  source: string,
  errors: string[]
): string | null {
  if (!(field in fields)) {
    errors.push(`${source}.${field} is required`);
    return null;
  }
  const value = readString(fields[field]);
  if (!value) {
    errors.push(`${source}.${field} must be a non-empty string`);
  }
  return value;
}

function requireStringListField(
  fields: Record<string, unknown>,
  field: 'packs',
  source: string,
  errors: string[],
  options: { allowCommaString?: boolean }
): string[] {
  if (!(field in fields) && !('pack' in fields)) {
    errors.push(`${source}.${field} is required`);
    return [];
  }
  const values = readStringArray(fields[field] ?? fields.pack, field, source, errors, options);
  if (values.length === 0) {
    errors.push(`${source}.${field} must include at least one pack id`);
  }
  return values;
}

function metadataFromFields(
  fields: Record<string, unknown>,
  source: string,
  errors: string[]
): WorkflowGeneratedProfileProvenance {
  return {
    profile: requireStringField(fields, 'profile', source, errors),
    bundle: requireStringField(fields, 'bundle', source, errors),
    packs: requireStringListField(fields, 'packs', source, errors, {
      allowCommaString: source === 'workflow_comment'
    }),
    references: referencesFromFields(fields, source, errors),
    sources: [source]
  };
}

function metadataFromConfig(config: Record<string, unknown>, errors: string[]): {
  metadata: WorkflowGeneratedProfileProvenance | null;
  present: boolean;
} {
  const symphony = readRecord(config.symphony);
  if (!symphony || (!('generated_profile' in symphony) && !('profile_provenance' in symphony))) {
    return { metadata: null, present: false };
  }

  const raw = symphony.generated_profile ?? symphony.profile_provenance;
  const generated = readRecord(raw);
  if (!generated) {
    errors.push('workflow_frontmatter.generated_profile must be a map/object');
    return { metadata: null, present: true };
  }

  return { metadata: metadataFromFields(generated, 'workflow_frontmatter', errors), present: true };
}

function metadataFromWorkflowComments(workflowText: string, errors: string[]): {
  metadata: WorkflowGeneratedProfileProvenance | null;
  present: boolean;
} {
  const htmlPattern = /<!--\s*symphony-generated-profile\s*:\s*([\s\S]*?)-->/gi;
  const linePattern = /^\s*#\s*symphony-generated-profile\s*:\s*(.+)$/gim;
  const records: Record<string, string>[] = [];
  let match: RegExpExecArray | null;
  while ((match = htmlPattern.exec(workflowText))) {
    records.push(splitMetadataFields(match[1] ?? ''));
  }
  while ((match = linePattern.exec(workflowText))) {
    records.push(splitMetadataFields(match[1] ?? ''));
  }
  if (records.length === 0) {
    return { metadata: null, present: false };
  }

  const merged = Object.assign({}, ...records);
  return { metadata: metadataFromFields(merged, 'workflow_comment', errors), present: true };
}

function mergeCustomizationMetadata(
  left: WorkflowGeneratedProfileProvenance | null,
  right: WorkflowGeneratedProfileProvenance | null
): WorkflowGeneratedProfileProvenance | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    profile: left.profile ?? right.profile,
    bundle: left.bundle ?? right.bundle,
    packs: [...new Set([...left.packs, ...right.packs])],
    references: [...left.references, ...right.references],
    sources: [...new Set([...left.sources, ...right.sources])]
  };
}

function assertMatchingMetadata(
  left: WorkflowGeneratedProfileProvenance | null,
  right: WorkflowGeneratedProfileProvenance | null,
  errors: string[]
): void {
  if (!left || !right) {
    return;
  }
  if (left.profile && right.profile && left.profile !== right.profile) {
    errors.push(`generated profile mismatch between frontmatter (${left.profile}) and comment (${right.profile})`);
  }
  if (left.bundle && right.bundle && left.bundle !== right.bundle) {
    errors.push(`generated bundle mismatch between frontmatter (${left.bundle}) and comment (${right.bundle})`);
  }
  const leftPacks = [...left.packs].sort();
  const rightPacks = [...right.packs].sort();
  if (leftPacks.length > 0 && rightPacks.length > 0 && leftPacks.join(',') !== rightPacks.join(',')) {
    errors.push(`generated packs mismatch between frontmatter (${leftPacks.join(',')}) and comment (${rightPacks.join(',')})`);
  }
}

export function readWorkflowGeneratedProfileProvenance(params: {
  config: Record<string, unknown>;
  workflowText?: string;
}): WorkflowGeneratedProfileProvenanceRead {
  const errors: string[] = [];
  const configResult = metadataFromConfig(params.config, errors);
  const commentResult =
    typeof params.workflowText === 'string'
      ? metadataFromWorkflowComments(params.workflowText, errors)
      : { metadata: null, present: false };

  assertMatchingMetadata(configResult.metadata, commentResult.metadata, errors);

  return {
    metadata: mergeCustomizationMetadata(configResult.metadata, commentResult.metadata),
    errors,
    present: configResult.present || commentResult.present
  };
}

export function validateWorkflowGeneratedProfileProvenance(params: {
  config: Record<string, unknown>;
  workflowText?: string;
}): { ok: true } | { ok: false; message: string } {
  const read = readWorkflowGeneratedProfileProvenance(params);
  if (!read.present || read.errors.length === 0) {
    return { ok: true };
  }
  return { ok: false, message: read.errors.join('; ') };
}
