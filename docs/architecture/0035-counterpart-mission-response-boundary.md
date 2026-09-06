# 0035 — Bounded counterpart mission responses and uncertain creation

Status: Implemented local MCP response boundary with disposable PostgreSQL-to-HTTP
composition evidence. No workflow execution, native provisioning or external effect.

## Validate before returning, not only in the SDK

The installed MCP SDK validates output but returns the original handler result;
successful Zod parsing alone does not strip unexpected fields from that result.
It also converts handler/validation exceptions to tool errors using their original
messages. An outer HTTP catch therefore cannot prevent private persistence errors
from becoming successful HTTP responses containing MCP error text.

The three mission tools now own validation and error handling inside the handler.
Input and output objects are strict; stable IDs use the complete canonical UUIDv4
shape. Every successful structured result is detached, validated and reconstructed
before return. Unknown fields reject the entire response, including nested metadata;
the handler never returns an original persistence object or a partial valid prefix.
The SDK's schema validation remains a secondary check, not the disclosure boundary.

## One bounded data snapshot

`snapshotJsonData` accepts only plain/null-prototype records, ordinary dense arrays,
and JSON primitives. It reads own property descriptors, not getters or user-defined
iteration/serialization methods. Symbol/non-enumerable/custom-array keys, accessors,
hooks, cycles, non-plain prototypes and unsupported values reject. Repeated acyclic
aliases become separate detached values; negative zero becomes JSON zero. An own
`__proto__` property is copied as data without changing the new object's prototype.

The mission boundary limits structured content to 65,536 encoded UTF-8 bytes,
including wrappers, keys, escaping and punctuation; 32 levels; 10,000 values;
200 entries per collection; and 4,096 UTF-16 code units per string. Byte accounting
happens incrementally on primitive strings, never by serializing the caller's
object. Status retains its separate 50-environment limit. Overflow is denial,
not truncation or a returned partial snapshot. These are application data bounds,
not a sandbox for hostile Proxy traps, process-wide prototype changes, or an
upstream database-result memory limit. Existing other JSON parsers are unchanged.

## Shared persisted projection, exact request relationship

Creation and recorded status share mission summary/node validation. Use exact
domain mission states and worker roles, migration 0002 mission-node states, and
the existing SQL semantic-version grammar. Node type/graph revision remain bounded
nonempty text, not invented enums. Validate finite Gregorian mission timestamps
with at most six fractional digits while retaining their original valid offset
spelling. This does not re-evaluate historical lifecycle evidence or normalize all
recorded observation timestamps to a new representation.

Node IDs and listed mission IDs must be unique. A list must fit the requested
limit, contain only nonterminal missions and match the exact optional project.
Creation must match requested project/scope and any explicit workflow ID; the
authoritative stored binding still pins the version. Status must match its exact
requested mission ID. Historical replay can report a later mission state: it is
not required to fabricate the original `received` projection. No returned state
grants execution permission or implies deployment, acceptance or business success.

## Private failures and uncertain commits

Status/list failures return fixed generic messages with no structured content.
Creation failure says the mission could not be confirmed and that the same request
ID may be reused only with unchanged terms. It does not assert that the transaction
rolled back or that no mission exists. A COMMIT can succeed while its reply is lost;
neither validation failure nor missing acknowledgement is a fresh retry grant.

Handlers perform no automatic retry, status readback, repair, or new-ID creation.
An explicitly repeated unchanged request uses the storage idempotency contract
from ADR0034 to retrieve retained history. Changed terms remain an error. Input
validation errors may describe caller-provided input; persistence diagnostics do
not cross the boundary. No new database schema or authentication policy is added.

## Evidence and limits

Five HTTP regression cases reproduced the old private-error/extra-field behavior;
three parser cases reproduced unsafe object handling and invalid projection data.
Eighteen new local cases cover those defects and independent primitive/parser bounds.
Additional assertions exercise multibyte text, exact byte boundaries, duplicate
identities independently of list length, nested getters/iterators with zero calls,
historical timestamps, and every persisted mission/node/role state.

`CounterpartSessions http` composes the installed MCP client, real loopback HTTP
server and actual PostgreSQL store under the schema through 0005. Four bounded
checks prove pre-SQL auth/input rejection, one-history creation/replay, unavailable
workflow denial, and actual COMMIT with a deliberately lost reply. The latter
returns a fixed unconfirmed error with no automatic retry/readback, retains one
history and subsequently returns the exact mission on explicit unchanged retry.
Fixture witnesses await discarded backend end and absence separately from the
handler response. Worker-run, effect and node counts stay unchanged.

The fixture uses synthetic credentials and an owned disposable database under a
30-second child/90-second outer bound. It does not prove production pool latency,
production identity isolation, workflow execution, live models or external effects.
