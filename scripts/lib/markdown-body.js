function normalizeMarkdownBody(body) {
  if (typeof body !== 'string') {
    return '';
  }
  return body.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
}

function assertHumanReadableMarkdownBody(body) {
  const normalized = normalizeMarkdownBody(body);
  const escapedControlSequence = normalized.match(/\\\n|\\\r|\\\t|\\n|\\r|\\t|\\u[0-9a-fA-F]{4}/);
  if (escapedControlSequence) {
    const error = new Error('pr_body_escaped_newlines: body contains escaped newline sequences; normalize before submit');
    error.code = 'pr_body_escaped_newlines';
    throw error;
  }
  return normalized;
}

module.exports = {
  normalizeMarkdownBody,
  assertHumanReadableMarkdownBody
};
