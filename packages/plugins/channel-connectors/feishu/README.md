# Verrail Feishu Channel Connector

This package implements the shared Channel Connector V1 contract for a Feishu
custom application. Configure `channelConnections` in the Workspace plugin settings.
Each connection pins `contractVersion: 1`, `connectorKey: "feishu"`, a unique
`connectionId`, `appId`, an `appSecretRef`, and `authorizedUsers` mappings from
Feishu `providerUserId` (open_id) to an active Verrail `userId`.

`transport: "long_connection"` uses the official Feishu WebSocket SDK and the
existing `im.message.receive_v1` subscription. It requires no public callback URL,
verification token, or encryption key. One application has one receiver binding
in this worker; another process connected to the same application competes for
events and must be accounted for by the operator. Configuration replacement and
shutdown close receivers; the SDK reconnects after connection loss.

Long connections ingest authorized direct messages only. An unmapped direct
sender is not persisted; connection diagnostics show its latest open_id for operator mapping,
without its message content. The host rechecks the current configured connection,
active Workspace and membership before accepting events. Ordinary messages extend
the conversation; `/verrail target create <title>` creates a draft and replies
with its reference. A human confirms the draft in Verrail to create a Target.

`transport: "webhook"` (the default) uses the host-generated callback URL and
requires encrypted event delivery, signature verification, `verificationTokenRef`
and `encryptKeyRef`. WebSocket events never impersonate signed HTTP callbacks.

Store credentials in local Secret configuration and use only references here.
Raw transport bodies, headers, tokens, keys and app secrets are not persisted as
channel evidence. SDK diagnostics containing authenticated request objects are
suppressed; health exposes connection state and delivery counters instead.

The board-only plugin data bridge exposes `connection-health` with a required
`companyId` scope. Its `sessions` contain only that Workspace's connection IDs,
transport state, delivery counters, and latest unmapped sender ID. The registry
Status page reports plugin readiness, not WebSocket connectivity.

## Existing Reply Readback

The optional `onChannelReplyRead` hook supports operator-requested reconciliation
of an existing creation notification. It obtains a tenant token and calls
[Get Message](https://open.feishu.cn/document/server-docs/im-v1/message/get)
with a validated message ID. It never sends or edits a message. The bot must have
access to the referenced conversation and the required Provider read permission;
missing permission leaves the delivery outcome unresolved.

Only one unedited, undeleted text message from the configured application is
accepted. The result contains its parent message, conversation, body hash and
creation timestamp, not the message text, token or application secret. Message
response parsing is capped at 512 KiB. The existing host HTTP transport buffers
the response before worker parsing; the hook does not claim a new transport-wide
streaming limit or cancellation guarantee.

The host separately matches those facts against the stored send reservation,
checks the confirmer's current authority and exact configuration before and
after reading, and records a conditional state update plus audit. Supplying a
message ID is not a self-reported success assertion. Older plugins without this
hook cannot reconcile unknown results, and reconciliation never authorizes a
second send.
