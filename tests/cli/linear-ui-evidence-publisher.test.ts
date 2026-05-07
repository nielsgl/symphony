import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const publisher = require('../../.codex/skills/linear-ui-evidence/scripts/publish-linear-ui-evidence.js');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-linear-ui-evidence-'));
}

function writeEvidence(root: string, relativePath: string, content = 'stub') {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, 'utf8');
}

describe('linear ui evidence publisher', () => {
  it('parses explicit image and video evidence items', () => {
    const parsed = publisher.parseArgs([
      '--issue',
      'NIE-57',
      '--summary',
      'Dashboard evidence',
      '--image',
      'output/playwright/a.png::Screenshot caption',
      '--video',
      'output/playwright/b.webm::Video caption',
      '--comment-id',
      'comment-1'
    ]);

    expect(parsed.issue).toBe('NIE-57');
    expect(parsed.summary).toBe('Dashboard evidence');
    expect(parsed.commentId).toBe('comment-1');
    expect(parsed.items).toEqual([
      { declaredType: 'image', filePath: 'output/playwright/a.png', caption: 'Screenshot caption' },
      { declaredType: 'video', filePath: 'output/playwright/b.webm', caption: 'Video caption' }
    ]);
  });

  it('infers supported MIME types and rejects unsupported media', () => {
    expect(publisher.inferMedia('demo.png')).toEqual({ type: 'image', contentType: 'image/png' });
    expect(publisher.inferMedia('demo.webm')).toEqual({ type: 'video', contentType: 'video/webm' });
    expect(publisher.inferMedia('demo.mp4')).toEqual({ type: 'video', contentType: 'video/mp4' });
    expect(() => publisher.inferMedia('demo.jpg')).toThrow(/Supported media types/);
  });

  it('builds rich bodyData for mixed screenshots and videos without hashes', () => {
    const bodyData = publisher.buildBodyData({
      summary: 'Summary text',
      items: [
        {
          type: 'image',
          assetUrl: 'https://uploads.linear.app/demo.png',
          filename: 'demo.png',
          caption: 'Screenshot',
          size: 10,
          contentType: 'image/png',
          sha256: 'abc123'
        },
        {
          type: 'video',
          assetUrl: 'https://uploads.linear.app/demo.webm',
          filename: 'demo.webm',
          caption: 'Screencast',
          size: 20,
          contentType: 'video/webm',
          sha256: 'def456'
        }
      ]
    });

    expect(publisher.countMediaNodes(bodyData)).toEqual({ image: 1, video: 1 });
    expect(JSON.stringify(bodyData)).toContain('"type":"image"');
    expect(JSON.stringify(bodyData)).toContain('"type":"video"');
    expect(JSON.stringify(bodyData)).not.toContain('abc123');
    expect(JSON.stringify(bodyData)).not.toContain('def456');
  });

  it('normalizes Linear bodyData returned as a JSON string', () => {
    const bodyData = publisher.buildBodyData({
      items: [
        {
          type: 'image',
          assetUrl: 'https://uploads.linear.app/demo.png',
          filename: 'demo.png',
          caption: 'Screenshot',
          size: 10,
          contentType: 'image/png'
        }
      ]
    });

    expect(publisher.countMediaNodes(publisher.normalizeBodyData(JSON.stringify(bodyData)))).toEqual({ image: 1, video: 0 });
  });

  it('fails verification when Linear bodyData is not valid JSON', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.png', 'png-bytes');

    const graphql = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('query IssueByIdOrKey')) {
        return { issue: { id: 'issue-id', identifier: variables.id, url: null } };
      }
      if (query.includes('mutation FileUpload')) {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/demo.png',
              assetUrl: 'https://uploads.linear.app/demo.png',
              headers: []
            }
          }
        };
      }
      if (query.includes('mutation CreateComment')) {
        return { commentCreate: { success: true, comment: { id: 'comment-id', url: null, bodyData: variables.bodyData } } };
      }
      if (query.includes('query CommentById')) {
        return { comment: { id: variables.id, url: null, bodyData: '{not-json}', issue: { id: 'issue-id', identifier: 'NIE-57' } } };
      }
      throw new Error(`unexpected query: ${query}`);
    };

    await expect(
      publisher.publishEvidence(publisher.parseArgs(['--issue', 'NIE-57', '--image', 'output/playwright/demo.png::Screenshot']), {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql,
        putFile: async () => {}
      })
    ).rejects.toMatchObject({ code: 'linear_comment_verify_failed' });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads LINEAR_API_KEY from env before .env', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, '.env'), 'LINEAR_API_KEY=file-key\n', 'utf8');

    expect(publisher.resolveLinearApiKey({ LINEAR_API_KEY: 'env-key' }, root)).toEqual({
      apiKey: 'env-key',
      source: 'env:LINEAR_API_KEY'
    });
    expect(publisher.resolveLinearApiKey({}, root)).toEqual({
      apiKey: 'file-key',
      source: 'file:.env'
    });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates one rich Linear evidence comment and reports hashes in JSON output data only', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.png', 'png-bytes');
    writeEvidence(root, 'output/playwright/demo.webm', 'webm-bytes');
    let savedBodyData: unknown;
    const uploadUrls: string[] = [];
    const putPaths: string[] = [];
    const uploadMakePublicValues: unknown[] = [];
    const queryNames: string[] = [];

    const graphql = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('query IssueByIdOrKey')) {
        queryNames.push('issue');
        return { issue: { id: 'issue-id', identifier: variables.id, url: 'https://linear.app/nielsgl/issue/NIE-57/demo' } };
      }
      if (query.includes('mutation FileUpload')) {
        queryNames.push('fileUpload');
        const uploadUrl = `https://upload.test/${String(variables.filename)}`;
        uploadUrls.push(uploadUrl);
        uploadMakePublicValues.push(variables.makePublic);
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl,
              assetUrl: `https://uploads.linear.app/${String(variables.filename)}`,
              headers: [{ key: 'x-upload-header', value: 'yes' }]
            }
          }
        };
      }
      if (query.includes('mutation CreateComment')) {
        queryNames.push('commentCreate');
        savedBodyData = variables.bodyData;
        return { commentCreate: { success: true, comment: { id: 'comment-id', url: 'https://linear.app/comment', bodyData: savedBodyData } } };
      }
      if (query.includes('query CommentById')) {
        queryNames.push('commentReread');
        return { comment: { id: variables.id, url: 'https://linear.app/comment', bodyData: savedBodyData, issue: { id: 'issue-id', identifier: 'NIE-57' } } };
      }
      throw new Error(`unexpected query: ${query}`);
    };

    const result = await publisher.publishEvidence(
      publisher.parseArgs([
        '--issue',
        'NIE-57',
        '--image',
        'output/playwright/demo.png::Screenshot',
        '--video',
        'output/playwright/demo.webm::Screencast'
      ]),
      {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql,
        putFile: async (_uploadUrl: string, _headers: unknown[], absolutePath: string) => {
          putPaths.push(path.relative(root, absolutePath).replace(/\\/g, '/'));
        }
      }
    );

    expect(uploadUrls).toEqual(['https://upload.test/demo.png', 'https://upload.test/demo.webm']);
    expect(uploadMakePublicValues).toEqual([false, false]);
    expect(putPaths).toEqual(['output/playwright/demo.png', 'output/playwright/demo.webm']);
    expect(queryNames).toEqual(['issue', 'fileUpload', 'fileUpload', 'commentCreate', 'commentReread']);
    expect(result.comment.mode).toBe('created');
    expect(result.node_counts).toEqual({ image: 1, video: 1 });
    expect(result.verification.status).toBe('passed');
    expect(result.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(savedBodyData)).not.toContain(result.artifacts[0].sha256);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('validates evidence inputs before any Linear network calls', async () => {
    const root = tempRoot();
    let graphqlCalled = false;

    await expect(
      publisher.publishEvidence(publisher.parseArgs(['--issue', 'NIE-57', '--image', 'output/playwright/missing.png::Missing']), {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql: async () => {
          graphqlCalled = true;
          return {};
        },
        putFile: async () => {}
      })
    ).rejects.toMatchObject({ code: 'ui_evidence_file_missing' });
    expect(graphqlCalled).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('updates an explicit existing comment when --comment-id is provided', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.mp4', 'mp4-bytes');
    let updatedCommentId = '';
    let savedBodyData: unknown;

    const graphql = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('query IssueByIdOrKey')) {
        return { issue: { id: 'issue-id', identifier: variables.id, url: null } };
      }
      if (query.includes('mutation FileUpload')) {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/demo.mp4',
              assetUrl: 'https://uploads.linear.app/demo.mp4',
              headers: []
            }
          }
        };
      }
      if (query.includes('mutation UpdateComment')) {
        updatedCommentId = String(variables.id);
        savedBodyData = variables.bodyData;
        return { commentUpdate: { success: true, comment: { id: variables.id, url: 'https://linear.app/comment', bodyData: savedBodyData } } };
      }
      if (query.includes('query CommentById')) {
        return { comment: { id: variables.id, url: 'https://linear.app/comment', bodyData: savedBodyData, issue: { id: 'issue-id', identifier: 'NIE-57' } } };
      }
      throw new Error(`unexpected query: ${query}`);
    };

    const result = await publisher.publishEvidence(
      publisher.parseArgs(['--issue', 'NIE-57', '--comment-id', 'comment-2', '--video', 'output/playwright/demo.mp4::Screencast']),
      {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql,
        putFile: async () => {}
      }
    );

    expect(updatedCommentId).toBe('comment-2');
    expect(result.comment.mode).toBe('updated');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects update when the explicit comment belongs to another issue', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.mp4', 'mp4-bytes');
    let updateCalled = false;

    const graphql = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('query IssueByIdOrKey')) {
        return { issue: { id: 'issue-id', identifier: variables.id, url: null } };
      }
      if (query.includes('mutation FileUpload')) {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/demo.mp4',
              assetUrl: 'https://uploads.linear.app/demo.mp4',
              headers: []
            }
          }
        };
      }
      if (query.includes('query CommentById')) {
        return { comment: { id: variables.id, url: 'https://linear.app/comment', bodyData: { type: 'doc', content: [] }, issue: { id: 'other-issue-id', identifier: 'ABC-999' } } };
      }
      if (query.includes('mutation UpdateComment')) {
        updateCalled = true;
      }
      return {};
    };

    await expect(
      publisher.publishEvidence(
        publisher.parseArgs(['--issue', 'NIE-57', '--comment-id', 'comment-2', '--video', 'output/playwright/demo.mp4::Screencast']),
        {
          cwd: root,
          auth: { apiKey: 'test-key', source: 'test' },
          graphql,
          putFile: async () => {}
        }
      )
    ).rejects.toMatchObject({ code: 'linear_comment_issue_mismatch' });
    expect(updateCalled).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('aborts before comment creation when signed upload PUT fails', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.png', 'png-bytes');
    let commentCreateCalled = false;

    const graphql = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('query IssueByIdOrKey')) {
        return { issue: { id: 'issue-id', identifier: variables.id, url: null } };
      }
      if (query.includes('mutation FileUpload')) {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/demo.png',
              assetUrl: 'https://uploads.linear.app/demo.png',
              headers: []
            }
          }
        };
      }
      if (query.includes('mutation CreateComment')) {
        commentCreateCalled = true;
      }
      return {};
    };

    await expect(
      publisher.publishEvidence(publisher.parseArgs(['--issue', 'NIE-57', '--image', 'output/playwright/demo.png::Screenshot']), {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql,
        putFile: async () => {
          throw new publisher.UiEvidenceError('linear_file_put_failed', 'PUT failed');
        }
      })
    ).rejects.toMatchObject({ code: 'linear_file_put_failed' });
    expect(commentCreateCalled).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('surfaces typed Linear GraphQL failures', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.png', 'png-bytes');

    await expect(
      publisher.publishEvidence(publisher.parseArgs(['--issue', 'NIE-57', '--image', 'output/playwright/demo.png::Screenshot']), {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql: async () => {
          throw new publisher.UiEvidenceError('linear_graphql_failed', 'GraphQL failed');
        },
        putFile: async () => {}
      })
    ).rejects.toMatchObject({ code: 'linear_graphql_failed' });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails verification when Linear bodyData lacks expected media nodes', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.png', 'png-bytes');
    const emptyBodyData = { type: 'doc', content: [] };

    const graphql = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('query IssueByIdOrKey')) {
        return { issue: { id: 'issue-id', identifier: variables.id, url: null } };
      }
      if (query.includes('mutation FileUpload')) {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/demo.png',
              assetUrl: 'https://uploads.linear.app/demo.png',
              headers: []
            }
          }
        };
      }
      if (query.includes('mutation CreateComment')) {
        return { commentCreate: { success: true, comment: { id: 'comment-id', url: null, bodyData: variables.bodyData } } };
      }
      if (query.includes('query CommentById')) {
        return { comment: { id: variables.id, url: null, bodyData: emptyBodyData, issue: { id: 'issue-id', identifier: 'NIE-57' } } };
      }
      throw new Error(`unexpected query: ${query}`);
    };

    await expect(
      publisher.publishEvidence(publisher.parseArgs(['--issue', 'NIE-57', '--image', 'output/playwright/demo.png::Screenshot']), {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql,
        putFile: async () => {}
      })
    ).rejects.toMatchObject({ code: 'linear_comment_verify_failed' });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails verification when Linear bodyData media sources do not match uploaded assets', async () => {
    const root = tempRoot();
    writeEvidence(root, 'output/playwright/demo.png', 'png-bytes');
    const wrongBodyData = publisher.buildBodyData({
      items: [
        {
          type: 'image',
          assetUrl: 'https://uploads.linear.app/wrong.png',
          filename: 'wrong.png',
          caption: 'Screenshot',
          size: 1,
          contentType: 'image/png'
        }
      ]
    });

    const graphql = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('query IssueByIdOrKey')) {
        return { issue: { id: 'issue-id', identifier: variables.id, url: null } };
      }
      if (query.includes('mutation FileUpload')) {
        return {
          fileUpload: {
            success: true,
            uploadFile: {
              uploadUrl: 'https://upload.test/demo.png',
              assetUrl: 'https://uploads.linear.app/demo.png',
              headers: []
            }
          }
        };
      }
      if (query.includes('mutation CreateComment')) {
        return { commentCreate: { success: true, comment: { id: 'comment-id', url: null, bodyData: variables.bodyData } } };
      }
      if (query.includes('query CommentById')) {
        return { comment: { id: variables.id, url: null, bodyData: wrongBodyData, issue: { id: 'issue-id', identifier: 'NIE-57' } } };
      }
      throw new Error(`unexpected query: ${query}`);
    };

    await expect(
      publisher.publishEvidence(publisher.parseArgs(['--issue', 'NIE-57', '--image', 'output/playwright/demo.png::Screenshot']), {
        cwd: root,
        auth: { apiKey: 'test-key', source: 'test' },
        graphql,
        putFile: async () => {}
      })
    ).rejects.toMatchObject({ code: 'linear_comment_verify_failed' });

    fs.rmSync(root, { recursive: true, force: true });
  });
});
