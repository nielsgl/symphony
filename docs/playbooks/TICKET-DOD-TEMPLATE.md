# Ticket Definition of Done (DoD) Template

Copy this into the issue/workpad and fill it before implementation starts.

## A) Surface acceptance (UI/API/Events)

- [ ] UI surface renders required fields and controls.
- [ ] API adds/updates required request/response fields.
- [ ] Event taxonomy includes required lifecycle events.

## B) Semantic acceptance (runtime behavior)

- [ ] The user action changes runtime behavior as intended.
- [ ] Primary path is executable in production code.
- [ ] Fallback path exists only as backup, with typed reasoning.
- [ ] No placeholders/stubs in required production path.

## C) Scenario matrix (required)

Document expected outcome for each:

1. Primary success path:
   - Expected mode:
   - Expected reason code:
   - Expected status:
2. Fallback path:
   - Trigger:
   - Expected mode:
   - Expected reason code:
3. Mismatch/conflict path:
   - Expected error code:
   - Expected HTTP status:
4. Validation failure path:
   - Expected error code:
   - Expected HTTP status:

## D) Proof requirements (required)

- [ ] Integration test proving primary success path.
- [ ] Integration test proving fallback path.
- [ ] Integration test proving mismatch/conflict path.
- [ ] API tests for success + all typed failure envelopes.
- [ ] UI test/walkthrough evidence for operator-visible behavior.

## E) Observability and auditability

- [ ] Request lineage is persisted and queryable where required.
- [ ] Mode/reason fields are exposed in runtime state and issue detail.
- [ ] Events emitted for request, applied, fallback, failure transitions.

## F) Closure gate

Do not move to `Human Review` unless all are true:

- [ ] Surface acceptance complete.
- [ ] Semantic acceptance complete.
- [ ] Proof requirements complete.
- [ ] Ticket and PR summaries do not over-claim implemented scope.
