interface DynamicToolLinearGraphqlInput {
  query: string;
  variables?: Record<string, unknown> | null;
}

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DynamicToolResult {
  success: boolean;
  output: string;
  contentItems: Array<{ type: 'inputText'; text: string }>;
}

export interface DynamicToolExecutor {
  toolSpecs(): DynamicToolSpec[];
  execute(toolName: string | undefined, argumentsValue: unknown): Promise<DynamicToolResult>;
}

interface DynamicToolExecutorOptions {
  trackerEndpoint: string;
  trackerApiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const LINEAR_GRAPHQL_TOOL_NAME = 'linear_graphql';

function encodeResult(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resultPayload(success: boolean, value: unknown): DynamicToolResult {
  const text = encodeResult(value);
  return {
    success,
    output: text,
    contentItems: [
      {
        type: 'inputText',
        text
      }
    ]
  };
}

function failurePayload(
  code: string,
  message: string,
  fields: Record<string, unknown> = {}
): DynamicToolResult {
  return resultPayload(false, {
    error: {
      code,
      message,
      ...fields
    }
  });
}

function toLinearGraphqlInput(argumentsValue: unknown): DynamicToolLinearGraphqlInput | null {
  if (typeof argumentsValue === 'string') {
    const trimmed = argumentsValue.trim();
    if (!trimmed) {
      return null;
    }

    return {
      query: trimmed,
      variables: {}
    };
  }

  if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) {
    return null;
  }

  const raw = argumentsValue as Record<string, unknown>;
  const query = typeof raw.query === 'string' ? raw.query.trim() : '';
  if (!query) {
    return null;
  }

  let variables: Record<string, unknown> | null = {};
  if (raw.variables !== undefined && raw.variables !== null) {
    if (typeof raw.variables !== 'object' || Array.isArray(raw.variables)) {
      return null;
    }
    variables = raw.variables as Record<string, unknown>;
  }

  return { query, variables };
}

export function createDefaultDynamicToolExecutor(options: DynamicToolExecutorOptions): DynamicToolExecutor {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  const toolSpecs: DynamicToolSpec[] = [
    {
      name: LINEAR_GRAPHQL_TOOL_NAME,
      description: "Execute a raw GraphQL query or mutation against Linear using Symphony's configured auth.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description: 'GraphQL query or mutation document to execute against Linear.'
          },
          variables: {
            type: ['object', 'null'],
            description: 'Optional GraphQL variables object.',
            additionalProperties: true
          }
        }
      }
    }
  ];

  return {
    toolSpecs(): DynamicToolSpec[] {
      return toolSpecs;
    },
    async execute(toolName: string | undefined, argumentsValue: unknown): Promise<DynamicToolResult> {
      if (toolName !== LINEAR_GRAPHQL_TOOL_NAME) {
        return failurePayload('unsupported_dynamic_tool', `Unsupported dynamic tool: ${JSON.stringify(toolName)}.`, {
          attemptedToolName: toolName ?? null,
          supportedTools: toolSpecs.map((entry) => entry.name)
        });
      }

      const parsedInput = toLinearGraphqlInput(argumentsValue);
      if (!parsedInput) {
        return failurePayload(
          'invalid_linear_graphql_arguments',
          '`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`.',
          { attemptedToolName: LINEAR_GRAPHQL_TOOL_NAME }
        );
      }

      if (!options.trackerApiKey.trim()) {
        return failurePayload('missing_linear_auth', 'Symphony is missing Linear auth. Set tracker.api_key or export LINEAR_API_KEY.', {
          attemptedToolName: LINEAR_GRAPHQL_TOOL_NAME
        });
      }

      if (!options.trackerEndpoint.trim()) {
        return failurePayload('missing_tracker_endpoint', 'Symphony is missing tracker endpoint for dynamic tool execution.', {
          attemptedToolName: LINEAR_GRAPHQL_TOOL_NAME
        });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetchFn(options.trackerEndpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: options.trackerApiKey
          },
          body: JSON.stringify({
            query: parsedInput.query,
            variables: parsedInput.variables ?? {}
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          return failurePayload('linear_graphql_http_error', `Linear GraphQL request failed with HTTP ${response.status}.`, {
            attemptedToolName: LINEAR_GRAPHQL_TOOL_NAME,
            status: response.status
          });
        }

        const payload = (await response.json()) as Record<string, unknown>;
        const graphQlErrors = Array.isArray(payload.errors) ? payload.errors : [];
        const success = graphQlErrors.length === 0;
        return resultPayload(success, payload);
      } catch (error) {
        return failurePayload('linear_graphql_transport_error', 'Linear GraphQL request failed before receiving a successful response.', {
          attemptedToolName: LINEAR_GRAPHQL_TOOL_NAME,
          reason: error instanceof Error ? error.message : String(error)
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}
