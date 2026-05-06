#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const FILE_UPLOAD_MUTATION = `
mutation FileUpload($filename: String!, $contentType: String!, $size: Int!, $makePublic: Boolean) {
  fileUpload(filename: $filename, contentType: $contentType, size: $size, makePublic: $makePublic) {
    success
    uploadFile {
      uploadUrl
      assetUrl
      headers {
        key
        value
      }
    }
  }
}`;

const ISSUE_QUERY = `
query IssueByIdOrKey($id: String!) {
  issue(id: $id) {
    id
    identifier
    url
  }
}`;

const COMMENT_CREATE_MUTATION = `
mutation CreateComment($issueId: String!, $bodyData: JSON!) {
  commentCreate(input: { issueId: $issueId, bodyData: $bodyData }) {
    success
    comment {
      id
      url
      bodyData
    }
  }
}`;

const COMMENT_UPDATE_MUTATION = `
mutation UpdateComment($id: String!, $bodyData: JSON!) {
  commentUpdate(id: $id, input: { bodyData: $bodyData }) {
    success
    comment {
      id
      url
      bodyData
    }
  }
}`;

const COMMENT_QUERY = `
query CommentById($id: String!) {
  comment(id: $id) {
    id
    url
    bodyData
    issue {
      id
      identifier
    }
  }
}`;

class UiEvidenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UiEvidenceError';
    this.code = code;
    this.details = details;
  }
}

function typedError(code, message, details) {
  return new UiEvidenceError(code, message, details);
}

function parseDotenv(content) {
  const parsed = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

function resolveLinearApiKey(env = process.env, cwd = process.cwd()) {
  const envKey = String(env.LINEAR_API_KEY || '').trim();
  if (envKey) {
    return { apiKey: envKey, source: 'env:LINEAR_API_KEY' };
  }

  const envPath = path.join(cwd, '.env');
  if (fs.existsSync(envPath)) {
    const parsed = parseDotenv(fs.readFileSync(envPath, 'utf8'));
    const dotenvKey = String(parsed.LINEAR_API_KEY || '').trim();
    if (dotenvKey) {
      return { apiKey: dotenvKey, source: 'file:.env' };
    }
  }

  throw typedError('linear_auth_missing', 'Missing LINEAR_API_KEY. Set it in the environment or repo .env.');
}

function splitEvidenceArg(value, flagName) {
  const separator = String(value || '').indexOf('::');
  if (separator < 1 || separator === String(value || '').length - 2) {
    throw typedError('ui_evidence_invalid_args', `${flagName} must use path::caption`, { value });
  }
  return {
    filePath: String(value).slice(0, separator).trim(),
    caption: String(value).slice(separator + 2).trim()
  };
}

function parseArgs(argv) {
  const options = {
    issue: '',
    summary: '',
    commentId: '',
    items: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--issue') {
      options.issue = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--summary') {
      options.summary = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--comment-id') {
      options.commentId = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (token === '--image' || token === '--video') {
      const parsed = splitEvidenceArg(argv[index + 1], token);
      options.items.push({
        declaredType: token === '--image' ? 'image' : 'video',
        ...parsed
      });
      index += 1;
      continue;
    }
    throw typedError('ui_evidence_invalid_args', `Unsupported argument: ${token}`);
  }

  if (!options.issue) {
    throw typedError('ui_evidence_invalid_args', '--issue is required');
  }
  if (options.items.length < 1) {
    throw typedError('ui_evidence_invalid_args', 'At least one --image or --video item is required');
  }
  return options;
}

function inferMedia(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') {
    return { type: 'image', contentType: 'image/png' };
  }
  if (extension === '.webm') {
    return { type: 'video', contentType: 'video/webm' };
  }
  if (extension === '.mp4') {
    return { type: 'video', contentType: 'video/mp4' };
  }
  throw typedError('ui_evidence_unsupported_media_type', 'Supported media types are .png, .webm, and .mp4', {
    path: filePath
  });
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function validateEvidenceItems(items, cwd = process.cwd()) {
  return items.map((item, index) => {
    const resolvedPath = path.resolve(cwd, item.filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw typedError('ui_evidence_file_missing', 'Evidence file does not exist', { path: item.filePath });
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw typedError('ui_evidence_file_invalid', 'Evidence path must be a file', { path: item.filePath });
    }
    const media = inferMedia(item.filePath);
    if (media.type !== item.declaredType) {
      throw typedError('ui_evidence_media_type_mismatch', `${item.filePath} is ${media.type}, not ${item.declaredType}`, {
        path: item.filePath,
        expected: item.declaredType,
        actual: media.type
      });
    }
    return {
      index,
      type: media.type,
      contentType: media.contentType,
      filePath: item.filePath,
      absolutePath: resolvedPath,
      caption: item.caption,
      filename: path.basename(item.filePath),
      size: stat.size,
      sha256: sha256File(resolvedPath)
    };
  });
}

function textNode(text) {
  return { type: 'text', text };
}

function paragraph(text) {
  return { type: 'paragraph', content: [textNode(text)] };
}

function buildBodyData({ summary = '', items = [] }) {
  const content = [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [textNode('UI Evidence for Review')]
    }
  ];

  if (summary) {
    content.push(paragraph(summary));
  }

  for (const item of items) {
    content.push(paragraph(item.caption));
    if (item.type === 'image') {
      content.push({
        type: 'image',
        attrs: {
          uploadState: 'finished',
          uploadId: null,
          src: item.assetUrl,
          alt: item.filename,
          title: null,
          attribution: null,
          originalSrc: null,
          width: null,
          height: null,
          displayWidth: null
        }
      });
    } else {
      content.push({
        type: 'video',
        attrs: {
          uploadState: 'finished',
          uploadId: null,
          src: item.assetUrl,
          title: item.filename,
          size: item.size,
          controls: true,
          height: null,
          width: null,
          metadataId: null,
          mimetype: item.contentType
        }
      });
    }
  }

  return { type: 'doc', content };
}

function normalizeBodyData(bodyData) {
  if (typeof bodyData === 'string') {
    try {
      return JSON.parse(bodyData);
    } catch {
      return null;
    }
  }
  return bodyData;
}

function countMediaNodes(bodyData) {
  const counts = { image: 0, video: 0 };
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if (node.type === 'image') {
      counts.image += 1;
    }
    if (node.type === 'video') {
      counts.video += 1;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        visit(child);
      }
    }
  };
  visit(bodyData);
  return counts;
}

function collectMediaSrcs(bodyData) {
  const sources = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }
    if ((node.type === 'image' || node.type === 'video') && node.attrs && typeof node.attrs.src === 'string') {
      sources.push(node.attrs.src);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        visit(child);
      }
    }
  };
  visit(bodyData);
  return sources.sort();
}

async function defaultGraphql(query, variables, apiKey) {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw typedError('linear_graphql_http_failed', 'Linear GraphQL returned non-JSON response', {
      status: response.status,
      body: text.slice(0, 500)
    });
  }
  if (!response.ok) {
    throw typedError('linear_graphql_http_failed', 'Linear GraphQL request failed', {
      status: response.status,
      errors: parsed.errors || []
    });
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw typedError('linear_graphql_failed', 'Linear GraphQL operation returned errors', { errors: parsed.errors });
  }
  return parsed.data;
}

async function defaultPutFile(uploadUrl, headers, absolutePath, contentType) {
  const uploadHeaders = {};
  for (const header of headers || []) {
    if (header && header.key) {
      uploadHeaders[header.key] = header.value || '';
    }
  }
  uploadHeaders['Content-Type'] = contentType;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: uploadHeaders,
    body: fs.readFileSync(absolutePath)
  });
  if (!response.ok) {
    throw typedError('linear_file_put_failed', 'Linear signed upload PUT failed', { status: response.status });
  }
}

function assertSuccess(success, code, message, details = {}) {
  if (!success) {
    throw typedError(code, message, details);
  }
}

async function publishEvidence(options, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const env = deps.env || process.env;
  const graphql = deps.graphql || ((query, variables) => defaultGraphql(query, variables, auth.apiKey));
  const putFile = deps.putFile || defaultPutFile;
  const auth = deps.auth || resolveLinearApiKey(env, cwd);
  const validatedItems = validateEvidenceItems(options.items, cwd);

  const issueData = await graphql(ISSUE_QUERY, { id: options.issue }, auth.apiKey);
  const issue = issueData && issueData.issue;
  if (!issue || !issue.id) {
    throw typedError('linear_issue_not_found', 'Linear issue was not found', { issue: options.issue });
  }

  const uploadedItems = [];
  for (const item of validatedItems) {
    const uploadData = await graphql(
      FILE_UPLOAD_MUTATION,
      {
        filename: item.filename,
        contentType: item.contentType,
        size: item.size,
        makePublic: false
      },
      auth.apiKey
    );
    const upload = uploadData && uploadData.fileUpload;
    assertSuccess(upload && upload.success, 'linear_file_upload_failed', 'Linear fileUpload did not succeed', {
      path: item.filePath
    });
    const uploadFile = upload.uploadFile || {};
    if (!uploadFile.uploadUrl || !uploadFile.assetUrl) {
      throw typedError('linear_file_upload_failed', 'Linear fileUpload response missed uploadUrl or assetUrl', {
        path: item.filePath
      });
    }
    await putFile(uploadFile.uploadUrl, uploadFile.headers || [], item.absolutePath, item.contentType);
    uploadedItems.push({
      ...item,
      assetUrl: uploadFile.assetUrl
    });
  }

  const expectedCounts = {
    image: uploadedItems.filter((item) => item.type === 'image').length,
    video: uploadedItems.filter((item) => item.type === 'video').length
  };
  const bodyData = buildBodyData({ summary: options.summary, items: uploadedItems });

  if (options.commentId) {
    const existingCommentData = await graphql(COMMENT_QUERY, { id: options.commentId }, auth.apiKey);
    const existingComment = existingCommentData && existingCommentData.comment;
    const existingIssue = existingComment && existingComment.issue;
    if (!existingComment || !existingIssue || existingIssue.id !== issue.id) {
      throw typedError('linear_comment_issue_mismatch', 'Linear comment does not belong to the requested issue', {
        commentId: options.commentId,
        issue: options.issue,
        expectedIssueId: issue.id,
        actualIssueId: existingIssue && existingIssue.id ? existingIssue.id : null
      });
    }
  }

  const commentData = options.commentId
    ? await graphql(COMMENT_UPDATE_MUTATION, { id: options.commentId, bodyData }, auth.apiKey)
    : await graphql(COMMENT_CREATE_MUTATION, { issueId: issue.id, bodyData }, auth.apiKey);
  const mutationResult = options.commentId ? commentData && commentData.commentUpdate : commentData && commentData.commentCreate;
  assertSuccess(mutationResult && mutationResult.success, 'linear_comment_save_failed', 'Linear comment save did not succeed');
  const comment = mutationResult.comment;
  if (!comment || !comment.id) {
    throw typedError('linear_comment_save_failed', 'Linear comment save response missed comment id');
  }

  const rereadData = await graphql(COMMENT_QUERY, { id: comment.id }, auth.apiKey);
  const rereadComment = rereadData && rereadData.comment;
  if (!rereadComment || !rereadComment.bodyData) {
    throw typedError('linear_comment_verify_failed', 'Unable to re-read Linear comment bodyData', { commentId: comment.id });
  }
  const rereadBodyData = normalizeBodyData(rereadComment.bodyData);
  if (!rereadBodyData) {
    throw typedError('linear_comment_verify_failed', 'Linear comment bodyData was not valid JSON', { commentId: comment.id });
  }
  const actualCounts = countMediaNodes(rereadBodyData);
  if (actualCounts.image !== expectedCounts.image || actualCounts.video !== expectedCounts.video) {
    throw typedError('linear_comment_verify_failed', 'Linear comment bodyData media counts did not match uploaded evidence', {
      expected: expectedCounts,
      actual: actualCounts,
      commentId: comment.id
    });
  }
  const expectedSources = uploadedItems.map((item) => item.assetUrl).sort();
  const actualSources = collectMediaSrcs(rereadBodyData);
  if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) {
    throw typedError('linear_comment_verify_failed', 'Linear comment bodyData media sources did not match uploaded evidence', {
      expected: expectedSources,
      actual: actualSources,
      commentId: comment.id
    });
  }

  return {
    issue: {
      input: options.issue,
      id: issue.id,
      identifier: issue.identifier || null,
      url: issue.url || null
    },
    comment: {
      id: comment.id,
      url: comment.url || rereadComment.url || null,
      mode: options.commentId ? 'updated' : 'created'
    },
    uploaded_count: uploadedItems.length,
    node_counts: actualCounts,
    artifacts: uploadedItems.map((item) => ({
      type: item.type,
      path: item.filePath,
      caption: item.caption,
      asset_url: item.assetUrl,
      sha256: item.sha256,
      size: item.size,
      content_type: item.contentType
    })),
    verification: {
      status: 'passed',
      expected: expectedCounts,
      actual: actualCounts
    }
  };
}

function printError(error) {
  const code = error && error.code ? error.code : 'linear_ui_evidence_failed';
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`${code}: ${message}\n`);
  if (error && error.details && Object.keys(error.details).length > 0) {
    process.stderr.write(`${JSON.stringify(error.details)}\n`);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await publishEvidence(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    printError(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  COMMENT_CREATE_MUTATION,
  COMMENT_QUERY,
  COMMENT_UPDATE_MUTATION,
  FILE_UPLOAD_MUTATION,
  ISSUE_QUERY,
  UiEvidenceError,
  buildBodyData,
  collectMediaSrcs,
  countMediaNodes,
  inferMedia,
  normalizeBodyData,
  parseArgs,
  parseDotenv,
  publishEvidence,
  resolveLinearApiKey,
  validateEvidenceItems
};
